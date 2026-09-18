const net = require('node:net')
const tls = require('node:tls')

const MAX_LINE = 4096
const MAX_RESPONSE_LINES = 100

function assertHeader(value, name, max = 998) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n]/.test(value)) {
    throw new Error(`Invalid email ${name}`)
  }
  return value.trim()
}

function assertAddress(value, name) {
  const address = assertHeader(value, name, 320)
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address)) throw new Error(`Invalid email ${name}`)
  return address
}

function buildTextEmail({ from, to, subject, body, messageId, inReplyTo, references }) {
  const sender = assertAddress(from, 'sender')
  const recipient = assertAddress(to, 'recipient')
  const title = assertHeader(subject || '(no subject)', 'subject')
  if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body, 'utf8') > 96 * 1024 || /\u0000/.test(body)) throw new Error('Invalid email body')
  const headers = [
    `From: ${sender}`,
    `To: ${recipient}`,
    `Subject: ${title}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ]
  for (const [name, value] of [['Message-ID', messageId], ['In-Reply-To', inReplyTo], ['References', references]]) {
    if (value) headers.push(`${name}: ${assertHeader(value, name, 8192)}`)
  }
  // SMTP DATA terminates on a line containing only a dot; dot-stuff every line.
  const normalized = body.replace(/\r?\n/g, '\r\n').replace(/\r(?!\n)/g, '\r\n')
  const stuffed = normalized.split('\r\n').map(line => line.startsWith('.') ? `.${line}` : line).join('\r\n')
  return { from: sender, to: recipient, data: `${headers.join('\r\n')}\r\n\r\n${stuffed}\r\n.\r\n` }
}

function socketReader(socket) {
  let buffer = ''
  let ended = false
  const waiters = []
  const lines = []
  const onData = chunk => {
    buffer += chunk.toString('utf8')
    if (buffer.length > MAX_LINE * MAX_RESPONSE_LINES) return fail(new Error('SMTP response too large'))
    while (true) {
      const index = buffer.indexOf('\n')
      if (index < 0) return
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      const waiter = waiters.shift()
      if (waiter) waiter.resolve(line)
      else lines.push(line)
    }
  }
  const fail = error => {
    if (ended) return
    ended = true
    while (waiters.length) waiters.shift().reject(error)
  }
  socket.on('data', onData)
  socket.once('error', () => fail(new Error('SMTP endpoint unavailable')))
  socket.once('close', () => fail(new Error('SMTP endpoint closed')))
  return {
    next(timeoutMs = 10000) {
      if (ended) return Promise.reject(new Error('SMTP endpoint closed'))
      if (lines.length) return Promise.resolve(lines.shift())
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject }
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('SMTP endpoint timed out'))
        }, timeoutMs)
        waiter.resolve = value => { clearTimeout(timer); resolve(value) }
        waiter.reject = error => { clearTimeout(timer); reject(error) }
        waiters.push(waiter)
      })
    },
    close(destroy = true) {
      socket.removeListener('data', onData)
      if (destroy) socket.destroy?.()
    },
  }
}

async function response(reader, expected, label) {
  const lines = []
  let line
  do {
    line = await reader.next()
    if (line.length > MAX_LINE || !/^\d{3}[ -]/.test(line)) throw new Error(`Invalid SMTP ${label} response`)
    lines.push(line)
    if (lines.length > MAX_RESPONSE_LINES) throw new Error(`SMTP ${label} response too large`)
  } while (line[3] === '-')
  if (!expected.includes(line.slice(0, 3))) throw new Error(`SMTP ${label} failed`)
  return lines
}

function connectSocket(host, port, secure) {
  return secure ? tls.connect({ host, port, servername: host, rejectUnauthorized: true }) : net.connect({ host, port })
}

async function sendTextEmail({ host, port, secure, username, password, from, to, subject, body, messageId, inReplyTo, references, connect = connectSocket, tlsConnect = (socket, servername) => tls.connect({ socket, servername, rejectUnauthorized: true }) }) {
  if (typeof host !== 'string' || !host || !Number.isSafeInteger(port) || port < 1 || port > 65535 || typeof username !== 'string' || !username || typeof password !== 'string' || !password) throw new Error('SMTP configuration is incomplete')
  if (typeof secure !== 'boolean') throw new Error('SMTP TLS setting is invalid')
  const message = buildTextEmail({ from, to, subject, body, messageId, inReplyTo, references })
  const directTls = secure && port === 465
  let socket = connect(host, port, directTls)
  let reader = socketReader(socket)
  try {
    await response(reader, ['220'], 'greeting')
    socket.write('EHLO localhost\r\n')
    await response(reader, ['250'], 'EHLO')
    if (secure && !directTls) {
      socket.write('STARTTLS\r\n')
      await response(reader, ['220'], 'STARTTLS')
      reader.close(false)
      socket = tlsConnect(socket, host)
      reader = socketReader(socket)
      socket.write('EHLO localhost\r\n')
      await response(reader, ['250'], 'EHLO after STARTTLS')
    }
    const auth = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64')
    socket.write(`AUTH PLAIN ${auth}\r\n`)
    await response(reader, ['235'], 'AUTH')
    socket.write(`MAIL FROM:<${message.from}>\r\n`)
    await response(reader, ['250'], 'MAIL FROM')
    socket.write(`RCPT TO:<${message.to}>\r\n`)
    await response(reader, ['250', '251'], 'RCPT TO')
    socket.write('DATA\r\n')
    await response(reader, ['354'], 'DATA')
    socket.write(message.data)
    await response(reader, ['250'], 'message delivery')
    socket.write('QUIT\r\n')
    return { delivered: true }
  } finally {
    reader.close()
    socket.destroy?.()
  }
}

module.exports = { buildTextEmail, sendTextEmail }
