# Startup Troubleshooting

> PostgreSQL output distinguishes spawn, early-exit, and readiness failures;
> capture it first, then adjust the failing startup boundary.

## Capture Failure Diagnostics

Use `on-error` before reproducing a startup problem:

```ts
import { LocalPostgresError, startPostgres } from 'local-postgres'

try {
  await startPostgres({
    dataDir: '.postgres',
    log: 'on-error',
  })
} catch (error) {
  if (error instanceof LocalPostgresError) {
    console.error(error.diagnostics)
  }
  throw error
}
```

The error message also includes the captured output under `Postgres
diagnostics:`. Use a [log file](../features/logging.md#retain-a-log-file) when
output must continue after readiness.

## `Failed to start the "postgres" process`

The executable could not be spawned. Verify that the selected binary exists
and is executable:

```sh
postgres --version
```

If the command is missing, continue with [Binary Troubleshooting](binaries.md).
If a configured managed cache is involved, verify that the cache directory and
its extracted binaries are readable and executable by the current user.

## `Postgres exited before becoming ready`

PostgreSQL started but exited before accepting connections. Read the attached
diagnostics for the concrete `FATAL` or configuration message.

Common causes include:

- another server won a `postmaster.pid` race after the preflight check
- PostgreSQL could not bind the selected host, port, or socket
- a configuration value appended during initialization is invalid
- the data directory or socket directory is not writable

Fix the reported local fact. Do not remove `postmaster.pid` until
[Data Directory Troubleshooting](data-directories.md) confirms it is stale.

## `Timed out ... waiting for Postgres to become ready`

PostgreSQL remained alive, but the readiness connection did not succeed before
`readinessTimeoutMs`:

```ts
await startPostgres({
  dataDir: '.postgres',
  log: 'on-error',
  readinessTimeoutMs: 10_000,
})
```

Increase the timeout only when diagnostics show a valid but slow startup. Bind
errors, invalid configuration, filesystem permissions, and mismatched client
addresses require fixing the underlying condition instead.
