# local-postgres

A lightweight Node.js utility for managing a local development PostgreSQL
process using the Postgres binaries already installed on your machine.

It starts a real TCP Postgres server from JavaScript without Docker, without
bundling Postgres binaries, and without requiring a framework. It is intended
for local development and scripting: local CLIs, examples, tests, migrations,
demos, and development tools that need a temporary or per-project Postgres
server.

It is not intended for production.

## Install

```sh
pnpm add local-postgres
```

## Requirements

`local-postgres` shells out to local Postgres tools. These binaries must be on
`PATH`:

- `initdb`
- `postgres`
- `createdb`
- `pg_isready`
- `psql` when using `superuser`

Install Postgres with your platform package manager, such as Homebrew,
Postgres.app, apt, yum, or the official PostgreSQL installers. This package does
not download or bundle Postgres.

## Usage

```ts
import { startPostgres } from 'local-postgres'

const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'example_dev',
  port: 54329,
  superuser: {
    name: 'example',
    password: 'postgres',
  },
})

console.log(postgres.connectionString)
console.log(postgres.env)

try {
  // Run migrations, tests, demos, scripts, or local tools here.
} finally {
  await postgres.stop()
}
```

When `port` is omitted, `local-postgres` picks an available local port before
starting Postgres.

```ts
const postgres = await startPostgres({
  dataDir: '/tmp/my-tool-postgres',
  database: 'my_tool',
})
```

## What It Does

- Creates the data directory when needed.
- Runs `initdb` when the data directory does not contain a Postgres cluster.
- Starts a real local TCP Postgres server on `127.0.0.1` by default.
- Uses a requested port or picks an available port.
- Creates the requested database when it does not already exist.
- Optionally creates or updates a superuser role.
- Returns connection details, `DATABASE_URL`, and standard `PG*` environment
  variables without mutating `process.env`.
- Provides an explicit async `stop()` method for shutdown.

Framework integrations can decide how to use the returned values:

```ts
Object.assign(process.env, postgres.env)
```

## API

```ts
import { startPostgres } from 'local-postgres'
```

### `startPostgres(options)`

Required options:

- `dataDir`: directory for the Postgres data cluster. It can be new or already
  initialized.

Common options:

- `database`: database name to create or reuse. Defaults to `postgres`.
- `port`: specific TCP port. When omitted, an available port is selected.
- `host`: TCP host. Defaults to `127.0.0.1`.
- `superuser`: `{ name, password }` role to create or update and expose through
  returned connection details.
- `log`: `'ignore'`, `'inherit'`, or `{ filePath }` for Postgres stdout/stderr.
- `logger`: optional `{ info, warn, error }` lifecycle logger.
- `readinessTimeoutMs`: maximum wait for `pg_isready`. Defaults to `3000`.
- `readinessIntervalMs`: delay between readiness checks. Defaults to `100`.
- `stopTimeoutMs`: shutdown wait after each signal. Defaults to `5000`.

The returned server object includes:

- `host`, `port`, `database`, `dataDir`
- `user` and `password` when `superuser` is set
- `connectionString`
- `env` with `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, `PGDATA`, and
  optional `PGUSER`/`PGPASSWORD`
- `pid`
- `stop()`

## Positioning

`local-postgres` fills a smaller niche than Docker-based tooling and a different
one than embedded Postgres-compatible runtimes:

- Docker and Testcontainers are more isolated and production-like, but heavier
  and require Docker.
- PGlite and WASM Postgres are easier to embed, but they are not the same as
  running a real local Postgres server.
- Postgres clients and ORMs connect to a server, but do not create or manage
  one.
- Framework plugins can be convenient, but process lifecycle management is
  useful outside any one framework.

Wrappers such as `vite-postgres` should own framework-specific behavior:
framework root defaults, env mutation, dev-server shutdown hooks, and seed
module loading.
