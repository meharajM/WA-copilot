const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const test = require('node:test')
const { AgentdServer } = require('../../agentd/server.cjs')
const { makeTempDir } = require('./temp-dir.cjs')

function request(origin, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(`${origin}${pathname}`, { method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

const settings = {
  accountName: 'default', provider: 'imap-smtp', gmailAuthMode: 'app-password',
  imapHost: 'imap.example.com', imapPort: 993, smtpHost: 'smtp.example.com', smtpPort: 587,
  emailAddress: 'support@example.com', userName: 'support@example.com', imapTls: true, smtpTls: true,
  pollingIntervalSeconds: 60, enabled: true, autoReplyMode: false, draftMode: true,
}

function draft(status = 'approved') {
  return {
    id: 'draft_transport_1', responseText: 'Thanks for reaching out.', originalFrom: 'customer@example.com',
    originalSubject: 'Question', replyTo: 'customer@example.com', policyDecision: {
      action: 'send', confidence: 0.9, rationale: 'safe', hasSensitiveTopic: false, sensitiveTopics: [],
    }, createdAt: Date.now(), status,
  }
}

test('agentd sends an approved browser email draft through daemon transport', async () => {
  const dataDir = makeTempDir('aica-email-transport-')
  const sent = []
  const server = new AgentdServer({
    dataDir, secret: 's'.repeat(32), pairingCode: '123456',
    credentials: { async get(key) { assert.equal(key, 'email_smtp_password'); return 'app-password' } },
    emailSend: async options => { sent.push(options); return { delivered: true } },
  })
  const { origin } = await server.start()
  const pair = await request(origin, 'POST', '/api/v1/pair', { code: '123456' }, { origin })
  const auth = { origin, cookie: pair.headers['set-cookie'][0].split(';')[0], 'x-csrf-token': pair.body.csrfToken }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', settings, auth)).status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/email/drafts', draft(), auth)).status, 200)
  const result = await request(origin, 'POST', '/api/v1/email/drafts/draft_transport_1/send', {}, auth)
  assert.equal(result.status, 200)
  assert.equal(result.body.draft.status, 'sent')
  assert.equal(sent[0].to, 'customer@example.com')
  assert.equal(sent[0].secure, true)
  assert.equal(sent[0].password, 'app-password')
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd refuses browser email delivery unless explicitly enabled and approved', async () => {
  const dataDir = makeTempDir('aica-email-transport-gate-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), pairingCode: '123456', credentials: { async get() { return 'secret' } }, emailSend: async () => { throw new Error('must not call') } })
  const { origin } = await server.start()
  const pair = await request(origin, 'POST', '/api/v1/pair', { code: '123456' }, { origin })
  const auth = { origin, cookie: pair.headers['set-cookie'][0].split(';')[0], 'x-csrf-token': pair.body.csrfToken }
  const disabled = { ...settings, enabled: false }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', disabled, auth)).status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/email/drafts', draft('pending_review'), auth)).status, 200)
  const result = await request(origin, 'POST', '/api/v1/email/drafts/draft_transport_1/send', {}, auth)
  assert.equal(result.status, 409)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
