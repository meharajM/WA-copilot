const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const { buildTextEmail, sendTextEmail } = require('../../agentd/email-transport.cjs')

class FakeSmtpSocket extends EventEmitter {
  constructor({ greeting = true } = {}) {
    super()
    this.writes = []
    this.dataMode = false
    if (greeting) queueMicrotask(() => this.emit('data', Buffer.from('220 fake.example ESMTP\r\n')))
  }

  write(value) {
    this.writes.push(String(value))
    if (this.dataMode) {
      if (String(value).endsWith('\r\n.\r\n')) {
        this.dataMode = false
        queueMicrotask(() => this.emit('data', Buffer.from('250 2.0.0 queued\r\n')))
      }
      return true
    }
    const command = String(value).split('\r\n')[0].toUpperCase()
    const replies = command.startsWith('EHLO') ? '250-fake.example\r\n250 AUTH PLAIN\r\n'
      : command === 'STARTTLS' ? '220 2.0.0 ready for TLS\r\n'
      : command.startsWith('AUTH PLAIN') ? '235 2.7.0 authenticated\r\n'
        : command.startsWith('MAIL FROM') ? '250 2.1.0 sender ok\r\n'
          : command.startsWith('RCPT TO') ? '250 2.1.5 recipient ok\r\n'
            : command === 'DATA' ? '354 End data with <CR><LF>.<CR><LF>\r\n'
              : command === 'QUIT' ? '221 2.0.0 bye\r\n' : '500 unexpected\r\n'
    if (command === 'DATA') this.dataMode = true
    queueMicrotask(() => this.emit('data', Buffer.from(replies)))
    return true
  }

  destroy() { this.emit('close') }
}

test('buildTextEmail creates bounded text-only DATA and dot-stuffs body', () => {
  const message = buildTextEmail({ from: 'sender@example.com', to: 'user@example.com', subject: 'Hello', body: 'first\n.second' })
  assert.match(message.data, /Content-Type: text\/plain; charset=utf-8/)
  assert.match(message.data, /\r\n\.\.second\r\n\.\r\n$/)
  assert.equal(message.from, 'sender@example.com')
})

test('buildTextEmail rejects header injection and oversized body', () => {
  assert.throws(() => buildTextEmail({ from: 'a@example.com', to: 'b@example.com', subject: 'x\r\nBcc: bad@example.com', body: 'ok' }), /Invalid email subject/)
  assert.throws(() => buildTextEmail({ from: 'a@example.com', to: 'b@example.com', subject: 'x', body: 'x'.repeat(96 * 1024 + 1) }), /Invalid email body/)
})

test('sendTextEmail authenticates and delivers only text over SMTP', async () => {
  const socket = new FakeSmtpSocket()
  const result = await sendTextEmail({
    host: 'fake.example', port: 587, secure: false,
    username: 'sender@example.com', password: 'app-password',
    from: 'sender@example.com', to: 'user@example.com', subject: 'Re: Help', body: 'Safe reply',
    connect: () => socket,
  })
  assert.deepEqual(result, { delivered: true })
  assert.ok(socket.writes.some(write => write.startsWith('AUTH PLAIN ')))
  assert.ok(socket.writes.some(write => write.includes('Content-Type: text/plain')))
  assert.equal(socket.writes.some(write => /multipart|attachment/i.test(write)), false)
})

test('sendTextEmail upgrades STARTTLS before AUTH', async () => {
  const plain = new FakeSmtpSocket()
  const secure = new FakeSmtpSocket({ greeting: false })
  const upgraded = []
  const result = await sendTextEmail({
    host: 'fake.example', port: 587, secure: true,
    username: 'sender@example.com', password: 'app-password',
    from: 'sender@example.com', to: 'user@example.com', subject: 'TLS', body: 'Safe reply',
    connect: () => plain,
    tlsConnect: (socket) => { upgraded.push(socket); return secure },
  })
  assert.deepEqual(result, { delivered: true })
  assert.equal(upgraded[0], plain)
  assert.ok(plain.writes.includes('STARTTLS\r\n'))
  assert.ok(secure.writes.some(write => write.startsWith('AUTH PLAIN ')))
})
