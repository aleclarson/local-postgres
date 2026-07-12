# Core Lifecycle API

> Use `local-postgres/core` when a wrapper needs to own initialization,
> readiness, database setup, or shutdown as separate operations.

Most callers should use `startPostgres`. The core entry point is for tools that
need a durable boundary between lifecycle stages or must reuse already resolved
binaries.

| Operation                 | Responsibility                                            |
| ------------------------- | --------------------------------------------------------- |
| `resolvePostgresBinaries` | Select local or managed `initdb` and `postgres` binaries. |
| `getPostgresVersion`      | Resolve `postgres` and return its parsed version.         |
| `initPostgresDataDir`     | Create or validate a cluster without starting it.         |
| `startPostgresDataDir`    | Start an existing cluster and wait for readiness.         |
| `waitForPostgresReady`    | Probe a server that the caller already owns.              |
| `ensurePostgresDatabase`  | Create a database through an existing listener.           |
| `stopPostgresDataDir`     | Stop an owned cluster by its `postmaster.pid`.            |

## Separate Initialization from Startup

Initialize configuration once, then start the cluster with a listener chosen
by the wrapper:

```ts
import { initPostgresDataDir, startPostgresDataDir } from 'local-postgres/core'

const dataDir = '.postgres/18'

await initPostgresDataDir({
  dataDir,
  auth: 'trust',
  encoding: 'UTF8',
  locale: false,
  config: {
    shared_buffers: '128MB',
  },
  postgres: {
    version: '18',
    strategy: 'prefer-local',
  },
})

const postgres = await startPostgresDataDir({
  dataDir,
  listen: {
    type: 'socket',
    socketDir: '.postgres/socket',
  },
  postgresOutput: 'on-error',
})

try {
  await runWork(postgres)
} finally {
  await postgres.stop()
}
```

`initPostgresDataDir` leaves an existing cluster's configuration untouched.
`startPostgresDataDir` rejects when `postmaster.pid` belongs to a live process;
it never attaches to that server.

## Reuse Resolved Binaries

Resolve once when a wrapper needs the same binary selection across inspection,
initialization, and startup:

```ts
import {
  initPostgresDataDir,
  resolvePostgresBinaries,
  startPostgresDataDir,
} from 'local-postgres/core'

const binaries = await resolvePostgresBinaries({
  version: '18',
  strategy: 'prefer-local',
})

await initPostgresDataDir({ dataDir: '.postgres/18', binaries })
const postgres = await startPostgresDataDir({
  dataDir: '.postgres/18',
  binaries,
  postgresOutput: 'on-error',
})
```

The caller remains responsible for stopping the returned process. See
[Shutdown](shutdown.md) for same-process and cross-process cleanup.
