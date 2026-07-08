# API Reference

> This page is the lookup boundary for the public API exported by
> `local-postgres` and `local-postgres/core`: the friendly `startPostgres`
> entry point, the lower-level cluster lifecycle primitives, and related types.

Import from the package root:

```ts
import { DEFAULT_POSTGRES_CACHE_DIR, LocalPostgresError, startPostgres } from 'local-postgres'
```

Import lower-level lifecycle primitives from `local-postgres/core`:

```ts
import {
  ensurePostgresDatabase,
  getPostgresVersion,
  initPostgresDataDir,
  resolvePostgresBinaries,
  startPostgresDataDir,
  stopPostgresDataDir,
  waitForPostgresReady,
} from 'local-postgres/core'
```

## `startPostgres(options)`

Starts a local PostgreSQL server and resolves after the server accepts client
connections and requested setup is complete.

```ts
const server = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
})
```

| Option                | Type                                            | Default                | Notes                                                                                                   |
| --------------------- | ----------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `dataDir`             | `string`                                        | Required               | Directory for the Postgres data cluster. Created when missing. Initialized when `PG_VERSION` is absent. |
| `database`            | `string`                                        | `postgres`             | Database to create when it does not exist and expose in connection details.                             |
| `port`                | `number`                                        | Available local port   | Must be an integer from `1` to `65535`. Fixed ports are probed before startup.                          |
| `host`                | `string`                                        | `127.0.0.1`            | Host passed to `postgres -h` and used by clients.                                                       |
| `listen`              | `PostgresListenOptions`                         | TCP from `host`/`port` | Lower-level listen shape. Do not combine with `host` or `port`.                                         |
| `config`              | `Record<string, string \| number \| boolean>`   | None                   | Appended to `postgresql.conf` after a new cluster is initialized. Existing clusters are not changed.    |
| `superuser`           | `{ name: string; password: string }`            | None                   | Role to create or update with `LOGIN SUPERUSER`; included in returned connection details.               |
| `log`                 | `'ignore' \| 'inherit' \| { filePath: string }` | `ignore`               | Controls Postgres stdout and stderr. File parent directories are created.                               |
| `postgres`            | `PostgresBinaryOptions`                         | Local-only behavior    | Enables binary version checks and, depending on strategy, managed downloads.                            |
| `logger`              | `Partial<LocalPostgresLogger>`                  | No-op methods          | Receives lifecycle `info`, `warn`, and `error` messages.                                                |
| `readinessTimeoutMs`  | `number`                                        | `3000`                 | Maximum time to wait for client readiness.                                                              |
| `readinessIntervalMs` | `number`                                        | `100`                  | Delay between readiness checks.                                                                         |
| `stopTimeoutMs`       | `number`                                        | `5000`                 | Wait after each shutdown signal.                                                                        |

`dataDir`, `database`, and `host` must not be empty strings. Invalid `port`
values throw a `RangeError`.

Use `listen` for socket mode:

```ts
const server = await startPostgres({
  dataDir: '/tmp/app-postgres/17',
  listen: {
    type: 'socket',
    socketDir: '/tmp/app-postgres/17',
  },
})
```

## `postgres` Options

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

| Option     | Type                     | Default                                                 | Notes                                                                             |
| ---------- | ------------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `version`  | `string`                 | Latest managed package, or no local version requirement | Required Postgres version. Major versions such as `18` accept any matching major. |
| `strategy` | `PostgresBinaryStrategy` | `prefer-local` when `postgres` is provided              | Chooses between local binaries and managed downloads.                             |
| `cacheDir` | `string`                 | `DEFAULT_POSTGRES_CACHE_DIR`                            | Directory for extracted managed binary packages.                                  |

`PostgresBinaryStrategy` is one of:

```ts
type PostgresBinaryStrategy = 'local-only' | 'prefer-local' | 'prefer-download' | 'download-only'
```

See [Postgres Binaries](../guides/postgres-binaries.md) for strategy behavior.

## Returned Server

`startPostgres` resolves with a `LocalPostgresServer`:

| Field                     | Type                            | Notes                                                  |
| ------------------------- | ------------------------------- | ------------------------------------------------------ |
| `dataDir`                 | `string`                        | The data directory passed to `startPostgres`.          |
| `database`                | `string`                        | The database exposed to callers.                       |
| `listen`                  | `ResolvedPostgresListenOptions` | Normalized TCP or socket listen details.               |
| `host`                    | `string`                        | The host used for the server and connection details.   |
| `port`                    | `number`                        | The fixed or selected port.                            |
| `socketDir`               | `string \| undefined`           | Present for socket-mode servers.                       |
| `user`                    | `string \| undefined`           | Present when `superuser` is set.                       |
| `password`                | `string \| undefined`           | Present when `superuser` is set.                       |
| `pid`                     | `number \| undefined`           | Child process id from `spawn`.                         |
| `connectionString`        | `string`                        | PostgreSQL URL with database and optional credentials. |
| `env`                     | `LocalPostgresEnv`              | Environment values for clients and child processes.    |
| `stop()`                  | `() => Promise<void>`           | Stops the server process. Safe to call more than once. |
| `[Symbol.asyncDispose]()` | `() => Promise<void>`           | Supports `await using` by delegating to `stop()`.      |

`connectionString` URL-encodes credentials and the database name. IPv6 hosts are
wrapped in brackets when needed.

## Returned Environment

`LocalPostgresEnv` always includes:

| Field          | Value                                            |
| -------------- | ------------------------------------------------ |
| `DATABASE_URL` | Same value as `server.connectionString`.         |
| `PGDATA`       | Data directory path.                             |
| `PGDATABASE`   | Database name.                                   |
| `PGHOST`       | Server host, or socket directory in socket mode. |
| `PGPORT`       | Server port as a string.                         |

When `superuser` is set, it also includes:

| Field        | Value                |
| ------------ | -------------------- |
| `PGUSER`     | `superuser.name`     |
| `PGPASSWORD` | `superuser.password` |

## `LocalPostgresError`

Operational failures use `LocalPostgresError`. Examples include missing
binaries, incompatible versions, unavailable ports, startup timeout, failed
managed downloads, and database or role creation failures.

Some validation failures use built-in errors instead:

- empty `dataDir`, `database`, or `host`: `TypeError`
- invalid `port`: `RangeError`

## `DEFAULT_POSTGRES_CACHE_DIR`

`DEFAULT_POSTGRES_CACHE_DIR` is the managed binary cache directory used when
`postgres.cacheDir` is omitted:

```ts
import { DEFAULT_POSTGRES_CACHE_DIR } from 'local-postgres'

console.log(DEFAULT_POSTGRES_CACHE_DIR)
```

The value is `path.join(os.homedir(), '.local-postgres')`.

## Core Entry Point

`local-postgres/core` exposes the reusable cluster lifecycle engine without
owning the caller's outer directory layout, pooling policy, delayed cleanup, or
package-specific lifecycle rules.

All core functions treat `dataDir` as the actual PostgreSQL cluster directory:
the directory that contains `PG_VERSION`, `postgresql.conf`, and the rest of the
cluster files. If a caller has an outer workspace directory, pass only the
versioned cluster directory to core functions.

```txt
/tmp/pg_tmp.abc123/
  NEW
  initdb.log
  17.0/
    PG_VERSION
    postgresql.conf
```

For that layout, pass `/tmp/pg_tmp.abc123/17.0` as `dataDir`.

## `PostgresListenOptions`

Core functions use one listen shape for TCP and Unix sockets:

```ts
type PostgresListenOptions =
  | {
      type: 'tcp'
      host?: string
      port?: number
    }
  | {
      type: 'socket'
      socketDir: string
      port?: number
    }
```

TCP startup picks an available local port when `port` is omitted. Socket mode
defaults to port `5432`, which controls the socket filename.

## `resolvePostgresBinaries(options?)`

Resolves the same local or managed Postgres binaries used by the lifecycle
helpers:

```ts
const binaries = await resolvePostgresBinaries({
  strategy: 'prefer-local',
  version: '18',
})
```

The result includes `postgres`, `initdb`, optional support tools such as
`pgCtl`, `createdb`, and `psql`, the binary `source`, and the resolved
`version` when known.

## `getPostgresVersion(options?)`

Returns the resolved `postgres` binary version before a data directory exists:

```ts
const version = await getPostgresVersion({
  postgres: {
    version: '18',
  },
})
```

Use this when the caller needs to choose a versioned cluster path before
initializing it.

## `initPostgresDataDir(options)`

Creates `dataDir` when needed and runs `initdb` only when `PG_VERSION` is
absent:

```ts
await initPostgresDataDir({
  dataDir: '/tmp/pg_tmp.abc123/17.0',
  noSync: true,
  auth: 'trust',
  encoding: 'UNICODE',
  locale: false,
  config: {
    unix_socket_directories: '/tmp/pg_tmp.abc123/17.0',
    listen_addresses: '',
    shared_buffers: '12MB',
    fsync: false,
  },
})
```

`config` values are appended to `postgresql.conf` only after a new cluster is
initialized. String values are written as PostgreSQL string literals, numbers
are written as numbers, and booleans are written as `on` or `off`.

## `startPostgresDataDir(options)`

Starts an already initialized cluster and resolves after readiness checks pass:

```ts
const process = await startPostgresDataDir({
  dataDir: '/tmp/pg_tmp.abc123/17.0',
  listen: {
    type: 'socket',
    socketDir: '/tmp/pg_tmp.abc123/17.0',
  },
  log: {
    filePath: '/tmp/pg_tmp.abc123/postgres.log',
  },
})
```

Socket mode starts Postgres with `-k <socketDir>` and `-h ''`, then checks
readiness through the socket directory. The returned `LocalPostgresProcess`
contains normalized `listen` details, `pid`, and an idempotent `stop()` method
for the retained child process.

## `stopPostgresDataDir(options)`

Stops a running cluster by data directory using `pg_ctl stop`:

```ts
await stopPostgresDataDir({
  dataDir: '/tmp/pg_tmp.abc123/17.0',
  mode: 'fast',
  timeoutMs: 5000,
})
```

This does not remove `dataDir`. Cleanup of any outer root directory remains the
caller's responsibility.

Set `waitForIdle` to wait for active connections to drain before `pg_ctl stop`:

```ts
await stopPostgresDataDir({
  dataDir: '/tmp/pg_tmp.abc123/17.0',
  listen: {
    type: 'socket',
    socketDir: '/tmp/pg_tmp.abc123/17.0',
  },
  waitForIdle: {
    database: 'test',
    timeoutMs: 10_000,
  },
})
```

## `waitForPostgresReady(options)`

Polls with `pg` until a server accepts connections:

```ts
await waitForPostgresReady({
  listen: {
    type: 'socket',
    socketDir: '/tmp/pg_tmp.abc123/17.0',
  },
  database: 'postgres',
})
```

This helper is useful when another process starts Postgres but the caller still
wants the same readiness behavior.

## `ensurePostgresDatabase(options)`

Creates a database when it does not already exist:

```ts
await ensurePostgresDatabase({
  listen: {
    type: 'socket',
    socketDir: '/tmp/pg_tmp.abc123/17.0',
  },
  database: 'test',
})
```

The helper connects to `bootstrapDatabase`, defaulting to `postgres`, and uses a
plain `CREATE DATABASE` statement only when the database is absent.
