import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { assertDataDirectoryVersion, resolvePostgresBinariesForLifecycle } from './binaries'
import {
  DEFAULT_READINESS_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
} from './constants'
import { listenLabel, requireNonEmptyString, resolveListenOptions } from './listen'
import { ensureDatabase, waitForIdleConnections, waitForReady } from './postgres-client'
import {
  commandError,
  delay,
  openLogTarget,
  runCommand,
  waitForExit,
  type ExitResult,
} from './process'
import {
  LocalPostgresError,
  PostgresDataDirInUseError,
  type EnsurePostgresDatabaseOptions,
  type InitPostgresDataDirOptions,
  type InitPostgresDataDirResult,
  type LocalPostgresLogger,
  type LocalPostgresProcess,
  type PostgresBinaryOptions,
  type PostgresConfigValue,
  type StartPostgresDataDirOptions,
  type StopPostgresDataDirOptions,
  type WaitForPostgresReadyOptions,
} from './types'

export { resolvePostgresBinaries } from './binaries'
export { DEFAULT_POSTGRES_CACHE_DIR, LocalPostgresError, PostgresDataDirInUseError } from './types'
export type {
  EnsurePostgresDatabaseOptions,
  InitPostgresDataDirOptions,
  InitPostgresDataDirResult,
  LocalPostgresLogTarget,
  LocalPostgresLogger,
  LocalPostgresProcess,
  PostgresBinaryOptions,
  PostgresBinaryStrategy,
  PostgresConfigValue,
  PostgresListenOptions,
  ResolvedPostgresBinaries,
  ResolvedPostgresListenOptions,
  StartPostgresDataDirOptions,
  StopPostgresDataDirOptions,
  WaitForPostgresReadyOptions,
} from './types'

/**
 * Resolves a Postgres binary and returns its parsed version.
 *
 * Use this before initializing a data directory when the caller needs the
 * binary version to choose a versioned cluster path.
 */
export async function getPostgresVersion(
  options: {
    /** Binary resolution behavior. */
    postgres?: PostgresBinaryOptions
  } = {},
): Promise<string> {
  const binaries = await resolvePostgresBinariesForLifecycle(options.postgres, {
    checkAvailability: true,
    logger: noopLogger,
    needsInitdb: false,
  })

  if (!binaries.version) {
    throw new LocalPostgresError('Resolved Postgres binary did not report a version.')
  }

  return binaries.version
}

/**
 * Creates and initializes a Postgres data directory when needed.
 *
 * If `PG_VERSION` already exists, this validates the data directory against
 * the resolved binary major version when known and leaves existing
 * configuration untouched.
 */
export async function initPostgresDataDir(
  options: InitPostgresDataDirOptions,
): Promise<InitPostgresDataDirResult> {
  const dataDir = requireNonEmptyString(options.dataDir, 'dataDir')
  const logger = resolveLogger(options.logger)

  mkdirSync(dataDir, { recursive: true })

  const needsInitdb = !existsSync(path.join(dataDir, 'PG_VERSION'))
  const binaries =
    options.binaries ??
    (await resolvePostgresBinariesForLifecycle(options.postgres, {
      logger,
      needsInitdb,
    }))

  if (!needsInitdb) {
    if (binaries.version) {
      assertDataDirectoryVersion(dataDir, binaries.version)
    }

    return {
      dataDir,
      version: binaries.version,
    }
  }

  const username = options.username
    ? requireNonEmptyString(options.username, 'username')
    : os.userInfo().username
  const args = ['-D', dataDir, '-U', username]

  if (options.auth !== undefined) {
    args.push(`--auth=${requireNonEmptyString(options.auth, 'auth')}`)
  }

  if (options.locale === false) {
    args.push('--no-locale')
  } else if (options.locale !== undefined) {
    args.push('--locale', requireNonEmptyString(options.locale, 'locale'))
  }

  if (options.encoding !== undefined) {
    args.push('-E', requireNonEmptyString(options.encoding, 'encoding'))
  }

  if (options.noSync) {
    args.push('--nosync')
  }

  logger.info('[postgres] Initializing database cluster...')
  try {
    await runCommand(binaries.initdb, args, { log: options.log })
  } catch (error) {
    throw commandError('Failed to initialize the Postgres data directory.', 'initdb', error)
  }

  if (options.config && Object.keys(options.config).length > 0) {
    await appendFile(path.join(dataDir, 'postgresql.conf'), formatPostgresConfig(options.config))
  }

  return {
    dataDir,
    version: binaries.version,
  }
}

/**
 * Starts a Postgres server for an existing data directory.
 *
 * The returned process resolves only after Postgres accepts client
 * connections. Call `stop()` or use `await using` to shut the process down.
 */
export async function startPostgresDataDir(
  options: StartPostgresDataDirOptions,
): Promise<LocalPostgresProcess> {
  const dataDir = requireNonEmptyString(options.dataDir, 'dataDir')
  const logger = resolveLogger(options.logger)
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const readinessIntervalMs = options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS
  await assertDataDirectoryNotInUse(dataDir)
  const listen = await resolveListenOptions(options.listen, {
    checkTcpPort: true,
    tcpPort: 'findAvailable',
  })

  const binaries =
    options.binaries ??
    (await resolvePostgresBinariesForLifecycle(options.postgres, {
      logger,
      needsInitdb: false,
    }))

  if (binaries.version) {
    assertDataDirectoryVersion(dataDir, binaries.version)
  }

  if (listen.type === 'socket') {
    mkdirSync(listen.socketDir, { recursive: true })
  }

  logger.info(`[postgres] Starting server on ${listenLabel(listen)}...`)
  const logFile = openLogTarget(options.log)
  let stopped = false
  let ready = false
  let spawnError: Error | undefined
  let exitResult: ExitResult | undefined
  const args =
    listen.type === 'socket'
      ? ['-D', dataDir, '-k', listen.socketDir, '-h', '', '-p', String(listen.port)]
      : ['-D', dataDir, '-h', listen.host, '-p', String(listen.port)]

  args.push(...(options.postgresOptions ?? []))

  const proc = spawn(binaries.postgres, args, {
    stdio: logFile.stdio,
  })
  logFile.attach(proc)

  const exitPromise = new Promise<ExitResult>((resolve) => {
    proc.once('exit', (code, signal) => {
      exitResult = { code, signal }
      logFile.close()
      if (ready && !stopped && code !== 0 && code !== null) {
        logger.error(`[postgres] Process exited unexpectedly with code ${code}.`)
      }
      resolve(exitResult)
    })
  })

  proc.once('error', (error) => {
    spawnError = error
    logFile.close()
  })

  const stop = async () => {
    if (stopped) return
    stopped = true

    if (exitResult || spawnError) return

    proc.kill('SIGINT')
    const didExitAfterSigint = await waitForExit(exitPromise, stopTimeoutMs)
    if (didExitAfterSigint) return

    proc.kill('SIGTERM')
    await waitForExit(exitPromise, stopTimeoutMs)
  }

  try {
    await waitForReady({
      listen,
      user: os.userInfo().username,
      getSpawnError: () => spawnError,
      getExitResult: () => exitResult,
      timeoutMs: readinessTimeoutMs,
      intervalMs: readinessIntervalMs,
    })
    ready = true
    logFile.finishStartup()
  } catch (error) {
    await stop()
    const diagnostics = logFile.diagnostics()
    if (!diagnostics) throw error

    if (error instanceof LocalPostgresError) {
      throw new LocalPostgresError(error.message, {
        cause: error.cause ?? error,
        diagnostics,
      })
    }

    throw new LocalPostgresError('Failed to start Postgres.', {
      cause: error,
      diagnostics,
    })
  }

  logger.info(`[postgres] Server ready on ${listenLabel(listen)}.`)

  return {
    dataDir,
    listen,
    port: listen.port,
    ...(listen.type === 'socket'
      ? {
          socketDir: listen.socketDir,
        }
      : {
          host: listen.host,
        }),
    pid: proc.pid,
    stop,
    [Symbol.asyncDispose]: stop,
  }
}

/**
 * Stops a Postgres data directory by reading its `postmaster.pid` file.
 *
 * This is useful for cleanup from a different process than the one that
 * started Postgres. If no `postmaster.pid` exists, the function resolves
 * without signaling anything.
 */
export async function stopPostgresDataDir(options: StopPostgresDataDirOptions): Promise<void> {
  const dataDir = requireNonEmptyString(options.dataDir, 'dataDir')
  const logger = resolveLogger(options.logger)
  const timeoutMs = options.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  if (options.waitForIdle) {
    if (!options.listen) {
      throw new TypeError('listen is required when waitForIdle is enabled.')
    }

    const waitOptions = options.waitForIdle === true ? {} : options.waitForIdle
    const listen = await resolveListenOptions(options.listen)
    await waitForIdleConnections({
      database: waitOptions.database,
      intervalMs: waitOptions.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS,
      listen,
      minConnections: waitOptions.minConnections ?? 0,
      timeoutMs: waitOptions.timeoutMs ?? timeoutMs,
    })
  }

  const pid = await readPostmasterPid(dataDir)
  if (pid === undefined) return

  logger.info(`[postgres] Stopping server for ${dataDir}...`)
  try {
    // postmaster.pid lets background processes stop clusters without pg_ctl.
    // These signals match PostgreSQL's smart/fast/immediate shutdown modes.
    process.kill(pid, shutdownSignal(options.mode ?? 'fast'))
    await waitForPostmasterExit({ dataDir, pid, timeoutMs })
  } catch (error) {
    if (isNoSuchProcessError(error)) return
    if (error instanceof LocalPostgresError) throw error

    throw new LocalPostgresError(`Failed to stop the Postgres data directory "${dataDir}".`, {
      cause: error,
    })
  }
}

/**
 * Waits until Postgres accepts a client connection through the given listener.
 */
export async function waitForPostgresReady(options: WaitForPostgresReadyOptions): Promise<void> {
  await waitForReady({
    database: options.database,
    listen: await resolveListenOptions(options.listen),
    password: options.password,
    user: options.user,
    getSpawnError: () => undefined,
    getExitResult: () => undefined,
    timeoutMs: options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
    intervalMs: options.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS,
  })
}

/**
 * Creates a database when it does not already exist.
 *
 * The database name is safely quoted before execution. The connection is made
 * through `bootstrapDatabase`, or `postgres` when that option is omitted.
 */
export async function ensurePostgresDatabase(
  options: EnsurePostgresDatabaseOptions,
): Promise<void> {
  await ensureDatabase({
    bootstrapDatabase: options.bootstrapDatabase,
    database: requireNonEmptyString(options.database, 'database'),
    listen: await resolveListenOptions(options.listen),
    password: options.password,
    user: options.user,
  })
}

function formatPostgresConfig(config: Record<string, PostgresConfigValue>) {
  const lines = Object.entries(config).map(([key, value]) => {
    return `${requireNonEmptyString(key, 'config key')} = ${formatPostgresConfigValue(value)}`
  })

  return `\n# Appended by local-postgres.\n${lines.join('\n')}\n`
}

function formatPostgresConfigValue(value: PostgresConfigValue) {
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off'
  }

  if (typeof value === 'number') {
    return String(value)
  }

  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

async function readPostmasterPid(dataDir: string) {
  try {
    const pidFile = await readFile(path.join(dataDir, 'postmaster.pid'), 'utf8')
    const rawPid = pidFile.split(/\r?\n/, 1)[0]?.trim()

    if (!rawPid || !/^\d+$/.test(rawPid)) {
      throw new LocalPostgresError(`Invalid postmaster.pid file in "${dataDir}".`)
    }

    const pid = Number.parseInt(rawPid, 10)
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new LocalPostgresError(`Invalid postmaster.pid file in "${dataDir}".`)
    }

    return pid
  } catch (error) {
    if (isNotFoundError(error)) return undefined
    throw error
  }
}

async function assertDataDirectoryNotInUse(dataDir: string) {
  const pid = await readPostmasterPid(dataDir)
  if (pid !== undefined && isProcessRunning(pid)) {
    throw new PostgresDataDirInUseError(dataDir, pid)
  }
}

async function waitForPostmasterExit({
  dataDir,
  pid,
  timeoutMs,
}: {
  dataDir: string
  pid: number
  timeoutMs: number
}) {
  const pidPath = path.join(dataDir, 'postmaster.pid')
  const deadline = Date.now() + timeoutMs

  while (Date.now() <= deadline) {
    if (!existsSync(pidPath) || !isProcessRunning(pid)) {
      return
    }

    await delay(DEFAULT_READINESS_INTERVAL_MS)
  }

  throw new LocalPostgresError(
    `Timed out after ${timeoutMs}ms waiting for Postgres to stop for "${dataDir}".`,
  )
}

function shutdownSignal(mode: 'smart' | 'fast' | 'immediate'): NodeJS.Signals {
  if (mode === 'smart') return 'SIGTERM'
  if (mode === 'immediate') return 'SIGQUIT'
  return 'SIGINT'
}

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (isNoSuchProcessError(error)) return false
    if (isPermissionError(error)) return true
    throw error
  }
}

function isNotFoundError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function isNoSuchProcessError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}

function isPermissionError(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM'
}

function resolveLogger(logger?: Partial<LocalPostgresLogger>): LocalPostgresLogger {
  return {
    info: logger?.info ?? noop,
    warn: logger?.warn ?? noop,
    error: logger?.error ?? noop,
  }
}

const noopLogger: LocalPostgresLogger = {
  info: noop,
  warn: noop,
  error: noop,
}

function noop() {}
