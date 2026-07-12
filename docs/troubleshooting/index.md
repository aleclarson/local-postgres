# Troubleshooting

> Start with the failed lifecycle stage, inspect the local fact that controls
> it, and change only the option or environment value responsible.

Most failures happen before `startPostgres` returns. Stop a server only after
startup succeeds:

```ts
let postgres: Awaited<ReturnType<typeof startPostgres>> | undefined

try {
  postgres = await startPostgres({
    dataDir: '.postgres',
    database: 'app_dev',
    postgresOutput: 'on-error',
  })
} finally {
  await postgres?.stop()
}
```

`postgresOutput: 'on-error'` keeps successful startup quiet and attaches a bounded tail of
Postgres output to startup errors.

| Symptom                                                 | Diagnose                                |
| ------------------------------------------------------- | --------------------------------------- |
| Spawn failure, early exit, or readiness timeout         | [Startup](startup.md)                   |
| Live `postmaster.pid`, stale state, or version mismatch | [Data Directories](data-directories.md) |
| Missing commands, downloads, or unsupported platforms   | [Binaries](binaries.md)                 |
| Unavailable port, database creation, or role setup      | [Connections](connections.md)           |

Operational failures use `LocalPostgresError`. A live data-directory owner uses
the more specific `PostgresDataDirInUseError`, which exposes `dataDir` and
`pid`.
