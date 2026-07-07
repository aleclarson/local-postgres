import type { LocalPostgresEnv } from './types'

export function createConnectionString({
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

export function createEnv({
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
