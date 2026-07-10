# Data Directory Troubleshooting

> Verify PID liveness and `PG_VERSION` before changing persistent cluster
> state; never delete a lock or directory merely to bypass an error.

## `Postgres data directory ... is already in use`

`postmaster.pid` names a process that is still alive. `local-postgres` rejects
with `PostgresDataDirInUseError` before spawning another server and does not
attach to, signal, or take ownership of it:

```ts
import { PostgresDataDirInUseError, startPostgres } from 'local-postgres'

try {
  await startPostgres({ dataDir: '.postgres', log: 'on-error' })
} catch (error) {
  if (error instanceof PostgresDataDirInUseError) {
    console.error(`Cluster ${error.dataDir} is already running as PID ${error.pid}`)
  }
  throw error
}
```

Verify the process before deciding whether its owner should stop it:

```sh
ps -p "$(head -n 1 .postgres/postmaster.pid)" -o pid=,command=
```

Use the original owner or an intentional
[`stopPostgresDataDir`](../features/shutdown.md#stop-by-data-directory) call to
stop a server you own. Do not start a second server against the same directory.

## Stale `postmaster.pid`

When the PID no longer exists, `local-postgres` lets PostgreSQL perform its
normal stale-lock handling. If startup still fails, use `log: 'on-error'` and
follow PostgreSQL's diagnostic instead of deleting the file blindly.

An invalid PID file produces `Invalid postmaster.pid file`. Inspect the file
and determine which interrupted tool owned the cluster before repairing
disposable state or restoring persistent state from its intended source.

## Data Directory Version Mismatch

The resolved binary major version differs from the cluster's `PG_VERSION`.
Verify both values:

```sh
cat .postgres/PG_VERSION
postgres --version
```

Fix one of these:

- use a Postgres binary from the same major version as `PG_VERSION`
- choose a separate `dataDir` for the requested version
- remove and recreate the directory only when its data is disposable

```ts
await startPostgres({
  dataDir: '.postgres-18',
  postgres: {
    version: '18',
    strategy: 'prefer-local',
  },
})
```

See [Data Directories](../features/data-directories.md) for persistence and
configuration ownership.
