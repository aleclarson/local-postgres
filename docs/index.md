# local-postgres

> Use `local-postgres` when a Node.js script needs a real local PostgreSQL
> server without taking a dependency on Docker, a framework plugin, or global
> process environment mutation.

`local-postgres` starts and stops a PostgreSQL server from JavaScript. It uses
Postgres binaries already installed on the machine by default, and it can opt
into cached managed binaries from the `@embedded-postgres/*` npm packages when a
project needs a specific Postgres version.

It is designed for local development, tests, examples, migrations, demos, and
developer tooling. It is not a production process manager.

## Start Here

| Task                                                   | Page                                               |
| ------------------------------------------------------ | -------------------------------------------------- |
| Install Postgres and start a first server              | [Getting Started](getting-started.md)              |
| Reuse a server in tests, CLIs, or dev tools            | [Lifecycle Patterns](guides/lifecycle-patterns.md) |
| Choose local binaries or managed downloads             | [Postgres Binaries](guides/postgres-binaries.md)   |
| Look up every option and returned field                | [API Reference](reference/api.md)                  |
| Diagnose startup, port, version, and download failures | [Troubleshooting](troubleshooting.md)              |

## What It Manages

`startPostgres` handles the local server lifecycle around one data directory:

- creates the data directory when it is missing
- runs `initdb` when the directory is not already a Postgres cluster
- starts `postgres` on a TCP host and port
- waits until the server accepts client connections
- creates or updates an optional superuser role
- creates the requested database when it does not exist
- returns connection details and `PG*` environment values
- stops the process when `server.stop()` is called

The returned environment values are plain data. `local-postgres` does not mutate
`process.env` for you.

```ts
import { startPostgres } from 'local-postgres'

const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
  superuser: {
    name: 'app',
    password: 'postgres',
  },
})

console.log(postgres.connectionString)
console.log(postgres.env.DATABASE_URL)

await postgres.stop()
```

## What It Does Not Manage

`local-postgres` deliberately leaves application-specific behavior to the
caller:

- migrations, schema creation, and seed data
- test runner hooks and teardown policy
- framework-specific environment injection
- data directory cleanup
- production service supervision
- backups, replication, access control hardening, or remote hosting

For example, a Vite plugin, migration CLI, or test fixture can decide when to
copy `postgres.env` into `process.env`:

```ts
Object.assign(process.env, postgres.env)
```

Keep that mutation near the tool or framework integration that needs it.
