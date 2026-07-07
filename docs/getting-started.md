# Getting Started

> A first `local-postgres` setup needs Node.js, Postgres binaries on `PATH`, one
> data directory, and a `try`/`finally` block that always stops the server.

## Requirements

`local-postgres` requires Node.js 18 or newer.

By default, these PostgreSQL binaries must be available on `PATH`:

- `initdb`
- `postgres`

Install PostgreSQL with your platform package manager or installer. Common
choices include Homebrew, Postgres.app, apt, yum, and the official PostgreSQL
installers.

Verify the two commands before using the package:

```sh
postgres --version
initdb --version
```

If either command is missing, install PostgreSQL or use managed binaries as
described in [Postgres Binaries](guides/postgres-binaries.md).

## Install

```sh
pnpm add local-postgres
```

Use the package manager for your project. The runtime API is the same whether
the package is installed with pnpm, npm, or yarn.

## Start a Server

Create a script that starts the server, uses the connection details, and stops
the process in `finally`:

```ts
import { startPostgres } from 'local-postgres'

const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'example_dev',
  superuser: {
    name: 'example',
    password: 'postgres',
  },
})

try {
  console.log(postgres.connectionString)
  console.log(postgres.env)

  // Run migrations, seed data, tests, demos, or local tools here.
} finally {
  await postgres.stop()
}
```

When the script runs for the first time, `local-postgres` initializes
`.postgres`. Later runs reuse the same cluster and create the requested database
only when it does not already exist.

## Pick a Port

Omit `port` when the script can use any available local port:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'example_dev',
})

console.log(`Postgres is listening on ${postgres.host}:${postgres.port}`)
```

Pass a fixed port when another tool expects a stable address:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'example_dev',
  port: 54329,
})
```

If the fixed port is already taken, `startPostgres` rejects before it initializes
or starts a server.

## Connect a Client

Use `connectionString` with clients that accept a URL:

```ts
import { Client } from 'pg'
import { startPostgres } from 'local-postgres'

const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'example_dev',
})

try {
  const client = new Client({
    connectionString: postgres.connectionString,
  })

  await client.connect()
  await client.query('select 1')
  await client.end()
} finally {
  await postgres.stop()
}
```

Use `postgres.env` for CLIs that read `DATABASE_URL` or standard `PG*`
variables:

```ts
import { spawn } from 'node:child_process'

const child = spawn('pnpm', ['run', 'migrate'], {
  env: {
    ...process.env,
    ...postgres.env,
  },
  stdio: 'inherit',
})
```

The object includes `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, and
`PGDATA`. It includes `PGUSER` and `PGPASSWORD` when `superuser` is set.
