const assert = require('node:assert/strict')
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

test('agentd exposes bounded Gmail attachment metadata and owner inspection through authenticated routes', async () => {
  const dataDir = makeTempDir('aica-agentd-email-attachments-')
  const secret = 'a'.repeat(32)
  const calls = []
  const server = new AgentdServer({
    dataDir,
    secret,
    credentials: {
      async get(key) {
        if (key === 'gmail_oauth_refresh_token') return 'refresh-token'
        if (key === 'gmail_oauth_client_id') return 'client-id'
        return null
      },
    },
    providerFetch: async (url) => {
      calls.push(String(url))
      if (String(url) === 'https://oauth2.googleapis.com/token') return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), { status: 200 })
      if (String(url).includes('/attachments/att-pdf')) return new Response(JSON.stringify({ data: 'JVBERi0xLjQ=', size: 8 }), { status: 200 })
      throw new Error(`unexpected provider request: ${url}`)
    },
    logger: { log() {} },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  const settings = {
    accountName: 'support', provider: 'gmail-api', gmailAuthMode: 'google-oauth',
    imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 587,
    emailAddress: 'support@example.test', userName: 'support@example.test', imapTls: true, smtpTls: true,
    pollingIntervalSeconds: 60, enabled: false, autoReplyMode: false, draftMode: true,
  }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', settings, auth)).status, 200)
  const event = {
    providerEventId: 'gmail:default:gmail-1',
    conversationId: 'email::sender@example.test::gmail-1',
    payload: {
      id: 'gmail-1', from: 'sender@example.test', to: 'support@example.test', subject: 'Report', body: 'See attached',
      bodyType: 'text', timestamp: 1_700_000_000_000, attachments: [{ id: 'att-pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 8 }],
    },
  }
  assert.equal((await request(origin, 'POST', '/api/v1/email/inbound', event, auth)).status, 202)
  const listed = await request(origin, 'GET', '/api/v1/email/attachments?limit=20', undefined, auth)
  assert.deepEqual(listed.body.attachments, [{ inboundId: '1', messageId: 'gmail-1', id: 'att-pdf', name: 'report.pdf', mimeType: 'application/pdf', size: 8, receivedAt: listed.body.attachments[0].receivedAt }])
  const inspected = await request(origin, 'POST', '/api/v1/email/attachments/gmail-1/att-pdf', { mimeType: 'application/pdf', name: 'report.pdf' }, auth)
  assert.equal(inspected.status, 200)
  assert.equal(inspected.body.scan.safe, true)
  assert.equal(inspected.body.bytes, 'JVBERi0xLjQ=')
  assert.equal(calls.filter(url => url.includes('/attachments/att-pdf')).length, 1)
  assert.equal(JSON.stringify(inspected.body).includes('access-token'), false)
  await server.stop()
  const fs = require('node:fs')
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd rejects unsupported or unsafe browser attachment inspection', async () => {
  const dataDir = makeTempDir('aica-agentd-email-attachments-gate-')
  const secret = 'b'.repeat(32)
  let providerCalls = 0
  const server = new AgentdServer({
    dataDir,
    secret,
    credentials: { async get() { return 'secret' } },
    providerFetch: async () => { providerCalls += 1; return new Response(JSON.stringify({ data: 'TVqQ', size: 3 }), { status: 200 }) },
    logger: { log() {} },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/email/attachments/message/attachment', { mimeType: 'application/pdf' }, auth)).status, 409)
  assert.equal(providerCalls, 0)
  await server.stop()
  const fs = require('node:fs')
  fs.rmSync(dataDir, { recursive: true, force: true })
})
