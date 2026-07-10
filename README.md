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

Use the temporary entry point when a test or short-lived tool should own an
isolated cluster and remove it after shutdown:

```ts
import { start } from 'local-postgres/tmp'

await using postgres = await start({ timeout: 0 })
console.log(postgres.dsn)
```

## Documentation

| Task                                      | Page                                                       |
| ----------------------------------------- | ---------------------------------------------------------- |
| Install Postgres and start a first server | [Getting Started](docs/getting-started.md)                 |
| Understand a package capability           | [Features](docs/features/data-directories.md)              |
| Set up local development or tests         | [Guides](docs/guides/local-development.md)                 |
| Start an automatically cleaned-up server  | [Temporary Databases](docs/guides/temporary-databases.md)  |
| Choose local binaries or downloads        | [Postgres Binaries](docs/features/postgres-binaries.md)    |
| Diagnose a failure                        | [Troubleshooting](docs/troubleshooting/index.md)           |
| Look up every option and returned field   | Generated API documentation from the exported public types |

## Scope

The root `local-postgres` entry point owns the server lifecycle around one data
directory: initialization, startup, readiness, connection details, and
shutdown. Callers own application-specific behavior such as migrations, seed
data, framework environment injection, test runner hooks, and data directory
cleanup. The opt-in `local-postgres/tmp` entry point additionally owns a
temporary container and its cleanup policy.
