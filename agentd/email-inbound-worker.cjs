const net = require('node:net')
const tls = require('node:tls')

// IMAP literals are bounded before parsing. The parser keeps text bodies small
// while allowing a few modest, scan-able MIME parts to reach the daemon.
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024
const MAX_TEXT_BODY_BYTES = 128 * 1024
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024
const MAX_HEADER_BYTES = 32 * 1024
const MAX_ATTACHMENT_BYTES = 512 * 1024
const MAX_TOTAL_ATTACHMENT_BYTES = 1024 * 1024
const MAX_ATTACHMENTS = 5

function imapQuote(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000\r\n]/.test(value)) throw new Error('Invalid IMAP credential')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

class ImapConnection {
  constructor(socket) {
    this.socket = socket
    this.buffer = Buffer.alloc(0)
    this.waiters = []
    this.byteWaiters = []
    this.closed = false
    this.socket.on('data', chunk => this.onData(chunk))
    this.socket.once('error', () => this.fail(new Error('IMAP endpoint unavailable')))
    this.socket.once('close', () => this.fail(new Error('IMAP endpoint closed')))
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (this.buffer.length > MAX_RESPONSE_BYTES) return this.fail(new Error('IMAP response too large'))
    for (const waiter of this.byteWaiters.splice(0)) waiter()
    this.flush()
  }

  flush() {
    while (this.waiters.length) {
      const waiter = this.waiters[0]
      const lineEnd = this.buffer.indexOf(0x0a)
      if (lineEnd < 0) return
      const raw = this.buffer.subarray(0, lineEnd + 1)
      this.buffer = this.buffer.subarray(lineEnd + 1)
      const line = raw.toString('utf8').replace(/\r?\n$/, '')
      if (Buffer.byteLength(line, 'utf8') > 8192) return this.fail(new Error('IMAP response line too large'))
      this.waiters.shift()
      waiter.resolve(line)
    }
  }

  fail(error) {
    if (this.closed) return
    this.closed = true
    while (this.waiters.length) this.waiters.shift().reject(error)
    while (this.byteWaiters.length) this.byteWaiters.shift()(error)
  }

  line(timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error('IMAP connection closed'))
    const lineEnd = this.buffer.indexOf(0x0a)
    if (lineEnd >= 0) {
      const raw = this.buffer.subarray(0, lineEnd + 1)
      this.buffer = this.buffer.subarray(lineEnd + 1)
      return Promise.resolve(raw.toString('utf8').replace(/\r?\n$/, ''))
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error('IMAP endpoint timed out'))
      }, timeoutMs)
      const originalResolve = resolve
      waiter.resolve = value => { clearTimeout(waiter.timer); originalResolve(value) }
      waiter.reject = error => { clearTimeout(waiter.timer); reject(error) }
      this.waiters.push(waiter)
    })
  }

  async bytes(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) throw new Error('IMAP literal too large')
    while (this.buffer.length < length) {
      if (this.closed) throw new Error('IMAP connection closed')
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = this.byteWaiters.indexOf(notify)
          if (index >= 0) this.byteWaiters.splice(index, 1)
          reject(new Error('IMAP literal timed out'))
        }, 10000)
        const notify = error => {
          clearTimeout(timer)
          if (error) reject(error)
          else resolve()
        }
        this.byteWaiters.push(notify)
      })
    }
    const value = this.buffer.subarray(0, length)
    this.buffer = this.buffer.subarray(length)
    return value
  }

  async command(tag, command) {
    this.socket.write(`${tag} ${command}\r\n`)
    const lines = []
    const literals = []
    let total = 0
    while (true) {
      const line = await this.line()
      total += Buffer.byteLength(line, 'utf8')
      if (total > MAX_RESPONSE_BYTES) throw new Error('IMAP response too large')
      const literal = /\{(\d+)\}$/.exec(line)
      if (literal) literals.push(await this.bytes(Number(literal[1])))
      lines.push(line)
      if (line.startsWith(`${tag} `)) {
        if (!/^(?:OK|NO|BAD)\b/i.test(line.slice(tag.length + 1))) throw new Error('IMAP command failed')
        return { lines, literals }
      }
    }
  }

  close(destroy = true) {
    this.fail(new Error('IMAP connection closed'))
    this.socket.removeAllListeners('data')
    if (destroy) this.socket.destroy()
  }
}

function connect(host, port, secure) {
  return secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
    : net.connect({ host, port })
}

function splitHeaders(raw) {
  const crlf = raw.indexOf(Buffer.from('\r\n\r\n'))
  const lf = raw.indexOf(Buffer.from('\n\n'))
  const separator = crlf >= 0 ? crlf : lf
  if (separator < 0 || separator > MAX_HEADER_BYTES) throw new Error('Email headers are malformed')
  const split = crlf >= 0 ? 4 : 2
  const headerText = raw.subarray(0, separator).toString('utf8')
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ')
  const headers = new Map()
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) throw new Error('Email header is malformed')
    const name = line.slice(0, index).trim().toLowerCase()
    const value = line.slice(index + 1).trim()
    if (!/^[a-z0-9-]+$/.test(name) || value.length > 8192) throw new Error('Email header is malformed')
    if (!headers.has(name)) headers.set(name, value)
  }
  return { headers, body: raw.subarray(separator + split) }
}

function headerParameters(value) {
  const parts = String(value || '').split(';')
  const type = (parts.shift() || '').trim().toLowerCase()
  const parameters = new Map()
  for (const rawPart of parts) {
    const index = rawPart.indexOf('=')
    if (index <= 0) continue
    const name = rawPart.slice(0, index).trim().toLowerCase()
    let parameter = rawPart.slice(index + 1).trim()
    if (parameter.startsWith('"') && parameter.endsWith('"')) parameter = parameter.slice(1, -1).replace(/\\([\\"])/g, '$1')
    parameters.set(name, parameter)
  }
  for (const [name, value] of [...parameters]) {
    if (!name.endsWith('*')) continue
    try {
      const encoded = value.replace(/^[^']*''/, '')
      parameters.set(name.slice(0, -1), decodeURIComponent(encoded))
    } catch { parameters.delete(name) }
  }
  return { type, parameters }
}

function safeFilename(value, fallback) {
  const normalized = String(value || '').replace(/[\u0000\r\n\\/]/g, '_').trim().slice(0, 256)
  return normalized || fallback
}

function decodeQuotedPrintableBytes(value) {
  const text = value.toString('utf8')
  const output = []
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '=' && /[0-9a-fA-F]{2}/.test(text.slice(index + 1, index + 3))) {
      output.push(Number.parseInt(text.slice(index + 1, index + 3), 16)); index += 2
    } else if (text[index] === '=' && (text[index + 1] === '\n' || (text[index + 1] === '\r' && text[index + 2] === '\n'))) {
      index += text[index + 1] === '\r' ? 2 : 1
    } else {
      const byte = Buffer.from(text[index], 'utf8'); for (const value of byte) output.push(value)
    }
  }
  return Buffer.from(output)
}

function decodeTransfer(body, transfer) {
  const encoding = String(transfer || '7bit').trim().toLowerCase()
  if (['7bit', '8bit', 'binary'].includes(encoding)) return Buffer.from(body)
  if (encoding === 'quoted-printable') return decodeQuotedPrintableBytes(body)
  if (encoding === 'base64') {
    const encoded = body.toString('ascii').replace(/[\t\r\n ]/g, '')
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('Invalid base64 email part')
    const decoded = Buffer.from(encoded, 'base64')
    if (decoded.toString('base64') !== encoded) throw new Error('Invalid base64 email part')
    return decoded
  }
  throw new Error('Unsupported email transfer encoding')
}

function splitMultipart(body, boundary) {
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw new Error('Email MIME boundary is invalid')
  const marker = Buffer.from(`--${boundary}`)
  const parts = []
  let cursor = body.indexOf(marker)
  while (cursor >= 0) {
    const after = cursor + marker.length
    if (body[after] === 0x2d && body[after + 1] === 0x2d) break
    const start = body[after] === 0x0d && body[after + 1] === 0x0a ? after + 2 : body[after] === 0x0a ? after + 1 : -1
    if (start < 0) throw new Error('Email MIME boundary is malformed')
    const next = body.indexOf(marker, start)
    if (next < 0) throw new Error('Email MIME boundary is incomplete')
    let end = next
    if (body[end - 2] === 0x0d && body[end - 1] === 0x0a) end -= 2
    else if (body[end - 1] === 0x0a) end -= 1
    parts.push(body.subarray(start, end))
    cursor = next
  }
  if (!parts.length) throw new Error('Email MIME body is empty')
  return parts
}

function parseTextMessage(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > MAX_MESSAGE_BYTES) throw new Error('Email message too large')
  const root = splitHeaders(raw)
  const attachments = []
  const attachmentState = { nextId: 1, totalBytes: 0 }
  let textBody = null

  const visit = (headers, body, depth) => {
    if (depth > 4) throw new Error('Email MIME nesting is too deep')
    const contentType = headerParameters(headers.get('content-type') || 'text/plain')
    const disposition = headerParameters(headers.get('content-disposition') || '')
    if (contentType.type.startsWith('multipart/')) {
      for (const part of splitMultipart(body, contentType.parameters.get('boundary'))) {
        const parsed = splitHeaders(part)
        visit(parsed.headers, parsed.body, depth + 1)
      }
      return
    }
    const filename = contentType.parameters.get('filename') || contentType.parameters.get('name') || disposition.parameters.get('filename') || disposition.parameters.get('name')
    const decoded = decodeTransfer(body, headers.get('content-transfer-encoding'))
    const isAttachment = Boolean(filename) || disposition.type === 'attachment'
    if (isAttachment) {
      if (attachments.length >= MAX_ATTACHMENTS) throw new Error('Too many email attachments')
      const id = `imap-${attachmentState.nextId++}`
      const metadata = { id, name: safeFilename(filename, `attachment-${attachments.length + 1}`), mimeType: contentType.type || 'application/octet-stream', size: decoded.length }
      // Preserve metadata for larger parts but only retain bytes within the
      // daemon's small-media budget. The server will scan retained bytes.
      if (decoded.length <= MAX_ATTACHMENT_BYTES && attachmentState.totalBytes + decoded.length <= MAX_TOTAL_ATTACHMENT_BYTES) {
        metadata.bytes = decoded
        attachmentState.totalBytes += decoded.length
      }
      attachments.push(metadata)
      return
    }
    if (contentType.type === 'text/plain' && textBody === null) {
      if (decoded.length > MAX_TEXT_BODY_BYTES || decoded.includes(0)) throw new Error('Email body is invalid')
      textBody = decoded.toString('utf8')
    }
  }
  visit(root.headers, root.body, 0)
  if (textBody === null) throw new Error('Only text/plain email is supported')
  const headers = root.headers
  const from = headers.get('from') || ''
  const to = headers.get('to') || ''
  const timestamp = Date.parse(headers.get('date') || '')
  return {
    from: from.slice(0, 320),
    to: to.slice(0, 320),
    subject: (headers.get('subject') || '').slice(0, 998),
    body: textBody,
    bodyType: 'text',
    timestamp: Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now(),
    ...(headers.get('message-id') ? { messageId: headers.get('message-id').slice(0, 998) } : {}),
    ...(headers.get('in-reply-to') ? { inReplyTo: headers.get('in-reply-to').slice(0, 998) } : {}),
    ...(headers.get('references') ? { references: headers.get('references').slice(0, 8192) } : {}),
    ...(attachments.length ? { attachments } : {}),
  }
}

async function openImap(settings, password) {
  const directTls = settings.imapTls && settings.imapPort === 993
  let socket = connect(settings.imapHost, settings.imapPort, directTls)
  let connection = new ImapConnection(socket)
  const greeting = await connection.line()
  if (!/^\* (?:OK|PREAUTH)\b/i.test(greeting)) throw new Error('Invalid IMAP greeting')
  let tag = 1
  const command = (text) => connection.command(`A${String(tag++).padStart(3, '0')}`, text)
  if (settings.imapTls && !directTls) {
    const response = await command('STARTTLS')
    if (!response.lines.at(-1)?.match(/\bOK\b/i)) throw new Error('IMAP STARTTLS unavailable')
    connection.close(false)
    socket = tls.connect({ socket, servername: settings.imapHost, rejectUnauthorized: true })
    connection = new ImapConnection(socket)
    tag = 1
  }
  const login = await command(`LOGIN ${imapQuote(settings.userName || settings.emailAddress)} ${imapQuote(password)}`)
  if (!login.lines.at(-1)?.match(/\bOK\b/i)) throw new Error('IMAP authentication failed')
  return { connection, command, close: () => connection.close() }
}

async function pollMailbox(settings, password, lastUid = 0) {
  const session = await openImap(settings, password)
  try {
    await session.command('SELECT INBOX')
    const search = await session.command(`UID SEARCH UID ${Math.max(1, lastUid + 1)}:*`)
    const line = search.lines.find(item => /^\* SEARCH(?: |$)/.test(item)) || ''
    const uids = (line.match(/\d+/g) || []).map(Number)
      .filter(uid => Number.isSafeInteger(uid) && uid > lastUid)
      .sort((a, b) => a - b)
      .slice(0, 50)
    const messages = []
    for (const uid of uids) {
      const response = await session.command(`UID FETCH ${uid} (UID BODY.PEEK[])`)
      const raw = response.literals[0]
      if (!raw) throw new Error('IMAP message literal missing')
      try {
        messages.push({ uid, payload: parseTextMessage(raw) })
      } catch (error) {
        // A malformed/unsupported message is immutable on the server. Return a
        // bounded rejection marker so one bad message cannot block newer mail;
        // the worker advances the UID cursor without ingesting its content.
        messages.push({ uid, rejected: true, reason: error instanceof Error ? error.message : 'Unsupported email message' })
      }
    }
    return messages
  } finally {
    session.close()
  }
}

class EmailInboundWorker {
  constructor({ credentials, getSettings, getCursor, setCursor, onMessage, logger = console, poll = pollMailbox } = {}) {
    this.credentials = credentials
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
    const gated = settings?.enabled && ['imap-smtp', 'gmail-api'].includes(settings.provider)
      && settings.gmailAuthMode === 'app-password' && settings.imapTls && settings.imapHost
    if (gated && this.credentials) {
      try {
        // `email_mcp_password` was the browser credential name used by the
        // first agentd email slice. Keep it as a read-only fallback so an
        // existing browser setup continues to work while new writes use the
        // transport-specific IMAP key.
        let password = await this.credentials.get('email_imap_password')
        if (!password) password = await this.credentials.get('email_mcp_password')
        if (password) {
          this.active = this.poll(settings, password, this.getCursor())
          const messages = await this.active
          for (const message of messages) {
            if (message.rejected) {
              this.logger.warn?.(`[agentd] skipped unsupported inbound email: ${message.reason}`)
            } else {
              await this.onMessage(settings, message)
            }
            // Persist after every UID. A later transient failure must not make
            // earlier successful messages replay on the next poll.
            this.setCursor(message.uid)
          }
        }
      } catch { this.logger.warn?.('[agentd] email inbound polling failed') }
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

module.exports = { EmailInboundWorker, pollMailbox, parseTextMessage, ImapConnection }
