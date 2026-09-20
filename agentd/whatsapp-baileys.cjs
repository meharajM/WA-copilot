const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const MAX_PHONE_LENGTH = 32
const MAX_TEXT_LENGTH = 4096
const MAX_MEDIA_BYTES = 8 * 1024 * 1024
const MAX_MEDIA_FILENAME_LENGTH = 256
const MAX_MEDIA_MIME_LENGTH = 128

const INBOUND_MEDIA_TYPES = Object.freeze({
  image: { extension: 'jpg', mime: 'image/jpeg' },
  video: { extension: 'mp4', mime: 'video/mp4' },
  audio: { extension: 'ogg', mime: 'audio/ogg' },
  document: { extension: 'bin', mime: 'application/octet-stream' },
})

function isSupportedMediaMime(type, mimeType) {
  if (typeof type !== 'string' || typeof mimeType !== 'string') return false
  const mime = mimeType.trim().toLowerCase()
  if (type === 'image') return /^(?:image\/(?:jpeg|jpg|png|webp|gif))$/.test(mime)
  if (type === 'video') return /^(?:video\/(?:mp4|3gpp|quicktime|webm))$/.test(mime)
  if (type === 'audio') return /^(?:audio\/(?:aac|mp4|mpeg|amr|ogg|wav|webm))$/.test(mime)
  if (type === 'document') return /^(?:application\/(?:pdf|json|zip|octet-stream|msword|rtf|vnd\.ms-(?:excel|powerpoint)|vnd\.openxmlformats-officedocument\.[a-z0-9.+-]+)|text\/(?:plain|csv|markdown))$/.test(mime)
  return false
}

function inboundMediaDescriptor(message) {
  if (!message || typeof message !== 'object') return null
  const candidates = [
    ['image', message.imageMessage],
    ['video', message.videoMessage],
    ['audio', message.audioMessage],
    ['document', message.documentMessage],
  ]
  const [type, value] = candidates.find(([, candidate]) => candidate && typeof candidate === 'object') || []
  if (!type || !value) return null
  const defaults = INBOUND_MEDIA_TYPES[type]
  const mimeType = typeof value.mimetype === 'string' && value.mimetype.trim()
    ? value.mimetype.trim().toLowerCase()
    : defaults.mime
  const rawName = typeof value.fileName === 'string' && value.fileName.trim()
    ? value.fileName.trim()
    : `whatsapp-${type}.${defaults.extension}`
  const fileName = rawName.slice(0, MAX_MEDIA_FILENAME_LENGTH)
  if (!fileName || /[\0\r\n\\/]/.test(fileName) || !isSupportedMediaMime(type, mimeType)) return null
  const declaredSize = Number(value.fileLength)
  return {
    type,
    fileName,
    mimeType,
    ...(Number.isSafeInteger(declaredSize) && declaredSize > 0 ? { declaredSize } : {}),
  }
}

async function readInboundMediaStream(stream) {
  if (Buffer.isBuffer(stream)) {
    if (stream.length < 1 || stream.length > MAX_MEDIA_BYTES) return null
    return stream
  }
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return null
  const chunks = []
  let total = 0
  for await (const chunk of stream) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += value.length
    if (total > MAX_MEDIA_BYTES) return null
    chunks.push(value)
  }
  if (!total) return null
  return Buffer.concat(chunks, total)
}
const RECONNECT_BASE_MS = 2000
const RECONNECT_MAX_MS = 60 * 1000
const MAX_RECONNECT_ATTEMPTS = 8

const DEFAULT_STATE = Object.freeze({
  status: 'disconnected',
  qrCode: null,
  error: null,
  phoneNumber: null,
  workerNumber: null,
  handshakeStatus: 'idle',
})

function normalizePhone(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_PHONE_LENGTH || !/^\+?[0-9\s().-]+$/.test(trimmed)) return ''
  const digits = trimmed.replace(/\D/g, '')
  return /^\d{8,15}$/.test(digits) ? digits : ''
}

function normalizeJid(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (/^\d{8,15}@s\.whatsapp\.net$/.test(trimmed)) return trimmed
  const phone = normalizePhone(trimmed)
  return phone ? `${phone}@s.whatsapp.net` : ''
}

function phoneFromJid(value) {
  if (typeof value !== 'string') return ''
  const match = value.match(/^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/i)
  return match ? match[1] : ''
}

function textFromMessage(message) {
  if (!message || typeof message !== 'object') return { text: '', type: 'text' }
  if (typeof message.conversation === 'string') return { text: message.conversation, type: 'text' }
  if (typeof message.extendedTextMessage?.text === 'string') return { text: message.extendedTextMessage.text, type: 'text' }
  if (typeof message.imageMessage?.caption === 'string') return { text: message.imageMessage.caption, type: 'image' }
  if (typeof message.videoMessage?.caption === 'string') return { text: message.videoMessage.caption, type: 'video' }
  if (typeof message.documentMessage?.caption === 'string') return { text: message.documentMessage.caption, type: 'document' }
  if (message.imageMessage) return { text: '', type: 'image' }
  if (message.videoMessage) return { text: '', type: 'video' }
  if (message.documentMessage) return { text: '', type: 'document' }
  if (message.audioMessage) return { text: '', type: 'audio' }
  return { text: '', type: 'text' }
}

function safeState(value) {
  const state = value && typeof value === 'object' ? value : DEFAULT_STATE
  return {
    status: ['disconnected', 'connecting', 'qr_required', 'connected', 'logged_out', 'blocked', 'error'].includes(state.status) ? state.status : 'disconnected',
    qrCode: typeof state.qrCode === 'string' && state.qrCode.length <= 16 * 1024 ? state.qrCode : null,
    error: typeof state.error === 'string' && state.error.length <= 512 ? state.error : null,
    phoneNumber: typeof state.phoneNumber === 'string' ? state.phoneNumber : null,
    workerNumber: typeof state.workerNumber === 'string' ? state.workerNumber : null,
    handshakeStatus: ['idle', 'pending', 'expired', 'verified'].includes(state.handshakeStatus) ? state.handshakeStatus : 'idle',
  }
}

class WhatsAppBaileysService {
  constructor({ dataDir, logger = console, onState = () => {}, onMessage = async () => {}, loadBaileys = () => import('@whiskeysockets/baileys') } = {}) {
    if (!dataDir || typeof dataDir !== 'string') throw new Error('WhatsApp data directory is required')
    this.authDir = path.join(dataDir, 'whatsapp-auth')
    this.logger = logger
    this.onState = onState
    this.onMessage = onMessage
    this.loadBaileys = loadBaileys
    this.state = { ...DEFAULT_STATE }
    this.socket = null
    this.explicitDisconnect = false
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    this.pendingHandshake = null
    this.handshakeTimer = null
    this.processedMessageIds = new Map()
    this.stateGet = () => null
    this.stateSet = () => {}
    this.baileys = null
  }

  configureStateAccessors({ get, set } = {}) {
    if (typeof get === 'function') this.stateGet = get
    if (typeof set === 'function') this.stateSet = set
  }

  getState() {
    return { ...this.state }
  }

  emitState(next) {
    this.state = safeState({ ...this.state, ...next })
    try { this.onState(this.getState()) } catch {}
  }

  async initialize() {
    const savedPhone = normalizePhone(this.stateGet('whatsapp_target_phone'))
    if (savedPhone) this.emitState({ phoneNumber: savedPhone })
  }

  async connect(targetPhoneNumber = undefined) {
    if (this.state.status === 'connected' || this.state.status === 'connecting' || this.state.status === 'qr_required') return this.getState()
    const requestedPhone = targetPhoneNumber === undefined ? this.state.phoneNumber : normalizePhone(targetPhoneNumber)
    if (targetPhoneNumber !== undefined && targetPhoneNumber !== null && !requestedPhone) throw new Error('Invalid WhatsApp target phone number')
    this.explicitDisconnect = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.emitState({ status: 'connecting', qrCode: null, error: null, phoneNumber: requestedPhone || null })
    try {
      fs.mkdirSync(this.authDir, { recursive: true, mode: 0o700 })
      const baileys = await this.loadBaileys()
      this.baileys = baileys
      const makeWASocket = baileys.default || baileys
      const { state, saveCreds } = await baileys.useMultiFileAuthState(this.authDir)
      const latest = await baileys.fetchLatestBaileysVersion()
      const silentLogger = {
        level: 'silent',
        trace() {}, debug() {}, info() {},
        warn: (...args) => this.logger.warn?.('[Baileys]', ...args),
        error: (...args) => this.logger.error?.('[Baileys]', ...args),
        fatal: (...args) => this.logger.error?.('[Baileys]', ...args),
        child: () => silentLogger,
      }
      const socket = makeWASocket({
        version: latest?.version,
        auth: state,
        logger: silentLogger,
        printQRInTerminal: false,
        browser: ['WhatsApp', 'Chrome', '124.0.6367.118'],
        connectTimeoutMs: 60 * 1000,
        markOnlineOnConnect: true,
      })
      this.socket = socket
      socket.ev.on('creds.update', saveCreds)
      socket.ev.on('connection.update', update => this.handleConnectionUpdate(update, baileys.DisconnectReason, requestedPhone))
      socket.ev.on('messages.upsert', update => { void this.handleMessages(update) })
      return this.getState()
    } catch (error) {
      this.socket = null
      const message = error instanceof Error ? error.message : 'WhatsApp connection failed'
      this.emitState({ status: 'error', qrCode: null, error: message.slice(0, 512) })
      throw error
    }
  }

  handleConnectionUpdate(update, DisconnectReason, requestedPhone) {
    const connection = update?.connection
    if (typeof update?.qr === 'string' && update.qr.length <= 16 * 1024) {
      this.emitState({ status: 'qr_required', qrCode: update.qr, error: null })
    }
    if (connection === 'open') {
      this.reconnectAttempts = 0
      const workerNumber = phoneFromJid(this.socket?.user?.id || '') || null
      this.emitState({ status: 'connected', qrCode: null, error: null, workerNumber })
      return
    }
    if (connection !== 'close') return
    this.socket = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.explicitDisconnect) return
    const statusCode = update?.lastDisconnect?.error?.output?.statusCode
    const message = String(update?.lastDisconnect?.error?.message || update?.lastDisconnect?.reason || 'WhatsApp connection closed')
    if (DisconnectReason && statusCode === DisconnectReason.loggedOut) {
      this.clearAuth()
      this.emitState({ status: 'logged_out', qrCode: null, error: 'WhatsApp session was logged out. Scan the QR code again.', phoneNumber: null, workerNumber: null, handshakeStatus: 'idle' })
      return
    }
    if (statusCode === 403) {
      this.emitState({ status: 'blocked', qrCode: null, error: 'WhatsApp rejected this connection.' })
      return
    }
    if ((requestedPhone || this.state.workerNumber) && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** this.reconnectAttempts))
      this.reconnectAttempts += 1
      this.emitState({ status: 'disconnected', qrCode: null, error: null })
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(requestedPhone || undefined).catch(() => {}) }, delay)
      this.reconnectTimer.unref?.()
      return
    }
    this.emitState({ status: 'error', qrCode: null, error: message.slice(0, 512) })
  }

  async handleMessages(update) {
    if (update?.type !== 'notify' || !Array.isArray(update.messages)) return
    for (const raw of update.messages) {
      if (this.pendingHandshake && Date.now() >= this.pendingHandshake.expires) {
        this.pendingHandshake = null
        if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
        this.handshakeTimer = null
        this.emitState({ handshakeStatus: 'expired' })
      }
      const key = raw?.key || {}
      const id = typeof key.id === 'string' ? key.id : ''
      const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : ''
      if (!id || !remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')) continue
      const seenAt = this.processedMessageIds.get(id)
      if (seenAt && seenAt > Date.now() - 10 * 60 * 1000) continue
      this.processedMessageIds.set(id, Date.now())
      for (const [seenId, timestamp] of this.processedMessageIds) {
        if (timestamp <= Date.now() - 10 * 60 * 1000) this.processedMessageIds.delete(seenId)
      }
      const parsed = textFromMessage(raw.message)
      if (parsed.text.length > MAX_TEXT_LENGTH) continue
      const descriptor = inboundMediaDescriptor(raw.message)
      if (!parsed.text && !descriptor) continue
      let mediaBytes = null
      if (descriptor && (!descriptor.declaredSize || descriptor.declaredSize <= MAX_MEDIA_BYTES)) {
        try {
          const downloader = this.baileys?.downloadMediaMessage
          if (typeof downloader === 'function') {
            const downloaded = await downloader(raw, 'buffer', {}, {
              logger: this.logger,
              reuploadRequest: this.socket?.updateMediaMessage,
            })
            mediaBytes = await readInboundMediaStream(downloaded)
          }
        } catch (error) {
          this.logger.warn?.('[agentd] WhatsApp inbound media download failed')
        }
      }
      if (!parsed.text && !mediaBytes) continue
      const fromJid = typeof key.participant === 'string' ? key.participant : remoteJid
      const from = phoneFromJid(fromJid) || fromJid
      const isFromMe = key.fromMe === true
      if (this.pendingHandshake && !isFromMe) {
        const expected = normalizePhone(this.pendingHandshake.phoneNumber)
        const received = normalizePhone(from)
        if (expected && received === expected && parsed.text.replace(/\D/g, '').includes(this.pendingHandshake.code)) {
          this.pendingHandshake = null
          if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
          this.handshakeTimer = null
          this.emitState({ phoneNumber: received, handshakeStatus: 'verified' })
          this.stateSet('whatsapp_target_phone', received)
          continue
        }
      }
      if (isFromMe) continue
      const timestamp = Number(raw.messageTimestamp)
      try {
        await this.onMessage({
          id,
          providerEventId: `baileys:${id}`,
          from,
          to: phoneFromJid(this.socket?.user?.id || '') || '',
          content: parsed.text,
          type: parsed.type,
          timestamp: Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp * 1000 : Date.now(),
          isFromMe: false,
          conversationId: remoteJid,
          ...(mediaBytes && descriptor ? { media: { ...descriptor, bytes: mediaBytes, size: mediaBytes.length } } : {}),
        })
      } catch (error) {
        this.logger.warn?.('[agentd] WhatsApp inbound handling failed', error)
      }
    }
  }

  async sendText(to, text) {
    if (this.state.status !== 'connected' || !this.socket) throw Object.assign(new Error('WhatsApp is not connected'), { statusCode: 409 })
    const jid = normalizeJid(to)
    if (!jid) throw Object.assign(new Error('Invalid WhatsApp recipient'), { statusCode: 400 })
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH) throw Object.assign(new Error('Invalid WhatsApp message'), { statusCode: 400 })
    const result = await this.socket.sendMessage(jid, { text: text.trim() })
    const providerMessageId = result?.key?.id
    if (typeof providerMessageId !== 'string' || !providerMessageId) throw new Error('WhatsApp provider did not return a message ID')
    return { providerMessageId }
  }

  async sendMedia(to, bytes, { type, fileName, mimeType, caption = '' } = {}) {
    if (this.state.status !== 'connected' || !this.socket) throw Object.assign(new Error('WhatsApp is not connected'), { statusCode: 409 })
    const jid = normalizeJid(to)
    if (!jid) throw Object.assign(new Error('Invalid WhatsApp recipient'), { statusCode: 400 })
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_MEDIA_BYTES) throw Object.assign(new Error('WhatsApp media is too large or empty'), { statusCode: 413 })
    if (!['image', 'video', 'audio', 'document'].includes(type)) throw Object.assign(new Error('Unsupported WhatsApp media type'), { statusCode: 400 })
    if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > MAX_MEDIA_FILENAME_LENGTH || /[\0\r\n\\/]/.test(fileName)) throw Object.assign(new Error('Invalid WhatsApp media filename'), { statusCode: 400 })
    if (typeof mimeType !== 'string' || !mimeType.trim() || mimeType.length > MAX_MEDIA_MIME_LENGTH || /[\0\r\n]/.test(mimeType)) throw Object.assign(new Error('Invalid WhatsApp media MIME type'), { statusCode: 400 })
    if (!isSupportedMediaMime(type, mimeType)) throw Object.assign(new Error('Unsupported WhatsApp media MIME type'), { statusCode: 415 })
    if (typeof caption !== 'string' || caption.length > MAX_TEXT_LENGTH) throw Object.assign(new Error('Invalid WhatsApp media caption'), { statusCode: 400 })

    const message = type === 'image'
      ? { image: bytes, mimetype: mimeType, ...(caption.trim() ? { caption: caption.trim() } : {}) }
      : type === 'video'
        ? { video: bytes, mimetype: mimeType, ...(caption.trim() ? { caption: caption.trim() } : {}) }
        : type === 'audio'
          ? { audio: bytes, mimetype: mimeType, ptt: false }
          : { document: bytes, fileName: fileName.trim(), mimetype: mimeType, ...(caption.trim() ? { caption: caption.trim() } : {}) }
    try {
      const result = await this.socket.sendMessage(jid, message)
      const providerMessageId = result?.key?.id
      if (typeof providerMessageId !== 'string' || !providerMessageId) throw new Error('WhatsApp provider did not return a message ID')
      return { providerMessageId }
    } catch (error) {
      if (error?.statusCode) throw error
      throw Object.assign(new Error('WhatsApp media message failed'), { statusCode: 502, cause: error })
    }
  }

  async setTargetPhoneNumber(phoneNumber) {
    const normalized = normalizePhone(phoneNumber)
    if (!normalized) return { success: false, error: 'Invalid phone number' }
    const worker = normalizePhone(this.state.workerNumber)
    if (worker && worker === normalized) return { success: false, error: 'Cannot use the same number for Worker and Personal' }
    if (this.state.status !== 'connected') return { success: false, error: 'WhatsApp is not connected' }
    const code = String(crypto.randomInt(100000, 1000000))
    this.pendingHandshake = { phoneNumber: normalized, code, expires: Date.now() + 5 * 60 * 1000 }
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = setTimeout(() => {
      if (this.pendingHandshake?.code !== code) return
      this.pendingHandshake = null
      this.handshakeTimer = null
      this.emitState({ handshakeStatus: 'expired' })
    }, 5 * 60 * 1000)
    this.handshakeTimer.unref?.()
    this.emitState({ handshakeStatus: 'pending' })
    try {
      await this.sendText(normalized, '🤖 AICA verification\n\nReply to this message with the 6-digit verification code shown on your computer.')
      return { success: true, handshakeCode: code }
    } catch (error) {
      this.pendingHandshake = null
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
      this.emitState({ handshakeStatus: 'idle' })
      return { success: false, error: error instanceof Error ? error.message : 'Verification message failed' }
    }
  }

  clearAuth() {
    try { fs.rmSync(this.authDir, { recursive: true, force: true }) } catch {}
  }

  async disconnect(clearAuth = true) {
    this.explicitDisconnect = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const socket = this.socket
    this.socket = null
    try {
      if (socket) {
        if (clearAuth && typeof socket.logout === 'function') await socket.logout()
        else if (typeof socket.end === 'function') socket.end(undefined)
      }
    } catch (error) { this.logger.warn?.('[agentd] WhatsApp disconnect failed', error) }
    if (clearAuth) this.clearAuth()
    this.pendingHandshake = null
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer)
    this.handshakeTimer = null
    this.reconnectAttempts = 0
    this.emitState({ status: 'disconnected', qrCode: null, error: null, phoneNumber: clearAuth ? null : this.state.phoneNumber, workerNumber: clearAuth ? null : this.state.workerNumber, handshakeStatus: 'idle' })
    if (clearAuth) this.stateSet('whatsapp_target_phone', null)
  }
}

module.exports = { WhatsAppBaileysService, normalizePhone, normalizeJid, textFromMessage, DEFAULT_STATE, MAX_MEDIA_BYTES, isSupportedMediaMime }
