const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const test = require('node:test')
const { GmailOAuthService } = require('../../agentd/gmail-oauth.cjs')
const { AgentdServer } = require('../../agentd/server.cjs')
const { makeTempDir } = require('./temp-dir.cjs')

function fakeCredentials(records) {
  return {
    get: async key => records.get(key) ?? null,
    set: async (key, value) => { records.set(key, value) },
    delete: async key => { records.delete(key) },
    exists: async key => records.has(key),
  }
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function request(origin, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(`${origin}${pathname}`, { method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? (String(res.headers['content-type']).includes('json') ? JSON.parse(text) : text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

test('agentd Gmail OAuth uses loopback PKCE and stores only refresh token in the OS credential adapter', async () => {
  const records = new Map()
  const state = new Map()
  const calls = []
  const service = new GmailOAuthService({
    credentials: fakeCredentials(records),
    clientId: 'desktop-client-id',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url === 'https://oauth2.googleapis.com/token') return jsonResponse({ access_token: 'access-never-returned', expires_in: 3600, refresh_token: 'refresh-never-returned' })
      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return jsonResponse({ email: 'Owner@Example.com' })
      throw new Error(`unexpected URL ${url}`)
    },
  })
  service.configureStateAccessors({ get: key => state.get(key) ?? null, set: (key, value) => value === null ? state.delete(key) : state.set(key, value) })
  const started = await service.start('http://127.0.0.1:43001')
  const authUrl = new URL(started.authorizationUrl)
  assert.equal(authUrl.origin, 'https://accounts.google.com')
  assert.equal(authUrl.searchParams.get('client_id'), 'desktop-client-id')
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'http://127.0.0.1:43001/api/v1/email/oauth/callback')
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(authUrl.searchParams.get('code_challenge').length, 43)
  assert.equal(authUrl.searchParams.get('state').length, 32)
  const status = await service.complete({ code: 'authorization-code', state: authUrl.searchParams.get('state') })
  assert.deepEqual(status, { signedIn: true, email: 'owner@example.com', requiresReauthentication: false })
  assert.equal(records.get('gmail_oauth_refresh_token'), 'refresh-never-returned')
  assert.equal(state.get('gmail_oauth_email'), 'owner@example.com')
  assert.equal(JSON.stringify(status).includes('access-never-returned'), false)
  assert.equal(calls.length, 2)
  await assert.rejects(() => service.complete({ code: 'authorization-code', state: authUrl.searchParams.get('state') }), /state|expired/i)
  await service.signOut()
  assert.equal(records.has('gmail_oauth_refresh_token'), false)
  assert.equal(state.has('gmail_oauth_email'), false)
})

test('agentd Gmail OAuth fails closed on refresh revocation and rejects malformed callback state', async () => {
  const records = new Map([['gmail_oauth_refresh_token', 'refresh-token'], ['gmail_oauth_client_id', 'client-id']])
  const service = new GmailOAuthService({
    credentials: fakeCredentials(records),
    fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 400),
  })
  await service.initialize()
  assert.equal(service.getStatus().signedIn, true)
  await assert.rejects(() => service.getAccessToken(), /refresh failed/i)
  assert.deepEqual(service.getStatus(), { signedIn: false, email: null, requiresReauthentication: true })
  await assert.rejects(() => service.complete({ code: 'x', state: 'bad' }), /state/i)
})

test('agentd Gmail OAuth sends bounded text-only messages through fixed Gmail API', async () => {
  const records = new Map([['gmail_oauth_refresh_token', 'refresh-token'], ['gmail_oauth_client_id', 'client-id']])
  const calls = []
  const service = new GmailOAuthService({
    credentials: fakeCredentials(records),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url === 'https://oauth2.googleapis.com/token') return jsonResponse({ access_token: 'access-token', expires_in: 3600 })
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') return jsonResponse({ id: 'gmail-message-1' })
      throw new Error(`unexpected URL ${url}`)
    },
  })
  assert.equal(await service.sendText({ to: 'customer@example.test', subject: 'Re: Help', body: 'Reply' }), 'gmail-message-1')
  const payload = JSON.parse(calls.at(-1).init.body)
  const decoded = Buffer.from(payload.raw, 'base64url').toString('utf8')
  assert.match(decoded, /To: customer@example\.test\r\nSubject: Re: Help/)
  assert.match(decoded, /\r\n\r\nReply$/)
  await assert.rejects(() => service.sendText({ to: 'bad\r\nBcc: attacker@example.test', subject: 'No', body: 'x' }), /Invalid Gmail message/)
  assert.equal(JSON.stringify(calls.at(-1)).includes('refresh-token'), false)
})

test('agentd Gmail OAuth sends bounded operator attachments as multipart MIME', async () => {
  const records = new Map([['gmail_oauth_refresh_token', 'refresh-token'], ['gmail_oauth_client_id', 'client-id']])
  const calls = []
  const service = new GmailOAuthService({
    credentials: fakeCredentials(records),
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      if (url === 'https://oauth2.googleapis.com/token') return jsonResponse({ access_token: 'access-token', expires_in: 3600 })
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') return jsonResponse({ id: 'gmail-message-attachment-1' })
      throw new Error(`unexpected URL ${url}`)
    },
  })
  assert.equal(await service.sendText({
    to: 'customer@example.test', subject: 'Invoice', body: 'Attached.',
    attachments: [{ name: 'notes.txt', mimeType: 'text/plain', size: 5, dataBase64: 'aGVsbG8=' }],
  }), 'gmail-message-attachment-1')
  const decoded = Buffer.from(JSON.parse(calls.at(-1).init.body).raw, 'base64url').toString('utf8')
  assert.match(decoded, /Content-Type: multipart\/mixed; boundary=/)
  assert.match(decoded, /Content-Disposition: attachment; filename\*=UTF-8''notes.txt/)
  assert.match(decoded, /aGVsbG8=/)
})

test('agentd browser routes own Gmail OAuth callback and never return token material', async () => {
  const previousClientId = process.env.GMAIL_OAUTH_CLIENT_ID
  process.env.GMAIL_OAUTH_CLIENT_ID = 'desktop-client-id'
  const dataDir = makeTempDir('aica-agentd-gmail-oauth-route-')
  const records = new Map()
  const server = new AgentdServer({
    dataDir,
    secret: 'g'.repeat(32),
    pairingCode: '123456',
    credentials: fakeCredentials(records),
    providerFetch: async (url) => {
      if (url === 'https://oauth2.googleapis.com/token') return jsonResponse({ access_token: 'access-never-returned', expires_in: 3600, refresh_token: 'refresh-never-returned' })
      if (url === 'https://www.googleapis.com/oauth2/v2/userinfo') return jsonResponse({ email: 'owner@example.test' })
      throw new Error(`unexpected URL ${url}`)
    },
    logger: { log() {} },
  })
  try {
    const { origin } = await server.start()
    const auth = { authorization: `Bearer ${'g'.repeat(32)}` }
    const started = await request(origin, 'POST', '/api/v1/email/oauth/start', {}, auth)
    assert.equal(started.status, 200)
    const authUrl = new URL(started.body.authorizationUrl)
    const callback = await request(origin, 'GET', `/api/v1/email/oauth/callback?code=code-1&state=${encodeURIComponent(authUrl.searchParams.get('state'))}`)
    assert.equal(callback.status, 200)
    assert.equal(callback.body.includes('complete'), true)
    const status = await request(origin, 'GET', '/api/v1/email/oauth/status', undefined, auth)
    assert.deepEqual(status.body, { signedIn: true, email: 'owner@example.test', requiresReauthentication: false })
    assert.equal(JSON.stringify(status.body).includes('access-never-returned'), false)
    assert.equal((await request(origin, 'POST', '/api/v1/email/oauth/signout', {}, auth)).status, 200)
    assert.equal(records.has('gmail_oauth_refresh_token'), false)
  } finally {
    await server.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
    if (previousClientId === undefined) delete process.env.GMAIL_OAUTH_CLIENT_ID
    else process.env.GMAIL_OAUTH_CLIENT_ID = previousClientId
  }
})

test('agentd Gmail OAuth test and approved-draft send routes use Gmail API without SMTP credentials', async () => {
  const dataDir = makeTempDir('aica-agentd-gmail-delivery-')
  const records = new Map([['gmail_oauth_refresh_token', 'refresh-token'], ['gmail_oauth_client_id', 'desktop-client-id']])
  const calls = []
  const settings = {
    accountName: 'support', provider: 'gmail-api', gmailAuthMode: 'google-oauth',
    imapHost: '', imapPort: 993, smtpHost: '', smtpPort: 587,
    emailAddress: 'support@example.test', userName: '', imapTls: true, smtpTls: true,
    pollingIntervalSeconds: 60, enabled: true, autoReplyMode: false, draftMode: true,
  }
  const server = new AgentdServer({
    dataDir,
    secret: 'd'.repeat(32),
    credentials: fakeCredentials(records),
    providerFetch: async (url, init) => {
      calls.push({ url, init })
      if (url === 'https://oauth2.googleapis.com/token') return jsonResponse({ access_token: 'access-token', expires_in: 3600 })
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return jsonResponse({ emailAddress: 'support@example.test' })
      if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/messages?')) return jsonResponse({ messages: [] })
      if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send') return jsonResponse({ id: 'gmail-sent-1' })
      throw new Error(`unexpected URL ${url}`)
    },
    logger: { log() {}, warn() {} },
  })
  try {
    const { origin } = await server.start()
    const auth = { authorization: `Bearer ${'d'.repeat(32)}` }
    assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', settings, auth)).status, 200)
    const tested = await request(origin, 'POST', '/api/v1/email/test', {}, auth)
    assert.equal(tested.status, 200)
    assert.deepEqual(tested.body.transport, { gmailApi: { reachable: true, tls: true } })
    assert.equal(JSON.stringify(tested.body).includes('refresh-token'), false)
    const draft = {
      id: 'draft_gmail_1', responseText: 'Thanks for the details.', originalFrom: 'customer@example.test',
      originalSubject: 'Support request', replyTo: 'customer@example.test', accountName: 'support', createdAt: Date.now(),
      policyDecision: { action: 'draft', confidence: 0.5, rationale: 'Owner review', hasSensitiveTopic: false, sensitiveTopics: [] },
      status: 'approved',
    }
    assert.equal((await request(origin, 'POST', '/api/v1/email/drafts', draft, auth)).status, 200)
    const sent = await request(origin, 'POST', '/api/v1/email/drafts/draft_gmail_1/send', {}, auth)
    assert.equal(sent.status, 200)
    assert.equal(sent.body.draft.status, 'sent')
    assert.ok(calls.some(call => call.url === 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'))
  } finally {
    await server.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
