import { Client } from 'pg'

import { DEFAULT_DATABASE } from './constants'
import { delay, type ExitResult } from './process'
import { LocalPostgresError, type LocalPostgresSuperuser } from './types'

export async function waitForReady({
  host,
  port,
  user,
  getSpawnError,
  getExitResult,
  timeoutMs,
  intervalMs,
}: {
  host: string
  port: number
  user: string
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
      await withBootstrapClient({ host, port, user }, async (client) => {
        await client.query('SELECT 1')
      })
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

export async function ensureSuperuser({
  host,
  port,
  user,
  superuser,
}: {
  host: string
  port: number
  user: string
  superuser: LocalPostgresSuperuser
}) {
  const roleName = escapeIdent(superuser.name)
  const rolePassword = escapeLiteral(superuser.password)

  try {
    await withBootstrapClient({ host, port, user }, async (client) => {
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
  host,
  port,
  user,
  database,
}: {
  host: string
  port: number
  user: string
  database: string
}) {
  try {
    await withBootstrapClient({ host, port, user }, async (client) => {
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

async function withBootstrapClient<T>(
  {
    host,
    port,
    user,
  }: {
    host: string
    port: number
    user: string
  },
  callback: (client: Client) => Promise<T>,
) {
  const client = new Client({
    database: DEFAULT_DATABASE,
    host,
    port,
    user,
  })

  await client.connect()
  try {
    return await callback(client)
  } finally {
    await client.end()
  }
}

function escapeIdent(value: string) {
  return `"${value.replace(/"/g, '""')}"`
}

function escapeLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}
