import {
  AGENTD_MAX_FRAME_BYTES,
  AGENTD_PROTOCOL_VERSION,
  type AgentdErrorCode,
  type AgentdHealth,
  type AgentdOutboundMessage,
} from '../shared/agentd-protocol.js'

const health: AgentdHealth = {
  status: 'ready',
  protocolVersion: AGENTD_PROTOCOL_VERSION,
  pid: process.pid,
  startedAt: new Date().toISOString(),
}

function emit(message: AgentdOutboundMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function emitError(id: string | null, code: AgentdErrorCode, message: string): void {
  emit({
    version: AGENTD_PROTOCOL_VERSION,
    kind: 'response',
    id,
    ok: false,
    error: { code, message },
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isValidRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

let shutdownScheduled = false

function scheduleShutdown(): void {
  if (shutdownScheduled) return
  shutdownScheduled = true

  setImmediate(() => {
    process.stdin.pause()
    process.stdin.removeAllListeners()
    process.stdin.destroy()
    process.stdout.write('', () => process.exit(0))
  })
}

function handleFrame(line: string): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(line) as unknown
  } catch {
    emitError(null, 'malformed_json', 'Frame is not valid JSON')
    return
  }

  if (!isObject(parsed) || parsed.kind !== 'request') {
    emitError(
      isObject(parsed) && isValidRequestId(parsed.id) ? parsed.id : null,
      'invalid_envelope',
      'Frame must be a request object',
    )
    return
  }

  const request = parsed
  if (request.version !== AGENTD_PROTOCOL_VERSION) {
    emitError(
      isValidRequestId(request.id) ? request.id : null,
      'unsupported_version',
      'Unsupported protocol version',
    )
    return
  }

  if (!isValidRequestId(request.id)) {
    emitError(null, 'invalid_request_id', 'Request ID must be a non-empty string')
    return
  }

  if (typeof request.method !== 'string') {
    emitError(request.id, 'invalid_envelope', 'Method must be a string')
    return
  }

  if (request.method === 'health.get') {
    emit({
      version: AGENTD_PROTOCOL_VERSION,
      kind: 'response',
      id: request.id,
      ok: true,
      result: health,
    })
    return
  }

  if (request.method === 'shutdown') {
    emit({
      version: AGENTD_PROTOCOL_VERSION,
      kind: 'response',
      id: request.id,
      ok: true,
      result: { status: 'stopping' },
    })
    scheduleShutdown()
    return
  }

  emitError(
    request.id,
    'unknown_method',
    'Unknown method',
  )
}

let frameParts: Buffer[] = []
let frameBytes = 0
let discardingOversizedFrame = false

function appendFramePart(part: Buffer): void {
  if (discardingOversizedFrame || part.length === 0) return

  if (frameBytes + part.length > AGENTD_MAX_FRAME_BYTES) {
    frameParts = []
    frameBytes = 0
    discardingOversizedFrame = true
    emitError(
      null,
      'frame_too_large',
      `Frame exceeds ${AGENTD_MAX_FRAME_BYTES} bytes`,
    )
    return
  }

  frameParts.push(part)
  frameBytes += part.length
}

process.stdin.on('data', (chunk: Buffer) => {
  let start = 0

  while (start < chunk.length) {
    const newline = chunk.indexOf(0x0a, start)
    const end = newline === -1 ? chunk.length : newline
    appendFramePart(chunk.subarray(start, end))

    if (newline === -1) return

    if (!discardingOversizedFrame) {
      const frame = Buffer.concat(frameParts, frameBytes)
      const content = frame.at(-1) === 0x0d ? frame.subarray(0, -1) : frame
      handleFrame(content.toString('utf8'))
    }

    frameParts = []
    frameBytes = 0
    discardingOversizedFrame = false
    start = newline + 1
  }
})

process.stdin.on('end', scheduleShutdown)

emit({
  version: AGENTD_PROTOCOL_VERSION,
  kind: 'event',
  event: 'ready',
  data: health,
})
