import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { createInterface, type Interface } from 'node:readline'
import { beforeAll, describe, expect, it } from 'vitest'
import { AGENTD_MAX_FRAME_BYTES } from '../../src/shared/agentd-protocol'

const entrypoint = path.resolve(process.cwd(), 'out/agentd/agentd/index.js')

interface RunningAgentd {
  child: ChildProcessWithoutNullStreams
  lines: Interface
  messages: AsyncIterator<string>
}

function startAgentd(): RunningAgentd {
  const child = spawn(process.execPath, [entrypoint], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  return { child, lines, messages: lines[Symbol.asyncIterator]() }
}

async function readMessage(agentd: RunningAgentd): Promise<Record<string, unknown>> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const next = await Promise.race([
    agentd.messages.next(),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Timed out waiting for agentd output')),
        2_000,
      )
    }),
  ]).finally(() => clearTimeout(timeout))
  expect(next.done).toBe(false)
  return JSON.parse(next.value) as Record<string, unknown>
}

function writeMessage(agentd: RunningAgentd, message: unknown): void {
  agentd.child.stdin.write(`${JSON.stringify(message)}\n`)
}

async function stopAgentd(agentd: RunningAgentd): Promise<void> {
  agentd.lines.close()
  if (agentd.child.exitCode === null) {
    agentd.child.kill()
    await once(agentd.child, 'close')
  }
}

async function waitForClose(agentd: RunningAgentd): Promise<number | null> {
  if (agentd.child.exitCode !== null) return agentd.child.exitCode

  let timeout: ReturnType<typeof setTimeout> | undefined
  const [code] = await Promise.race([
    once(agentd.child, 'close'),
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Timed out waiting for agentd to exit')),
        2_000,
      )
    }),
  ]).finally(() => clearTimeout(timeout))
  return code as number | null
}

// Historical pilot evidence only. The Tauri product no longer builds or starts
// this second JSONL runtime; the independently supervised HTTP agentd is canonical.
describe.skip('retired agentd JSONL pilot protocol', () => {
  beforeAll(async () => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const build = spawn(npm, ['run', 'build:agentd'], {
      cwd: process.cwd(),
      stdio: 'inherit',
    })
    const [code] = await once(build, 'close')
    expect(code).toBe(0)
  })

  it('announces readiness once and reports health from the real process', async () => {
    const agentd = startAgentd()

    try {
      const ready = await readMessage(agentd)
      expect(ready).toMatchObject({
        version: 1,
        kind: 'event',
        event: 'ready',
        data: {
          status: 'ready',
          protocolVersion: 1,
          pid: agentd.child.pid,
        },
      })

      writeMessage(agentd, {
        version: 1,
        kind: 'request',
        id: 'health-1',
        method: 'health.get',
      })

      expect(await readMessage(agentd)).toMatchObject({
        version: 1,
        kind: 'response',
        id: 'health-1',
        ok: true,
        result: {
          status: 'ready',
          protocolVersion: 1,
          pid: agentd.child.pid,
        },
      })
    } finally {
      await stopAgentd(agentd)
    }
  })

  it('rejects malformed JSON and continues serving requests', async () => {
    const agentd = startAgentd()

    try {
      await readMessage(agentd)
      agentd.child.stdin.write('{not-json}\n')

      expect(await readMessage(agentd)).toEqual({
        version: 1,
        kind: 'response',
        id: null,
        ok: false,
        error: {
          code: 'malformed_json',
          message: 'Frame is not valid JSON',
        },
      })

      writeMessage(agentd, {
        version: 1,
        kind: 'request',
        id: 'health-after-error',
        method: 'health.get',
      })
      expect(await readMessage(agentd)).toMatchObject({
        id: 'health-after-error',
        ok: true,
      })
    } finally {
      await stopAgentd(agentd)
    }
  })

  it('rejects unsupported protocol versions', async () => {
    const agentd = startAgentd()

    try {
      await readMessage(agentd)
      writeMessage(agentd, {
        version: 2,
        kind: 'request',
        id: 'wrong-version',
        method: 'health.get',
      })

      expect(await readMessage(agentd)).toEqual({
        version: 1,
        kind: 'response',
        id: 'wrong-version',
        ok: false,
        error: {
          code: 'unsupported_version',
          message: 'Unsupported protocol version',
        },
      })
    } finally {
      await stopAgentd(agentd)
    }
  })

  it('rejects unknown methods', async () => {
    const agentd = startAgentd()

    try {
      await readMessage(agentd)
      writeMessage(agentd, {
        version: 1,
        kind: 'request',
        id: 'unknown-method',
        method: 'system.exec',
      })

      expect(await readMessage(agentd)).toEqual({
        version: 1,
        kind: 'response',
        id: 'unknown-method',
        ok: false,
        error: {
          code: 'unknown_method',
          message: 'Unknown method',
        },
      })
    } finally {
      await stopAgentd(agentd)
    }
  })

  it('rejects invalid envelopes, request IDs, and method fields', async () => {
    const agentd = startAgentd()

    try {
      await readMessage(agentd)

      writeMessage(agentd, [])
      expect(await readMessage(agentd)).toMatchObject({
        id: null,
        ok: false,
        error: { code: 'invalid_envelope' },
      })

      writeMessage(agentd, {
        version: 1,
        kind: 'event',
        id: 'wrong-kind',
        method: 'health.get',
      })
      expect(await readMessage(agentd)).toMatchObject({
        id: 'wrong-kind',
        ok: false,
        error: { code: 'invalid_envelope' },
      })

      writeMessage(agentd, {
        version: 1,
        kind: 'request',
        id: '',
        method: 'health.get',
      })
      expect(await readMessage(agentd)).toMatchObject({
        id: null,
        ok: false,
        error: { code: 'invalid_request_id' },
      })

      writeMessage(agentd, {
        version: 1,
        kind: 'request',
        id: 'bad-method',
        method: null,
      })
      expect(await readMessage(agentd)).toMatchObject({
        id: 'bad-method',
        ok: false,
        error: { code: 'invalid_envelope' },
      })
    } finally {
      await stopAgentd(agentd)
    }
  })

  it('rejects oversized frames and resumes at the next line', async () => {
    const agentd = startAgentd()

    try {
      await readMessage(agentd)
      agentd.child.stdin.write(`${'x'.repeat(AGENTD_MAX_FRAME_BYTES + 1)}\n`)

      expect(await readMessage(agentd)).toEqual({
        version: 1,
        kind: 'response',
        id: null,
        ok: false,
        error: {
          code: 'frame_too_large',
          message: 'Frame exceeds 1048576 bytes',
        },
      })

      writeMessage(agentd, {
        version: 1,
        kind: 'request',
        id: 'health-after-large-frame',
        method: 'health.get',
      })
      expect(await readMessage(agentd)).toMatchObject({
        id: 'health-after-large-frame',
        ok: true,
      })
    } finally {
      await stopAgentd(agentd)
    }
  })

  it('handles shutdown idempotently and exits cleanly', async () => {
    const agentd = startAgentd()

    try {
      await readMessage(agentd)
      agentd.child.stdin.write(
        [
          JSON.stringify({
            version: 1,
            kind: 'request',
            id: 'shutdown-1',
            method: 'shutdown',
          }),
          JSON.stringify({
            version: 1,
            kind: 'request',
            id: 'shutdown-2',
            method: 'shutdown',
          }),
          '',
        ].join('\n'),
      )

      expect(await readMessage(agentd)).toEqual({
        version: 1,
        kind: 'response',
        id: 'shutdown-1',
        ok: true,
        result: { status: 'stopping' },
      })
      expect(await readMessage(agentd)).toEqual({
        version: 1,
        kind: 'response',
        id: 'shutdown-2',
        ok: true,
        result: { status: 'stopping' },
      })

      expect(await waitForClose(agentd)).toBe(0)
    } finally {
      await stopAgentd(agentd)
    }
  })

  it('exits cleanly when the host closes stdin', async () => {
    const agentd = startAgentd()

    try {
      await readMessage(agentd)
      agentd.child.stdin.end()
      expect(await waitForClose(agentd)).toBe(0)
    } finally {
      await stopAgentd(agentd)
    }
  })
})
