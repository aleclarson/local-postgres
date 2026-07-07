# local-postgres

A lightweight Node.js utility for starting and stopping a real local PostgreSQL
server from JavaScript.

`local-postgres` is designed for local development, tests, examples, migrations,
demos, and developer tooling that need Postgres without Docker or a framework
plugin. It uses locally installed Postgres binaries by default, with opt-in
managed binary downloads when a project needs a specific Postgres version.

It is not intended for production.

## Install

```sh
pnpm add local-postgres
```

## Quick Start

```ts
import { startPostgres } from 'local-postgres'

const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'example_dev',
})

try {
  console.log(postgres.connectionString)

  // Run migrations, tests, demos, scripts, or local tools here.
} finally {
  await postgres.stop()
}
```

The returned server includes connection details and standard `PG*` environment
values without mutating `process.env`.

## Documentation

| Task                                                   | Page                                                    |
| ------------------------------------------------------ | ------------------------------------------------------- |
| Install Postgres and start a first server              | [Getting Started](docs/getting-started.md)              |
| Reuse a server in tests, CLIs, or dev tools            | [Lifecycle Patterns](docs/guides/lifecycle-patterns.md) |
| Choose local binaries or managed downloads             | [Postgres Binaries](docs/guides/postgres-binaries.md)   |
| Look up every option and returned field                | [API Reference](docs/reference/api.md)                  |
| Diagnose startup, port, version, and download failures | [Troubleshooting](docs/troubleshooting.md)              |

## Scope

`local-postgres` owns the local server lifecycle around one data directory:
initialization, startup, readiness, connection details, and shutdown. Callers
own application-specific behavior such as migrations, seed data, framework
environment injection, test runner hooks, and data directory cleanup.
