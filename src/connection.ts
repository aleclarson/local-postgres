import type { LocalPostgresEnv, ResolvedPostgresListenOptions } from './types'

export function createConnectionString({
  database,
  listen,
  user,
  password,
}: {
  database: string
  listen: ResolvedPostgresListenOptions
  user?: string
  password?: string
}) {
  const auth =
    user === undefined ? '' : `${encodeURIComponent(user)}:${encodeURIComponent(password ?? '')}@`

  if (listen.type === 'socket') {
    const params = new URLSearchParams({
      host: listen.socketDir,
      port: String(listen.port),
    })

    return `postgresql://${auth}/${encodeURIComponent(database)}?${params}`
  }

  const hostForUrl =
    listen.host.includes(':') && !listen.host.startsWith('[') ? `[${listen.host}]` : listen.host

  return `postgresql://${auth}${hostForUrl}:${listen.port}/${encodeURIComponent(database)}`
}

export function createEnv({
  dataDir,
  database,
  connectionString,
  listen,
  user,
  password,
}: {
  dataDir: string
  database: string
  connectionString: string
  listen: ResolvedPostgresListenOptions
  user?: string
  password?: string
}): LocalPostgresEnv {
  const host = listen.type === 'socket' ? listen.socketDir : listen.host

  return {
    PGDATA: dataDir,
    PGDATABASE: database,
    PGHOST: host,
    PGPORT: String(listen.port),
    DATABASE_URL: connectionString,
    ...(user === undefined
      ? {}
      : {
          PGUSER: user,
          PGPASSWORD: password ?? '',
        }),
  }
}
