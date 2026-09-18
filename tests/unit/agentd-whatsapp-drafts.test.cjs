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
      let text = ''; res.on('data', chunk => { text += chunk }); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject); req.end(payload)
  })
}

test('authenticated WhatsApp events dedupe, pause, persist, and expose safe draft transitions', async () => {
  const dataDir = makeTempDir('aica-agentd-wa-drafts-')
  const secret = 's'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/whatsapp/events', { channel: 'whatsapp', providerEventId: 'evt-secret', conversationId: 'chat', payload: { accessToken: 'do-not-return' }, draftText: 'hello' })).status, 401)
  const event = await request(origin, 'POST', '/api/v1/whatsapp/events', { channel: 'whatsapp', providerEventId: 'evt-secret', conversationId: 'chat', payload: { accessToken: 'do-not-return' }, draftText: 'hello' }, auth)
  assert.equal(event.status, 202)
  assert.equal((await request(origin, 'POST', '/api/v1/whatsapp/events', { channel: 'whatsapp', providerEventId: 'evt-secret', conversationId: 'chat', payload: {} }, auth)).body.duplicate, true)
  const list = await request(origin, 'GET', '/api/v1/drafts', undefined, auth)
  assert.equal(list.body.drafts.length, 1)
  assert.equal(JSON.stringify(list.body).includes('do-not-return'), false)
  const id = list.body.drafts[0].id
  assert.equal((await request(origin, 'PATCH', `/api/v1/drafts/${id}`, { status: 'sent' }, auth)).status, 409)
  assert.equal((await request(origin, 'PATCH', `/api/v1/drafts/${id}`, { status: 'approved' }, auth)).status, 200)
  assert.equal((await request(origin, 'PATCH', `/api/v1/drafts/${id}`, { status: 'sent' }, auth)).status, 409)
  await server.stop()

  const recovered = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const restarted = await recovered.start()
  assert.equal((await request(restarted.origin, 'GET', `/api/v1/whatsapp/drafts/${id}`, undefined, auth)).body.status, 'approved')
  await request(restarted.origin, 'POST', '/api/v1/pause-all', {}, auth)
  const paused = await request(restarted.origin, 'POST', '/api/v1/whatsapp/events', { channel: 'whatsapp', providerEventId: 'paused-event', conversationId: 'chat', payload: {} }, auth)
  assert.deepEqual(paused.body, { accepted: false, paused: true, duplicate: false })
  assert.equal((await request(restarted.origin, 'GET', '/api/v1/drafts', undefined, auth)).body.drafts.length, 1)
  assert.equal((await request(restarted.origin, 'POST', '/api/v1/whatsapp/events', { channel: 'email', providerEventId: 'bad', conversationId: 'chat', payload: {} }, auth)).status, 400)
  await recovered.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('concurrent WhatsApp retries and legacy endpoint ordering stay idempotent', async () => {
  const dataDir = makeTempDir('aica-agentd-wa-race-')
  const secret = 'r'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  const event = { channel: 'whatsapp', providerEventId: 'race-event', conversationId: 'chat', payload: { authorization: 'secret-at-rest', nested: { apiKey: 'hidden' } }, draftText: 'reply' }
  const results = await Promise.all(Array.from({ length: 12 }, () => request(origin, 'POST', '/api/v1/whatsapp/events', event, auth)))
  assert.equal(results.every(result => result.status >= 200 && result.status < 300), true)
  assert.equal((await request(origin, 'GET', '/api/v1/drafts', undefined, auth)).body.drafts.length, 1)
  const db = new (require('better-sqlite3'))(`${dataDir}/agentd.db`)
  const stored = db.prepare('SELECT payload FROM inbound_events WHERE provider_event_id = ?').get('race-event').payload
  assert.equal(stored.includes('secret-at-rest'), false)
  assert.equal(stored.includes('hidden'), false)
  db.close()
  const legacy = { ...event, providerEventId: 'legacy-first' }
  assert.equal((await request(origin, 'POST', '/api/v1/events', legacy, auth)).status, 202)
  assert.equal((await request(origin, 'POST', '/api/v1/whatsapp/events', legacy, auth)).status, 200)
  assert.equal((await request(origin, 'GET', '/api/v1/drafts', undefined, auth)).body.drafts.length, 2)
  const drafts = (await request(origin, 'GET', '/api/v1/drafts', undefined, auth)).body.drafts
  const statusId = drafts.find(draft => draft.providerEventId === 'race-event').id
  const transitions = await Promise.all([
    request(origin, 'PATCH', `/api/v1/drafts/${statusId}`, { status: 'approved' }, auth),
    request(origin, 'PATCH', `/api/v1/drafts/${statusId}`, { status: 'rejected' }, auth),
  ])
  assert.equal(transitions.filter(result => result.status === 200).length, 1)
  assert.equal(transitions.filter(result => result.status === 409).length, 1)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('browser-authenticated explicit WhatsApp sends use Cloud transport without returning secrets', async () => {
  const dataDir = makeTempDir('aica-agentd-wa-send-')
  const secret = 'w'.repeat(32)
  const calls = []
  const credentials = {
    async get(key) { assert.equal(key, 'whatsapp_cloud_access_token'); return 'cloud-secret-token' },
    async exists() { return true },
    async set() {},
    async delete() {},
  }
  const server = new AgentdServer({
    dataDir,
    secret,
    credentials,
    providerFetch: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.123' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    logger: { log() {} },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  const configured = await request(origin, 'PUT', '/api/v1/settings/whatsapp', {
    whatsapp_transport: 'cloud',
    whatsapp_cloud_phone_number_id: '1234567890',
    whatsapp_cloud_api_version: 'v23.0',
  }, auth)
  assert.equal(configured.status, 200)
  const sent = await request(origin, 'POST', '/api/v1/whatsapp/messages', { to: '+1 (415) 555-1212', text: 'hello from browser' }, auth)
  assert.deepEqual(sent.body, { success: true, providerMessageId: 'wamid.123' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/1234567890/messages')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer cloud-secret-token')
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    messaging_product: 'whatsapp', to: '14155551212', type: 'text', text: { body: 'hello from browser' },
  })
  assert.equal(JSON.stringify(sent.body).includes('cloud-secret-token'), false)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('browser WhatsApp send stays fail-closed when transport/configuration is unavailable', async () => {
  const dataDir = makeTempDir('aica-agentd-wa-send-guard-')
  const secret = 'g'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/whatsapp/messages', { to: '14155551212', text: 'hello' }, auth)).status, 409)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/whatsapp', {
    whatsapp_transport: 'cloud', whatsapp_cloud_phone_number_id: '1234567890', whatsapp_cloud_api_version: 'v23.0',
  }, auth)).status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/whatsapp/messages', { to: 'not-a-number', text: 'hello' }, auth)).status, 400)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('approved WhatsApp drafts send through the durable browser outbox exactly once', async () => {
  const dataDir = makeTempDir('aica-agentd-wa-outbox-')
  const secret = 'o'.repeat(32)
  const calls = []
  const server = new AgentdServer({
    dataDir,
    secret,
    credentials: { async get() { return 'cloud-secret-token' }, async exists() { return true } },
    providerFetch: async (url, init) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.draft-1' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
    logger: { log() {} },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  await request(origin, 'PUT', '/api/v1/settings/whatsapp', { whatsapp_transport: 'cloud', whatsapp_cloud_phone_number_id: '1234567890', whatsapp_cloud_api_version: 'v23.0' }, auth)
  const event = await request(origin, 'POST', '/api/v1/whatsapp/events', { channel: 'whatsapp', providerEventId: 'draft-send-1', conversationId: '14155551212@s.whatsapp.net', payload: {}, draftText: 'approved reply' }, auth)
  assert.equal(event.status, 202)
  const draft = (await request(origin, 'GET', '/api/v1/drafts', undefined, auth)).body.drafts[0]
  assert.equal((await request(origin, 'POST', `/api/v1/whatsapp/drafts/${draft.id}/send`, { unexpected: true }, auth)).status, 400)
  assert.equal((await request(origin, 'POST', `/api/v1/whatsapp/drafts/${draft.id}/send`, {}, auth)).status, 409)
  assert.equal((await request(origin, 'PATCH', `/api/v1/drafts/${draft.id}`, { status: 'approved' }, auth)).status, 200)
  const sent = await request(origin, 'POST', `/api/v1/whatsapp/drafts/${draft.id}/send`, {}, auth)
  assert.deepEqual(sent.body, {
    success: true,
    duplicate: false,
    providerMessageId: 'wamid.draft-1',
    draft: {
      id: draft.id,
      channel: 'whatsapp',
      providerEventId: 'draft-send-1',
      conversationId: '14155551212@s.whatsapp.net',
      responseText: 'approved reply',
      status: 'sent',
      createdAt: draft.createdAt,
      updatedAt: sent.body.draft.updatedAt,
      sendStatus: 'sent',
      providerMessageId: 'wamid.draft-1',
      sendAttempts: 1,
    },
  })
  const duplicate = await request(origin, 'POST', `/api/v1/whatsapp/drafts/${draft.id}/send`, {}, auth)
  assert.deepEqual(duplicate.body, { success: true, duplicate: true, providerMessageId: 'wamid.draft-1', draft: sent.body.draft })
  assert.equal(calls.length, 1)
  assert.equal(JSON.stringify(sent.body).includes('cloud-secret-token'), false)
  const metrics = await request(origin, 'GET', '/api/v1/autonomy/metrics?days=14', undefined, auth)
  assert.equal(metrics.status, 200)
  assert.equal(metrics.body.inbound, 1)
  assert.equal(metrics.body.sent, 1)
  assert.equal(metrics.body.drafts, 0)
  assert.equal(metrics.body.draftApprovalRate, 1)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})
