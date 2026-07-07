# API Reference

> This page is the lookup boundary for the public API exported by
> `local-postgres`: `startPostgres`, its options, returned server fields, and
> related types.

Import from the package root:

```ts
import { DEFAULT_POSTGRES_CACHE_DIR, LocalPostgresError, startPostgres } from 'local-postgres'
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

| Option                | Type                                            | Default              | Notes                                                                                                   |
| --------------------- | ----------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------- |
| `dataDir`             | `string`                                        | Required             | Directory for the Postgres data cluster. Created when missing. Initialized when `PG_VERSION` is absent. |
| `database`            | `string`                                        | `postgres`           | Database to create when it does not exist and expose in connection details.                             |
| `port`                | `number`                                        | Available local port | Must be an integer from `1` to `65535`. Fixed ports are probed before startup.                          |
| `host`                | `string`                                        | `127.0.0.1`          | Host passed to `postgres -h` and used by clients.                                                       |
| `superuser`           | `{ name: string; password: string }`            | None                 | Role to create or update with `LOGIN SUPERUSER`; included in returned connection details.               |
| `log`                 | `'ignore' \| 'inherit' \| { filePath: string }` | `ignore`             | Controls Postgres stdout and stderr. File parent directories are created.                               |
| `postgres`            | `PostgresBinaryOptions`                         | Local-only behavior  | Enables binary version checks and, depending on strategy, managed downloads.                            |
| `logger`              | `Partial<LocalPostgresLogger>`                  | No-op methods        | Receives lifecycle `info`, `warn`, and `error` messages.                                                |
| `readinessTimeoutMs`  | `number`                                        | `3000`               | Maximum time to wait for client readiness.                                                              |
| `readinessIntervalMs` | `number`                                        | `100`                | Delay between readiness checks.                                                                         |
| `stopTimeoutMs`       | `number`                                        | `5000`               | Wait after each shutdown signal.                                                                        |

`dataDir`, `database`, and `host` must not be empty strings. Invalid `port`
values throw a `RangeError`.

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

| Field              | Type                  | Notes                                                  |
| ------------------ | --------------------- | ------------------------------------------------------ |
| `dataDir`          | `string`              | The data directory passed to `startPostgres`.          |
| `database`         | `string`              | The database exposed to callers.                       |
| `host`             | `string`              | The host used for the server and connection details.   |
| `port`             | `number`              | The fixed or selected port.                            |
| `user`             | `string \| undefined` | Present when `superuser` is set.                       |
| `password`         | `string \| undefined` | Present when `superuser` is set.                       |
| `pid`              | `number \| undefined` | Child process id from `spawn`.                         |
| `connectionString` | `string`              | PostgreSQL URL with database and optional credentials. |
| `env`              | `LocalPostgresEnv`    | Environment values for clients and child processes.    |
| `stop()`           | `() => Promise<void>` | Stops the server process. Safe to call more than once. |

`connectionString` URL-encodes credentials and the database name. IPv6 hosts are
wrapped in brackets when needed.

## Returned Environment

`LocalPostgresEnv` always includes:

| Field          | Value                                    |
| -------------- | ---------------------------------------- |
| `DATABASE_URL` | Same value as `server.connectionString`. |
| `PGDATA`       | Data directory path.                     |
| `PGDATABASE`   | Database name.                           |
| `PGHOST`       | Server host.                             |
| `PGPORT`       | Server port as a string.                 |

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
