import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

import { Client } from 'pg'

const hasLocalPostgres =
  spawnSync('postgres', ['--version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('initdb', ['--version'], { stdio: 'ignore' }).status === 0

describe.skipIf(!hasLocalPostgres)('temporary postgres', () => {
  test('initializes, starts, connects, and removes its container', async () => {
    const { initdb, start } = await import('../src/tmp')
    const dataDir = await initdb()
    expect(existsSync(join(dataDir, 'data', 'PG_VERSION'))).toBe(true)

    const postgres = await start({ dataDir, prewarm: false, timeout: 0 })
    const client = new Client({ connectionString: postgres.dsn })

    try {
      await client.connect()
      await expect(client.query('SELECT 1 AS value')).resolves.toMatchObject({
        rows: [{ value: 1 }],
      })
    } finally {
      await client.end()
      await postgres.stop()
    }

    expect(existsSync(dataDir)).toBe(false)
  })

  test('atomically claims a prewarmed container once', async () => {
    const { initdb, start } = await import('../src/tmp')
    const prewarmedDir = await initdb()
    const servers = await Promise.all([
      start({ prewarm: false, timeout: 0 }),
      start({ prewarm: false, timeout: 0 }),
    ])

    try {
      expect(new Set(servers.map((server) => server.dataDir)).size).toBe(2)
      expect(servers.some((server) => server.dataDir === prewarmedDir)).toBe(true)
    } finally {
      await Promise.all(servers.map((server) => server.stop({ force: true })))
      await rm(prewarmedDir, { force: true, recursive: true })
    }
  })
})
