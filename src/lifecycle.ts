import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { assertDataDirectoryVersion, resolvePostgresBinaries } from './binaries'
import {
  DEFAULT_DATABASE,
  DEFAULT_HOST,
  DEFAULT_READINESS_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
} from './constants'
import { createConnectionString, createEnv } from './connection'
import { ensureDatabase, ensureSuperuser, waitForReady } from './postgres-client'
import { commandError, openLogTarget, runCommand, waitForExit, type ExitResult } from './process'
import {
  LocalPostgresError,
  type LocalPostgresLogger,
  type LocalPostgresServer,
  type StartPostgresOptions,
} from './types'

export async function startPostgres(options: StartPostgresOptions): Promise<LocalPostgresServer> {
  const dataDir = requireNonEmptyString(options.dataDir, 'dataDir')
  const database = options.database
    ? requireNonEmptyString(options.database, 'database')
    : DEFAULT_DATABASE
  const host = options.host ? requireNonEmptyString(options.host, 'host') : DEFAULT_HOST
  const logger = resolveLogger(options.logger)
  const bootstrapUser = os.userInfo().username
  const port =
    options.port === undefined
      ? await findAvailablePort(host)
      : await assertAvailablePort(host, normalizePort(options.port))
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const readinessIntervalMs = options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  const needsInitdb = !existsSync(path.join(dataDir, 'PG_VERSION'))
  const binaries = await resolvePostgresBinaries(options.postgres, {
    logger,
    needsInitdb,
  })

  if (!needsInitdb && binaries.version) {
    assertDataDirectoryVersion(dataDir, binaries.version)
  }

  if (needsInitdb) {
    logger.info('[postgres] Initializing database cluster...')
    try {
      // Trust authentication keeps the package local-dev friendly. Callers that
      // need stronger auth can initialize and pass their own data directory.
      await runCommand(binaries.initdb, [
        '-D',
        dataDir,
        '-U',
        bootstrapUser,
        '--auth=trust',
        '--no-locale',
        '-E',
        'UTF8',
      ])
    } catch (error) {
      throw commandError('Failed to initialize the Postgres data directory.', 'initdb', error)
    }
  }

  logger.info(`[postgres] Starting server on ${host}:${port}...`)
  const logFile = openLogTarget(options.log)
  let stopped = false
  let ready = false
  let spawnError: Error | undefined
  let exitResult: ExitResult | undefined

  const proc = spawn(binaries.postgres, ['-D', dataDir, '-h', host, '-p', String(port)], {
    stdio: logFile.stdio,
  })

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
      host,
      port,
      user: bootstrapUser,
      getSpawnError: () => spawnError,
      getExitResult: () => exitResult,
      timeoutMs: readinessTimeoutMs,
      intervalMs: readinessIntervalMs,
    })
    ready = true

    if (options.superuser) {
      await ensureSuperuser({
        host,
        port,
        user: bootstrapUser,
        superuser: options.superuser,
      })
    }

    if (database !== DEFAULT_DATABASE) {
      await ensureDatabase({
        host,
        port,
        user: bootstrapUser,
        database,
      })
    }
  } catch (error) {
    await stop()
    throw error
  }

  const connectionString = createConnectionString({
    host,
    port,
    database,
    user: options.superuser?.name,
    password: options.superuser?.password,
  })
  const env = createEnv({
    dataDir,
    database,
    host,
    port,
    connectionString,
    user: options.superuser?.name,
    password: options.superuser?.password,
  })

  logger.info(`[postgres] Server ready on ${host}:${port}.`)

  return {
    dataDir,
    database,
    host,
    port,
    user: options.superuser?.name,
    password: options.superuser?.password,
    pid: proc.pid,
    connectionString,
    env,
    stop,
  }
}

function resolveLogger(logger?: Partial<LocalPostgresLogger>): LocalPostgresLogger {
  return {
    info: logger?.info ?? noop,
    warn: logger?.warn ?? noop,
    error: logger?.error ?? noop,
  }
}

function noop() {}

function requireNonEmptyString(value: string, name: string) {
  if (value.trim() === '') {
    throw new TypeError(`${name} must not be empty.`)
  }
  return value
}

function normalizePort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('port must be an integer between 1 and 65535.')
  }
  return port
}

async function assertAvailablePort(host: string, port: number) {
  try {
    return await probePort(host, port)
  } catch (error) {
    throw new LocalPostgresError(
      `Port ${port} is not available on ${host}. Choose another port or stop the process using it.`,
      { cause: error },
    )
  }
}

async function findAvailablePort(host: string) {
  return probePort(host, 0)
}

function probePort(host: string, port: number) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()

    server.unref()
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      if (typeof address !== 'object' || address === null) {
        server.close(() => {
          reject(new LocalPostgresError('Unable to determine the selected port.'))
        })
        return
      }

      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(address.port)
      })
    })
  })
}
