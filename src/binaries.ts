import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { unpackTar } from 'modern-tar/fs'

import { commandError, runCommand } from './process'
import {
  DEFAULT_POSTGRES_CACHE_DIR,
  LocalPostgresError,
  type LocalPostgresLogger,
  type PostgresBinaryOptions,
} from './types'

const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org'

export interface ResolvedPostgresBinaries {
  initdb: string
  postgres: string
  source: 'local' | 'download'
  version?: string
}

interface NpmPackageMetadata {
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

export async function resolvePostgresBinaries(
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

export function assertDataDirectoryVersion(dataDir: string, binaryVersion: string) {
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

  const packageName = packageNameForPlatform('@embedded-postgres', os.platform(), os.arch())
  const metadata = await fetchNpmPackageMetadata(packageName)
  const packageVersion = selectPackageVersion(
    metadata,
    options?.version,
    'embedded Postgres package',
  )
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
    packageName.split('/').at(-1) ?? packageName,
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

function packageNameForPlatform(scope: string, platform: NodeJS.Platform, arch: string) {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) {
    return `${scope}/darwin-${arch}`
  }

  if (
    platform === 'linux' &&
    (arch === 'arm' || arch === 'arm64' || arch === 'ia32' || arch === 'ppc64' || arch === 'x64')
  ) {
    return `${scope}/linux-${arch}`
  }

  if (platform === 'win32' && arch === 'x64') {
    return `${scope}/windows-x64`
  }

  throw new LocalPostgresError(`No ${scope} package is known for ${platform}/${arch}.`)
}

async function fetchNpmPackageMetadata(packageName: string) {
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

  return (await response.json()) as NpmPackageMetadata
}

function selectPackageVersion(
  metadata: NpmPackageMetadata,
  requestedVersion: string | undefined,
  packageLabel: string,
) {
  if (!requestedVersion) {
    const latest = metadata['dist-tags']?.latest
    if (!latest) {
      throw new LocalPostgresError(`The ${packageLabel} has no latest dist-tag.`)
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
      `No ${packageLabel} version satisfies requested version ${requestedVersion}.`,
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

  try {
    await pipeline(Readable.from(tarballBuffer), createGunzip(), unpackTar(tempDir, { strip: 1 }))
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
