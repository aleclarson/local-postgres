# Databases and Roles

> Choose the database exposed to callers and whether development clients need
> a dedicated superuser instead of the bootstrap operating-system user.

## Select a Database

`database` defaults to `postgres`. A different name is created after the server
becomes ready when it does not already exist:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
})
```

The selected name appears in `postgres.database`, `connectionString`,
`env.PGDATABASE`, and `env.DATABASE_URL`.

## Create a Development Superuser

Set `superuser` when application tools need stable credentials:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
  superuser: {
    name: 'app',
    password: 'postgres',
  },
})
```

After readiness, `local-postgres` creates the role or updates its password and
ensures it has `LOGIN SUPERUSER`. Returned connection details then include the
role:

| Field                       | Value source                              |
| --------------------------- | ----------------------------------------- |
| `postgres.user`             | `superuser.name`                          |
| `postgres.password`         | `superuser.password`                      |
| `postgres.env.PGUSER`       | `superuser.name`                          |
| `postgres.env.PGPASSWORD`   | `superuser.password`                      |
| `postgres.connectionString` | Selected database and encoded credentials |

This convenience is intended for local development and tests, not production
access control.

## Understand Bootstrap Identity

The cluster is initialized with the current operating-system username. That
bootstrap identity starts the server and performs database and role setup.
Without `superuser`, client connection details omit explicit credentials and
use the local PostgreSQL authentication behavior.

See [Child Processes](../guides/child-processes.md) for passing the returned
environment to a CLI and [Connection Troubleshooting](../troubleshooting/connections.md)
when database or role setup fails.
