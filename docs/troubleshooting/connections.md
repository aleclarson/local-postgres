# Connection Troubleshooting

> Separate listener allocation failures from database and role setup failures;
> they happen on opposite sides of PostgreSQL readiness.

## `Port 54321 is not available on 127.0.0.1`

A fixed port is already bound before PostgreSQL starts. Verify its owner:

```sh
lsof -nP -iTCP:54321 -sTCP:LISTEN
```

Fix one of these:

- stop the process that intentionally owns the port
- choose a different fixed port
- omit `port` and use the returned `postgres.port`

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
})

console.log(postgres.port)
```

See [Listeners](../features/listeners.md) before choosing a fixed address for
tests or concurrent tools.

## Database or Role Creation Fails

PostgreSQL is ready, but post-start setup failed. `local-postgres` connects as
the operating-system username used during bootstrap, then creates the selected
database and optional development superuser.

Retain the server log while reproducing setup failures:

```ts
await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
  superuser: {
    name: 'app',
    password: 'postgres',
  },
  postgresOutput: {
    filePath: '.postgres/postgres.log',
  },
})
```

Verify that the cluster was initialized by compatible local tooling and that
its files are writable by the current user. For disposable development state,
a fresh data directory is usually the smallest recovery. Preserve and repair
valuable state deliberately.

See [Databases and Roles](../features/databases-and-roles.md) for bootstrap
identity and returned credentials.
