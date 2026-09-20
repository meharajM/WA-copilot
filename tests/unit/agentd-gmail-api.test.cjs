const assert = require('node:assert/strict')
const test = require('node:test')
const { GmailInboundWorker, extractGmailBody, pollGmail, toInboundGmailMessage } = require('../../agentd/gmail-api.cjs')

const encode = value => Buffer.from(value, 'utf8').toString('base64url')

test('agentd Gmail API parser prefers bounded text/plain and marks sent messages', () => {
  const payload = {
    mimeType: 'multipart/alternative',
    headers: [
      { name: 'From', value: 'Owner <owner@example.test>' },
      { name: 'To', value: 'customer@example.test' },
      { name: 'Subject', value: 'Hello' },
      { name: 'Message-Id', value: '<gmail-1@example.test>' },
    ],
    parts: [{ mimeType: 'text/plain', body: { data: encode('Plain body') } }, { mimeType: 'text/html', body: { data: encode('<p>HTML body</p>') } }],
  }
  assert.equal(extractGmailBody(payload), 'Plain body')
  assert.deepEqual(toInboundGmailMessage({ id: 'gmail-1', labelIds: ['INBOX', 'SENT'], internalDate: '1720000000000', payload }, 'owner@example.test'), {
    id: 'gmail-1', sourceId: 'gmail-1', from: 'owner@example.test', to: 'customer@example.test', subject: 'Hello', body: 'Plain body', bodyType: 'text', timestamp: 1720000000000,
    messageId: '<gmail-1@example.test>', isFromMe: true,
  })
})

test('agentd Gmail API poll uses bounded fixed query and advances timestamp cursor', async () => {
  const calls = []
  const oauth = {
    getStatus: () => ({ email: 'owner@example.test' }),
    request: async path => {
      calls.push(path)
      if (path.startsWith('/messages?')) return { messages: [{ id: 'gmail-1' }] }
      if (path === '/messages/gmail-1?format=full') return {
        id: 'gmail-1', internalDate: '1720000000000', labelIds: ['INBOX'], payload: {
          headers: [{ name: 'From', value: 'sender@example.test' }, { name: 'To', value: 'owner@example.test' }, { name: 'Subject', value: 'Help' }],
          body: { data: encode('Need help') },
        },
      }
      throw new Error('unexpected Gmail path')
    },
  }
  const result = await pollGmail(oauth, { maxEmailsPerPoll: 10 }, 1719999990000)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].uid, 'gmail-1')
  assert.equal(result.messages[0].payload.body, 'Need help')
  assert.ok(result.nextCursor >= 1720000000000)
  assert.match(calls[0], /^\/messages\?/)
  assert.match(calls[0], /q=(?:in%3A|in:)inbox(?:\+|%20)(?:after%3A|after:)/)
})

test('agentd Gmail inbound worker only runs when Gmail OAuth mode is enabled', async () => {
  let calls = 0
  let cursor = 10
  const messages = []
  const worker = new GmailInboundWorker({
    oauth: { initialize: async () => {}, getStatus: () => ({ signedIn: true }) },
    getSettings: () => ({ enabled: true, provider: 'gmail-api', gmailAuthMode: 'google-oauth', pollingIntervalSeconds: 60 }),
    getCursor: () => cursor,
    setCursor: value => { cursor = value },
    poll: async () => { calls += 1; return { messages: [{ uid: 20, payload: { from: 'a@example.test' } }], nextCursor: 30 } },
    onMessage: async (_settings, message) => messages.push(message),
    logger: { warn() {} },
  })
  await worker.start()
  worker.stop()
  assert.equal(calls, 1)
  assert.equal(cursor, 30)
  assert.equal(messages.length, 1)
})

test('agentd Gmail inbound worker does not call the provider before OAuth sign-in', async () => {
  let calls = 0
  const worker = new GmailInboundWorker({
    oauth: { initialize: async () => {}, getStatus: () => ({ signedIn: false }) },
    getSettings: () => ({ enabled: true, provider: 'gmail-api', gmailAuthMode: 'google-oauth', pollingIntervalSeconds: 60 }),
    getCursor: () => 0,
    setCursor: () => {},
    poll: async () => { calls += 1; return { messages: [], nextCursor: 0 } },
    onMessage: async () => {},
    logger: { warn() {} },
  })
  await worker.start()
  worker.stop()
  assert.equal(calls, 0)
})
