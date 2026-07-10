# local-postgres or PGlite?

> Choose `local-postgres` when compatibility with a normal PostgreSQL server is
> the requirement; choose PGlite when PostgreSQL needs to run inside a
> JavaScript process or browser.

Both projects make PostgreSQL available without Docker, but they provide
different execution models. `local-postgres` starts native PostgreSQL binaries
as a server. [PGlite](https://pglite.dev/) embeds a WebAssembly build of
PostgreSQL behind a TypeScript API.

## Compare the Execution Models

| Decision                      | `local-postgres`                                                                        | PGlite                                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL runtime            | Native PostgreSQL executable                                                            | PostgreSQL compiled to WebAssembly                                                                                                                       |
| Supported hosts               | Node.js on macOS, Linux, or Windows                                                     | Browsers, Node.js, Bun, and Deno                                                                                                                         |
| Primary interface             | Standard TCP or Unix-socket PostgreSQL connections                                      | In-process TypeScript query API                                                                                                                          |
| Existing clients and CLIs     | Connect directly with `pg`, `psql`, migration tools, ORMs, and other PostgreSQL clients | Use the PGlite API or an additional adapter; [PGlite Socket](https://pglite.dev/docs/pglite-socket) can expose a PostgreSQL-compatible server in Node.js |
| Concurrent clients            | Native PostgreSQL connection and process model                                          | A PGlite instance is single-user; PGlite Socket can multiplex client connections                                                                         |
| Persistence                   | A normal PostgreSQL data directory                                                      | Memory, a host filesystem, or browser storage, depending on the [PGlite filesystem](https://pglite.dev/docs/filesystems)                                 |
| PostgreSQL versions           | Use an installed version or select a managed native binary                              | Use the PostgreSQL version built into the installed PGlite release                                                                                       |
| Extensions                    | Use extensions available to the selected native PostgreSQL installation                 | Use extensions compiled and packaged for PGlite; see the [PGlite extension catalog](https://pglite.dev/extensions/)                                      |
| Reactive and local-first APIs | Not included                                                                            | PGlite provides live-query and synchronization-oriented integrations                                                                                     |

Neither execution model is universally more accurate or more convenient. The
important question is whether the surrounding application expects a server or
an embedded database.

## Choose local-postgres for Server Compatibility

Use `local-postgres` when the code under test or the local tool should connect
to PostgreSQL exactly as it connects to another server. This includes workflows
that:

- exercise a PostgreSQL driver over TCP or a Unix socket
- invoke `psql`, a migration CLI, or another child process
- open multiple independent client connections
- depend on behavior or extensions from a native PostgreSQL installation
- need to select a specific native PostgreSQL version

For example, the returned connection string can be passed to both application
code and an external tool:

```ts
import { spawn } from 'node:child_process'
import { startPostgres } from 'local-postgres'

const postgres = await startPostgres({
  dataDir: '.postgres/test',
  database: 'app_test',
})

try {
  await runTests(postgres.connectionString)

  const migrate = spawn('pnpm', ['run', 'migrate'], {
    env: { ...process.env, ...postgres.env },
    stdio: 'inherit',
  })
  await new Promise<void>((resolve, reject) => {
    migrate.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`migrate exited ${code}`)),
    )
    migrate.once('error', reject)
  })
} finally {
  await postgres.stop()
}
```

This starts a separate PostgreSQL process. The machine therefore needs either
an installed PostgreSQL or permission to download a managed binary. See
[Postgres Binaries](features/postgres-binaries.md) for those choices.

## Choose PGlite for an Embedded Database

Use PGlite when the database should live inside the JavaScript application.
This is the stronger fit when a project:

- runs PostgreSQL in a browser
- wants an in-memory database through an in-process API
- cannot rely on native PostgreSQL executables
- uses PGlite's live-query, worker, or local-first integrations
- only needs extensions available as PGlite-compatible builds

A minimal PGlite instance accepts queries without opening a network listener:

```ts
import { PGlite } from '@electric-sql/pglite'

const postgres = await PGlite.create('memory://')

try {
  const result = await postgres.query<{ value: number }>('select 42 as value')
  console.log(result.rows[0].value)
} finally {
  await postgres.close()
}
```

The embedded API is a useful boundary of its own, but it is not the same test
boundary as connecting an unmodified PostgreSQL client to a native server.

## Decide from the Boundary You Need to Test

Choose based on the production boundary that matters to the test or tool:

- If correctness depends on client connections, authentication, server
  processes, native extensions, or external PostgreSQL tools, use
  `local-postgres`.
- If correctness depends on browser storage, an embedded query API, workers,
  or PGlite-specific reactive behavior, use PGlite.
- If the code is mostly portable SQL, either can work. Run a representative
  test against the same execution model used by the application before relying
  on the substitute.

For an isolated native test setup, continue with
[Test Fixtures](guides/test-fixtures.md). For the embedded alternative, see the
[PGlite documentation](https://pglite.dev/docs/).
