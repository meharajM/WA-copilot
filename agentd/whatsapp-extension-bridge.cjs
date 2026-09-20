const crypto = require('node:crypto')
const http = require('node:http')

const MAX_BODY_BYTES = 256 * 1024
const DEFAULT_PORT = 8790
const MIN_TOKEN_LENGTH = 16

function configuredPort() {
  const port = Number(process.env.AICA_EXTENSION_BRIDGE_PORT)
  return Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : DEFAULT_PORT
}

function normalizeMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const from = typeof input.from === 'string' ? input.from.trim() : ''
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  const timestamp = typeof input.timestamp === 'number' ? input.timestamp : Date.now()
  if (!id || id.length > 256 || !from || from.length > 256 || !content || content.length > 100_000
    || !Number.isFinite(timestamp) || timestamp <= 0) return null
  return {
    id,
    from,
    to: typeof input.to === 'string' ? input.to.slice(0, 256) : '',
    content,
    timestamp,
  }
}

class WhatsAppExtensionBridge {
  constructor({ logger = console, onMessage = () => {}, allowMessage = () => false, token = process.env.AICA_EXTENSION_BRIDGE_TOKEN, port = configuredPort() } = {}) {
    this.logger = logger
    this.onMessage = onMessage
    this.allowMessage = allowMessage
    this.token = typeof token === 'string' ? token.trim() : ''
    this.state = { status: 'disabled', port, lastStatus: null, error: null }
    this.server = null
  }

  async start() {
    if (!this.token) return this.getState()
    if (this.token.length < MIN_TOKEN_LENGTH) {
      this.state = { ...this.state, status: 'error', error: `AICA_EXTENSION_BRIDGE_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters` }
      return this.getState()
    }
    if (this.server) return this.getState()
    this.state = { ...this.state, status: 'connecting', error: null }
    this.server = http.createServer((request, response) => void this.handle(request, response))
    this.server.requestTimeout = 10_000
    this.server.headersTimeout = 5_000
    this.server.keepAliveTimeout = 5_000
    this.server.maxHeadersCount = 32
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject)
        this.server.listen(this.state.port, '127.0.0.1', resolve)
      })
      this.state = { ...this.state, status: 'connected' }
    } catch (error) {
      await this.stop()
      this.state = { ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) }
    }
    return this.getState()
  }

  async stop() {
    const server = this.server
    this.server = null
    if (server) await new Promise(resolve => server.close(() => resolve()))
    this.state = { ...this.state, status: 'disabled' }
  }

  getState() { return { ...this.state } }

  async handle(request, response) {
    response.setHeader('content-type', 'application/json')
    response.setHeader('cache-control', 'no-store')
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
    if (!this.authorized(request)) { this.json(response, 401, { error: 'unauthorized' }); return }
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
    const message = normalizeMessage(body.message ?? body)
    if (!message) { this.json(response, 400, { error: 'invalid_message' }); return }
    let allowed = false
    try { allowed = this.allowMessage(message) } catch { allowed = false }
    if (!allowed) { this.json(response, 403, { accepted: false, error: 'extension_transport_not_enabled' }); return }
    try { await this.onMessage(message) } catch {
      this.json(response, 503, { accepted: false, error: 'message_ingest_failed' })
      return
    }
    this.json(response, 202, { accepted: true, id: message.id })
  }

  authorized(request) {
    const supplied = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : ''
    const expected = crypto.createHash('sha256').update(this.token).digest()
    const actual = crypto.createHash('sha256').update(supplied).digest()
    return crypto.timingSafeEqual(expected, actual)
  }

  async readBody(request) {
    const declaredLength = Number(request.headers['content-length'])
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      request.resume()
      return null
    }
    const chunks = []
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
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch { return null }
  }

  json(response, status, body) { response.writeHead(status); response.end(JSON.stringify(body)) }
}

module.exports = { WhatsAppExtensionBridge, normalizeMessage, MAX_BODY_BYTES, DEFAULT_PORT }
