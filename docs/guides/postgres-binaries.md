# Postgres Binaries

> Binary resolution is the main portability choice: use installed local
> binaries for the smallest setup, or opt into managed downloads when scripts
> need a specific Postgres version across machines.

By default, `local-postgres` runs the `initdb` and `postgres` commands from
`PATH`. It does not inspect versions and it does not download packages unless
the `postgres` option is provided with a strategy that allows downloads.

## Local-Only Default

Omit `postgres` when the machine's installed PostgreSQL is the contract:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
})
```

This is equivalent to local-only behavior. It is the best fit when developers
already install PostgreSQL themselves and the project does not need to enforce a
specific major version.

## Version Checks

Provide `postgres.version` when the project needs a matching binary:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
  postgres: {
    version: '18',
    strategy: 'prefer-local',
  },
})
```

Major versions match any release in that major line. More specific versions
match the provided components:

| Requested version | Matches                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `18`              | Any Postgres 18 version                                             |
| `18.4`            | Any Postgres 18.4 patch or prerelease selected by the binary source |
| `18.4.1`          | `18.4.1` without a prerelease suffix                                |
| `18.4.1-beta.1`   | Exactly `18.4.1-beta.1`                                             |

When `dataDir` already contains a cluster and a binary version is known,
`local-postgres` also checks `PG_VERSION`. A data directory initialized by
Postgres 15 will not be started with a Postgres 18 binary.

## Strategies

| Strategy          | First choice     | Fallback         | Use when                                                                                    |
| ----------------- | ---------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `local-only`      | `PATH` binaries  | None             | Downloads are never allowed.                                                                |
| `prefer-local`    | `PATH` binaries  | Managed download | Local installs are preferred, but a compatible downloaded binary is acceptable.             |
| `prefer-download` | Managed download | `PATH` binaries  | Reproducibility matters more than local installs, but offline local fallback is acceptable. |
| `download-only`   | Managed download | None             | The script must not use machine-installed Postgres.                                         |

When the `postgres` object is provided and `strategy` is omitted, the strategy
defaults to `prefer-local`. When `postgres` is omitted entirely, behavior is
local-only and no version check is performed.

## Managed Downloads

Managed downloads use the platform-specific packages published under
`@embedded-postgres/*` on npm. The package is selected from the current
platform and CPU architecture:

| Platform | Supported architectures                |
| -------- | -------------------------------------- |
| macOS    | `arm64`, `x64`                         |
| Linux    | `arm`, `arm64`, `ia32`, `ppc64`, `x64` |
| Windows  | `x64`                                  |

Downloaded tarballs are verified against npm integrity metadata before
extraction. Extracted packages are cached under `DEFAULT_POSTGRES_CACHE_DIR`
unless `postgres.cacheDir` is set. The default cache directory is
`path.join(os.homedir(), '.local-postgres')`.

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  postgres: {
    cacheDir: '.cache/local-postgres',
    strategy: 'download-only',
    version: '18',
  },
})
```

The cache layout is internal, but repeated runs reuse an extracted package when
its marker file and expected binaries are present.

## Disable Downloads

Set `LOCAL_POSTGRES_SKIP_DOWNLOAD=1` to make every managed-download path fail
before fetching npm metadata:

```sh
LOCAL_POSTGRES_SKIP_DOWNLOAD=1 pnpm test
```

The values `0` and `false` do not disable downloads. Any other non-empty value
does.
