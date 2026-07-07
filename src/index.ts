import { execFile, spawn, type StdioOptions } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_DATABASE = 'postgres'
const DEFAULT_READINESS_TIMEOUT_MS = 3_000
const DEFAULT_READINESS_INTERVAL_MS = 100
const DEFAULT_STOP_TIMEOUT_MS = 5_000

export interface LocalPostgresLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface LocalPostgresSuperuser {
  name: string
  password: string
}

export type LocalPostgresLogTarget =
  | 'ignore'
  | 'inherit'
  | {
      filePath: string
    }

export interface StartPostgresOptions {
  /**
   * Directory containing the Postgres data cluster. The directory is created
   * and initialized when it does not already contain a `PG_VERSION` file.
   */
  dataDir: string
  /**
   * Database to create if needed and expose in connection details.
   *
   * Defaults to `postgres`.
   */
  database?: string
  /**
   * Port for the Postgres TCP server. When omitted, an available local port is
   * selected before the server starts.
   */
  port?: number
  /**
   * TCP host for the Postgres server.
   *
   * Defaults to `127.0.0.1`.
   */
  host?: string
  /**
   * Superuser role to create or update after the server is ready. When set,
   * returned connection details include this role's credentials.
   */
  superuser?: LocalPostgresSuperuser
  /**
   * Where Postgres stdout/stderr should go.
   *
   * Defaults to `ignore`.
   */
  log?: LocalPostgresLogTarget
  /**
   * Optional lifecycle logger. Missing methods are treated as no-ops.
   */
  logger?: Partial<LocalPostgresLogger>
  /**
   * Maximum time to wait for `pg_isready` to report readiness.
   *
   * Defaults to 3000ms.
   */
  readinessTimeoutMs?: number
  /**
   * Delay between readiness checks.
   *
   * Defaults to 100ms.
   */
  readinessIntervalMs?: number
  /**
   * Maximum time to wait after each shutdown signal.
   *
   * Defaults to 5000ms.
   */
  stopTimeoutMs?: number
}

export interface LocalPostgresEnv {
  PGDATA: string
  PGDATABASE: string
  PGHOST: string
  PGPORT: string
  DATABASE_URL: string
  PGUSER?: string
  PGPASSWORD?: string
}

export interface LocalPostgresServer {
  dataDir: string
  database: string
  host: string
  port: number
  user?: string
  password?: string
  pid?: number
  connectionString: string
  env: LocalPostgresEnv
  stop(): Promise<void>
}

export class LocalPostgresError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalPostgresError'
  }
}

type CommandFailure = Error & {
  code?: number | string
  signal?: string
  stderr?: string
  stdout?: string
}

interface CommandResult {
  stderr: string
  stdout: string
}

interface ExitResult {
  code: number | null
  signal: NodeJS.Signals | null
}

export async function startPostgres(options: StartPostgresOptions): Promise<LocalPostgresServer> {
  const dataDir = requireNonEmptyString(options.dataDir, 'dataDir')
  const database = options.database
    ? requireNonEmptyString(options.database, 'database')
    : DEFAULT_DATABASE
  const host = options.host ? requireNonEmptyString(options.host, 'host') : DEFAULT_HOST
  const logger = resolveLogger(options.logger)
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

  if (!existsSync(join(dataDir, 'PG_VERSION'))) {
    logger.info('[postgres] Initializing database cluster...')
    try {
      // Trust authentication keeps the package local-dev friendly. Callers that
      // need stronger auth can initialize and pass their own data directory.
      await runCommand('initdb', ['-D', dataDir, '--auth=trust', '--no-locale', '-E', 'UTF8'])
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

  const proc = spawn('postgres', ['-D', dataDir, '-h', host, '-p', String(port)], {
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
        superuser: options.superuser,
      })
    }

    if (database !== DEFAULT_DATABASE) {
      await ensureDatabase({ host, port, database })
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

function openLogTarget(log: LocalPostgresLogTarget | undefined): {
  stdio: StdioOptions
  close(): void
} {
  if (log === 'inherit') {
    return {
      stdio: ['ignore', 'inherit', 'inherit'],
      close: noop,
    }
  }

  if (typeof log === 'object') {
    mkdirSync(dirname(log.filePath), { recursive: true })
    const fd = openSync(log.filePath, 'w')
    let closed = false
    return {
      stdio: ['ignore', fd, fd],
      close: () => {
        if (closed) return
        closed = true
        closeSync(fd)
      },
    }
  }

  return {
    stdio: ['ignore', 'ignore', 'ignore'],
    close: noop,
  }
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandFailure = error as CommandFailure
          commandFailure.stdout = stdout?.toString() ?? ''
          commandFailure.stderr = stderr?.toString() ?? ''
          reject(commandFailure)
          return
        }

        resolve({
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
        })
      },
    )
  })
}

function commandError(message: string, command: string, error: unknown) {
  const failure = error as CommandFailure
  const binaryMessage =
    failure.code === 'ENOENT' ? ` The "${command}" binary was not found on PATH.` : ''
  const stderr = failure.stderr?.trim()
  const detail = stderr ? ` ${stderr}` : failure.message ? ` ${failure.message}` : ''

  return new LocalPostgresError(`${message}${binaryMessage}${detail}`, {
    cause: error,
  })
}

async function waitForReady({
  host,
  port,
  getSpawnError,
  getExitResult,
  timeoutMs,
  intervalMs,
}: {
  host: string
  port: number
  getSpawnError(): Error | undefined
  getExitResult(): ExitResult | undefined
  timeoutMs: number
  intervalMs: number
}) {
  const deadline = Date.now() + timeoutMs
  let lastReadinessError: unknown

  while (Date.now() <= deadline) {
    const spawnError = getSpawnError()
    if (spawnError) {
      throw new LocalPostgresError(
        `Failed to start the "postgres" process. Is the "postgres" binary on PATH? ${spawnError.message}`,
        { cause: spawnError },
      )
    }

    const exitResult = getExitResult()
    if (exitResult) {
      throw new LocalPostgresError(
        `Postgres exited before becoming ready${
          exitResult.code === null ? '' : ` with code ${exitResult.code}`
        }${exitResult.signal ? ` after signal ${exitResult.signal}` : ''}.`,
      )
    }

    try {
      await runCommand('pg_isready', ['-h', host, '-p', String(port)])
      return
    } catch (error) {
      lastReadinessError = error
    }

    await delay(intervalMs)
  }

  throw new LocalPostgresError(
    `Timed out after ${timeoutMs}ms waiting for Postgres to become ready on ${host}:${port}.`,
    { cause: lastReadinessError },
  )
}

async function ensureSuperuser({
  host,
  port,
  superuser,
}: {
  host: string
  port: number
  superuser: LocalPostgresSuperuser
}) {
  const roleName = escapeIdent(superuser.name)
  const rolePassword = escapeLiteral(superuser.password)
  const sql = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${escapeLiteral(superuser.name)}) THEN
    CREATE ROLE ${roleName} WITH LOGIN SUPERUSER PASSWORD ${rolePassword};
  ELSE
    ALTER ROLE ${roleName} WITH LOGIN SUPERUSER PASSWORD ${rolePassword};
  END IF;
END
$$;
`

  try {
    await runCommand('psql', [
      '-h',
      host,
      '-p',
      String(port),
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ])
  } catch (error) {
    throw commandError(
      `Failed to create or update Postgres superuser "${superuser.name}".`,
      'psql',
      error,
    )
  }
}

async function ensureDatabase({
  host,
  port,
  database,
}: {
  host: string
  port: number
  database: string
}) {
  try {
    await runCommand('createdb', ['-h', host, '-p', String(port), database])
  } catch (error) {
    const failure = error as CommandFailure
    if (failure.stderr?.includes('already exists')) return

    throw commandError(`Failed to create Postgres database "${database}".`, 'createdb', error)
  }
}

function escapeIdent(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function escapeLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

function createConnectionString({
  host,
  port,
  database,
  user,
  password,
}: {
  host: string
  port: number
  database: string
  user?: string
  password?: string
}) {
  const hostForUrl = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  const auth =
    user === undefined ? '' : `${encodeURIComponent(user)}:${encodeURIComponent(password ?? '')}@`

  return `postgresql://${auth}${hostForUrl}:${port}/${encodeURIComponent(database)}`
}

function createEnv({
  dataDir,
  database,
  host,
  port,
  connectionString,
  user,
  password,
}: {
  dataDir: string
  database: string
  host: string
  port: number
  connectionString: string
  user?: string
  password?: string
}): LocalPostgresEnv {
  return {
    PGDATA: dataDir,
    PGDATABASE: database,
    PGHOST: host,
    PGPORT: String(port),
    DATABASE_URL: connectionString,
    ...(user === undefined
      ? {}
      : {
          PGUSER: user,
          PGPASSWORD: password ?? '',
        }),
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForExit(exitPromise: Promise<ExitResult>, timeoutMs: number) {
  return Promise.race([exitPromise.then(() => true), delay(timeoutMs).then(() => false)])
}
