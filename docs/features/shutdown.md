# Shutdown

> The component that starts a server should own its shutdown, while the core
> API supports explicit cross-process cleanup when ownership must be recovered.

## Stop the Returned Server

Call `stop()` from the same scope that called `startPostgres`:

```ts
const postgres = await startPostgres({ dataDir: '.postgres' })

try {
  await runApplication(postgres.connectionString)
} finally {
  await postgres.stop()
}
```

Calling `stop()` more than once is safe. Startup failures after spawn also
attempt to stop the child before rejecting.

The managed child first receives `SIGINT`. If it remains alive after
`stopTimeoutMs`, it receives `SIGTERM` and gets one more timeout interval:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  stopTimeoutMs: 10_000,
})
```

## Use Explicit Resource Management

Runtimes with explicit resource management can bind shutdown to a lexical
scope:

```ts
await using postgres = await startPostgres({
  dataDir: '.postgres',
})

await runApplication(postgres.connectionString)
```

Leaving the scope calls the same idempotent `stop()` operation.

## Stop by Data Directory

The core API can stop a server from a different process by reading
`postmaster.pid`:

```ts
import { stopPostgresDataDir } from 'local-postgres/core'

await stopPostgresDataDir({
  dataDir: '.postgres',
  mode: 'fast',
  timeoutMs: 10_000,
})
```

| Mode        | PostgreSQL signal | Intent                                                     |
| ----------- | ----------------- | ---------------------------------------------------------- |
| `smart`     | `SIGTERM`         | Wait for clients to disconnect.                            |
| `fast`      | `SIGINT`          | Roll back active work and disconnect clients; the default. |
| `immediate` | `SIGQUIT`         | Stop without normal shutdown processing.                   |

Use this only when the caller intentionally owns that cluster. Startup itself
never adopts or stops an existing live server.

## Wait for Idle Connections

Cross-process shutdown can wait for connection counts before signaling:

```ts
await stopPostgresDataDir({
  dataDir: '.postgres',
  listen: { type: 'tcp', host: '127.0.0.1', port: 54329 },
  waitForIdle: {
    database: 'app_dev',
    minConnections: 0,
    timeoutMs: 30_000,
  },
})
```

`listen` is required when `waitForIdle` is enabled. See
[Core Lifecycle API](core-lifecycle-api.md) for the lower-level ownership model.
