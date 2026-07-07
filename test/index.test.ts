import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'

type ExecFileResult = {
  error?: Error
  stdout?: string
  stderr?: string
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

type ExecFileHandler = (command: string, args: string[]) => ExecFileResult

type QueryResult = {
  rowCount: number
  rows?: unknown[]
}

type QueryHandler = (
  sql: string,
  values: unknown[] | undefined,
) => QueryResult | Promise<QueryResult>

class FakeChildProcess extends EventEmitter {
  pid = 12_345
  signals: Array<NodeJS.Signals | number | undefined> = []

  kill(signal?: NodeJS.Signals | number) {
    this.signals.push(signal)
    queueMicrotask(() => {
      this.emit('exit', 0, typeof signal === 'string' ? signal : null)
    })
    return true
  }
}

class FakeNetServer extends EventEmitter {
  listenPort = 0
  pickedPort: number
  listenError?: Error

  constructor({ pickedPort, listenError }: { pickedPort: number; listenError?: Error }) {
    super()
    this.pickedPort = pickedPort
    this.listenError = listenError
  }

  unref() {
    return this
  }

  listen(port: number, _host: string, callback: () => void) {
    if (this.listenError) {
      this.emit('error', this.listenError)
      return this
    }

    this.listenPort = port === 0 ? this.pickedPort : port
    callback()
    return this
  }

  address() {
    return {
      address: '127.0.0.1',
      family: 'IPv4',
      port: this.listenPort,
    }
  }

  close(callback?: (error?: Error) => void) {
    callback?.()
    return this
  }
}

const tempDirs: string[] = []

async function tempPath() {
  const path = await mkdtemp(join(tmpdir(), 'local-postgres-test-'))
  tempDirs.push(path)
  return path
}

async function loadSubject({
  execFile = defaultExecFile,
  fetch,
  homeDir = '/Users/tester',
  pickedPort = 55_432,
  pgQuery = defaultQuery,
  platform = 'darwin',
  arch = 'arm64',
  listenError,
}: {
  execFile?: ExecFileHandler
  fetch?: (url: string) => Response | Promise<Response>
  homeDir?: string
  pickedPort?: number
  pgQuery?: QueryHandler
  platform?: NodeJS.Platform
  arch?: string
  listenError?: Error
} = {}) {
  vi.resetModules()

  const child = new FakeChildProcess()
  const netServers: FakeNetServer[] = []
  const pgQueries: Array<{ sql: string; values?: unknown[] }> = []

  const execFileMock = vi.fn(
    (command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      const result = execFile(command, args)
      callback(result.error ?? null, result.stdout ?? '', result.stderr ?? '')
    },
  )
  const spawnMock = vi.fn((_command: string, _args: string[], _options: unknown) => child)
  const createServerMock = vi.fn(() => {
    const server = new FakeNetServer({ pickedPort, listenError })
    netServers.push(server)
    return server
  })
  const unpackTarMock = vi.fn((directoryPath: string) => {
    return new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
      final(callback) {
        void (async () => {
          const binDir = join(directoryPath, 'native', 'bin')
          await mkdir(binDir, { recursive: true })
          await writeFile(join(binDir, 'initdb'), '')
          await writeFile(join(binDir, 'postgres'), '')
        })().then(
          () => callback(),
          (error: Error) => callback(error),
        )
      },
    })
  })
  const fetchMock = vi.fn(async (url: string) => {
    if (!fetch) {
      throw new Error(`Unexpected fetch: ${url}`)
    }
    return fetch(url)
  })

  class FakePgClient {
    async connect() {}

    async query(sql: string, values?: unknown[]) {
      pgQueries.push({ sql, values })
      return pgQuery(sql, values)
    }

    async end() {}
  }

  vi.doMock('node:child_process', () => ({
    execFile: execFileMock,
    spawn: spawnMock,
  }))
  vi.doMock('node:net', () => ({
    createServer: createServerMock,
  }))
  vi.doMock('node:os', () => ({
    arch: () => arch,
    homedir: () => homeDir,
    platform: () => platform,
    userInfo: () => ({ username: 'test_user' }),
  }))
  vi.doMock('pg', () => ({
    Client: FakePgClient,
  }))
  vi.doMock('modern-tar/fs', () => ({
    unpackTar: unpackTarMock,
  }))
  vi.doMock('node:zlib', () => ({
    createGunzip: () => new PassThrough(),
  }))
  vi.stubGlobal('fetch', fetchMock)

  const subject = await import('../src/index')

  return {
    child,
    execFileMock,
    fetchMock,
    netServers,
    pgQueries,
    spawnMock,
    startPostgres: subject.startPostgres,
    DEFAULT_POSTGRES_CACHE_DIR: subject.DEFAULT_POSTGRES_CACHE_DIR,
    unpackTarMock,
  }
}

afterEach(async () => {
  vi.doUnmock('node:child_process')
  vi.doUnmock('node:net')
  vi.doUnmock('node:os')
  vi.doUnmock('node:zlib')
  vi.doUnmock('modern-tar/fs')
  vi.doUnmock('pg')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()

  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { force: true, recursive: true })))
})

test('initializes a cluster, starts local postgres, and returns connection details', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  const logFile = join(root, 'postgres.log')
  const { child, execFileMock, pgQueries, spawnMock, startPostgres } = await loadSubject()

  const server = await startPostgres({
    dataDir,
    database: 'app_test',
    port: 54_321,
    superuser: {
      name: 'app',
      password: 'secret',
    },
    log: {
      filePath: logFile,
    },
    stopTimeoutMs: 1,
  })

  expect(execFileMock).toHaveBeenCalledWith(
    'initdb',
    ['-D', dataDir, '-U', 'test_user', '--auth=trust', '--no-locale', '-E', 'UTF8'],
    expect.anything(),
    expect.anything(),
  )
  expect(spawnMock).toHaveBeenCalledWith(
    'postgres',
    ['-D', dataDir, '-h', '127.0.0.1', '-p', '54321'],
    expect.objectContaining({
      stdio: ['ignore', expect.any(Number), expect.any(Number)],
    }),
  )
  expect(pgQueries.map((query) => query.sql)).toEqual([
    'SELECT 1',
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    'CREATE ROLE "app" WITH LOGIN SUPERUSER PASSWORD \'secret\'',
    'SELECT 1 FROM pg_database WHERE datname = $1',
    'CREATE DATABASE "app_test"',
  ])
  expect(server).toMatchObject({
    dataDir,
    database: 'app_test',
    host: '127.0.0.1',
    port: 54_321,
    user: 'app',
    password: 'secret',
    pid: 12_345,
    connectionString: 'postgresql://app:secret@127.0.0.1:54321/app_test',
    env: {
      DATABASE_URL: 'postgresql://app:secret@127.0.0.1:54321/app_test',
      PGDATA: dataDir,
      PGDATABASE: 'app_test',
      PGHOST: '127.0.0.1',
      PGPASSWORD: 'secret',
      PGPORT: '54321',
      PGUSER: 'app',
    },
  })

  await server.stop()

  expect(child.signals).toEqual(['SIGINT'])
})

test('picks an available port when no port is provided', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const { netServers, spawnMock, startPostgres } = await loadSubject({
    pickedPort: 56_789,
  })

  const server = await startPostgres({
    dataDir,
    database: 'app',
    stopTimeoutMs: 1,
  })

  expect(netServers[0]?.listenPort).toBe(56_789)
  expect(spawnMock.mock.calls[0]?.[1]).toEqual(['-D', dataDir, '-h', '127.0.0.1', '-p', '56789'])
  expect(server.port).toBe(56_789)

  await server.stop()
})

test('reuses an initialized cluster and existing database', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const { execFileMock, pgQueries, startPostgres } = await loadSubject({
    pgQuery: (sql) => {
      if (sql === 'SELECT 1 FROM pg_database WHERE datname = $1') {
        return { rowCount: 1 }
      }
      return defaultQuery(sql)
    },
  })

  const server = await startPostgres({
    dataDir,
    database: 'app',
    port: 54_321,
    stopTimeoutMs: 1,
  })

  expect(execFileMock).not.toHaveBeenCalled()
  expect(pgQueries.map((query) => query.sql)).toEqual([
    'SELECT 1',
    'SELECT 1 FROM pg_database WHERE datname = $1',
  ])

  await server.stop()
})

test('rejects before spawning when the requested port is unavailable', async () => {
  const listenError = Object.assign(new Error('listen EADDRINUSE'), {
    code: 'EADDRINUSE',
  })
  const { execFileMock, spawnMock, startPostgres } = await loadSubject({
    listenError,
  })

  await expect(
    startPostgres({
      dataDir: join(await tempPath(), 'data'),
      port: 54_321,
    }),
  ).rejects.toThrow('Port 54321 is not available on 127.0.0.1')

  expect(execFileMock).not.toHaveBeenCalled()
  expect(spawnMock).not.toHaveBeenCalled()
})

test('uses local binaries when they satisfy the requested version', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const { execFileMock, fetchMock, spawnMock, startPostgres } = await loadSubject()

  const server = await startPostgres({
    dataDir,
    database: 'app',
    port: 54_321,
    postgres: {
      version: '18',
    },
    stopTimeoutMs: 1,
  })

  expect(execFileMock.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ['postgres', ['--version']],
  ])
  expect(fetchMock).not.toHaveBeenCalled()
  expect(spawnMock.mock.calls[0]?.[0]).toBe('postgres')

  await server.stop()
})

test('rejects an initialized data directory from another Postgres major version', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '15')

  const { spawnMock, startPostgres } = await loadSubject()

  await expect(
    startPostgres({
      dataDir,
      database: 'app',
      port: 54_321,
      postgres: {
        version: '18',
      },
      stopTimeoutMs: 1,
    }),
  ).rejects.toThrow('data directory was initialized with version 15')

  expect(spawnMock).not.toHaveBeenCalled()
})

test('downloads embedded postgres when local binaries are the wrong version', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  const cacheDir = join(root, 'cache')
  const tarball = Buffer.from('fake embedded postgres package')
  const tarballResponse = new Response(tarball)
  const arrayBufferMock = vi.spyOn(tarballResponse, 'arrayBuffer')
  const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const {
    DEFAULT_POSTGRES_CACHE_DIR,
    execFileMock,
    fetchMock,
    spawnMock,
    startPostgres,
    unpackTarMock,
  } = await loadSubject({
    execFile: (command, args) => {
      if (command === 'postgres' && args[0] === '--version') {
        return { stdout: 'postgres (PostgreSQL) 15.0' }
      }
      return defaultExecFile(command, args)
    },
    fetch: async (url) => {
      if (url === 'https://registry.npmjs.org/@embedded-postgres%2fdarwin-arm64') {
        return Response.json({
          'dist-tags': {
            latest: '18.4.0-beta.17',
          },
          versions: {
            '18.4.0-beta.17': {
              dist: {
                integrity,
                tarball: 'https://registry.npmjs.org/fake.tgz',
              },
            },
          },
        })
      }

      if (url === 'https://registry.npmjs.org/fake.tgz') {
        return tarballResponse
      }

      throw new Error(`Unexpected fetch: ${url}`)
    },
    homeDir: root,
  })

  expect(DEFAULT_POSTGRES_CACHE_DIR).toBe(join(root, '.local-postgres'))

  const server = await startPostgres({
    dataDir,
    database: 'app',
    port: 54_321,
    postgres: {
      cacheDir,
      version: '18',
    },
    stopTimeoutMs: 1,
  })

  const packageDir = join(cacheDir, 'embedded-postgres', 'darwin-arm64', '18.4.0-beta.17')
  expect(execFileMock.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ['postgres', ['--version']],
  ])
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    'https://registry.npmjs.org/@embedded-postgres%2fdarwin-arm64',
    'https://registry.npmjs.org/fake.tgz',
  ])
  expect(arrayBufferMock).not.toHaveBeenCalled()
  expect(unpackTarMock).toHaveBeenCalledWith(expect.any(String), { strip: 1 })
  expect(existsSync(join(packageDir, '.local-postgres-installed'))).toBe(true)
  expect(spawnMock.mock.calls[0]?.[0]).toBe(join(packageDir, 'native', 'bin', 'postgres'))

  await server.stop()
})

test('rejects managed downloads before extraction when integrity verification fails', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  const cacheDir = join(root, 'cache')
  const tarball = Buffer.from('fake embedded postgres package')
  const integrity = `sha512-${createHash('sha512').update('different tarball').digest('base64')}`
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const { spawnMock, startPostgres, unpackTarMock } = await loadSubject({
    execFile: (command, args) => {
      if (command === 'postgres' && args[0] === '--version') {
        return { stdout: 'postgres (PostgreSQL) 15.0' }
      }
      return defaultExecFile(command, args)
    },
    fetch: async (url) => {
      if (url === 'https://registry.npmjs.org/@embedded-postgres%2fdarwin-arm64') {
        return Response.json({
          'dist-tags': {
            latest: '18.4.0-beta.17',
          },
          versions: {
            '18.4.0-beta.17': {
              dist: {
                integrity,
                tarball: 'https://registry.npmjs.org/fake.tgz',
              },
            },
          },
        })
      }

      if (url === 'https://registry.npmjs.org/fake.tgz') {
        return new Response(tarball)
      }

      throw new Error(`Unexpected fetch: ${url}`)
    },
    homeDir: root,
  })

  await expect(
    startPostgres({
      dataDir,
      database: 'app',
      port: 54_321,
      postgres: {
        cacheDir,
        version: '18',
      },
      stopTimeoutMs: 1,
    }),
  ).rejects.toThrow('Integrity check failed for @embedded-postgres/darwin-arm64@18.4.0-beta.17')

  expect(unpackTarMock).not.toHaveBeenCalled()
  expect(spawnMock).not.toHaveBeenCalled()
})

function defaultExecFile(command: string, args: string[]): ExecFileResult {
  if (args[0] === '--version' && command.includes('postgres')) {
    return { stdout: 'postgres (PostgreSQL) 18.4' }
  }

  if (args[0] === '--version' && command.includes('initdb')) {
    return { stdout: 'initdb (PostgreSQL) 18.4' }
  }

  return {}
}

function defaultQuery(sql: string): QueryResult {
  if (sql === 'SELECT 1') {
    return { rowCount: 1, rows: [{}] }
  }

  if (
    sql === 'SELECT 1 FROM pg_roles WHERE rolname = $1' ||
    sql === 'SELECT 1 FROM pg_database WHERE datname = $1'
  ) {
    return { rowCount: 0, rows: [] }
  }

  return { rowCount: 0, rows: [] }
}
