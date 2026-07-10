import { closeSync, openSync } from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { setPriority } from 'node:os'
import { fileURLToPath } from 'node:url'

export function spawnWorker(workerUrl: URL, payload: unknown, logFile: string): ChildProcess {
  const logFd = openSync(logFile, 'a')

  try {
    const child = spawn(process.execPath, [fileURLToPath(workerUrl), JSON.stringify(payload)], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    })
    child.unref()
    return child
  } finally {
    closeSync(logFd)
  }
}

export function parseWorkerPayload<T>(): T {
  const payload = process.argv[2]
  if (!payload) {
    throw new Error('Temporary Postgres worker payload is missing.')
  }
  return JSON.parse(payload) as T
}

export function lowerWorkerPriority(): void {
  try {
    setPriority(0, 19)
  } catch {
    // Priority is an optimization; unsupported platforms can use the default.
  }
}
