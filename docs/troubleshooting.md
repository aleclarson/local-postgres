# Troubleshooting

> Start from the symptom, verify the local fact that can cause it, then change
> the smallest option or environment value that resolves the startup path.

Most failures happen before the server is returned. Wrap startup in ordinary
error handling and call `stop()` only after startup succeeds:

```ts
let postgres: Awaited<ReturnType<typeof startPostgres>> | undefined

try {
  postgres = await startPostgres({
    dataDir: '.postgres',
    database: 'app_dev',
  })
} finally {
  await postgres?.stop()
}
```

For quiet tools and test runners, set `log: 'on-error'` so startup failures
carry a bounded tail of Postgres output without printing successful startup:

```ts
import { LocalPostgresError, startPostgres } from 'local-postgres'

try {
  await startPostgres({ dataDir: '.postgres', log: 'on-error' })
} catch (error) {
  if (error instanceof LocalPostgresError) {
    console.error(error.diagnostics)
  }
  throw error
}
```

## `"initdb" binary was not found on PATH`

`local-postgres` needs `initdb` when `dataDir` does not contain a `PG_VERSION`
file.

Verify:

```sh
initdb --version
postgres --version
```

Fix one of these:

- Install PostgreSQL and ensure its `bin` directory is on `PATH`.
- Reuse a data directory that is already initialized by a compatible Postgres.
- Opt into managed binaries with `postgres.strategy`.

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

`local-postgres` always needs a `postgres` executable from either `PATH` or a
managed download.

Verify:

```sh
postgres --version
```

Fix:

```ts
await startPostgres({
  dataDir: '.postgres',
  postgres: {
    strategy: 'prefer-local',
    version: '18',
  },
})
```

If downloads are disabled in the environment, remove
`LOCAL_POSTGRES_SKIP_DOWNLOAD` or install local binaries instead.

## `Port 54321 is not available on 127.0.0.1`

A fixed `port` is already bound before `local-postgres` starts Postgres.

Verify:

```sh
lsof -nP -iTCP:54321 -sTCP:LISTEN
```

Fix one of these:

- Stop the process using the port.
- Choose a different fixed port.
- Omit `port` and use `server.port` after startup.

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
})

console.log(postgres.port)
```

## `Timed out ... waiting for Postgres to become ready`

Postgres was spawned, but `local-postgres` could not connect before
`readinessTimeoutMs`.

First capture startup diagnostics without enabling successful-run output:

```ts
await startPostgres({
  dataDir: '.postgres',
  log: 'on-error',
  readinessTimeoutMs: 10_000,
})
```

The thrown `LocalPostgresError` includes the captured output in its message and
`diagnostics` property. To retain output after startup too, write Postgres
output to a file:

```ts
await startPostgres({
  dataDir: '.postgres',
  log: {
    filePath: '.postgres/postgres.log',
  },
  readinessTimeoutMs: 10_000,
})
```

Fix depends on the log. Common causes are a slow first initialization, invalid
data directory state, filesystem permissions, or a host/port that the local
server cannot bind.

## `Postgres data directory ... is already in use`

`postmaster.pid` names a process that is still alive. `local-postgres` rejects
with `PostgresDataDirInUseError` before spawning another server and does not
attach to, signal, or take ownership of the existing process.

Use the structured fields to report which cluster blocks startup:

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

Verify the process before deciding whether to stop it:

```sh
ps -p "$(head -n 1 .postgres/postmaster.pid)" -o pid=,command=
```

If the PID is stale because no such process exists, `local-postgres` lets
Postgres perform its normal stale-lock handling. A process can also win the
startup race after the preflight check; use `log: 'on-error'` so PostgreSQL's
lock-file error remains visible in that case.

## Data Directory Version Mismatch

The error mentions a data directory initialized with one version and a resolved
binary from another major version.

Verify:

```sh
cat .postgres/PG_VERSION
postgres --version
```

Fix one of these:

- Use a Postgres binary from the same major version as `PG_VERSION`.
- Choose a different `dataDir` for the requested version.
- Remove and recreate the data directory only when the data can be discarded.

```ts
await startPostgres({
  dataDir: '.postgres-18',
  postgres: {
    version: '18',
    strategy: 'prefer-local',
  },
})
```

## Managed Downloads Are Disabled

The error says downloads are disabled by `LOCAL_POSTGRES_SKIP_DOWNLOAD`.

Verify:

```sh
echo "$LOCAL_POSTGRES_SKIP_DOWNLOAD"
```

Fix one of these:

- Unset `LOCAL_POSTGRES_SKIP_DOWNLOAD`.
- Set it to `0` or `false`.
- Use `postgres.strategy: 'local-only'` and install matching local binaries.

## No Embedded Package for the Platform

Managed binaries are only available for supported `@embedded-postgres/*`
platform packages. If the error says no package is known for the current
platform and architecture, use local PostgreSQL binaries instead:

```ts
await startPostgres({
  dataDir: '.postgres',
  postgres: {
    strategy: 'local-only',
    version: '18',
  },
})
```

## Database or Role Creation Fails

`local-postgres` connects as the current OS username used during bootstrap. It
creates the requested database and optional superuser after readiness succeeds.

Enable logs first:

```ts
await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
  superuser: {
    name: 'app',
    password: 'postgres',
  },
  log: {
    filePath: '.postgres/postgres.log',
  },
})
```

Then verify that the data directory is writable and was initialized by this
tooling or by a compatible local setup. For a disposable development cluster,
using a fresh `dataDir` is usually the smallest fix.
