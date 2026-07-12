import { existsSync, mkdirSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { resolvePostgresBinariesForLifecycle } from './binaries'
import { ensurePostgresDatabase, initPostgresDataDir, startPostgresDataDir } from './core'
import { DEFAULT_DATABASE } from './constants'
import { createConnectionString, createEnv } from './connection'
import {
  listenClientHost,
  requireNonEmptyString,
  resolveStartPostgresListenOptions,
} from './listen'
import { ensureSuperuser } from './postgres-client'
import type { LocalPostgresLogger, LocalPostgresServer, StartPostgresOptions } from './types'

/**
 * Starts a local PostgreSQL server and returns connection details.
 *
 * The data directory is created and initialized when needed, the server is
 * started, readiness is verified, optional superuser/database setup is applied,
 * and the returned `stop()` function shuts the process down.
 */
export async function startPostgres(options: StartPostgresOptions): Promise<LocalPostgresServer> {
  const dataDir = requireNonEmptyString(options.dataDir, 'dataDir')
  const database = options.database
    ? requireNonEmptyString(options.database, 'database')
    : DEFAULT_DATABASE
  const bootstrapUser = os.userInfo().username
  const listen = await resolveStartPostgresListenOptions({
    host: options.host,
    listen: options.listen,
    port: options.port,
  })
  const logger = resolveLogger(options.logger)

  mkdirSync(dataDir, { recursive: true })
  const needsInitdb = !existsSync(path.join(dataDir, 'PG_VERSION'))
  const binaries = await resolvePostgresBinariesForLifecycle(options.postgres, {
    logger,
    needsInitdb,
  })

  await initPostgresDataDir({
    // Trust authentication keeps the package local-dev friendly. Callers that
    // need stronger auth can initialize through the core API first.
    auth: 'trust',
    binaries,
    config: options.config,
    dataDir,
    encoding: 'UTF8',
    locale: false,
    postgres: options.postgres,
    username: bootstrapUser,
    logger: options.logger,
  })

  const postgres = await startPostgresDataDir({
    binaries,
    dataDir,
    listen,
    postgresOutput: options.postgresOutput,
    logger: options.logger,
    postgres: options.postgres,
    readinessIntervalMs: options.readinessIntervalMs,
    readinessTimeoutMs: options.readinessTimeoutMs,
    stopTimeoutMs: options.stopTimeoutMs,
  })

  try {
    if (options.superuser) {
      await ensureSuperuser({
        listen,
        user: bootstrapUser,
        superuser: options.superuser,
      })
    }

    if (database !== DEFAULT_DATABASE) {
      await ensurePostgresDatabase({
        database,
        listen,
        user: bootstrapUser,
      })
    }
  } catch (error) {
    await postgres.stop()
    throw error
  }

  const connectionString = createConnectionString({
    database,
    listen,
    user: options.superuser?.name,
    password: options.superuser?.password,
  })
  const env = createEnv({
    connectionString,
    dataDir,
    database,
    listen,
    user: options.superuser?.name,
    password: options.superuser?.password,
  })
  const host = listenClientHost(listen)

  return {
    dataDir,
    database,
    listen,
    host,
    port: listen.port,
    ...(listen.type === 'socket'
      ? {
          socketDir: listen.socketDir,
        }
      : {}),
    user: options.superuser?.name,
    password: options.superuser?.password,
    pid: postgres.pid,
    connectionString,
    env,
    stop: postgres.stop,
    [Symbol.asyncDispose]: postgres.stop,
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
