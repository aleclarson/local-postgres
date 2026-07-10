# Test Fixtures

> An isolated fixture owns a temporary data directory, the server lifecycle,
> application setup, and cleanup in one scope.

Create a new directory when each test run should start from an empty cluster:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startPostgres } from 'local-postgres'

const dataDir = await mkdtemp(join(tmpdir(), 'app-postgres-'))
const postgres = await startPostgres({
  dataDir,
  database: 'app_test',
  log: 'on-error',
})

try {
  await runMigrations(postgres.connectionString)
  await runTests(postgres.connectionString)
} finally {
  await postgres.stop()
  await rm(dataDir, { recursive: true, force: true })
}
```

`local-postgres` stops the process but does not remove the data directory. Stop
the server before removing the directory so PostgreSQL can finish shutdown
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
