# local-postgres

A lightweight Node.js utility for managing a local development PostgreSQL
process using Postgres binaries already installed on your machine, with an
opt-in managed binary fallback.

It starts a real TCP Postgres server from JavaScript without Docker and without
requiring a framework. By default, it uses local Postgres binaries on `PATH`.
When configured, it can download cached `@embedded-postgres/*` npm binary
packages if local Postgres is missing or does not match the requested version.
It is intended for local development and scripting: local CLIs, examples, tests,
migrations, demos, and development tools that need a temporary or per-project
Postgres server.

It is not intended for production.

## Install

```sh
pnpm add local-postgres
```

## Requirements

Node.js 18 or newer is required.

By default, `local-postgres` shells out to local Postgres tools. These binaries
must be on `PATH`:

- `initdb`
- `postgres`

Install Postgres with your platform package manager, such as Homebrew,
Postgres.app, apt, yum, or the official PostgreSQL installers. This package does
not download anything unless `postgres.strategy` allows managed downloads.

Managed downloads use the platform packages already published under
`@embedded-postgres/*` on npm. Downloaded packages are cached in
`path.join(os.homedir(), ".local-postgres")` by default, and tarballs are
verified against npm integrity metadata before extraction.

Set `LOCAL_POSTGRES_SKIP_DOWNLOAD=1` to prevent managed downloads.

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

To require a Postgres major version and download a managed package when local
binaries are missing or incompatible:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'example_dev',
  postgres: {
    version: '18',
    strategy: 'prefer-local',
  },
})
```

## What It Does

- Creates the data directory when needed.
- Runs `initdb` when the data directory does not contain a Postgres cluster.
- Starts a real local TCP Postgres server on `127.0.0.1` by default.
- Optionally verifies local Postgres versions and downloads managed server
  binaries when configured.
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
- `postgres`: binary resolution options. Omit for local-only behavior.
- `logger`: optional `{ info, warn, error }` lifecycle logger.
- `readinessTimeoutMs`: maximum wait for Postgres to accept client connections.
  Defaults to `3000`.
- `readinessIntervalMs`: delay between readiness checks. Defaults to `100`.
- `stopTimeoutMs`: shutdown wait after each signal. Defaults to `5000`.

### `postgres` Options

```ts
await startPostgres({
  dataDir: '.postgres',
  postgres: {
    cacheDir: '/tmp/local-postgres-cache',
    strategy: 'prefer-local',
    version: '18',
  },
})
```

- `version`: required Postgres version. A major version such as `18` accepts any
  matching major version. More specific values require matching components.
- `strategy`: one of `'local-only'`, `'prefer-local'`, `'prefer-download'`, or
  `'download-only'`. Defaults to `'prefer-local'` when `postgres` is provided.
- `cacheDir`: managed binary cache directory. Defaults to
  `path.join(os.homedir(), ".local-postgres")`.

When `postgres` is omitted, the strategy is effectively `'local-only'` and no
version check or download is attempted.

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
