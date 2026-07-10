# Lifecycle Patterns

> The right lifecycle depends on whether the caller wants reusable local state,
> isolated test state, or a child process that inherits connection variables.

`startPostgres` returns a `LocalPostgresServer`. Keep that object near the code
that owns startup and teardown, and call `stop()` exactly when that owner is
done. In runtimes that support explicit resource management, `await using`
also stops the server when the scope exits.

## Local Development Scripts

Use a persistent data directory when you want local data to survive between
runs:

```ts
import { startPostgres } from 'local-postgres'

const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
  port: 54329,
  superuser: {
    name: 'app',
    password: 'postgres',
  },
  log: {
    filePath: '.postgres/postgres.log',
  },
})

try {
  Object.assign(process.env, postgres.env)
  await import('./dev-server.ts')
} finally {
  await postgres.stop()
}
```

With `await using`, teardown can be scoped without a `finally` block:

```ts
import { startPostgres } from 'local-postgres'

await using postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
})

Object.assign(process.env, postgres.env)
await import('./dev-server.ts')
```

This pattern keeps the data directory stable and lets the surrounding dev tool
decide whether `process.env` should be mutated.

## Test Fixtures

Use a temporary data directory when each test run should start from an empty
cluster:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPostgres } from 'local-postgres'

const dataDir = await mkdtemp(join(tmpdir(), 'app-postgres-'))
const postgres = await startPostgres({
  dataDir,
  database: 'app_test',
})

try {
  await runMigrations(postgres.connectionString)
  await runTests(postgres.connectionString)
} finally {
  await postgres.stop()
  await rm(dataDir, { recursive: true, force: true })
}
```

`local-postgres` stops the server process. It does not remove the data
directory, so the fixture owns cleanup.

## Child Process Commands

Pass `postgres.env` to tools that already read `DATABASE_URL` or `PG*`
variables:

```ts
import { spawn } from 'node:child_process'
import { startPostgres } from 'local-postgres'

const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
})

try {
  const child = spawn('pnpm', ['run', 'migrate'], {
    env: {
      ...process.env,
      ...postgres.env,
    },
    stdio: 'inherit',
  })

  await new Promise((resolve, reject) => {
    child.once('exit', (code) => {
      code === 0 ? resolve(undefined) : reject(new Error(`migrate exited ${code}`))
    })
    child.once('error', reject)
  })
} finally {
  await postgres.stop()
}
```

This keeps the parent process environment unchanged while giving the child
command everything it needs to connect.

## Logging

Postgres stdout and stderr are ignored by default. Developer tools that should
stay quiet when startup succeeds can retain a bounded diagnostic tail only for
startup failures:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  log: 'on-error',
})
```

`on-error` keeps the newest 64 KiB of combined Postgres stdout and stderr in
memory during startup. If startup fails, `LocalPostgresError.diagnostics`
contains that output and the error message prints it under `Postgres
diagnostics:`. The buffer is discarded after successful readiness.

Use a file when output from the whole server lifetime needs inspection after a
run:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  log: {
    filePath: '.postgres/postgres.log',
  },
})
```

Use `inherit` when the process should write directly to the current terminal:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  log: 'inherit',
})
```

`ignore`, `inherit`, and file targets retain their existing behavior.
`local-postgres` creates the log file parent directory when needed.

## Shutdown

`stop()` first sends `SIGINT`. If the process has not exited after
`stopTimeoutMs`, it sends `SIGTERM` and waits one more timeout interval.

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  stopTimeoutMs: 10_000,
})
```

Calling `stop()` more than once is safe. If startup fails after the process has
been spawned, `local-postgres` attempts to stop it before rejecting.
