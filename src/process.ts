import { execFile, type StdioOptions } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import * as path from 'node:path'

import { LocalPostgresError, type LocalPostgresLogTarget } from './types'

type CommandFailure = Error & {
  code?: number | string
  signal?: string
  stderr?: string
  stdout?: string
}

interface CommandResult {
  stderr: string
  stdout: string
}

export interface ExitResult {
  code: number | null
  signal: NodeJS.Signals | null
}

export function openLogTarget(log: LocalPostgresLogTarget | undefined): {
  stdio: StdioOptions
  close(): void
} {
  if (log === 'inherit') {
    return {
      stdio: ['ignore', 'inherit', 'inherit'],
      close: noop,
    }
  }

  if (typeof log === 'object') {
    mkdirSync(path.dirname(log.filePath), { recursive: true })
    const fd = openSync(log.filePath, 'w')
    let closed = false
    return {
      stdio: ['ignore', fd, fd],
      close: () => {
        if (closed) return
        closed = true
        closeSync(fd)
      },
    }
  }

  return {
    stdio: ['ignore', 'ignore', 'ignore'],
    close: noop,
  }
}

export function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const commandFailure = error as CommandFailure
          commandFailure.stdout = stdout?.toString() ?? ''
          commandFailure.stderr = stderr?.toString() ?? ''
          reject(commandFailure)
          return
        }

        resolve({
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
        })
      },
    )
  })
}

export function commandError(message: string, command: string, error: unknown) {
  const failure = error as CommandFailure
  const binaryMessage =
    failure.code === 'ENOENT' ? ` The "${command}" binary was not found on PATH.` : ''
  const stderr = failure.stderr?.trim()
  const detail = stderr ? ` ${stderr}` : failure.message ? ` ${failure.message}` : ''

  return new LocalPostgresError(`${message}${binaryMessage}${detail}`, {
    cause: error,
  })
}

export function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForExit(exitPromise: Promise<ExitResult>, timeoutMs: number) {
  return Promise.race([exitPromise.then(() => true), delay(timeoutMs).then(() => false)])
}

function noop() {}
