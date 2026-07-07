import { execFile, spawn, type StdioOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { Client } from 'pg'
import { x as extractTar } from 'tar'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_DATABASE = 'postgres'
const DEFAULT_READINESS_TIMEOUT_MS = 3_000
const DEFAULT_READINESS_INTERVAL_MS = 100
const DEFAULT_STOP_TIMEOUT_MS = 5_000
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'
const EMBEDDED_POSTGRES_SCOPE = '@embedded-postgres'

export const DEFAULT_POSTGRES_CACHE_DIR = path.join(os.homedir(), '.local-postgres')

export interface LocalPostgresLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface LocalPostgresSuperuser {
  name: string
  password: string
}

export type LocalPostgresLogTarget =
  | 'ignore'
  | 'inherit'
  | {
      filePath: string
    }

export type PostgresBinaryStrategy =
  | 'local-only'
  | 'prefer-local'
  | 'prefer-download'
  | 'download-only'

export interface PostgresBinaryOptions {
  /**
   * Required Postgres version. A major version such as `18` accepts any
   * matching major version. More specific values require matching components.
   */
  version?: string
  /**
   * How local binaries and managed downloads should be resolved.
   *
   * Defaults to `prefer-local` when this object is provided. When `postgres`
   * is omitted, `local-only` preserves the package's original behavior.
   */
  strategy?: PostgresBinaryStrategy
  /**
   * Directory for downloaded npm package tarballs and extracted binaries.
   *
   * Defaults to `path.join(os.homedir(), ".local-postgres")`.
   */
  cacheDir?: string
}

export interface StartPostgresOptions {
  /**
   * Directory containing the Postgres data cluster. The directory is created
   * and initialized when it does not already contain a `PG_VERSION` file.
   */
  dataDir: string
  /**
   * Database to create if needed and expose in connection details.
   *
   * Defaults to `postgres`.
   */
  database?: string
  /**
   * Port for the Postgres TCP server. When omitted, an available local port is
   * selected before the server starts.
   */
  port?: number
  /**
   * TCP host for the Postgres server.
   *
   * Defaults to `127.0.0.1`.
   */
  host?: string
  /**
   * Superuser role to create or update after the server is ready. When set,
   * returned connection details include this role's credentials.
   */
  superuser?: LocalPostgresSuperuser
  /**
   * Where Postgres stdout/stderr should go.
   *
   * Defaults to `ignore`.
   */
  log?: LocalPostgresLogTarget
  /**
   * Postgres binary resolution behavior. Omit this for local-only PATH based
   * behavior. Provide it to enable version checks and managed downloads.
   */
  postgres?: PostgresBinaryOptions
  /**
   * Optional lifecycle logger. Missing methods are treated as no-ops.
   */
  logger?: Partial<LocalPostgresLogger>
  /**
   * Maximum time to wait for `pg_isready` to report readiness.
   *
   * Defaults to 3000ms.
   */
  readinessTimeoutMs?: number
  /**
   * Delay between readiness checks.
   *
   * Defaults to 100ms.
   */
  readinessIntervalMs?: number
  /**
   * Maximum time to wait after each shutdown signal.
   *
   * Defaults to 5000ms.
   */
  stopTimeoutMs?: number
}

export interface LocalPostgresEnv {
  PGDATA: string
  PGDATABASE: string
  PGHOST: string
  PGPORT: string
  DATABASE_URL: string
  PGUSER?: string
  PGPASSWORD?: string
}

export interface LocalPostgresServer {
  dataDir: string
  database: string
  host: string
  port: number
  user?: string
  password?: string
  pid?: number
  connectionString: string
  env: LocalPostgresEnv
  stop(): Promise<void>
}

export class LocalPostgresError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'LocalPostgresError'
  }
}

type CommandFailure = Error & {
  code?: number | string
  signal?: string
  stderr?: string
  stdout?: string
}

interface CommandResult {
  stderr: string
  stdout: string
}

interface ExitResult {
  code: number | null
  signal: NodeJS.Signals | null
}

interface ResolvedPostgresBinaries {
  initdb: string
  postgres: string
  source: 'local' | 'download'
  version?: string
}

interface EmbeddedPostgresPackageMetadata {
  'dist-tags'?: {
    latest?: string
  }
  versions: Record<
    string,
    {
      dist?: {
        integrity?: string
        tarball?: string
      }
    }
  >
}

export async function startPostgres(options: StartPostgresOptions): Promise<LocalPostgresServer> {
  const dataDir = requireNonEmptyString(options.dataDir, 'dataDir')
  const database = options.database
    ? requireNonEmptyString(options.database, 'database')
    : DEFAULT_DATABASE
  const host = options.host ? requireNonEmptyString(options.host, 'host') : DEFAULT_HOST
  const logger = resolveLogger(options.logger)
  const bootstrapUser = os.userInfo().username
  const port =
    options.port === undefined
      ? await findAvailablePort(host)
      : await assertAvailablePort(host, normalizePort(options.port))
  const readinessTimeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  const readinessIntervalMs = options.readinessIntervalMs ?? DEFAULT_READINESS_INTERVAL_MS
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true })
  }

  const needsInitdb = !existsSync(path.join(dataDir, 'PG_VERSION'))
  const binaries = await resolvePostgresBinaries(options.postgres, {
    logger,
    needsInitdb,
  })

  if (!needsInitdb && binaries.version) {
    assertDataDirectoryVersion(dataDir, binaries.version)
  }

  if (needsInitdb) {
    logger.info('[postgres] Initializing database cluster...')
    try {
      // Trust authentication keeps the package local-dev friendly. Callers that
      // need stronger auth can initialize and pass their own data directory.
      await runCommand(binaries.initdb, [
        '-D',
        dataDir,
        '-U',
        bootstrapUser,
        '--auth=trust',
        '--no-locale',
        '-E',
        'UTF8',
      ])
    } catch (error) {
      throw commandError('Failed to initialize the Postgres data directory.', 'initdb', error)
    }
  }

  logger.info(`[postgres] Starting server on ${host}:${port}...`)
  const logFile = openLogTarget(options.log)
  let stopped = false
  let ready = false
  let spawnError: Error | undefined
  let exitResult: ExitResult | undefined

  const proc = spawn(binaries.postgres, ['-D', dataDir, '-h', host, '-p', String(port)], {
    stdio: logFile.stdio,
  })

  const exitPromise = new Promise<ExitResult>((resolve) => {
    proc.once('exit', (code, signal) => {
      exitResult = { code, signal }
      logFile.close()
      if (ready && !stopped && code !== 0 && code !== null) {
        logger.error(`[postgres] Process exited unexpectedly with code ${code}.`)
      }
      resolve(exitResult)
    })
  })

  proc.once('error', (error) => {
    spawnError = error
    logFile.close()
  })

  const stop = async () => {
    if (stopped) return
    stopped = true

    if (exitResult || spawnError) return

    proc.kill('SIGINT')
    const didExitAfterSigint = await waitForExit(exitPromise, stopTimeoutMs)
    if (didExitAfterSigint) return

    proc.kill('SIGTERM')
    await waitForExit(exitPromise, stopTimeoutMs)
  }

  try {
    await waitForReady({
      host,
      port,
      user: bootstrapUser,
      getSpawnError: () => spawnError,
      getExitResult: () => exitResult,
      timeoutMs: readinessTimeoutMs,
      intervalMs: readinessIntervalMs,
    })
    ready = true

    if (options.superuser) {
      await ensureSuperuser({
        host,
        port,
        user: bootstrapUser,
        superuser: options.superuser,
      })
    }

    if (database !== DEFAULT_DATABASE) {
      await ensureDatabase({
        host,
        port,
        user: bootstrapUser,
        database,
      })
    }
  } catch (error) {
    await stop()
    throw error
  }

  const connectionString = createConnectionString({
    host,
    port,
    database,
    user: options.superuser?.name,
    password: options.superuser?.password,
  })
  const env = createEnv({
    dataDir,
    database,
    host,
    port,
    connectionString,
    user: options.superuser?.name,
    password: options.superuser?.password,
  })

  logger.info(`[postgres] Server ready on ${host}:${port}.`)

  return {
    dataDir,
    database,
    host,
    port,
    user: options.superuser?.name,
    password: options.superuser?.password,
    pid: proc.pid,
    connectionString,
    env,
    stop,
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

function requireNonEmptyString(value: string, name: string) {
  if (value.trim() === '') {
    throw new TypeError(`${name} must not be empty.`)
  }
  return value
}

function normalizePort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError('port must be an integer between 1 and 65535.')
  }
  return port
}

async function resolvePostgresBinaries(
  options: PostgresBinaryOptions | undefined,
  {
    logger,
    needsInitdb,
  }: {
    logger: LocalPostgresLogger
    needsInitdb: boolean
  },
): Promise<ResolvedPostgresBinaries> {
  const strategy = options?.strategy ?? (options ? 'prefer-local' : 'local-only')
  const localOptions = {
    checkAvailability: options !== undefined,
    needsInitdb,
    version: options?.version,
  }

  if (strategy === 'local-only') {
    return resolveLocalPostgresBinaries(localOptions)
  }

  if (strategy === 'download-only') {
    return resolveDownloadedPostgresBinaries(options, logger)
  }

  if (strategy === 'prefer-download') {
    try {
      return await resolveDownloadedPostgresBinaries(options, logger)
    } catch (downloadError) {
      logger.warn(
        `[postgres] Managed Postgres download failed; falling back to local binaries. ${errorMessage(
          downloadError,
        )}`,
      )
      return resolveLocalPostgresBinaries({
        ...localOptions,
        checkAvailability: true,
      })
    }
  }

  try {
    return await resolveLocalPostgresBinaries({
      ...localOptions,
      checkAvailability: true,
    })
  } catch (localError) {
    logger.warn(
      `[postgres] Local Postgres binaries are unavailable or incompatible; using managed binaries. ${errorMessage(
        localError,
      )}`,
    )
    return resolveDownloadedPostgresBinaries(options, logger)
  }
}

async function resolveLocalPostgresBinaries({
  checkAvailability,
  needsInitdb,
  version,
}: {
  checkAvailability: boolean
  needsInitdb: boolean
  version?: string
}): Promise<ResolvedPostgresBinaries> {
  const binaries: ResolvedPostgresBinaries = {
    initdb: 'initdb',
    postgres: 'postgres',
    source: 'local',
  }

  if (!checkAvailability) {
    return binaries
  }

  const postgresVersion = await readPostgresBinaryVersion(binaries.postgres)
  if (version && !versionMatches(postgresVersion, version)) {
    throw new LocalPostgresError(
      `Local postgres version ${postgresVersion} does not satisfy requested version ${version}.`,
    )
  }

  if (needsInitdb) {
    const initdbVersion = await readPostgresBinaryVersion(binaries.initdb)
    if (version && !versionMatches(initdbVersion, version)) {
      throw new LocalPostgresError(
        `Local initdb version ${initdbVersion} does not satisfy requested version ${version}.`,
      )
    }
  }

  return {
    ...binaries,
    version: postgresVersion,
  }
}

async function readPostgresBinaryVersion(binaryPath: string) {
  try {
    const { stdout, stderr } = await runCommand(binaryPath, ['--version'])
    const version = parsePostgresVersion(stdout || stderr)
    if (!version) {
      throw new LocalPostgresError(`Unable to parse version from "${binaryPath} --version".`)
    }
    return version
  } catch (error) {
    if (error instanceof LocalPostgresError) {
      throw error
    }

    throw commandError(`Failed to inspect Postgres binary "${binaryPath}".`, binaryPath, error)
  }
}

function assertDataDirectoryVersion(dataDir: string, binaryVersion: string) {
  const dataDirectoryVersion = readFileSync(path.join(dataDir, 'PG_VERSION'), 'utf8').trim()
  const dataDirectoryMajor = versionNumberParts(dataDirectoryVersion)[0]
  const binaryMajor = versionNumberParts(binaryVersion)[0]

  if (dataDirectoryMajor === undefined || binaryMajor === undefined) {
    return
  }

  if (dataDirectoryMajor !== binaryMajor) {
    throw new LocalPostgresError(
      `Postgres data directory was initialized with version ${dataDirectoryVersion}, but the resolved Postgres binary is version ${binaryVersion}. Use a matching binary version or a different data directory.`,
    )
  }
}

async function resolveDownloadedPostgresBinaries(
  options: PostgresBinaryOptions | undefined,
  logger: LocalPostgresLogger,
): Promise<ResolvedPostgresBinaries> {
  const skipDownload = process.env.LOCAL_POSTGRES_SKIP_DOWNLOAD
  if (skipDownload && skipDownload !== '0' && skipDownload !== 'false') {
    throw new LocalPostgresError(
      'Managed Postgres downloads are disabled by LOCAL_POSTGRES_SKIP_DOWNLOAD.',
    )
  }

  const packageName = embeddedPostgresPackageName()
  const metadata = await fetchEmbeddedPostgresPackageMetadata(packageName)
  const packageVersion = selectEmbeddedPostgresPackageVersion(metadata, options?.version)
  const packageInfo = metadata.versions[packageVersion]
  const tarball = packageInfo?.dist?.tarball
  const integrity = packageInfo?.dist?.integrity

  if (!tarball || !integrity) {
    throw new LocalPostgresError(
      `The npm metadata for ${packageName}@${packageVersion} is missing tarball or integrity data.`,
    )
  }

  const cacheDir = options?.cacheDir ?? DEFAULT_POSTGRES_CACHE_DIR
  const packageDir = path.join(
    cacheDir,
    'embedded-postgres',
    packageName.replace(`${EMBEDDED_POSTGRES_SCOPE}/`, ''),
    packageVersion,
  )
  const markerPath = path.join(packageDir, '.local-postgres-installed')
  const binaries = downloadedBinaryPaths(packageDir, packageVersion)

  if (existsSync(markerPath) && existsSync(binaries.postgres) && existsSync(binaries.initdb)) {
    return binaries
  }

  logger.info(`[postgres] Downloading ${packageName}@${packageVersion}...`)
  await installEmbeddedPostgresPackage({
    integrity,
    packageDir,
    packageName,
    packageVersion,
    tarball,
  })

  if (!existsSync(binaries.postgres) || !existsSync(binaries.initdb)) {
    throw new LocalPostgresError(
      `${packageName}@${packageVersion} did not contain the expected native Postgres binaries.`,
    )
  }

  return binaries
}

function embeddedPostgresPackageName() {
  const platform = os.platform()
  const arch = os.arch()

  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `${EMBEDDED_POSTGRES_SCOPE}/darwin-${arch}`
  }

  if (
    platform === 'linux' &&
    (arch === 'arm' || arch === 'arm64' || arch === 'ia32' || arch === 'ppc64' || arch === 'x64')
  ) {
    return `${EMBEDDED_POSTGRES_SCOPE}/linux-${arch}`
  }

  if (platform === 'win32' && arch === 'x64') {
    return `${EMBEDDED_POSTGRES_SCOPE}/windows-x64`
  }

  throw new LocalPostgresError(
    `No ${EMBEDDED_POSTGRES_SCOPE} package is known for ${platform}/${arch}.`,
  )
}

async function fetchEmbeddedPostgresPackageMetadata(packageName: string) {
  const metadataUrl = `${DEFAULT_REGISTRY_URL}/${packageName.replace('/', '%2f')}`
  const response = await fetch(metadataUrl, {
    headers: {
      accept: 'application/vnd.npm.install-v1+json, application/json',
    },
  })

  if (!response.ok) {
    throw new LocalPostgresError(
      `Failed to fetch npm metadata for ${packageName}: ${response.status} ${response.statusText}`,
    )
  }

  return (await response.json()) as EmbeddedPostgresPackageMetadata
}

function selectEmbeddedPostgresPackageVersion(
  metadata: EmbeddedPostgresPackageMetadata,
  requestedVersion: string | undefined,
) {
  if (!requestedVersion) {
    const latest = metadata['dist-tags']?.latest
    if (!latest) {
      throw new LocalPostgresError('The embedded Postgres package has no latest dist-tag.')
    }
    return latest
  }

  if (metadata.versions[requestedVersion]) {
    return requestedVersion
  }

  const matchedVersion = Object.keys(metadata.versions)
    .filter((version) => versionMatches(version, requestedVersion))
    .sort(compareVersions)
    .at(-1)

  if (!matchedVersion) {
    throw new LocalPostgresError(
      `No embedded Postgres package version satisfies requested version ${requestedVersion}.`,
    )
  }

  return matchedVersion
}

function downloadedBinaryPaths(packageDir: string, version: string): ResolvedPostgresBinaries {
  const extension = os.platform() === 'win32' ? '.exe' : ''
  const binDir = path.join(packageDir, 'native', 'bin')

  return {
    initdb: path.join(binDir, `initdb${extension}`),
    postgres: path.join(binDir, `postgres${extension}`),
    source: 'download',
    version,
  }
}

async function installEmbeddedPostgresPackage({
  integrity,
  packageDir,
  packageName,
  packageVersion,
  tarball,
}: {
  integrity: string
  packageDir: string
  packageName: string
  packageVersion: string
  tarball: string
}) {
  const response = await fetch(tarball)
  if (!response.ok) {
    throw new LocalPostgresError(
      `Failed to download ${packageName}@${packageVersion}: ${response.status} ${response.statusText}`,
    )
  }

  const tarballBuffer = Buffer.from(await response.arrayBuffer())
  verifyNpmIntegrity(tarballBuffer, integrity, `${packageName}@${packageVersion}`)

  const packageParentDir = path.dirname(packageDir)
  await mkdir(packageParentDir, { recursive: true })
  const tempDir = await mkdtemp(path.join(packageParentDir, '.tmp-'))
  const tarballPath = path.join(tempDir, 'package.tgz')

  try {
    await writeFile(tarballPath, tarballBuffer)
    await extractTar({
      cwd: tempDir,
      file: tarballPath,
      strip: 1,
    })
    await rm(tarballPath, { force: true })
    await writeFile(
      path.join(tempDir, '.local-postgres-installed'),
      JSON.stringify(
        {
          integrity,
          packageName,
          packageVersion,
        },
        null,
        2,
      ),
    )
    await rm(packageDir, { force: true, recursive: true })
    await rename(tempDir, packageDir)
  } catch (error) {
    await rm(tempDir, { force: true, recursive: true })
    throw error
  }
}

function verifyNpmIntegrity(buffer: Buffer, integrity: string, label: string) {
  const [algorithm, expectedDigest] = integrity.split('-', 2)
  if (!algorithm || !expectedDigest) {
    throw new LocalPostgresError(`Unsupported npm integrity value for ${label}.`)
  }

  const actualDigest = createHash(algorithm).update(buffer).digest('base64')
  if (actualDigest !== expectedDigest) {
    throw new LocalPostgresError(`Integrity check failed for ${label}.`)
  }
}

function parsePostgresVersion(output: string) {
  return output.match(/(\d+(?:\.\d+){0,2}(?:[-.a-zA-Z0-9]+)?)/)?.[1]
}

function versionMatches(actualVersion: string, requestedVersion: string) {
  const actual = normalizeVersion(actualVersion)
  const requested = normalizeVersion(requestedVersion)
  const actualParts = versionNumberParts(actual)
  const requestedParts = versionNumberParts(requested)
  const requestedSpecificity = requestedParts.length

  if (requestedSpecificity === 0) {
    return actual === requested
  }

  for (let index = 0; index < requestedSpecificity; index++) {
    if (actualParts[index] !== requestedParts[index]) {
      return false
    }
  }

  if (requestedSpecificity >= 3) {
    return requested.includes('-') ? actual === requested : !actual.includes('-')
  }

  return true
}

function compareVersions(left: string, right: string) {
  const leftVersion = parsedVersion(left)
  const rightVersion = parsedVersion(right)

  for (let index = 0; index < 3; index++) {
    const diff = leftVersion.parts[index] - rightVersion.parts[index]
    if (diff !== 0) return diff
  }

  if (!leftVersion.prerelease && rightVersion.prerelease) return 1
  if (leftVersion.prerelease && !rightVersion.prerelease) return -1

  return leftVersion.prerelease.localeCompare(rightVersion.prerelease, undefined, {
    numeric: true,
  })
}

function parsedVersion(version: string) {
  const normalized = normalizeVersion(version)
  const [numbers, prerelease = ''] = normalized.split('-', 2)
  const parts = numbers.split('.').map((part) => Number.parseInt(part, 10) || 0)

  return {
    parts: [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0] as const,
    prerelease,
  }
}

function versionNumberParts(version: string) {
  return normalizeVersion(version)
    .split('-', 1)[0]
    .split('.')
    .filter(Boolean)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part))
}

function normalizeVersion(version: string) {
  return version.trim().replace(/^v/, '')
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
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

function openLogTarget(log: LocalPostgresLogTarget | undefined): {
  stdio: StdioOptions
  close(): void
} {
  if (log === 'inherit') {
    return {
      stdio: ['ignore', 'inherit', 'inherit'],
      close: noop,
    }
  }

  if (typeof log === 'object') {
    mkdirSync(path.dirname(log.filePath), { recursive: true })
    const fd = openSync(log.filePath, 'w')
    let closed = false
    return {
      stdio: ['ignore', fd, fd],
      close: () => {
        if (closed) return
        closed = true
        closeSync(fd)
      },
    }
  }

  return {
    stdio: ['ignore', 'ignore', 'ignore'],
    close: noop,
  }
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandFailure = error as CommandFailure
          commandFailure.stdout = stdout?.toString() ?? ''
          commandFailure.stderr = stderr?.toString() ?? ''
          reject(commandFailure)
          return
        }

        resolve({
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
        })
      },
    )
  })
}

function commandError(message: string, command: string, error: unknown) {
  const failure = error as CommandFailure
  const binaryMessage =
    failure.code === 'ENOENT' ? ` The "${command}" binary was not found on PATH.` : ''
  const stderr = failure.stderr?.trim()
  const detail = stderr ? ` ${stderr}` : failure.message ? ` ${failure.message}` : ''

  return new LocalPostgresError(`${message}${binaryMessage}${detail}`, {
    cause: error,
  })
}

async function waitForReady({
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

async function ensureSuperuser({
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

async function ensureDatabase({
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

function createConnectionString({
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

function createEnv({
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForExit(exitPromise: Promise<ExitResult>, timeoutMs: number) {
  return Promise.race([exitPromise.then(() => true), delay(timeoutMs).then(() => false)])
}
