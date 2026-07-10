import { execFile, type ChildProcess, type StdioOptions } from 'node:child_process'
import { appendFileSync, closeSync, mkdirSync, openSync } from 'node:fs'
import * as path from 'node:path'

import { LocalPostgresError, type LocalPostgresLogTarget } from './types'

const MAX_CAPTURED_POSTGRES_OUTPUT_BYTES = 64 * 1024

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
  attach(process: ChildProcess): void
  diagnostics(): string | undefined
  finishStartup(): void
  close(): void
} {
  if (log === 'inherit') {
    return {
      stdio: ['ignore', 'inherit', 'inherit'],
      attach: noop,
      diagnostics: () => undefined,
      finishStartup: noop,
      close: noop,
    }
  }

  if (log === 'on-error') {
    let chunks: Buffer[] = []
    let byteLength = 0
    let child: ChildProcess | undefined
    let capturing = true

    const capture = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(buffer)
      byteLength += buffer.byteLength

      while (byteLength > MAX_CAPTURED_POSTGRES_OUTPUT_BYTES && chunks.length > 0) {
        const overflow = byteLength - MAX_CAPTURED_POSTGRES_OUTPUT_BYTES
        const first = chunks[0]!
        if (first.byteLength <= overflow) {
          chunks.shift()
          byteLength -= first.byteLength
        } else {
          chunks[0] = first.subarray(overflow)
          byteLength -= overflow
        }
      }
    }

    const stopCapturing = () => {
      if (!capturing) return
      capturing = false
      child?.stdout?.off('data', capture)
      child?.stderr?.off('data', capture)
      // A piped child must keep being drained after startup or verbose servers
      // can block once the operating system pipe fills.
      child?.stdout?.resume()
      child?.stderr?.resume()
    }

    return {
      stdio: ['ignore', 'pipe', 'pipe'],
      attach: (process) => {
        child = process
        process.stdout?.on('data', capture)
        process.stderr?.on('data', capture)
      },
      diagnostics: () => {
        if (byteLength === 0) return undefined
        return Buffer.concat(chunks, byteLength).toString('utf8').trim() || undefined
      },
      finishStartup: () => {
        stopCapturing()
        chunks = []
        byteLength = 0
      },
      close: stopCapturing,
    }
  }

  if (typeof log === 'object') {
    mkdirSync(path.dirname(log.filePath), { recursive: true })
    const fd = openSync(log.filePath, 'w')
    let closed = false
    return {
      stdio: ['ignore', fd, fd],
      attach: noop,
      diagnostics: () => undefined,
      finishStartup: noop,
      close: () => {
        if (closed) return
        closed = true
        closeSync(fd)
      },
    }
  }

  return {
    stdio: ['ignore', 'ignore', 'ignore'],
    attach: noop,
    diagnostics: () => undefined,
    finishStartup: noop,
    close: noop,
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: {
    log?: LocalPostgresLogTarget
  } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const result = {
          stdout: stdout?.toString() ?? '',
          stderr: stderr?.toString() ?? '',
        }
        writeCommandOutput(options.log, result)

        if (error) {
          const commandFailure = error as CommandFailure
          commandFailure.stdout = result.stdout
          commandFailure.stderr = result.stderr
          reject(commandFailure)
          return
        }

        resolve(result)
      },
    )
  })
}

function writeCommandOutput(
  log: LocalPostgresLogTarget | undefined,
  { stderr, stdout }: CommandResult,
) {
  if (!log || log === 'ignore' || log === 'on-error') return

  if (log === 'inherit') {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    return
  }

  mkdirSync(path.dirname(log.filePath), { recursive: true })
  appendFileSync(log.filePath, stdout)
  appendFileSync(log.filePath, stderr)
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
