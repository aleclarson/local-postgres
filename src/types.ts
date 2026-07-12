import * as os from 'node:os'
import * as path from 'node:path'
import type { Writable } from 'node:stream'

/**
 * Default directory used to cache managed Postgres binary packages.
 */
export const DEFAULT_POSTGRES_CACHE_DIR = path.join(os.homedir(), '.local-postgres')

/**
 * Receives lifecycle messages from `local-postgres`.
 */
export interface LocalPostgresLogger {
  /** Called for normal lifecycle progress messages. */
  info(message: string): void
  /** Called when a recoverable fallback or unusual condition occurs. */
  warn(message: string): void
  /** Called when the managed Postgres process exits unexpectedly. */
  error(message: string): void
}

/**
 * Superuser role that should exist before `startPostgres` resolves.
 */
export interface LocalPostgresSuperuser {
  /** Role name to create or update with `LOGIN SUPERUSER`. */
  name: string
  /** Password assigned to the role and returned in connection details. */
  password: string
}

/**
 * Destination for Postgres process stdout and stderr. `on-error` keeps a
 * bounded in-memory tail quiet during successful startup and adds it to a
 * `LocalPostgresError` when startup fails.
 */
export type PostgresOutputTarget =
  | 'ignore'
  | 'inherit'
  | 'on-error'
  | {
      /** File path that receives appended Postgres stdout and stderr output. */
      filePath: string
    }
  | Writable

/**
 * Strategy for resolving local or managed Postgres binaries.
 */
export type PostgresBinaryStrategy =
  | 'local-only'
  | 'prefer-local'
  | 'prefer-download'
  | 'download-only'

/**
 * Options that control which `postgres` and `initdb` binaries are used.
 */
export interface PostgresBinaryOptions {
  /**
   * Required Postgres version. A major version such as `18` accepts any
   * matching major version. More specific values require matching components.
   */
  version?: string
  /**
   * How local binaries and managed downloads should be resolved.
   *
   * Defaults to `prefer-local` when this object is provided. When `postgres`
   * is omitted, `local-only` preserves the package's original behavior.
   */
  strategy?: PostgresBinaryStrategy
  /**
   * Directory for downloaded npm package tarballs and extracted binaries.
   *
   * Defaults to `path.join(os.homedir(), ".local-postgres")`.
   */
  cacheDir?: string
}

/**
 * Absolute or PATH-resolved binaries selected for lifecycle operations.
 */
export interface ResolvedPostgresBinaries {
  /** Path or command name for the `initdb` executable. */
  initdb: string
  /** Path or command name for the `postgres` executable. */
  postgres: string
  /** Whether the binaries came from PATH or a managed package download. */
  source: 'local' | 'download'
  /** Parsed Postgres version when it could be inspected during resolution. */
  version?: string
}

/**
 * Value type accepted when appending PostgreSQL settings to `postgresql.conf`.
 */
export type PostgresConfigValue = string | number | boolean

/**
 * Listen configuration for TCP or Unix socket Postgres servers.
 */
export type PostgresListenOptions =
  | {
      /** Start a TCP listener. */
      type: 'tcp'
      /** TCP host passed to `postgres -h`. Defaults to `127.0.0.1`. */
      host?: string
      /** TCP port. When omitted, an available local port is selected. */
      port?: number
    }
  | {
      /** Start a Unix socket listener. */
      type: 'socket'
      /** Directory passed to `postgres -k` and used as the client host. */
      socketDir: string
      /** Socket port component. Defaults to PostgreSQL's `5432`. */
      port?: number
    }

/**
 * Normalized listen configuration returned after defaults are applied.
 */
export type ResolvedPostgresListenOptions =
  | {
      /** TCP listener. */
      type: 'tcp'
      /** Concrete TCP host used by the server and clients. */
      host: string
      /** Concrete TCP port used by the server and clients. */
      port: number
    }
  | {
      /** Unix socket listener. */
      type: 'socket'
      /** Concrete socket directory used by the server and clients. */
      socketDir: string
      /** Concrete socket port component. */
      port: number
    }

/**
 * Options for initializing a Postgres data directory with `initdb`.
 */
export interface InitPostgresDataDirOptions {
  /**
   * Actual Postgres cluster directory. This is the directory that contains
   * `PG_VERSION`, not necessarily the caller's outer workspace directory.
   */
  dataDir: string
  /** Pre-resolved binaries to reuse instead of resolving again. */
  binaries?: ResolvedPostgresBinaries
  /** Binary resolution behavior when `binaries` is omitted. */
  postgres?: PostgresBinaryOptions
  /** Encoding passed to `initdb -E`. */
  encoding?: string
  /** Locale passed to `initdb --locale`, or `false` to pass `--no-locale`. */
  locale?: string | false
  /** Bootstrap database superuser name. Defaults to the current OS user. */
  username?: string
  /** Authentication method passed to `initdb --auth`. */
  auth?: string
  /** Pass `--nosync` to `initdb` for faster, less durable initialization. */
  noSync?: boolean
  /** Settings appended to `postgresql.conf` after a new cluster is initialized. */
  config?: Record<string, PostgresConfigValue>
  /** Destination for raw `initdb` stdout and stderr. */
  initdbOutput?: PostgresOutputTarget
  /** Optional lifecycle logger. Missing methods are treated as no-ops. */
  logger?: Partial<LocalPostgresLogger>
}

/**
 * Result of `initPostgresDataDir`.
 */
export interface InitPostgresDataDirResult {
  /** Initialized or existing data directory. */
  dataDir: string
  /** Resolved binary version when known. */
  version?: string
}

/**
 * Options for starting an existing Postgres data directory.
 */
export interface StartPostgresDataDirOptions {
  /**
   * Actual Postgres cluster directory to start.
   */
  dataDir: string
  /** Pre-resolved binaries to reuse instead of resolving again. */
  binaries?: ResolvedPostgresBinaries
  /** Listen configuration. Defaults to TCP on an available local port. */
  listen?: PostgresListenOptions
  /** Binary resolution behavior when `binaries` is omitted. */
  postgres?: PostgresBinaryOptions
  /** Additional command-line arguments passed to the `postgres` process. */
  postgresOptions?: string[]
  /** Destination for raw `postgres` server stdout and stderr. */
  postgresOutput?: PostgresOutputTarget
  /** Optional lifecycle logger. Missing methods are treated as no-ops. */
  logger?: Partial<LocalPostgresLogger>
  /** Maximum time to wait for Postgres to accept client connections. */
  readinessTimeoutMs?: number
  /** Delay between readiness checks. */
  readinessIntervalMs?: number
  /** Maximum time to wait after each shutdown signal. */
  stopTimeoutMs?: number
}

/**
 * Running Postgres process returned by the core lifecycle API.
 */
export interface LocalPostgresProcess {
  /** Data directory passed to `startPostgresDataDir`. */
  dataDir: string
  /** Normalized listen configuration used by the server. */
  listen: ResolvedPostgresListenOptions
  /** Port used by the server. */
  port: number
  /** TCP host when the server is listening on TCP. */
  host?: string
  /** Socket directory when the server is listening on a Unix socket. */
  socketDir?: string
  /** Child process id reported by Node.js when available. */
  pid?: number
  /** Stops the server process. Safe to call more than once. */
  stop(): Promise<void>
  /** Supports `await using` by delegating to `stop()`. */
  [Symbol.asyncDispose](): Promise<void>
}

/**
 * Options for stopping a Postgres data directory by reading `postmaster.pid`.
 */
export interface StopPostgresDataDirOptions {
  /** Actual Postgres cluster directory that contains `postmaster.pid`. */
  dataDir: string
  /**
   * Stop only when `postmaster.pid` still identifies this process. This keeps
   * delayed cleanup jobs from stopping a newer server that reused the directory.
   */
  expectedPid?: number
  /** Listen configuration used when waiting for idle connections. */
  listen?: PostgresListenOptions
  /** PostgreSQL shutdown mode. Defaults to `fast`. */
  mode?: 'smart' | 'fast' | 'immediate'
  /** Wait for client connections to fall below a threshold before signaling. */
  waitForIdle?:
    | boolean
    | {
        /** Database checked for active connections. */
        database?: string
        /** Connection count threshold that is considered idle. Defaults to `0`. */
        minConnections?: number
        /** Maximum time to wait for idle connections. */
        timeoutMs?: number
        /** Delay between idle-connection checks. */
        intervalMs?: number
      }
  /** Maximum time to wait after signaling Postgres to stop. */
  timeoutMs?: number
  /** Optional lifecycle logger. Missing methods are treated as no-ops. */
  logger?: Partial<LocalPostgresLogger>
}

/**
 * Options for waiting until Postgres accepts client connections.
 */
export interface WaitForPostgresReadyOptions {
  /** Listen configuration to connect through. */
  listen: PostgresListenOptions
  /** Database used for readiness probes. Defaults to `postgres`. */
  database?: string
  /** Optional user for readiness probes. */
  user?: string
  /** Optional password for readiness probes. */
  password?: string
  /** Maximum time to wait for readiness. */
  timeoutMs?: number
  /** Delay between readiness checks. */
  intervalMs?: number
}

/**
 * Options for creating a database when it does not already exist.
 */
export interface EnsurePostgresDatabaseOptions {
  /** Listen configuration used to connect to Postgres. */
  listen: PostgresListenOptions
  /** Database to create when missing. */
  database: string
  /** Existing database used for the creation connection. Defaults to `postgres`. */
  bootstrapDatabase?: string
  /** Optional user for the creation connection. */
  user?: string
  /** Optional password for the creation connection. */
  password?: string
}

/**
 * Options for the high-level `startPostgres` lifecycle helper.
 */
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
   * selected before the server starts. Fixed ports are probed before startup.
   */
  port?: number
  /**
   * TCP host for the Postgres server.
   *
   * Defaults to `127.0.0.1`.
   */
  host?: string
  /**
   * Lower-level listen configuration. When omitted, the friendly API starts a
   * TCP server using `host` and `port`. Do not combine this with `host` or
   * `port`.
   */
  listen?: PostgresListenOptions
  /**
   * PostgreSQL configuration values appended after a new cluster is
   * initialized. Existing clusters are left untouched.
   */
  config?: Record<string, PostgresConfigValue>
  /**
   * Superuser role to create or update after the server is ready. When set,
   * returned connection details include this role's credentials.
   */
  superuser?: LocalPostgresSuperuser
  /**
   * Where raw stdout and stderr from the `postgres` server process should go.
   *
   * Defaults to `ignore`. Use `on-error` for quiet successful startup with
   * captured failure diagnostics. File targets create parent directories when
   * needed.
   */
  postgresOutput?: PostgresOutputTarget
  /**
   * Postgres binary resolution behavior. Omit this for local-only PATH based
   * behavior. Provide it to enable version checks and managed downloads.
   */
  postgres?: PostgresBinaryOptions
  /**
   * Optional lifecycle logger. Missing methods are treated as no-ops.
   */
  logger?: Partial<LocalPostgresLogger>
  /**
   * Maximum time to wait for Postgres to accept bootstrap connections.
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

/**
 * Environment values for clients and child processes that should connect to the server.
 */
export interface LocalPostgresEnv {
  /** Data directory used by the server. */
  PGDATA: string
  /** Database exposed by the returned connection details. */
  PGDATABASE: string
  /** TCP host or Unix socket directory used by clients. */
  PGHOST: string
  /** Server port formatted for environment variables. */
  PGPORT: string
  /** PostgreSQL connection URL for the returned server. */
  DATABASE_URL: string
  /** Superuser name when `superuser` was provided. */
  PGUSER?: string
  /** Superuser password when `superuser` was provided. */
  PGPASSWORD?: string
}

/**
 * Running server returned by `startPostgres`.
 */
export interface LocalPostgresServer {
  /** Data directory passed to `startPostgres`. */
  dataDir: string
  /** Database exposed to callers. */
  database: string
  /** Normalized listen configuration used by the server. */
  listen: ResolvedPostgresListenOptions
  /** Client host, or socket directory in socket mode. */
  host: string
  /** Server port. */
  port: number
  /** Socket directory when the server is listening on a Unix socket. */
  socketDir?: string
  /** Superuser name when `superuser` was provided. */
  user?: string
  /** Superuser password when `superuser` was provided. */
  password?: string
  /** Child process id reported by Node.js when available. */
  pid?: number
  /** PostgreSQL connection URL with database and optional credentials encoded. */
  connectionString: string
  /** Environment values for clients and child processes. */
  env: LocalPostgresEnv
  /** Stops the server process. Safe to call more than once. */
  stop(): Promise<void>
  /** Supports `await using` by delegating to `stop()`. */
  [Symbol.asyncDispose](): Promise<void>
}

/**
 * Error type used for operational failures reported by `local-postgres`.
 */
export class LocalPostgresError extends Error {
  /** Bounded Postgres process output captured while an operation was failing. */
  readonly diagnostics?: string

  constructor(message: string, options?: ErrorOptions & { diagnostics?: string }) {
    super(
      options?.diagnostics
        ? `${message}\n\nPostgres diagnostics:\n${options.diagnostics}`
        : message,
      options,
    )
    this.name = 'LocalPostgresError'
    this.diagnostics = options?.diagnostics
  }
}

/**
 * Indicates that a data directory's `postmaster.pid` belongs to a live process.
 */
export class PostgresDataDirInUseError extends LocalPostgresError {
  readonly dataDir: string
  readonly pid: number

  constructor(dataDir: string, pid: number) {
    super(`Postgres data directory "${dataDir}" is already in use by process ${pid}.`)
    this.name = 'PostgresDataDirInUseError'
    this.dataDir = dataDir
    this.pid = pid
  }
}
