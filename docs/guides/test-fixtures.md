# Test Fixtures

> An isolated fixture owns a temporary data directory, the server lifecycle,
> application setup, and cleanup in one scope.

Use the temporary entry point when the fixture needs the standard `test`
database and automatic directory cleanup:

```ts
import { start } from 'local-postgres/tmp'

await using postgres = await start({ timeout: 0 })

await runMigrations(postgres.dsn)
await runTests(postgres.dsn)
```

See [Temporary Databases](temporary-databases.md) for detached cleanup,
prewarming, TCP listeners, and managed binaries.

Use the root entry point when the fixture needs to control the data-directory
layout, database name, role, or other lifecycle details. Create a new directory
when each test run should start from an empty cluster:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPostgres } from 'local-postgres'

const dataDir = await mkdtemp(join(tmpdir(), 'app-postgres-'))
const postgres = await startPostgres({
  dataDir,
  database: 'app_test',
  postgresOutput: 'on-error',
})

try {
  await runMigrations(postgres.connectionString)
  await runTests(postgres.connectionString)
} finally {
  await postgres.stop()
  await rm(dataDir, { recursive: true, force: true })
}
```

The root entry point stops the process but does not remove the data directory.
Stop the server before removing the directory so PostgreSQL can finish shutdown
without losing files beneath a running process.

Choose fixture scope based on the isolation the suite needs:

| Scope           | Data lifetime                  | Use when                                                        |
| --------------- | ------------------------------ | --------------------------------------------------------------- |
| Test run        | One cluster for the suite      | Tests can isolate state with schemas, transactions, or cleanup. |
| Test file       | One cluster per worker or file | Files run concurrently and need separate server state.          |
| Individual test | One cluster per case           | Complete storage isolation matters more than startup cost.      |

Use an automatically selected port unless the test harness requires a stable
address. Read the actual connection details from `connectionString` or `env`
instead of assuming port `5432`.

See [Listeners](../features/listeners.md) for isolation options and
[Logging](../features/logging.md) for quiet failure diagnostics.
