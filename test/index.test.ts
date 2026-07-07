import { EventEmitter } from 'node:events'
import { join } from 'node:path'

type ExecFileResult = {
  error?: Error
  stdout?: string
  stderr?: string
}

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void

type ExecFileHandler = (command: string, args: string[]) => ExecFileResult

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

async function loadSubject({
  existingPaths = [],
  execFile = () => ({}),
  pickedPort = 55_432,
  listenError,
}: {
  existingPaths?: string[]
  execFile?: ExecFileHandler
  pickedPort?: number
  listenError?: Error
} = {}) {
  vi.resetModules()

  const existing = new Set(existingPaths)
  const child = new FakeChildProcess()
  const netServers: FakeNetServer[] = []

  const existsSync = vi.fn((path: string) => existing.has(path))
  const mkdirSync = vi.fn((path: string) => {
    existing.add(path)
  })
  const openSync = vi.fn(() => 99)
  const closeSync = vi.fn()
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

  vi.doMock('node:child_process', () => ({
    execFile: execFileMock,
    spawn: spawnMock,
  }))
  vi.doMock('node:fs', () => ({
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
  }))
  vi.doMock('node:net', () => ({
    createServer: createServerMock,
  }))

  const subject = await import('../src/index')

  return {
    child,
    closeSync,
    createServerMock,
    execFileMock,
    mkdirSync,
    netServers,
    openSync,
    spawnMock,
    startPostgres: subject.startPostgres,
  }
}

afterEach(() => {
  vi.doUnmock('node:child_process')
  vi.doUnmock('node:fs')
  vi.doUnmock('node:net')
  vi.restoreAllMocks()
  vi.resetModules()
})

test('initializes a cluster, starts postgres, and returns connection details', async () => {
  const dataDir = '/tmp/local-postgres-test'
  const logFile = '/tmp/local-postgres-test/postgres.log'
  const { child, closeSync, execFileMock, mkdirSync, openSync, spawnMock, startPostgres } =
    await loadSubject()

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

  expect(mkdirSync).toHaveBeenCalledWith(dataDir, { recursive: true })
  expect(mkdirSync).toHaveBeenCalledWith('/tmp/local-postgres-test', {
    recursive: true,
  })
  expect(openSync).toHaveBeenCalledWith(logFile, 'w')
  expect(spawnMock).toHaveBeenCalledWith(
    'postgres',
    ['-D', dataDir, '-h', '127.0.0.1', '-p', '54321'],
    {
      stdio: ['ignore', 99, 99],
    },
  )

  expect(execFileMock.mock.calls.map(([command]) => command)).toEqual([
    'initdb',
    'pg_isready',
    'psql',
    'createdb',
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
  expect(closeSync).toHaveBeenCalledWith(99)
})

test('picks an available port when no port is provided', async () => {
  const dataDir = '/tmp/local-postgres-existing'
  const { netServers, spawnMock, startPostgres } = await loadSubject({
    existingPaths: [dataDir, join(dataDir, 'PG_VERSION')],
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
  const dataDir = '/tmp/local-postgres-existing'
  const { execFileMock, startPostgres } = await loadSubject({
    existingPaths: [dataDir, join(dataDir, 'PG_VERSION')],
    execFile: (command) => {
      if (command === 'createdb') {
        return {
          error: new Error('createdb failed'),
          stderr: 'createdb: error: database "app" already exists',
        }
      }
      return {}
    },
  })

  const server = await startPostgres({
    dataDir,
    database: 'app',
    port: 54_321,
    stopTimeoutMs: 1,
  })

  expect(execFileMock.mock.calls.map(([command]) => command)).toEqual(['pg_isready', 'createdb'])

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
      dataDir: '/tmp/local-postgres-test',
      port: 54_321,
    }),
  ).rejects.toThrow('Port 54321 is not available on 127.0.0.1')

  expect(execFileMock).not.toHaveBeenCalled()
  expect(spawnMock).not.toHaveBeenCalled()
})
