# Child Processes

> Pass the returned connection environment to migration tools and other CLIs
> without changing the parent process environment.

Start Postgres, merge `postgres.env` into the child environment, and keep the
server alive until the command exits:

```ts
import { spawn } from 'node:child_process'
import { startPostgres } from 'local-postgres'

const postgres = await startPostgres({
  dataDir: '.postgres',
  database: 'app_dev',
  postgresOutput: 'on-error',
})

try {
  const child = spawn('pnpm', ['run', 'migrate'], {
    env: {
      ...process.env,
      ...postgres.env,
    },
    stdio: 'inherit',
  })

  await new Promise<void>((resolve, reject) => {
    child.once('exit', (code) => {
      code === 0 ? resolve() : reject(new Error(`migrate exited ${code}`))
    })
    child.once('error', reject)
  })
} finally {
  await postgres.stop()
}
```

The child receives `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE`, and
`PGDATA`. It also receives `PGUSER` and `PGPASSWORD` when `superuser` is set.
The parent retains its original environment.

Keep the server alive for the entire child process. If the command launches a
long-running application, its exit should define when the surrounding owner
calls `postgres.stop()`.

See [Databases and Roles](../features/databases-and-roles.md) for the returned
credentials and [Shutdown](../features/shutdown.md) for ownership choices.
