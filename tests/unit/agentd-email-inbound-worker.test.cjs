const assert = require('node:assert/strict')
const net = require('node:net')
const test = require('node:test')
const { EmailInboundWorker, parseTextMessage, pollMailbox } = require('../../agentd/email-inbound-worker.cjs')

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

test('email inbound parser accepts bounded text/plain and rejects MIME outside browser scope', () => {
  const payload = parseTextMessage(Buffer.from([
    'From: Sender <sender@example.test>',
    'To: support@example.test',
    'Subject: Hello',
    'Message-ID: <one@example.test>',
    'Date: Tue, 01 Jan 2030 00:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Hello=20world',
  ].join('\r\n')))
  assert.equal(payload.body, 'Hello world')
  assert.equal(payload.bodyType, 'text')
  assert.equal(payload.messageId, '<one@example.test>')
  assert.throws(() => parseTextMessage(Buffer.from('Content-Type: multipart/mixed\r\n\r\nbody')), /text\/plain/)
  assert.throws(() => parseTextMessage(Buffer.from('Content-Type: text/html\r\n\r\nbody')), /text\/plain/)
})

test('fake IMAP server fetches UID messages and normalizes durable event payloads', async () => {
  const message = Buffer.from([
    'From: sender@example.test', 'To: support@example.test', 'Subject: New',
    'Message-ID: <uid-1@example.test>', 'Content-Type: text/plain', '', 'Body',
  ].join('\r\n'))
  const server = net.createServer(socket => {
    socket.write('* OK fake IMAP\r\n')
    let data = ''
    socket.on('data', chunk => {
      data += chunk.toString('utf8')
      let end
      while ((end = data.indexOf('\r\n')) >= 0) {
        const command = data.slice(0, end); data = data.slice(end + 2)
        const tag = command.split(' ', 1)[0]
        if (/ LOGIN /.test(command)) socket.write(`${tag} OK LOGIN\r\n`)
        else if (/SELECT INBOX/.test(command)) socket.write('* 1 EXISTS\r\n' + `${tag} OK SELECT\r\n`)
        else if (/UID SEARCH/.test(command)) socket.write('* SEARCH 1\r\n' + `${tag} OK SEARCH\r\n`)
        else if (/UID FETCH/.test(command)) socket.write(`* 1 FETCH (UID 1 BODY[] {${message.length}}\r\n` + message + `\r\n)\r\n${tag} OK FETCH\r\n`)
        else socket.write(`${tag} OK\r\n`)
      }
    })
  })
  const port = await listen(server)
  const messages = await pollMailbox({ imapHost: '127.0.0.1', imapPort: port, imapTls: false, userName: 'user', emailAddress: 'user@example.test' }, 'password', 0)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].uid, 1)
  assert.equal(messages[0].payload.body, 'Body')
  await new Promise(resolve => server.close(resolve))
})

test('inbound worker fail-closes when browser email TLS/app-password gate is incomplete', async () => {
  let calls = 0
  const worker = new EmailInboundWorker({
    credentials: { get: async () => 'secret' },
    getSettings: () => ({ enabled: true, provider: 'imap-smtp', gmailAuthMode: 'app-password', imapHost: 'x', imapTls: false, pollingIntervalSeconds: 60 }),
    getCursor: () => 0, setCursor: () => {}, onMessage: () => {}, poll: async () => { calls++ }, logger: { warn() {} },
  })
  await worker.start()
  worker.stop()
  assert.equal(calls, 0)
})
