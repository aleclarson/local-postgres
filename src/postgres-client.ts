import { Client } from 'pg'

import { DEFAULT_DATABASE } from './constants'
import { delay, type ExitResult } from './process'
import {
  LocalPostgresError,
  type LocalPostgresSuperuser,
  type ResolvedPostgresListenOptions,
} from './types'

export async function waitForReady({
  database = DEFAULT_DATABASE,
  listen,
  password,
  user,
  getSpawnError,
  getExitResult,
  timeoutMs,
  intervalMs,
}: {
  database?: string
  listen: ResolvedPostgresListenOptions
  password?: string
  user?: string
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
      await withClient({ database, listen, password, user }, async (client) => {
        await client.query('SELECT 1')
      })
      return
    } catch (error) {
      lastReadinessError = error
    }

    await delay(intervalMs)
  }

  throw new LocalPostgresError(
    `Timed out after ${timeoutMs}ms waiting for Postgres to become ready on ${listenLabel(
      listen,
    )}.`,
    { cause: lastReadinessError },
  )
}

export async function ensureSuperuser({
  listen,
  password,
  user,
  superuser,
}: {
  listen: ResolvedPostgresListenOptions
  password?: string
  user?: string
  superuser: LocalPostgresSuperuser
}) {
  const roleName = escapeIdent(superuser.name)
  const rolePassword = escapeLiteral(superuser.password)

  try {
    await withClient({ database: DEFAULT_DATABASE, listen, password, user }, async (client) => {
      const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
        superuser.name,
      ])

      if (existing.rowCount === 0) {
        await client.query(`CREATE ROLE ${roleName} WITH LOGIN SUPERUSER PASSWORD ${rolePassword}`)
        return
      }

      await client.query(`ALTER ROLE ${roleName} WITH LOGIN SUPERUSER PASSWORD ${rolePassword}`)
    })
  } catch (error) {
    throw new LocalPostgresError(
      `Failed to create or update Postgres superuser "${superuser.name}".`,
      { cause: error },
    )
  }
}

export async function ensureDatabase({
  bootstrapDatabase = DEFAULT_DATABASE,
  user,
  password,
  listen,
  database,
}: {
  bootstrapDatabase?: string
  listen: ResolvedPostgresListenOptions
  password?: string
  user?: string
  database: string
}) {
  try {
    await withClient({ database: bootstrapDatabase, listen, password, user }, async (client) => {
      const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
        database,
      ])

      if (existing.rowCount === 0) {
        await client.query(`CREATE DATABASE ${escapeIdent(database)}`)
      }
    })
  } catch (error) {
    throw new LocalPostgresError(`Failed to create Postgres database "${database}".`, {
      cause: error,
    })
  }
}

export async function waitForIdleConnections({
  database,
  intervalMs,
  listen,
  minConnections,
  password,
  timeoutMs,
  user,
}: {
  database?: string
  intervalMs: number
  listen: ResolvedPostgresListenOptions
  minConnections: number
  password?: string
  timeoutMs: number
  user?: string
}) {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown

  while (Date.now() <= deadline) {
    try {
      const connectionCount = await withClient(
        { database: database ?? DEFAULT_DATABASE, listen, password, user },
        async (client) => {
          const result = database
            ? await client.query(
                `
                  SELECT count(*)::int AS count
                  FROM pg_stat_activity
                  WHERE datname = $1
                    AND pid <> pg_backend_pid()
                `,
                [database],
              )
            : await client.query(`
                SELECT count(*)::int AS count
                FROM pg_stat_activity
                WHERE pid <> pg_backend_pid()
              `)

          return Number((result.rows?.[0] as { count?: unknown } | undefined)?.count ?? 0)
        },
      )

      if (connectionCount <= minConnections) {
        return
      }
    } catch (error) {
      lastError = error
    }

    await delay(intervalMs)
  }

  throw new LocalPostgresError(
    `Timed out after ${timeoutMs}ms waiting for Postgres connections to become idle on ${listenLabel(
      listen,
    )}.`,
    { cause: lastError },
  )
}

async function withClient<T>(
  {
    database,
    listen,
    password,
    user,
  }: {
    database: string
    listen: ResolvedPostgresListenOptions
    password?: string
    user?: string
  },
  callback: (client: Client) => Promise<T>,
) {
  const client = new Client({
    database,
    host: listen.type === 'socket' ? listen.socketDir : listen.host,
    password,
    port: listen.port,
    user,
  })

  await client.connect()
  try {
    return await callback(client)
  } finally {
    await client.end()
  }
}

function listenLabel(listen: ResolvedPostgresListenOptions) {
  if (listen.type === 'socket') {
    return `${listen.socketDir}:${listen.port}`
  }

  return `${listen.host}:${listen.port}`
}

function escapeIdent(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function escapeLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}
