const MAX_BODY_BYTES = 128 * 1024
const MAX_MESSAGES_PER_POLL = 50
const MAX_ATTACHMENTS_PER_MESSAGE = 20
const MAX_ATTACHMENT_NAME_LENGTH = 256
const MAX_ATTACHMENT_MIME_LENGTH = 128

function parseEmailAddress(input) {
  if (typeof input !== 'string') return ''
  const trimmed = input.trim()
  const match = trimmed.match(/<([^>]+@[^>]+)>/)
  return (match?.[1] || (trimmed.includes('@') ? trimmed : '')).trim().toLowerCase()
}

function readHeader(headers, name) {
  if (!Array.isArray(headers)) return ''
  const found = headers.find(header => header && typeof header.name === 'string' && header.name.toLowerCase() === name.toLowerCase())
  return typeof found?.value === 'string' ? found.value.slice(0, 8192) : ''
}

function decodeGmailBase64(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_BODY_BYTES * 4 / 3) + 32) return ''
  try {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/')
    return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='), 'base64').toString('utf8')
  } catch { return '' }
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

function extractGmailBody(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType.toLowerCase() : ''
  if (typeof payload.body?.data === 'string' && payload.body.data) {
    const decoded = decodeGmailBase64(payload.body.data)
    if (decoded) {
      const value = mimeType === 'text/html' ? stripHtml(decoded) : decoded
      return Buffer.byteLength(value, 'utf8') <= MAX_BODY_BYTES ? value : ''
    }
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : []
  let htmlFallback = ''
  for (const part of parts) {
    const type = typeof part?.mimeType === 'string' ? part.mimeType.toLowerCase() : ''
    if (type === 'text/plain' || type.startsWith('multipart/')) {
      const text = extractGmailBody(part)
      if (text) return text
    } else if (type === 'text/html' && !htmlFallback) {
      htmlFallback = extractGmailBody(part)
    }
  }
  return htmlFallback
}

function extractGmailAttachments(payload, output = [], seen = new Set(), depth = 0) {
  if (!payload || typeof payload !== 'object' || output.length >= MAX_ATTACHMENTS_PER_MESSAGE || depth > 8) return output
  const body = payload.body && typeof payload.body === 'object' ? payload.body : {}
  const attachmentId = typeof body.attachmentId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(body.attachmentId)
    ? body.attachmentId
    : ''
  const filename = typeof payload.filename === 'string' ? payload.filename.trim().slice(0, MAX_ATTACHMENT_NAME_LENGTH) : ''
  const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType.trim().slice(0, MAX_ATTACHMENT_MIME_LENGTH) : ''
  const size = Number(body.size)
  if (attachmentId && !seen.has(attachmentId)) {
    seen.add(attachmentId)
    output.push({
      id: attachmentId,
      ...(filename ? { name: filename } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
    })
  }
  const parts = Array.isArray(payload.parts) ? payload.parts : []
  for (const part of parts) {
    if (output.length >= MAX_ATTACHMENTS_PER_MESSAGE) break
    extractGmailAttachments(part, output, seen, depth + 1)
  }
  return output
}

function toInboundGmailMessage(item, ownerEmail = '') {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(item.id)) return null
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {}
  const headers = Array.isArray(payload.headers) ? payload.headers : []
  const from = parseEmailAddress(readHeader(headers, 'From')) || 'unknown-sender'
  const body = extractGmailBody(payload) || (typeof item.snippet === 'string' ? item.snippet.slice(0, MAX_BODY_BYTES) : '')
  if (!body || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) return null
  const internalDate = Number(item.internalDate)
  const timestamp = Number.isFinite(internalDate) && internalDate > 0 ? internalDate : Date.now()
  const normalizedOwner = parseEmailAddress(ownerEmail)
  const labels = Array.isArray(item.labelIds) ? item.labelIds : []
  const attachments = extractGmailAttachments(payload)
  return {
    id: item.id,
    sourceId: item.id,
    from,
    to: parseEmailAddress(readHeader(headers, 'To')),
    subject: readHeader(headers, 'Subject') || '(No Subject)',
    body,
    bodyType: 'text',
    timestamp,
    ...(readHeader(headers, 'Message-Id') ? { messageId: readHeader(headers, 'Message-Id').slice(0, 998) } : {}),
    ...(readHeader(headers, 'In-Reply-To') ? { inReplyTo: readHeader(headers, 'In-Reply-To').slice(0, 998) } : {}),
    ...(readHeader(headers, 'References') ? { references: readHeader(headers, 'References').slice(0, 8192) } : {}),
    isFromMe: labels.includes('SENT') || Boolean(normalizedOwner && normalizedOwner === from),
    ...(attachments.length ? { attachments } : {}),
  }
}

async function pollGmail(oauth, settings, lastSyncMs = 0) {
  const cursor = Number.isSafeInteger(lastSyncMs) && lastSyncMs > 0 ? lastSyncMs : 0
  const afterSeconds = Math.max(0, Math.floor((cursor - 5 * 60 * 1000) / 1000))
  const query = afterSeconds > 0 ? `in:inbox after:${afterSeconds}` : 'in:inbox newer_than:1h'
  const params = new URLSearchParams({ maxResults: String(Math.min(Math.max(Number(settings?.maxEmailsPerPoll) || 10, 1), MAX_MESSAGES_PER_POLL)), q: query })
  const list = await oauth.request(`/messages?${params.toString()}`)
  const messages = Array.isArray(list?.messages) ? list.messages : []
  const results = []
  let maxTimestamp = Date.now()
  for (const item of messages.slice(0, MAX_MESSAGES_PER_POLL)) {
    if (!item || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(item.id)) continue
    try {
      const detail = await oauth.request(`/messages/${encodeURIComponent(item.id)}?format=full`)
      const payload = toInboundGmailMessage(detail, oauth.getStatus().email)
      const timestamp = Number(detail?.internalDate)
      if (Number.isFinite(timestamp) && timestamp > maxTimestamp) maxTimestamp = timestamp
      // Gmail message IDs are stable provider identities; timestamps are only
      // used for the overlap cursor and can collide for concurrent messages.
      if (payload) results.push({ uid: item.id, payload })
    } catch {
      results.push({ uid: Date.now(), rejected: true, reason: 'Gmail message could not be read' })
    }
  }
  return { messages: results, nextCursor: Math.max(maxTimestamp, Date.now()) }
}

class GmailInboundWorker {
  constructor({ oauth, getSettings, getCursor, setCursor, onMessage, logger = console, poll = pollGmail } = {}) {
    this.oauth = oauth
    this.getSettings = getSettings
    this.getCursor = getCursor
    this.setCursor = setCursor
    this.onMessage = onMessage
    this.logger = logger
    this.poll = poll
    this.timer = null
    this.running = false
    this.active = null
  }

  async start() {
    if (this.running) return
    this.running = true
    await this.run()
  }

  async run() {
    if (!this.running) return
    const settings = this.getSettings()
    const gated = settings?.enabled && settings.provider === 'gmail-api' && settings.gmailAuthMode === 'google-oauth'
    let authenticated = false
    if (gated && this.oauth) {
      try {
        await this.oauth.initialize?.()
        authenticated = this.oauth.getStatus?.().signedIn === true
        if (authenticated) {
          this.active = this.poll(this.oauth, settings, this.getCursor())
          const result = await this.active
          for (const message of result.messages || []) {
            if (message.rejected) this.logger.warn?.('[agentd] skipped unsupported Gmail message')
            else await this.onMessage(settings, message)
          }
          if (Number.isSafeInteger(result.nextCursor)) this.setCursor(result.nextCursor)
        }
      } catch { this.logger.warn?.('[agentd] Gmail API polling failed') }
      finally { this.active = null }
    }
    if (this.running) {
      const delay = Math.max(30, Number(settings?.pollingIntervalSeconds) || 60) * 1000
      this.timer = setTimeout(() => this.run(), delay)
      this.timer.unref?.()
    }
  }

  stop() {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

module.exports = { MAX_BODY_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, extractGmailBody, extractGmailAttachments, toInboundGmailMessage, pollGmail, GmailInboundWorker }
