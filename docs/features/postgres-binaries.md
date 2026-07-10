# Postgres Binaries

> Binary resolution is the portability choice: use installed binaries for the
> smallest setup, or managed downloads when a script needs a specific version.

By default, `local-postgres` runs `initdb` and `postgres` from `PATH`. It does
not inspect versions or download packages unless the `postgres` option is
provided with a strategy that allows downloads.

## Use Local Binaries

Omit `postgres` when the machine's installed PostgreSQL is the contract:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
})
```

This is local-only behavior. It fits environments where developers install
PostgreSQL themselves and the project does not enforce a major version.

## Require a Version

Provide `postgres.version` when the project needs a compatible binary:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres/18',
  postgres: {
    version: '18',
    strategy: 'prefer-local',
  },
})
```

| Requested version | Matches                                                             |
| ----------------- | ------------------------------------------------------------------- |
| `18`              | Any Postgres 18 version                                             |
| `18.4`            | Any Postgres 18.4 patch or prerelease selected by the binary source |
| `18.4.1`          | `18.4.1` without a prerelease suffix                                |
| `18.4.1-beta.1`   | Exactly `18.4.1-beta.1`                                             |

When `dataDir` already contains a cluster and the binary version is known,
`local-postgres` also checks its `PG_VERSION` major version.

## Choose a Strategy

| Strategy          | First choice     | Fallback         | Use when                                           |
| ----------------- | ---------------- | ---------------- | -------------------------------------------------- |
| `local-only`      | `PATH` binaries  | None             | Downloads are never allowed.                       |
| `prefer-local`    | `PATH` binaries  | Managed download | Compatible local installs are preferred.           |
| `prefer-download` | Managed download | `PATH` binaries  | Reproducibility matters, with an offline fallback. |
| `download-only`   | Managed download | None             | Machine-installed Postgres must not be used.       |

Providing `postgres` without `strategy` defaults to `prefer-local`. Omitting
the entire `postgres` object preserves local-only behavior without a version
check.

## Cache Managed Downloads

Managed downloads use platform packages under `@embedded-postgres/*` on npm:

| Platform | Supported architectures                |
| -------- | -------------------------------------- |
| macOS    | `arm64`, `x64`                         |
| Linux    | `arm`, `arm64`, `ia32`, `ppc64`, `x64` |
| Windows  | `x64`                                  |

Tarballs are checked against npm integrity metadata before extraction. The
default cache is `path.join(os.homedir(), '.local-postgres')`; override it when
a tool owns a separate cache:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres/18',
  postgres: {
    cacheDir: '.cache/local-postgres',
    strategy: 'download-only',
    version: '18',
  },
})
```

Repeated runs reuse an extracted package when its marker and binaries remain
present.

## Disable Downloads

Set `LOCAL_POSTGRES_SKIP_DOWNLOAD=1` to make managed-download paths fail before
fetching npm metadata:

```sh
LOCAL_POSTGRES_SKIP_DOWNLOAD=1 pnpm test
```

The values `0` and `false` do not disable downloads. Any other non-empty value
does. See [Binary Troubleshooting](../troubleshooting/binaries.md) for missing
commands, unavailable packages, and disabled downloads.
