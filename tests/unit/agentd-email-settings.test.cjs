const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const test = require('node:test')
const { AgentdServer } = require('../../agentd/server.cjs')
const { makeTempDir } = require('./temp-dir.cjs')

function request(origin, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(`${origin}${pathname}`, { method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

test('agentd email settings are authenticated, bounded, durable, and secret-free', async () => {
  const dataDir = makeTempDir('aica-agentd-email-settings-')
  const secret = 'e'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'GET', '/api/v1/settings/email', undefined, bearer)).status, 200)
  const settings = {
    accountName: 'support', provider: 'imap-smtp', gmailAuthMode: 'app-password',
    imapHost: 'imap.example.test', imapPort: 993, smtpHost: 'smtp.example.test', smtpPort: 587,
    emailAddress: 'support@example.test', userName: 'support@example.test', imapTls: true, smtpTls: true,
    pollingIntervalSeconds: 120, enabled: true, autoReplyMode: false, draftMode: true,
  }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', settings, bearer)).status, 200)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', { ...settings, password: 'must-not-be-accepted' }, bearer)).status, 400)
  await server.stop()

  const restarted = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const recovered = await restarted.start()
  const response = await request(recovered.origin, 'GET', '/api/v1/settings/email', undefined, bearer)
  assert.deepEqual(response.body, settings)
  assert.equal(Object.prototype.hasOwnProperty.call(response.body, 'password'), false)
  await restarted.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd email transport test probes server-side and never returns credentials', async () => {
  const dataDir = makeTempDir('aica-agentd-email-test-')
  const records = new Map([['email_mcp_password', 'secret-never-return-this']])
  const probes = []
  const credentials = {
    exists: async key => records.has(key),
    get: async key => records.get(key) ?? null,
    set: async (key, value) => { records.set(key, value) },
    delete: async key => { records.delete(key) },
  }
  const server = new AgentdServer({
    dataDir,
    secret: 't'.repeat(32),
    credentials,
    emailProbe: async settings => {
      probes.push(settings)
      return { imap: { reachable: true, tls: true }, smtp: { reachable: true, tls: true } }
    },
    logger: { log() {} },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'t'.repeat(32)}` }
  const settings = {
    accountName: 'support', provider: 'imap-smtp', gmailAuthMode: 'app-password',
    imapHost: 'imap.example.test', imapPort: 993, smtpHost: 'smtp.example.test', smtpPort: 587,
    emailAddress: 'support@example.test', userName: 'support@example.test', imapTls: true, smtpTls: true,
    pollingIntervalSeconds: 60, enabled: false, autoReplyMode: false, draftMode: true,
  }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', settings, auth)).status, 200)
  const result = await request(origin, 'POST', '/api/v1/email/test', {}, auth)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, {
    success: true,
    credentialConfigured: true,
    transport: { imap: { reachable: true, tls: true }, smtp: { reachable: true, tls: true } },
  })
  assert.equal(JSON.stringify(result.body).includes('secret-never-return-this'), false)
  assert.equal(probes.length, 1)
  assert.equal(probes[0].emailAddress, settings.emailAddress)
  records.clear()
  assert.equal((await request(origin, 'POST', '/api/v1/email/test', {}, auth)).status, 400)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd browser email test rejects unauthenticated OAuth and custom MCP without probing', async () => {
  const dataDir = makeTempDir('aica-agentd-email-gated-')
  const credentials = { exists: async () => false, get: async () => null, set: async () => {}, delete: async () => {} }
  const server = new AgentdServer({ dataDir, secret: 'u'.repeat(32), credentials, emailProbe: async () => { throw new Error('must not probe') }, logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'u'.repeat(32)}` }
  const base = {
    accountName: 'support', provider: 'gmail-api', gmailAuthMode: 'google-oauth',
    imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587,
    emailAddress: 'support@example.test', userName: 'support@example.test', imapTls: true, smtpTls: true,
    pollingIntervalSeconds: 60, enabled: false, autoReplyMode: false, draftMode: true,
  }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', base, auth)).status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/email/test', {}, auth)).status, 409)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', { ...base, provider: 'custom-mcp', gmailAuthMode: 'app-password' }, auth)).status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/email/test', {}, auth)).status, 409)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd email inbound is durable, authenticated, bounded, and idempotent', async () => {
  const dataDir = makeTempDir('aica-agentd-email-inbound-')
  const secret = 'i'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  const event = {
    providerEventId: '<msg-1@example.test>',
    conversationId: 'email::sender@example.test::thread-1',
    payload: {
      from: 'sender@example.test', to: 'support@example.test', subject: 'Help', body: 'Hello',
      bodyType: 'text', timestamp: 1_700_000_000_000, messageId: '<msg-1@example.test>', isFromMe: false,
    },
  }
  const accepted = await request(origin, 'POST', '/api/v1/email/inbound', event, auth)
  assert.equal(accepted.status, 202)
  assert.deepEqual(accepted.body, { accepted: true, duplicate: false, id: 1 })
  const duplicate = await request(origin, 'POST', '/api/v1/email/inbound', event, auth)
  assert.equal(duplicate.status, 200)
  assert.deepEqual(duplicate.body, { accepted: true, duplicate: true, id: 1 })
  const listed = await request(origin, 'GET', '/api/v1/email/inbound?after_id=0&limit=20', undefined, auth)
  assert.equal(listed.status, 200)
  assert.equal(listed.body.events.length, 1)
  assert.deepEqual(listed.body.events[0].payload, event.payload)
  assert.equal(listed.body.nextAfterId, 1)
  const queued = await request(origin, 'GET', '/api/v1/email/inbound?after_id=0&status=queued', undefined, auth)
  assert.deepEqual(queued.body.events.map(item => item.id), [1])
  const claimed = await request(origin, 'POST', '/api/v1/email/inbound/claim', { limit: 1 }, auth)
  assert.equal(claimed.status, 200)
  assert.deepEqual(claimed.body.events.map(item => item.id), [1])
  assert.equal(claimed.body.events[0].status, 'processing')
  const secondClaim = await request(origin, 'POST', '/api/v1/email/inbound/claim', { limit: 1 }, auth)
  assert.deepEqual(secondClaim.body.events, [])
  server.db.prepare('UPDATE inbound_events SET claimed_at = ? WHERE id = ?').run(Date.now() - 10 * 60 * 1000, 1)
  const reclaimed = await request(origin, 'POST', '/api/v1/email/inbound/claim', { limit: 1 }, auth)
  assert.deepEqual(reclaimed.body.events.map(item => item.id), [1])
  assert.equal((await request(origin, 'POST', '/api/v1/email/inbound/ack', { eventIds: [1] }, auth)).status, 200)
  assert.deepEqual((await request(origin, 'POST', '/api/v1/email/inbound/ack', { eventIds: [1] }, auth)).body, { acknowledgedIds: [1] })
  assert.deepEqual((await request(origin, 'GET', '/api/v1/email/inbound?after_id=0&status=queued', undefined, auth)).body.events, [])
  assert.equal((await request(origin, 'GET', '/api/v1/email/inbound?after_id=0&status=invalid', undefined, auth)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/email/inbound/claim', { limit: 0 }, auth)).status, 400)
  assert.equal((await request(origin, 'POST', '/api/v1/email/inbound', { ...event, providerEventId: 'bad', payload: { ...event.payload, bodyType: 'binary' } }, auth)).status, 400)
  await server.stop()
  const restarted = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const recovered = await restarted.start()
  const recoveredList = await request(recovered.origin, 'GET', '/api/v1/email/inbound?after_id=0', undefined, auth)
  assert.equal(recoveredList.body.events.length, 1)
  assert.equal(recoveredList.body.events[0].status, 'completed')
  await restarted.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
