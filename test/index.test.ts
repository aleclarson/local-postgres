import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
  stdout = new PassThrough()
  stderr = new PassThrough()

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
  packageFiles = {},
}: {
  execFile?: ExecFileHandler
  fetch?: (url: string) => Response | Promise<Response>
  homeDir?: string
  pickedPort?: number
  pgQuery?: QueryHandler
  platform?: NodeJS.Platform
  arch?: string
  listenError?: Error
  packageFiles?: Record<string, string>
} = {}) {
  vi.resetModules()

  const child = new FakeChildProcess()
  const netServers: FakeNetServer[] = []
  const pgClients: unknown[] = []
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
          for (const [filePath, contents] of Object.entries(packageFiles)) {
            const extractedPath = join(directoryPath, filePath)
            await mkdir(dirname(extractedPath), { recursive: true })
            await writeFile(extractedPath, contents)
          }
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
    constructor(config: unknown) {
      pgClients.push(config)
    }

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
  const core = await import('../src/core')

  return {
    child,
    execFileMock,
    fetchMock,
    getPostgresVersion: core.getPostgresVersion,
    initPostgresDataDir: core.initPostgresDataDir,
    netServers,
    pgClients,
    pgQueries,
    spawnMock,
    ensurePostgresDatabase: core.ensurePostgresDatabase,
    startPostgres: subject.startPostgres,
    startPostgresDataDir: core.startPostgresDataDir,
    stopPostgresDataDir: core.stopPostgresDataDir,
    DEFAULT_POSTGRES_CACHE_DIR: subject.DEFAULT_POSTGRES_CACHE_DIR,
    LocalPostgresError: subject.LocalPostgresError,
    PostgresDataDirInUseError: subject.PostgresDataDirInUseError,
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
    postgresOutput: {
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

test('supports explicit resource management with async disposal', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  const { child, startPostgres } = await loadSubject()

  const server = await startPostgres({
    dataDir,
    port: 54_321,
    stopTimeoutMs: 1,
  })

  await server[Symbol.asyncDispose]()

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
    packageFiles: {
      'native/lib/libicudata.77.1.dylib': 'ICU data',
      'native/pg-symlinks.json': JSON.stringify([
        {
          source: 'native/lib/libicudata.77.1.dylib',
          target: 'native/lib/libicudata.77.dylib',
        },
        {
          source: 'native/lib/libicudata.77.1.dylib',
          target: 'native/lib/libicudata.dylib',
        },
      ]),
    },
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
  await expect(readlink(join(packageDir, 'native', 'lib', 'libicudata.77.dylib'))).resolves.toBe(
    'libicudata.77.1.dylib',
  )
  await expect(readlink(join(packageDir, 'native', 'lib', 'libicudata.dylib'))).resolves.toBe(
    'libicudata.77.1.dylib',
  )
  expect(spawnMock.mock.calls[0]?.[0]).toBe(join(packageDir, 'native', 'bin', 'postgres'))

  await server.stop()

  await rm(join(packageDir, 'native', 'lib', 'libicudata.77.dylib'))
  const cachedServer = await startPostgres({
    dataDir,
    database: 'app',
    port: 54_321,
    postgres: {
      cacheDir,
      version: '18',
    },
    stopTimeoutMs: 1,
  })

  await expect(readlink(join(packageDir, 'native', 'lib', 'libicudata.77.dylib'))).resolves.toBe(
    'libicudata.77.1.dylib',
  )
  expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
    'https://registry.npmjs.org/@embedded-postgres%2fdarwin-arm64',
    'https://registry.npmjs.org/fake.tgz',
    'https://registry.npmjs.org/@embedded-postgres%2fdarwin-arm64',
  ])

  await cachedServer.stop()
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

test.each(['../../outside-cache.dylib', 'C:\\Windows\\outside-cache.dylib'])(
  'rejects unsafe path %s in managed package symlink manifests',
  async (unsafeTarget) => {
    const root = await tempPath()
    const dataDir = join(root, 'data')
    const cacheDir = join(root, 'cache')
    const tarball = Buffer.from('fake embedded postgres package')
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'PG_VERSION'), '18')

    const { startPostgres } = await loadSubject({
      execFile: (command, args) => {
        if (command === 'postgres' && args[0] === '--version') {
          return { stdout: 'postgres (PostgreSQL) 15.0' }
        }
        return defaultExecFile(command, args)
      },
      fetch: async (url) => {
        if (url === 'https://registry.npmjs.org/@embedded-postgres%2fdarwin-arm64') {
          return Response.json({
            'dist-tags': { latest: '18.4.0-beta.17' },
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
      packageFiles: {
        'native/lib/libicudata.77.1.dylib': 'ICU data',
        'native/pg-symlinks.json': JSON.stringify([
          {
            source: 'native/lib/libicudata.77.1.dylib',
            target: unsafeTarget,
          },
        ]),
      },
    })

    await expect(
      startPostgres({
        dataDir,
        database: 'app',
        port: 54_321,
        postgres: { cacheDir, version: '18' },
        stopTimeoutMs: 1,
      }),
    ).rejects.toThrow('Unsafe symlink path')

    expect(existsSync(join(root, 'outside-cache.dylib'))).toBe(false)
  },
)

test('core resolves the postgres binary version before a data directory exists', async () => {
  const { execFileMock, getPostgresVersion } = await loadSubject()

  await expect(getPostgresVersion()).resolves.toBe('18.4')

  expect(execFileMock.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ['postgres', ['--version']],
  ])
})

test('core initializes a data directory with config without starting postgres', async () => {
  const root = await tempPath()
  const dataDir = join(root, '17.0')
  const { execFileMock, initPostgresDataDir, spawnMock } = await loadSubject()

  await initPostgresDataDir({
    dataDir,
    noSync: true,
    auth: 'trust',
    encoding: 'UNICODE',
    locale: false,
    config: {
      unix_socket_directories: dataDir,
      listen_addresses: '',
      shared_buffers: '12MB',
      fsync: false,
      log_min_duration_statement: 0,
    },
  })

  expect(execFileMock).toHaveBeenCalledWith(
    'initdb',
    ['-D', dataDir, '-U', 'test_user', '--auth=trust', '--no-locale', '-E', 'UNICODE', '--nosync'],
    expect.anything(),
    expect.anything(),
  )
  expect(await readFile(join(dataDir, 'postgresql.conf'), 'utf8')).toContain(
    [
      '# Appended by local-postgres.',
      `unix_socket_directories = '${dataDir}'`,
      "listen_addresses = ''",
      "shared_buffers = '12MB'",
      'fsync = off',
      'log_min_duration_statement = 0',
    ].join('\n'),
  )
  expect(spawnMock).not.toHaveBeenCalled()
})

test('core starts a data directory in socket mode', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  const socketDir = join(root, '17.0')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const { child, pgClients, spawnMock, startPostgresDataDir } = await loadSubject()

  const server = await startPostgresDataDir({
    dataDir,
    listen: {
      type: 'socket',
      socketDir,
    },
    stopTimeoutMs: 1,
  })

  expect(spawnMock).toHaveBeenCalledWith(
    'postgres',
    ['-D', dataDir, '-k', socketDir, '-h', '', '-p', '5432'],
    expect.anything(),
  )
  expect(pgClients[0]).toMatchObject({
    database: 'postgres',
    host: socketDir,
    port: 5432,
    user: 'test_user',
  })
  expect(server).toMatchObject({
    dataDir,
    listen: {
      type: 'socket',
      socketDir,
      port: 5432,
    },
    port: 5432,
    socketDir,
    pid: 12_345,
  })

  await server.stop()

  expect(child.signals).toEqual(['SIGINT'])
})

test('captures Postgres output without emitting it when startup succeeds', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const { child, spawnMock, startPostgresDataDir } = await loadSubject()
  const startup = startPostgresDataDir({
    dataDir,
    postgresOutput: 'on-error',
    stopTimeoutMs: 1,
  })

  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
  child.stderr.write('normal startup detail\n')
  const server = await startup

  expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  await server.stop()
})

test('streams Postgres stdout and stderr without taking ownership of the target', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const output = new PassThrough()
  const chunks: Buffer[] = []
  output.on('data', (chunk: Buffer) => chunks.push(chunk))
  const endSpy = vi.spyOn(output, 'end')
  const destroySpy = vi.spyOn(output, 'destroy')
  const { child, spawnMock, startPostgresDataDir } = await loadSubject()
  const startup = startPostgresDataDir({
    dataDir,
    postgresOutput: output,
    stopTimeoutMs: 1,
  })

  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
  child.stdout.write('server stdout\n')
  child.stderr.write('server stderr\n')
  const server = await startup
  child.stderr.write('after readiness\n')
  await server.stop()

  expect(Buffer.concat(chunks).toString('utf8')).toBe(
    'server stdout\nserver stderr\nafter readiness\n',
  )
  expect(endSpy).not.toHaveBeenCalled()
  expect(destroySpy).not.toHaveBeenCalled()
})

test('includes bounded Postgres diagnostics when the process exits before readiness', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const { child, LocalPostgresError, spawnMock, startPostgresDataDir } = await loadSubject({
    pgQuery: () => {
      throw new Error('not ready')
    },
  })
  const startup = startPostgresDataDir({
    dataDir,
    postgresOutput: 'on-error',
    readinessIntervalMs: 0,
    stopTimeoutMs: 1,
  })

  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
  child.stdout.write('x'.repeat(70 * 1024))
  child.stderr.write('FATAL: lock file "postmaster.pid" already exists\n')
  child.emit('exit', 1, null)

  const error = await startup.catch((error: unknown) => error)
  expect(error).toBeInstanceOf(LocalPostgresError)
  if (!(error instanceof LocalPostgresError)) throw error
  expect(error).toMatchObject({
    diagnostics: expect.stringContaining('FATAL: lock file "postmaster.pid" already exists'),
  })
  expect(error.message).toContain('Postgres diagnostics:')
  expect(Buffer.byteLength(error.diagnostics!)).toBeLessThanOrEqual(64 * 1024)
})

test('includes captured diagnostics when Postgres readiness times out', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const { child, spawnMock, startPostgresDataDir } = await loadSubject({
    pgQuery: () => {
      throw new Error('not ready')
    },
  })
  const startup = startPostgresDataDir({
    dataDir,
    postgresOutput: 'on-error',
    readinessIntervalMs: 5,
    readinessTimeoutMs: 100,
    stopTimeoutMs: 1,
  })
  const startupError = startup.catch((error: unknown) => error)

  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
  child.stderr.write('FATAL: could not bind address\n')

  await expect(startupError).resolves.toMatchObject({
    diagnostics: 'FATAL: could not bind address',
    message: expect.stringContaining('Timed out'),
  })
})

test('includes captured diagnostics when the Postgres process cannot spawn', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')

  const { child, spawnMock, startPostgresDataDir } = await loadSubject({
    pgQuery: () => {
      throw new Error('not ready')
    },
  })
  const startup = startPostgresDataDir({
    dataDir,
    postgresOutput: 'on-error',
    readinessIntervalMs: 0,
    stopTimeoutMs: 1,
  })
  const startupError = startup.catch((error: unknown) => error)

  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
  child.stderr.write('launcher diagnostic\n')
  child.emit('error', Object.assign(new Error('spawn postgres ENOENT'), { code: 'ENOENT' }))

  await expect(startupError).resolves.toMatchObject({
    diagnostics: 'launcher diagnostic',
    message: expect.stringContaining('Failed to start the "postgres" process'),
  })
})

test('rejects with a structured error when postmaster.pid points to a live process', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')
  await writeFile(join(dataDir, 'postmaster.pid'), '98765\n')
  vi.spyOn(process, 'kill').mockReturnValue(true)

  const { PostgresDataDirInUseError, spawnMock, startPostgresDataDir } = await loadSubject()
  const error = await startPostgresDataDir({ dataDir }).catch((error: unknown) => error)

  expect(error).toBeInstanceOf(PostgresDataDirInUseError)
  if (!(error instanceof PostgresDataDirInUseError)) throw error
  expect(error).toMatchObject({ dataDir, pid: 98_765 })
  expect(spawnMock).not.toHaveBeenCalled()
})

test('does not treat a stale postmaster.pid as a running cluster', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'PG_VERSION'), '18')
  await writeFile(join(dataDir, 'postmaster.pid'), '98765\n')
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  })

  const { spawnMock, startPostgresDataDir } = await loadSubject()
  const server = await startPostgresDataDir({ dataDir, stopTimeoutMs: 1 })

  expect(spawnMock).toHaveBeenCalledOnce()
  await server.stop()
})

test('core ensures a database over a socket connection', async () => {
  const root = await tempPath()
  const socketDir = join(root, '17.0')
  const { ensurePostgresDatabase, pgClients, pgQueries } = await loadSubject()

  await ensurePostgresDatabase({
    listen: {
      type: 'socket',
      socketDir,
      port: 54_444,
    },
    database: 'test',
  })

  expect(pgClients[0]).toMatchObject({
    database: 'postgres',
    host: socketDir,
    port: 54_444,
  })
  expect(pgQueries.map((query) => query.sql)).toEqual([
    'SELECT 1 FROM pg_database WHERE datname = $1',
    'CREATE DATABASE "test"',
  ])
})

test('core stops a data directory from postmaster.pid', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'postmaster.pid'), ['98765', dataDir, Date.now()].join('\n'))

  const killSignals: Array<string | number | undefined> = []
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    killSignals.push(signal)

    if (signal === 0) {
      throw Object.assign(new Error('kill ESRCH'), {
        code: 'ESRCH',
      })
    }

    return true
  })

  const { stopPostgresDataDir } = await loadSubject()

  await stopPostgresDataDir({
    dataDir,
    mode: 'smart',
    timeoutMs: 2_200,
  })

  expect(killSignals).toEqual(['SIGTERM', 0])
})

test('core does not stop a reused data directory when the expected pid changed', async () => {
  const root = await tempPath()
  const dataDir = join(root, 'data')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'postmaster.pid'), ['98765', dataDir, Date.now()].join('\n'))

  const killMock = vi.spyOn(process, 'kill')
  const { stopPostgresDataDir } = await loadSubject()

  await stopPostgresDataDir({
    dataDir,
    expectedPid: 12345,
  })

  expect(killMock).not.toHaveBeenCalled()
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
