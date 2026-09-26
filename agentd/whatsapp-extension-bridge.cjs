const crypto = require('node:crypto')
const http = require('node:http')

const MAX_BODY_BYTES = 256 * 1024
const DEFAULT_PORT = 8790
const MIN_TOKEN_LENGTH = 16
const MAX_OUTBOUND_TEXT_LENGTH = 32 * 1024
const MAX_OUTBOUND_MEDIA_BYTES = 8 * 1024 * 1024
const OUTBOUND_TIMEOUT_MS = 75_000
const MEDIA_TYPES = new Set(['image', 'video', 'audio', 'document'])

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
  constructor({ logger = console, onMessage = () => {}, allowMessage = () => false, allowOutbound = () => false, token = process.env.AICA_EXTENSION_BRIDGE_TOKEN, port = configuredPort() } = {}) {
    this.logger = logger
    this.onMessage = onMessage
    this.allowMessage = allowMessage
    this.allowOutbound = allowOutbound
    this.token = typeof token === 'string' ? token.trim() : ''
    this.state = { status: 'disabled', port, lastStatus: null, error: null }
    this.server = null
    this.outbound = new Map()
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
    for (const command of this.outbound.values()) {
      clearTimeout(command.timer)
      command.reject(Object.assign(new Error('WhatsApp Web bridge stopped'), { statusCode: 503 }))
    }
    this.outbound.clear()
    this.state = { ...this.state, status: 'disabled' }
  }

  getState() { return { ...this.state, outboundPending: this.outbound.size } }

  async enqueueOutbound(value) {
    const to = typeof value?.to === 'string' ? value.to.trim() : ''
    const text = typeof value?.text === 'string' ? value.text.trim() : ''
    const kind = value?.kind === 'media' ? 'media' : 'text'
    const media = value?.media && typeof value.media === 'object' && !Array.isArray(value.media) ? value.media : null
    const mediaType = media && typeof media.type === 'string' ? media.type : ''
    const mediaName = media && typeof media.fileName === 'string' ? media.fileName.trim() : ''
    const mediaMime = media && typeof media.mimeType === 'string' ? media.mimeType.trim().toLowerCase() : ''
    const mediaSize = media && Number.isSafeInteger(media.size) ? media.size : 0
    const mediaData = media && typeof media.dataBase64 === 'string' ? media.dataBase64 : ''
    const validMedia = kind === 'media'
      && MEDIA_TYPES.has(mediaType)
      && !!mediaName && mediaName.length <= 256 && !/[\0\r\n\\/]/.test(mediaName)
      && !!mediaMime && mediaMime.length <= 128 && !/[\0\r\n]/.test(mediaMime)
      && mediaSize > 0 && mediaSize <= MAX_OUTBOUND_MEDIA_BYTES
      && mediaData.length > 0 && mediaData.length <= Math.ceil(MAX_OUTBOUND_MEDIA_BYTES * 4 / 3) + 64
      && mediaData.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(mediaData)
    if (!to || to.length > 256 || /[\0\r\n]/.test(to)
      || (kind === 'text' && (!text || text.length > MAX_OUTBOUND_TEXT_LENGTH))
      || (kind === 'media' && (!validMedia || Buffer.from(mediaData, 'base64').length !== mediaSize))) {
      throw Object.assign(new Error('Invalid WhatsApp Web message'), { statusCode: 400 })
    }
    let allowed = false
    try {
      allowed = this.allowOutbound(kind === 'media'
        ? { kind, to, media: { type: mediaType, fileName: mediaName, mimeType: mediaMime, size: mediaSize, caption: typeof media?.caption === 'string' ? media.caption.slice(0, MAX_OUTBOUND_TEXT_LENGTH) : '' } }
        : { kind, to, text })
    } catch { allowed = false }
    if (!allowed) throw Object.assign(new Error('WhatsApp Web outbound transport is not enabled'), { statusCode: 409 })
    if (!this.server || this.state.status !== 'connected') throw Object.assign(new Error('WhatsApp Web extension is not connected'), { statusCode: 409 })
    const id = `web-send:${crypto.randomUUID()}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outbound.delete(id)
        reject(Object.assign(new Error('WhatsApp Web send timed out; keep the chat open and retry'), { statusCode: 504 }))
      }, OUTBOUND_TIMEOUT_MS)
      timer.unref?.()
      this.outbound.set(id, {
        id,
        to,
        ...(kind === 'media' ? {
          kind,
          media: {
            type: mediaType,
            fileName: mediaName,
            mimeType: mediaMime,
            size: mediaSize,
            dataBase64: mediaData,
            caption: typeof media.caption === 'string' ? media.caption.slice(0, MAX_OUTBOUND_TEXT_LENGTH) : '',
          },
        } : { text }),
        createdAt: Date.now(),
        claimed: false,
        timer,
        resolve,
        reject,
      })
    })
  }

  claimOutbound(chatId) {
    if (typeof chatId !== 'string' || !chatId.trim()) return null
    const target = chatId.trim()
    for (const command of this.outbound.values()) {
      if (!command.claimed && command.to === target) {
        command.claimed = true
        return {
          id: command.id,
          to: command.to,
          ...(command.kind === 'media' ? { kind: command.kind, media: command.media } : { text: command.text }),
          createdAt: command.createdAt,
        }
      }
    }
    return null
  }

  settleOutbound(value) {
    const id = typeof value?.id === 'string' ? value.id.trim() : ''
    const command = this.outbound.get(id)
    if (!command) return { accepted: false, error: 'unknown_command' }
    if (!command.claimed) return { accepted: false, error: 'command_not_claimed' }
    clearTimeout(command.timer)
    this.outbound.delete(id)
    if (value.success === true) {
      const providerMessageId = typeof value.providerMessageId === 'string' && /^[\x21-\x7e]{1,300}$/.test(value.providerMessageId)
        ? value.providerMessageId
        : `web:${id}`
      command.resolve({ providerMessageId })
    } else {
      const error = typeof value.error === 'string' && value.error.trim() ? value.error.trim().slice(0, 256) : 'WhatsApp Web send failed'
      command.reject(Object.assign(new Error(error), { statusCode: 502 }))
    }
    return { accepted: true, id }
  }

  async handle(request, response) {
    response.setHeader('content-type', 'application/json')
    response.setHeader('cache-control', 'no-store')
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return }
    if (!this.authorized(request)) { this.json(response, 401, { error: 'unauthorized' }); return }
    const parsedUrl = new URL(request.url || '/', 'http://127.0.0.1')
    if (request.method === 'GET' && parsedUrl.pathname === '/health') { this.json(response, 200, this.getState()); return }
    if (request.method === 'GET' && parsedUrl.pathname === '/outbound') {
      this.json(response, 200, { command: this.claimOutbound(parsedUrl.searchParams.get('chatId')) })
      return
    }
    if (request.method !== 'POST' || !['/status', '/messages', '/outbound/result'].includes(parsedUrl.pathname)) { this.json(response, 404, { error: 'not_found' }); return }
    const body = await this.readBody(request)
    if (!body) { this.json(response, 413, { error: 'body_too_large_or_invalid' }); return }
    if (parsedUrl.pathname === '/status') {
      const status = typeof body.status === 'string' ? body.status.trim().slice(0, 64) : ''
      if (!status) { this.json(response, 400, { error: 'invalid_status' }); return }
      this.state.lastStatus = status
      this.json(response, 200, { ok: true })
      return
    }
    if (parsedUrl.pathname === '/outbound/result') {
      if (typeof body.id !== 'string' || body.id.length > 128 || typeof body.success !== 'boolean'
        || (body.providerMessageId !== undefined && (typeof body.providerMessageId !== 'string' || body.providerMessageId.length > 300))
        || (body.error !== undefined && (typeof body.error !== 'string' || body.error.length > 256))) {
        this.json(response, 400, { error: 'invalid_outbound_result' })
        return
      }
      const result = this.settleOutbound(body)
      this.json(response, result.accepted ? 200 : 409, result)
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
