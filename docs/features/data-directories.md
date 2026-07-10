# Data Directories

> The data directory is the persistent cluster boundary: choose its lifetime,
> version, and initial configuration before deciding how callers share it.

`dataDir` is the directory that contains PostgreSQL cluster files such as
`PG_VERSION` and `postgresql.conf`. `startPostgres` creates the directory and
runs `initdb` when `PG_VERSION` is absent:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
})
```

The first run initializes `.postgres`. Later runs reuse it; they do not erase
existing databases or reinitialize the cluster.

## Choose a Lifetime

Use a stable project path for reusable development state and a temporary path
for isolated test state:

| Situation         | Directory                          | Owner of cleanup                        |
| ----------------- | ---------------------------------- | --------------------------------------- |
| Local development | A project path such as `.postgres` | The developer or project tooling        |
| Test run          | A path from `mkdtemp`              | The test fixture, after server shutdown |
| Versioned tooling | A path such as `.postgres/18`      | The tool that selected the version      |

`local-postgres` never removes a data directory. See
[Local Development](../guides/local-development.md) and
[Test Fixtures](../guides/test-fixtures.md) for complete ownership patterns.

## Set Initial Configuration

`config` values are appended to `postgresql.conf` only when a new cluster is
initialized:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  config: {
    fsync: false,
    log_min_duration_statement: 100,
    shared_buffers: '128MB',
  },
})
```

Existing clusters are left untouched, so changing `config` later does not
rewrite their configuration. Update or recreate a disposable cluster
deliberately when those settings must change.

## Preserve Version Compatibility

When binary resolution reports a version, `local-postgres` compares its major
version with `PG_VERSION`. It rejects a Postgres 15 cluster paired with a
Postgres 18 binary instead of attempting an unsafe startup.

Choose a version-specific directory when a tool may switch major versions:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres/18',
  postgres: {
    version: '18',
    strategy: 'prefer-local',
  },
})
```

See [Postgres Binaries](postgres-binaries.md) for version selection.

## Respect Existing Servers

Before startup, `local-postgres` checks `postmaster.pid`. If its PID is alive,
startup rejects with `PostgresDataDirInUseError`; it does not attach to, stop,
or take ownership of that server. A stale PID whose process no longer exists
is left for PostgreSQL's normal lock handling.

See [Data Directory Troubleshooting](../troubleshooting/data-directories.md)
before deleting or replacing cluster state.
