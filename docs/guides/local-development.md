# Local Development

> A persistent development cluster keeps data between runs while the calling
> tool remains responsible for environment injection and process teardown.

Use a stable data directory when migrations, seed data, and application state
should survive restarts:

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
  log: 'on-error',
})

try {
  Object.assign(process.env, postgres.env)
  await import('./dev-server.ts')
} finally {
  await postgres.stop()
}
```

The first run initializes `.postgres`; later runs reuse the same cluster and
database. Add `.postgres` to the application's ignored files when the cluster
is machine-local.

Use `await using` when the runtime supports explicit resource management:

```ts
await using postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
  log: 'on-error',
})

Object.assign(process.env, postgres.env)
await import('./dev-server.ts')
```

Keep the environment mutation near the development tool that needs it.
`local-postgres` returns environment values but never mutates `process.env`.

For the choices behind this setup, see [Data Directories](../features/data-directories.md),
[Databases and Roles](../features/databases-and-roles.md), and
[Logging](../features/logging.md).
