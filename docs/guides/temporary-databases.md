# Temporary Databases

> Use `local-postgres/tmp` when one test run or short-lived tool should own an
> isolated cluster and remove its files after shutdown.

The temporary entry point creates a container under the operating system's
temporary directory. PostgreSQL stores its cluster in the container's `data`
child directory, and the returned `dsn` connects to a database named `test`.

## Own Cleanup in the Current Process

Disable the background timeout when a `finally` block or explicit resource
management owns cleanup:

```ts
import { start } from 'local-postgres/tmp'

await using postgres = await start({ timeout: 0 })

await runMigrations(postgres.dsn)
await runTests(postgres.dsn)
```

Leaving the scope stops PostgreSQL and removes the temporary container. The
same lifecycle works without explicit resource management:

```ts
const postgres = await start({ timeout: 0 })

try {
  await runTests(postgres.dsn)
} finally {
  await postgres.stop()
}
```

Use this form when the current process is expected to reach its cleanup path.

## Recover Cleanup After the Parent Exits

`timeout` defaults to 60 seconds. When it is positive, `start()` launches a
detached worker that survives the parent process:

```ts
const postgres = await start({ timeout: 30 })
console.log(postgres.dsn)
```

After 30 seconds, the worker stops an idle server and removes its container. If
clients are still connected, it checks again every 30 seconds. The worker is
bound to the original PostgreSQL process ID, so it cannot stop a newer server
that later reuses the same container.

Set `keep: true` to stop PostgreSQL without removing the files:

```ts
const postgres = await start({ keep: true, timeout: 30 })
```

The background worker writes lifecycle output to `stop.log` in the container.
PostgreSQL output is retained in `data/postgres.log`.

## Choose a Listener

Unix sockets inside the temporary container are the default. Use TCP when a
client cannot accept the socket connection string:

```ts
const postgres = await start({
  host: true,
  timeout: 0,
})

console.log(postgres.dsn)
// postgresql://127.0.0.1:<available-port>/test
```

Pass a host string or `port` only when the client requires that specific TCP
address.

## Use Managed Postgres Binaries

Temporary servers use the same binary resolution policy as the other entry
points. Opt into a managed version when local binaries are unavailable or the
test requires a specific major version:

```ts
const postgres = await start({
  postgres: {
    version: '18',
    strategy: 'prefer-download',
  },
  timeout: 0,
})
```

See [Postgres Binaries](../features/postgres-binaries.md) for download and cache
behavior.

## Control Prewarming

When `dataDir` is omitted, `start()` can claim a compatible cluster initialized
by an earlier call. It then initializes one replacement in a detached worker so
the next startup can skip `initdb`.

Pass `prewarm: false` when a process should not leave a prepared cluster in the
operating system's temporary directory:

```ts
const postgres = await start({
  prewarm: false,
  timeout: 0,
})
```

Concurrent calls claim a prepared cluster atomically; each running server owns
a different container.

Use the root `local-postgres` entry point instead when the application owns a
stable data directory, a named database other than `test`, custom roles, or
standard `PG*` environment values.
