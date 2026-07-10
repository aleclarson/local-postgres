# Listeners

> Choose automatic TCP ports for isolated tools, fixed TCP ports for stable
> integrations, or Unix sockets when the caller needs a filesystem endpoint.

## Use an Available TCP Port

The high-level API listens on `127.0.0.1` and selects an available port when
`host` and `port` are omitted:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
})

console.log(postgres.host)
console.log(postgres.port)
console.log(postgres.connectionString)
```

Read the returned port instead of assuming PostgreSQL's conventional `5432`.
This avoids conflicts between concurrent tools and test workers.

## Use a Fixed TCP Address

Set `host` or `port` when another process requires a known address:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  host: '127.0.0.1',
  port: 54329,
})
```

Fixed ports are probed before PostgreSQL starts. Startup rejects if the address
is unavailable.

The equivalent explicit listener is useful when a wrapper accepts both TCP and
socket configuration:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  listen: {
    type: 'tcp',
    host: '127.0.0.1',
    port: 54329,
  },
})
```

Do not combine `listen` with the top-level `host` or `port` options.

## Use a Unix Socket

Pass a socket listener when local clients should connect through a directory:

```ts
const postgres = await startPostgres({
  dataDir: '.postgres',
  listen: {
    type: 'socket',
    socketDir: '.postgres/socket',
    port: 5432,
  },
})
```

`postgres.host` and `postgres.env.PGHOST` contain the socket directory, while
`postgres.socketDir` identifies socket mode directly. The port remains part of
PostgreSQL's socket filename and client configuration.

See [Connection Troubleshooting](../troubleshooting/connections.md) for port
conflicts and post-start database or role failures.
