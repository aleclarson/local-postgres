import { createServer } from 'node:net'

import { DEFAULT_HOST } from './constants'
import {
  LocalPostgresError,
  type PostgresListenOptions,
  type ResolvedPostgresListenOptions,
} from './types'

const DEFAULT_POSTGRES_PORT = 5432

export async function resolveListenOptions(
  listen: PostgresListenOptions | undefined,
  {
    checkTcpPort = false,
    tcpPort = 'default',
  }: {
    checkTcpPort?: boolean
    tcpPort?: 'default' | 'findAvailable'
  } = {},
): Promise<ResolvedPostgresListenOptions> {
  if (!listen || listen.type === 'tcp') {
    const host = listen?.host ? requireNonEmptyString(listen.host, 'host') : DEFAULT_HOST
    const port =
      listen?.port === undefined
        ? tcpPort === 'findAvailable'
          ? await findAvailablePort(host)
          : DEFAULT_POSTGRES_PORT
        : checkTcpPort
          ? await assertAvailablePort(host, normalizePort(listen.port))
          : normalizePort(listen.port)

    return {
      type: 'tcp',
      host,
      port,
    }
  }

  return {
    type: 'socket',
    socketDir: requireNonEmptyString(listen.socketDir, 'socketDir'),
    port: listen.port === undefined ? DEFAULT_POSTGRES_PORT : normalizePort(listen.port),
  }
}

export async function resolveStartPostgresListenOptions({
  host,
  listen,
  port,
}: {
  host?: string
  listen?: PostgresListenOptions
  port?: number
}) {
  if (listen && (host !== undefined || port !== undefined)) {
    throw new TypeError('host and port cannot be used when listen is provided.')
  }

  return resolveListenOptions(listen ?? { type: 'tcp', host, port }, {
    checkTcpPort: true,
    tcpPort: 'findAvailable',
  })
}

export function listenClientHost(listen: ResolvedPostgresListenOptions) {
  return listen.type === 'socket' ? listen.socketDir : listen.host
}

export function listenLabel(listen: ResolvedPostgresListenOptions) {
  if (listen.type === 'socket') {
    return `${listen.socketDir}:${listen.port}`
  }

  return `${listen.host}:${listen.port}`
}

export function requireNonEmptyString(value: string, name: string) {
  if (value.trim() === '') {
    throw new TypeError(`${name} must not be empty.`)
  }
  return value
}

export function normalizePort(port: number) {
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
