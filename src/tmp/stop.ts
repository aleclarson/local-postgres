import { readFile, rm, stat } from 'node:fs/promises'
import * as path from 'node:path'

import { stopPostgresDataDir } from '../core'
import { LocalPostgresError, type LocalPostgresLogger, type PostgresListenOptions } from '../types'

export const DATA_DIR = 'data'
export const OWNER_MARKER = '.local-postgres-tmp'
export const OWNER_MARKER_CONTENT = 'local-postgres/tmp\n'

export type StopOptions = {
  /** Preserve the temporary container after Postgres stops. Defaults to `false`. */
  keep?: boolean
  /**
   * Seconds to wait between active-connection checks. A non-positive value
   * stops immediately. Defaults to `5`.
   */
  timeout?: number
  /** Seconds to wait before the first active-connection check. Defaults to `0`. */
  initialTimeout?: number
  /** Stop without waiting for active connections to finish. */
  force?: boolean
  /** TCP host used by a server started with `host`. */
  host?: string
  /** TCP port used by a server started with `host`. */
  port?: number
  /** Retained for compatibility with `@pg-nano/pg-tmp`. */
  stdio?: import('node:child_process').StdioOptions
  /** Print lifecycle messages while waiting, stopping, and removing files. */
  verbose?: boolean
}

export async function stopTemporaryPostgres(
  rootDir: string,
  options: StopOptions = {},
  expectedPid?: number,
): Promise<void> {
  const dataDir = path.join(rootDir, DATA_DIR)

  if (!(await fileStat(dataDir))?.isDirectory()) {
    throw new Error('Please specify a valid temporary PostgreSQL container directory.')
  }

  const {
    force = false,
    host,
    initialTimeout = 0,
    keep = false,
    port,
    timeout = 5,
    verbose = false,
  } = options

  if (!keep) {
    await assertOwnedContainer(rootDir)
  }

  // A detached timer belongs to one server generation. If the server was
  // stopped or the container was restarted, that timer must not affect the
  // newer lifecycle or undo an explicit `keep` choice.
  if (expectedPid !== undefined && (await readPostmasterPid(dataDir)) !== expectedPid) {
    return
  }

  const listen: PostgresListenOptions = host
    ? { type: 'tcp', host, port }
    : { type: 'socket', socketDir: dataDir }
  const logger = verbose ? consoleLogger : undefined

  if (!force && timeout > 0) {
    if (initialTimeout > 0) {
      await delay(initialTimeout * 1_000)
    }

    if (verbose) {
      console.log('waiting for active connections to finish')
    }

    for (let attempts = 0; ; attempts++) {
      try {
        await stopPostgresDataDir({
          dataDir,
          expectedPid,
          listen,
          waitForIdle: {
            database: 'test',
            timeoutMs: attempts === 0 ? 0 : timeout * 1_000,
          },
          logger,
        })
        break
      } catch (error) {
        if (!isIdleTimeout(error)) {
          throw error
        }
      }

      if (expectedPid !== undefined && (await readPostmasterPid(dataDir)) !== expectedPid) return
    }
  } else {
    if (verbose) {
      console.log('stopping postgres...')
    }
    await stopPostgresDataDir({ dataDir, expectedPid, listen, logger })
  }

  const remainingPid = await readPostmasterPid(dataDir)
  if (expectedPid !== undefined && remainingPid !== undefined && remainingPid !== expectedPid)
    return

  if (!keep) {
    if (verbose) {
      console.log('removing temporary container...')
    }
    await rm(rootDir, { force: true, maxRetries: 3, recursive: true })
  }
}

async function assertOwnedContainer(rootDir: string) {
  const marker = path.join(rootDir, OWNER_MARKER)
  const [content, markerStat] = await Promise.all([
    readFile(marker, 'utf8').catch(() => ''),
    fileStat(marker),
  ])

  if (
    content !== OWNER_MARKER_CONTENT ||
    !markerStat ||
    (process.getuid && markerStat.uid !== process.getuid())
  ) {
    throw new Error(
      `Refusing to remove temporary container without an owned ${OWNER_MARKER} marker: ${rootDir}`,
    )
  }
}

async function readPostmasterPid(dataDir: string) {
  const value = await readFile(path.join(dataDir, 'postmaster.pid'), 'utf8').catch(() => '')
  const pid = Number.parseInt(value.split(/\r?\n/, 1)[0] ?? '', 10)
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

async function fileStat(filePath: string) {
  return stat(filePath).catch(() => undefined)
}

function isIdleTimeout(error: unknown) {
  return (
    error instanceof LocalPostgresError &&
    error.message.includes('waiting for Postgres connections to become idle')
  )
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

const consoleLogger: LocalPostgresLogger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
}
