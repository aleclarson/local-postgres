import type { StdioOptions } from 'node:child_process'
import { rename, readdir, readFile, rm, stat, writeFile, mkdtemp } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  ensurePostgresDatabase,
  initPostgresDataDir,
  resolvePostgresBinaries,
  startPostgresDataDir,
} from './core'
import type {
  PostgresBinaryOptions,
  PostgresListenOptions,
  ResolvedPostgresBinaries,
} from './types'
import {
  DATA_DIR,
  OWNER_MARKER,
  OWNER_MARKER_CONTENT,
  stopTemporaryPostgres,
  type StopOptions,
} from './tmp/stop'
import { spawnWorker } from './tmp/worker'

export type { StopOptions } from './tmp/stop'

const OS_TMP = os.tmpdir()
const NEW_MARKER = 'NEW'
const CLAIMED_MARKER = 'CLAIMED'

/** Prefix used for temporary container directories created under `os.tmpdir()`. */
export const PREFIX = 'pg_tmp.'

/** Options for `initdb()`. */
export type InitOptions = {
  /** Binary resolution behavior. */
  postgres?: PostgresBinaryOptions
  /** Only `'inherit'` is honored; other values keep successful initialization quiet. */
  stdio?: StdioOptions
}

/**
 * Initializes a temporary PostgreSQL container.
 *
 * The returned path is the outer container. The actual cluster is stored in
 * its `data` child directory and can later be claimed by `start()`.
 */
export async function initdb(dataDir?: string | null, options: InitOptions = {}): Promise<string> {
  const rootDir = dataDir || (await mkdtemp(path.join(OS_TMP, PREFIX)))
  const dataPath = path.join(rootDir, DATA_DIR)

  if (await readDataDirectoryVersion(rootDir)) {
    throw new Error(`PostgreSQL data directory is already initialized: ${dataPath}`)
  }

  await initializeDataDirectory(rootDir, options)
  return rootDir
}

/** Options for `start()`. */
export type StartOptions = {
  /** Temporary container root. When omitted, a prewarmed container may be claimed. */
  dataDir?: string
  /** Use TCP when true or a host string is provided. Unix sockets are the default. */
  host?: string | boolean
  /** TCP port. An available port is selected when omitted. */
  port?: number
  /** Seconds before a detached worker stops the server. Defaults to `60`; non-positive disables it. */
  timeout?: number
  /** Preserve the container when the detached worker or returned handle stops it. */
  keep?: boolean
  /** Initialize another container in the background after claiming one. Defaults to `true`. */
  prewarm?: boolean
  /** Binary resolution behavior, including opt-in managed Postgres downloads. */
  postgres?: PostgresBinaryOptions
  /** Additional command-line options passed to `postgres`. */
  postgresOptions?: string
}

/** Running temporary PostgreSQL server returned by `start()`. */
export type PgTmp = {
  /** Connection string for the `test` database. */
  dsn: string
  /** Temporary container root. The actual cluster is in `dataDir/data`. */
  dataDir: string
  /** Stops Postgres and removes the container unless `keep` is true. */
  stop(options?: StopOptions): Promise<void>
  /** Stops Postgres and applies the configured cleanup policy. */
  [Symbol.asyncDispose](): Promise<void>
}

/**
 * Starts an isolated temporary PostgreSQL server and ensures a `test` database.
 */
export async function start(options: StartOptions = {}): Promise<PgTmp> {
  const binaries = await resolvePostgresBinaries(options.postgres)
  if (!binaries.version) {
    throw new Error('Resolved Postgres binaries did not report a version.')
  }
  const dataVersion = postgresDataVersion(binaries.version)
  const suppliedDataDir = options.dataDir !== undefined
  let rootDir = options.dataDir

  if (!rootDir) {
    rootDir = await claimPrewarmedContainer(dataVersion)
    if (!rootDir) {
      rootDir = await initdb(undefined, { postgres: options.postgres })
      await claimContainer(rootDir)
    }
  } else {
    const existingVersion = await readDataDirectoryVersion(rootDir)
    if (existingVersion && existingVersion !== dataVersion) {
      throw new Error(
        `PostgreSQL data directory version ${existingVersion} does not match server version ${dataVersion}`,
      )
    }
    if (!existingVersion) {
      await initializeDataDirectory(rootDir, { postgres: options.postgres }, binaries)
    } else {
      await markOwned(rootDir)
    }
    await claimContainer(rootDir)
  }

  const dataDir = path.join(rootDir, DATA_DIR)
  const host = options.host === true ? '127.0.0.1' : options.host || undefined
  const listen: PostgresListenOptions = host
    ? { type: 'tcp', host, port: options.port }
    : { type: 'socket', socketDir: dataDir }
  const server = await startPostgresDataDir({
    binaries,
    dataDir,
    listen,
    postgresOptions: splitPostgresOptions(options.postgresOptions ?? ''),
    postgresOutput: { filePath: path.join(dataDir, 'postgres.log') },
  })

  try {
    await ensurePostgresDatabase({ listen: server.listen, database: 'test' })
  } catch (error) {
    await server.stop()
    if (!options.keep) {
      await rm(rootDir, { force: true, recursive: true })
    }
    throw error
  }

  if (!suppliedDataDir && options.prewarm !== false) {
    await startPrewarmWorker(options.postgres)
  }

  const timeout = options.timeout ?? 60
  if (timeout > 0) {
    try {
      spawnWorker(
        workerUrl('stop-worker'),
        {
          dataDir: rootDir,
          expectedPid: server.pid,
          options: {
            host: server.host,
            port: server.port,
            keep: options.keep,
            timeout,
            initialTimeout: timeout,
            verbose: true,
          } satisfies StopOptions,
        },
        path.join(rootDir, 'stop.log'),
      ).once('error', () => {})
    } catch (error) {
      await server.stop()
      if (!options.keep) {
        await rm(rootDir, { force: true, recursive: true })
      }
      throw new Error('Failed to schedule temporary Postgres cleanup.', { cause: error })
    }
  }

  let stopPromise: Promise<void> | undefined
  const stop = (stopOptions?: StopOptions) => {
    stopPromise ??= stopTemporaryPostgres(rootDir, {
      host: server.host,
      port: server.port,
      keep: options.keep,
      ...stopOptions,
    })
    return stopPromise
  }

  return {
    dsn:
      server.listen.type === 'tcp'
        ? `postgresql://${server.listen.host}:${server.listen.port}/test`
        : `postgresql:///test?host=${encodeURIComponent(dataDir)}`,
    dataDir: rootDir,
    stop,
    [Symbol.asyncDispose]: stop,
  }
}

/** Stops a server created by `start()` and removes its temporary container by default. */
export async function stop(dataDir: string, options: StopOptions = {}): Promise<void> {
  await stopTemporaryPostgres(dataDir, options)
}

async function initializeDataDirectory(
  rootDir: string,
  options: InitOptions,
  binaries?: ResolvedPostgresBinaries,
) {
  const dataDir = path.join(rootDir, DATA_DIR)
  await initPostgresDataDir({
    auth: 'trust',
    binaries,
    config: {
      unix_socket_directories: dataDir,
      listen_addresses: '',
      shared_buffers: '12MB',
      fsync: false,
      synchronous_commit: false,
      full_page_writes: false,
      log_min_duration_statement: 0,
      log_connections: true,
      log_disconnections: true,
    },
    dataDir,
    encoding: 'UNICODE',
    initdbOutput: options.stdio === 'inherit' ? 'inherit' : undefined,
    noSync: true,
    postgres: options.postgres,
  })
  await markOwned(rootDir)
  await writeFile(path.join(rootDir, NEW_MARKER), '')
}

async function claimPrewarmedContainer(version: string) {
  const entries = await readdir(OS_TMP, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(PREFIX)) continue
    const rootDir = path.join(OS_TMP, entry.name)
    if ((await readDataDirectoryVersion(rootDir)) !== version) continue
    if (!(await isOwnedMarker(path.join(rootDir, NEW_MARKER)))) continue

    try {
      // Renaming one source marker is atomic: only one concurrent start wins.
      await rename(path.join(rootDir, NEW_MARKER), path.join(rootDir, CLAIMED_MARKER))
      return rootDir
    } catch (error) {
      if (!isNotFoundError(error)) throw error
    }
  }
  return undefined
}

async function claimContainer(rootDir: string) {
  try {
    await rename(path.join(rootDir, NEW_MARKER), path.join(rootDir, CLAIMED_MARKER))
  } catch (error) {
    if (!isNotFoundError(error)) throw error
    await writeFile(path.join(rootDir, CLAIMED_MARKER), '', { flag: 'wx' }).catch((claimError) => {
      if (!isAlreadyExistsError(claimError)) throw claimError
    })
  }
}

async function startPrewarmWorker(postgres?: PostgresBinaryOptions) {
  let rootDir: string | undefined
  try {
    rootDir = await mkdtemp(path.join(OS_TMP, PREFIX))
    const createdRoot = rootDir
    const child = spawnWorker(
      workerUrl('init-worker'),
      { dataDir: createdRoot, postgres },
      path.join(createdRoot, 'initdb.log'),
    )
    child.once('error', () => {
      void rm(createdRoot, { force: true, recursive: true })
    })
  } catch {
    // Prewarming is speculative and must not fail an otherwise ready server.
    if (rootDir) {
      await rm(rootDir, { force: true, recursive: true })
    }
  }
}

function workerUrl(name: 'init-worker' | 'stop-worker') {
  return new URL(`./tmp/${name}.mjs`, import.meta.url)
}

async function markOwned(rootDir: string) {
  await writeFile(path.join(rootDir, OWNER_MARKER), OWNER_MARKER_CONTENT)
}

async function isOwnedMarker(filePath: string) {
  const markerStat = await stat(filePath).catch(() => undefined)
  return Boolean(markerStat && (!process.getuid || markerStat.uid === process.getuid()))
}

async function readDataDirectoryVersion(rootDir: string) {
  return readFile(path.join(rootDir, DATA_DIR, 'PG_VERSION'), 'utf8').then(
    (version) => version.trim(),
    () => undefined,
  )
}

function postgresDataVersion(version: string) {
  return version.startsWith('9.') ? version.split('.').slice(0, 2).join('.') : version.split('.')[0]
}

function splitPostgresOptions(options: string) {
  const args: string[] = []
  let current = ''
  let quote: string | undefined
  let escaped = false

  for (const char of options.trim()) {
    if (escaped) {
      current += char
      escaped = false
    } else if (char === '\\') {
      escaped = true
    } else if (quote) {
      if (char === quote) quote = undefined
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }

  if (escaped) current += '\\'
  if (quote) throw new Error('Unterminated quote in postgresOptions')
  if (current) args.push(current)
  return args
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
