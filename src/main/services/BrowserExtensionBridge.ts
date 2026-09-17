import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { WhatsAppMessage } from '../whatsapp/WhatsAppService'

const MAX_BODY_BYTES = 256 * 1024
const DEFAULT_PORT = 8790
const MIN_TOKEN_LENGTH = 16

export type BrowserExtensionBridgeStatus = 'disabled' | 'connecting' | 'connected' | 'error'
export interface BrowserExtensionBridgeState {
  status: BrowserExtensionBridgeStatus
  port: number
  lastStatus: string | null
  error: string | null
}

export function normalizeExtensionMessage(value: unknown): WhatsAppMessage | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const from = typeof input.from === 'string' ? input.from.trim() : ''
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  const timestamp = typeof input.timestamp === 'number' ? input.timestamp : Date.now()
  if (!id || id.length > 256 || !from || from.length > 256 || !content || content.length > 100_000 || !Number.isFinite(timestamp) || timestamp <= 0) return null
  return { id, from, to: typeof input.to === 'string' ? input.to.slice(0, 256) : '', content, timestamp, type: 'text', isFromMe: false }
}

function configuredPort(): number {
  const port = Number(process.env.AICA_EXTENSION_BRIDGE_PORT)
  return Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : DEFAULT_PORT
}

export class BrowserExtensionBridge {
  private server: Server | null = null
  private state: BrowserExtensionBridgeState = { status: 'disabled', port: configuredPort(), lastStatus: null, error: null }

  constructor(private readonly onMessage: (message: WhatsAppMessage) => void) {}

  async start(): Promise<BrowserExtensionBridgeState> {
    const token = (process.env.AICA_EXTENSION_BRIDGE_TOKEN || '').trim()
    if (!token) return this.getState()
    if (token.length < MIN_TOKEN_LENGTH) {
      this.state = { ...this.state, status: 'error', error: `AICA_EXTENSION_BRIDGE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters` }
      return this.getState()
    }
    if (this.server) return this.getState()
    this.state = { ...this.state, status: 'connecting', error: null }
    this.server = createServer((request, response) => void this.handle(request, response, token))
    try {
      await new Promise<void>((resolve, reject) => {
        this.server?.once('error', reject)
        this.server?.listen(this.state.port, '127.0.0.1', () => resolve())
      })
      this.state = { ...this.state, status: 'connected' }
    } catch (error) {
      await this.stop()
      this.state = { ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) }
    }
    return this.getState()
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    this.state = { ...this.state, status: 'disabled' }
  }

  getState(): BrowserExtensionBridgeState { return { ...this.state } }

  private async handle(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'no-store')
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
    if (!this.authorized(request, token)) { this.json(response, 401, { error: 'unauthorized' }); return }
    if (request.method === 'GET' && request.url === '/health') { this.json(response, 200, this.getState()); return }
    if (request.method !== 'POST' || (request.url !== '/status' && request.url !== '/messages')) { this.json(response, 404, { error: 'not_found' }); return }
    const body = await this.readBody(request)
    if (!body) { this.json(response, 413, { error: 'body_too_large_or_invalid' }); return }
    if (request.url === '/status') {
      const status = typeof body.status === 'string' ? body.status.trim().slice(0, 64) : ''
      if (!status) { this.json(response, 400, { error: 'invalid_status' }); return }
      this.state.lastStatus = status
      this.json(response, 200, { ok: true })
      return
    }
    const message = normalizeExtensionMessage(body.message ?? body)
    if (!message) { this.json(response, 400, { error: 'invalid_message' }); return }
    this.onMessage(message)
    this.json(response, 202, { accepted: true, id: message.id })
  }

  private authorized(request: IncomingMessage, token: string): boolean {
    const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : ''
    const expected = createHash('sha256').update(token).digest()
    const actual = createHash('sha256').update(supplied).digest()
    return timingSafeEqual(expected, actual)
  }

  private async readBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
    const declaredLength = Number(request.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      request.resume()
      return null
    }
    const chunks: Buffer[] = []
    let size = 0
    let tooLarge = false
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size <= MAX_BODY_BYTES && !tooLarge) chunks.push(buffer)
      else tooLarge = true
    }
    if (tooLarge) return null
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch { return null }
  }

  private json(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status); response.end(JSON.stringify(body)) }
}
