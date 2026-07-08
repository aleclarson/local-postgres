import * as os from 'node:os'
import * as path from 'node:path'

export const DEFAULT_POSTGRES_CACHE_DIR = path.join(os.homedir(), '.local-postgres')

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

export type PostgresBinaryStrategy =
  | 'local-only'
  | 'prefer-local'
  | 'prefer-download'
  | 'download-only'

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

export interface ResolvedPostgresBinaries {
  initdb: string
  postgres: string
  source: 'local' | 'download'
  version?: string
}

export type PostgresConfigValue = string | number | boolean

export type PostgresListenOptions =
  | {
      type: 'tcp'
      host?: string
      port?: number
    }
  | {
      type: 'socket'
      socketDir: string
      port?: number
    }

export type ResolvedPostgresListenOptions =
  | {
      type: 'tcp'
      host: string
      port: number
    }
  | {
      type: 'socket'
      socketDir: string
      port: number
    }

export interface InitPostgresDataDirOptions {
  /**
   * Actual Postgres cluster directory. This is the directory that contains
   * `PG_VERSION`, not necessarily the caller's outer workspace directory.
   */
  dataDir: string
  binaries?: ResolvedPostgresBinaries
  postgres?: PostgresBinaryOptions
  encoding?: string
  locale?: string | false
  username?: string
  auth?: string
  noSync?: boolean
  config?: Record<string, PostgresConfigValue>
  log?: LocalPostgresLogTarget
  logger?: Partial<LocalPostgresLogger>
}

export interface InitPostgresDataDirResult {
  dataDir: string
  version?: string
}

export interface StartPostgresDataDirOptions {
  /**
   * Actual Postgres cluster directory to start.
   */
  dataDir: string
  binaries?: ResolvedPostgresBinaries
  listen?: PostgresListenOptions
  postgres?: PostgresBinaryOptions
  postgresOptions?: string[]
  log?: LocalPostgresLogTarget
  logger?: Partial<LocalPostgresLogger>
  readinessTimeoutMs?: number
  readinessIntervalMs?: number
  stopTimeoutMs?: number
}

export interface LocalPostgresProcess {
  dataDir: string
  listen: ResolvedPostgresListenOptions
  port: number
  host?: string
  socketDir?: string
  pid?: number
  stop(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export interface StopPostgresDataDirOptions {
  dataDir: string
  listen?: PostgresListenOptions
  mode?: 'smart' | 'fast' | 'immediate'
  waitForIdle?:
    | boolean
    | {
        database?: string
        minConnections?: number
        timeoutMs?: number
        intervalMs?: number
      }
  timeoutMs?: number
  logger?: Partial<LocalPostgresLogger>
}

export interface WaitForPostgresReadyOptions {
  listen: PostgresListenOptions
  database?: string
  user?: string
  password?: string
  timeoutMs?: number
  intervalMs?: number
}

export interface EnsurePostgresDatabaseOptions {
  listen: PostgresListenOptions
  database: string
  bootstrapDatabase?: string
  user?: string
  password?: string
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
   * Lower-level listen configuration. When omitted, the friendly API starts a
   * TCP server using `host` and `port`.
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
   * Where Postgres stdout/stderr should go.
   *
   * Defaults to `ignore`.
   */
  log?: LocalPostgresLogTarget
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
  listen: ResolvedPostgresListenOptions
  host: string
  port: number
  socketDir?: string
  user?: string
  password?: string
  pid?: number
  connectionString: string
  env: LocalPostgresEnv
  stop(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export class LocalPostgresError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalPostgresError'
  }
}
