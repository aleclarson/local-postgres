# Logging

> Select a Postgres output target based on whether successful runs should stay
> quiet and whether diagnostics must survive beyond startup.

Postgres stdout and stderr are ignored by default. The `log` option controls
the child process output separately from lifecycle messages sent to `logger`.

| Target              | Successful startup             | Startup failure                     | After readiness     |
| ------------------- | ------------------------------ | ----------------------------------- | ------------------- |
| `ignore` or omitted | Silent                         | No Postgres output                  | Discarded           |
| `on-error`          | Silent                         | Newest 64 KiB attached to the error | Discarded           |
| `inherit`           | Written to the parent terminal | Already visible                     | Continues streaming |
| `{ filePath }`      | Written to a file              | Retained in the file                | Continues writing   |

## Keep Successful Runs Quiet

Use `on-error` for developer tools and tests that need actionable startup
failures without routine PostgreSQL output:

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

The buffer combines stdout and stderr during startup and retains only the
newest 64 KiB. On failure, `LocalPostgresError.diagnostics` contains that tail
and the error message prints it under `Postgres diagnostics:`. Successful
readiness discards the buffer while continuing to drain the child pipes.

## Stream to the Terminal

Use `inherit` when PostgreSQL should share the current process terminal:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  log: 'inherit',
})
```

This is useful during interactive diagnosis but makes successful runs noisy.

## Retain a Log File

Use a file when output from the entire server lifetime must remain available:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  log: {
    filePath: '.postgres/postgres.log',
  },
})
```

`local-postgres` creates parent directories when needed. File logging applies
for the server lifetime, unlike `on-error`, which is deliberately limited to
startup diagnostics.

## Receive Lifecycle Messages

`logger` is a separate optional interface for package-level progress, warnings,
and unexpected process exits:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  log: 'on-error',
  logger: console,
})
```

Missing `info`, `warn`, or `error` methods are treated as no-ops. See
[Startup Troubleshooting](../troubleshooting/startup.md) for failure-first
diagnosis.
