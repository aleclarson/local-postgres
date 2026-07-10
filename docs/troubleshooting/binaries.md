# Binary Troubleshooting

> Verify local commands, download policy, platform support, and cache integrity
> in that order before changing binary strategy.

## `"initdb" binary was not found on PATH`

`initdb` is required when `dataDir` has no `PG_VERSION`. Verify both local
commands:

```sh
initdb --version
postgres --version
```

Fix one of these:

- install PostgreSQL and add its `bin` directory to `PATH`
- reuse a compatible data directory that is already initialized
- allow a managed binary strategy

```ts
await startPostgres({
  dataDir: '.postgres',
  postgres: {
    strategy: 'prefer-local',
    version: '18',
  },
})
```

## `"postgres" binary was not found on PATH`

The server executable is always required. Verify it directly:

```sh
postgres --version
```

Install PostgreSQL or choose a strategy that permits a managed download. If
downloads should already be allowed, check the environment next.

## Managed Downloads Are Disabled

The error identifies `LOCAL_POSTGRES_SKIP_DOWNLOAD`. Verify its value:

```sh
echo "$LOCAL_POSTGRES_SKIP_DOWNLOAD"
```

Unset it, set it to `0` or `false`, or deliberately use `local-only` with an
installed matching binary. Other non-empty values disable downloads.

## No Embedded Package for the Platform

Managed binaries are available only for the platform and architecture pairs in
[Postgres Binaries](../features/postgres-binaries.md#cache-managed-downloads).
Use a local installation on unsupported systems:

```ts
await startPostgres({
  dataDir: '.postgres',
  postgres: {
    strategy: 'local-only',
    version: '18',
  },
})
```

## Integrity Verification Fails

The downloaded tarball did not match npm metadata, so `local-postgres` rejects
before extraction. Do not bypass the integrity check. Retry through the normal
package source or investigate the network/cache path supplying different
bytes.
