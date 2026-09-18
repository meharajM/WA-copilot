const net = require('node:net')
const tls = require('node:tls')

const MAX_MESSAGE_BYTES = 128 * 1024
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_HEADER_BYTES = 32 * 1024

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

function decodeQuotedPrintable(value) {
  return value.replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/=\r?\n/g, '')
}

function parseTextMessage(raw) {
  if (!Buffer.isBuffer(raw) || raw.length > MAX_MESSAGE_BYTES) throw new Error('Email message too large')
  const separator = raw.indexOf(Buffer.from('\r\n\r\n'))
  const alt = separator < 0 ? raw.indexOf(Buffer.from('\n\n')) : separator
  if (alt < 0 || alt > MAX_HEADER_BYTES) throw new Error('Email headers are malformed')
  const split = separator >= 0 ? 4 : 2
  const headerText = raw.subarray(0, alt).toString('utf8')
  const bodyBytes = raw.subarray(alt + split)
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ')
  const headers = new Map()
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) throw new Error('Email header is malformed')
    const name = line.slice(0, index).toLowerCase()
    const value = line.slice(index + 1).trim()
    if (value.length > 8192) throw new Error('Email header is too large')
    if (!headers.has(name)) headers.set(name, value)
  }
  const type = (headers.get('content-type') || 'text/plain').split(';', 1)[0].trim().toLowerCase()
  if (type !== 'text/plain') throw new Error('Only text/plain email is supported')
  const transfer = (headers.get('content-transfer-encoding') || '7bit').trim().toLowerCase()
  let body
  if (['7bit', '8bit', 'binary'].includes(transfer)) body = bodyBytes.toString('utf8')
  else if (transfer === 'quoted-printable') body = decodeQuotedPrintable(bodyBytes.toString('utf8'))
  else throw new Error('Unsupported email transfer encoding')
  if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BYTES || /\u0000/.test(body)) throw new Error('Email body is invalid')
  const from = headers.get('from') || ''
  const to = headers.get('to') || ''
  const timestamp = Date.parse(headers.get('date') || '')
  return {
    from: from.slice(0, 320),
    to: to.slice(0, 320),
    subject: (headers.get('subject') || '').slice(0, 998),
    body,
    bodyType: 'text',
    timestamp: Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : Date.now(),
    ...(headers.get('message-id') ? { messageId: headers.get('message-id').slice(0, 998) } : {}),
    ...(headers.get('in-reply-to') ? { inReplyTo: headers.get('in-reply-to').slice(0, 998) } : {}),
    ...(headers.get('references') ? { references: headers.get('references').slice(0, 8192) } : {}),
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
    const uids = (line.match(/\d+/g) || []).map(Number).filter(uid => Number.isSafeInteger(uid) && uid > lastUid).slice(0, 50)
    const messages = []
    for (const uid of uids) {
      const response = await session.command(`UID FETCH ${uid} (UID BODY.PEEK[])`)
      const raw = response.literals[0]
      if (!raw) throw new Error('IMAP message literal missing')
      messages.push({ uid, payload: parseTextMessage(raw) })
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
        const password = await this.credentials.get('email_imap_password')
        if (password) {
          this.active = this.poll(settings, password, this.getCursor())
          const messages = await this.active
          for (const message of messages) await this.onMessage(settings, message)
          if (messages.length) this.setCursor(messages[messages.length - 1].uid)
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
