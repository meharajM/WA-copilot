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

test('failed browser outbox attempts support retry and explicit operator disposition', async () => {
  const dataDir = makeTempDir('aica-agentd-wa-recovery-')
  const secret = 'y'.repeat(32)
  let calls = 0
  const server = new AgentdServer({
    dataDir,
    secret,
    credentials: { async get() { return 'cloud-secret-token' }, async exists() { return true } },
    providerFetch: async () => {
      calls += 1
      if (calls === 2) return new Response(JSON.stringify({ messages: [{ id: 'wamid.retry-1' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ error: { message: 'provider unavailable' } }), { status: 500, headers: { 'content-type': 'application/json' } })
    },
    logger: { log() {} },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  await request(origin, 'PUT', '/api/v1/settings/whatsapp', { whatsapp_transport: 'cloud', whatsapp_cloud_phone_number_id: '1234567890', whatsapp_cloud_api_version: 'v23.0' }, auth)

  const createDraft = async (providerEventId) => {
    const created = await request(origin, 'POST', '/api/v1/whatsapp/events', { channel: 'whatsapp', providerEventId, conversationId: '14155551212@s.whatsapp.net', payload: {}, draftText: 'operator recovery' }, auth)
    assert.equal(created.status, 202)
    const draft = (await request(origin, 'GET', `/api/v1/whatsapp/drafts?status=draft`, undefined, auth)).body.drafts[0]
    assert.equal((await request(origin, 'PATCH', `/api/v1/whatsapp/drafts/${draft.id}`, { status: 'approved' }, auth)).status, 200)
    return draft.id
  }

  const retryable = await createDraft('recovery-retry')
  assert.equal((await request(origin, 'POST', `/api/v1/whatsapp/drafts/${retryable}/send`, {}, auth)).status, 502)
  assert.equal((await request(origin, 'POST', `/api/v1/whatsapp/drafts/${retryable}/retry`, {}, auth)).body.providerMessageId, 'wamid.retry-1')

  const quarantined = await createDraft('recovery-quarantine')
  assert.equal((await request(origin, 'POST', `/api/v1/whatsapp/drafts/${quarantined}/send`, {}, auth)).status, 502)
  const quarantine = await request(origin, 'POST', `/api/v1/whatsapp/drafts/${quarantined}/quarantine`, {}, auth)
  assert.equal(quarantine.status, 200)
  assert.equal(quarantine.body.sendError, 'Quarantined by operator')
  assert.equal((await request(origin, 'POST', `/api/v1/whatsapp/drafts/${quarantined}/retry`, {}, auth)).status, 409)

  const cancelled = await createDraft('recovery-cancel')
  assert.equal((await request(origin, 'POST', `/api/v1/whatsapp/drafts/${cancelled}/send`, {}, auth)).status, 502)
  const cancel = await request(origin, 'POST', `/api/v1/whatsapp/drafts/${cancelled}/cancel`, {}, auth)
  assert.equal(cancel.status, 200)
  assert.equal(cancel.body.sendError, 'Cancelled by operator')
  assert.equal((await request(origin, 'POST', `/api/v1/whatsapp/drafts/${cancelled}/retry`, {}, auth)).status, 409)

  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('pending browser outbox cancellation is durable and provider-authoritative', async () => {
  const dataDir = makeTempDir('aica-agentd-wa-pending-cancel-')
  const secret = 'p'.repeat(32)
  let releaseProvider
  let providerStarted
  const providerReady = new Promise(resolve => { providerStarted = resolve })
  const server = new AgentdServer({
    dataDir,
    secret,
    credentials: { async get() { return 'cloud-secret-token' }, async exists() { return true } },
    providerFetch: async () => {
      providerStarted()
      return new Promise(resolve => { releaseProvider = resolve })
    },
    logger: { log() {} },
  })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${secret}` }
  await request(origin, 'PUT', '/api/v1/settings/whatsapp', { whatsapp_transport: 'cloud', whatsapp_cloud_phone_number_id: '1234567890', whatsapp_cloud_api_version: 'v23.0' }, auth)
  const created = await request(origin, 'POST', '/api/v1/whatsapp/events', { channel: 'whatsapp', providerEventId: 'pending-cancel', conversationId: '14155551212@s.whatsapp.net', payload: {}, draftText: 'pending reply' }, auth)
  assert.equal(created.status, 202)
  const draft = (await request(origin, 'GET', '/api/v1/whatsapp/drafts?status=draft', undefined, auth)).body.drafts[0]
  assert.equal((await request(origin, 'PATCH', `/api/v1/whatsapp/drafts/${draft.id}`, { status: 'approved' }, auth)).status, 200)
  const sending = request(origin, 'POST', `/api/v1/whatsapp/drafts/${draft.id}/send`, {}, auth)
  await providerReady
  const cancel = await request(origin, 'POST', `/api/v1/whatsapp/drafts/${draft.id}/cancel`, {}, auth)
  assert.equal(cancel.status, 202)
  assert.equal(cancel.body.sendStatus, 'pending')
  assert.equal(cancel.body.sendCancellationRequested, true)
  assert.equal(cancel.body.sendError, 'Cancellation requested by operator')
  releaseProvider(new Response(JSON.stringify({ messages: [{ id: 'wamid.cancel-race' }] }), { status: 200, headers: { 'content-type': 'application/json' } }))
  const sent = await sending
  assert.equal(sent.status, 200)
  assert.equal(sent.body.providerMessageId, 'wamid.cancel-race')
  const finalDraft = (await request(origin, 'GET', `/api/v1/whatsapp/drafts/${draft.id}`, undefined, auth)).body
  assert.equal(finalDraft.sendStatus, 'sent')
  assert.equal(finalDraft.sendCancellationRequested, undefined)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('draft send acquires migration admission before claiming the outbox', async () => {
  const dataDir = makeTempDir('aica-agentd-wa-claim-fence-')
  const secret = 'q'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  await server.start()
  const now = Date.now()
  const draft = server.db.prepare('INSERT INTO whatsapp_drafts(channel,provider_event_id,conversation_id,response_text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run('whatsapp', 'claim-fence', '14155551212@s.whatsapp.net', 'reply', 'approved', now, now)
  const originalBegin = server.beginActiveOperation.bind(server)
  server.beginActiveOperation = () => {
    server.migrationHold = true
    return null
  }
  const result = await server.performWhatsAppDraftSend(draft.lastInsertRowid)
  assert.equal(result.status, 409)
  assert.equal(server.db.prepare('SELECT 1 FROM whatsapp_outbox WHERE draft_id = ?').get(draft.lastInsertRowid), undefined)
  server.beginActiveOperation = originalBegin
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd owns WhatsApp inactivity follow-up, review admission, and user-silence logging', async () => {
  const dataDir = makeTempDir('aica-agentd-wa-inactivity-')
  const secret = 'i'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  await server.start()
  const old = Date.now() - 11 * 60 * 1000
  server.setState('whatsapp_ui_settings', JSON.stringify({ whatsappEnabled: true, businessBotMode: false, targetPhoneNumber: null }))
  server.db.prepare('INSERT INTO chat_sessions(id,title,status,channel,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('wa-review', 'Review', 'active', 'whatsapp', '14155551212@s.whatsapp.net', old, old)
  server.db.prepare('INSERT INTO chat_messages(session_id,message_id,role,content,created_at) VALUES (?,?,?,?,?)').run('wa-review', 'assistant-old', 'assistant', 'Previous answer', old)
  server.db.prepare('INSERT INTO chat_sessions(id,title,status,channel,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('wa-silence', 'Silence', 'active', 'whatsapp', '14155551313@s.whatsapp.net', old, old)
  server.db.prepare('INSERT INTO chat_messages(session_id,message_id,role,content,created_at) VALUES (?,?,?,?,?)').run('wa-silence', 'user-old', 'user', 'Question', old)

  await server.auditWhatsAppInactivity()
  const reviewDraft = server.db.prepare("SELECT * FROM whatsapp_drafts WHERE conversation_id = '14155551212@s.whatsapp.net'").get()
  assert.equal(reviewDraft.status, 'draft')
  assert.equal(reviewDraft.response_text.startsWith("It's been a while!"), true)
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = 'wa-review'").get().count, 2)
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM intelligence_logs WHERE event = 'user_silence'").get().count, 1)

  await server.auditWhatsAppInactivity()
  assert.equal(server.db.prepare('SELECT COUNT(*) AS count FROM whatsapp_drafts').get().count, 1)
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM intelligence_logs WHERE event = 'user_silence'").get().count, 1)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd inactivity autonomous mode approves and sends exactly once', async () => {
  const dataDir = makeTempDir('aica-agentd-wa-inactivity-auto-')
  const secret = 'j'.repeat(32)
  let sends = 0
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  await server.start()
  server.setState('whatsapp_ui_settings', JSON.stringify({ whatsappEnabled: false, businessBotMode: true, targetPhoneNumber: null }))
  server.sendWhatsAppConfiguredMessage = async () => {
    sends += 1
    return { providerMessageId: 'wamid.inactivity-1' }
  }
  const old = Date.now() - 11 * 60 * 1000
  server.db.prepare('INSERT INTO chat_sessions(id,title,status,channel,contact_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('wa-auto', 'Auto', 'active', 'whatsapp', '14155551414@s.whatsapp.net', old, old)
  server.db.prepare('INSERT INTO chat_messages(session_id,message_id,role,content,created_at) VALUES (?,?,?,?,?)').run('wa-auto', 'assistant-old', 'assistant', 'Previous answer', old)

  await server.auditWhatsAppInactivity()
  await server.auditWhatsAppInactivity()
  const draft = server.db.prepare('SELECT * FROM whatsapp_drafts').get()
  const outbox = server.db.prepare('SELECT * FROM whatsapp_outbox WHERE draft_id = ?').get(draft.id)
  assert.equal(draft.status, 'sent')
  assert.equal(outbox.status, 'sent')
  assert.equal(outbox.provider_message_id, 'wamid.inactivity-1')
  assert.equal(sends, 1)
  assert.equal(server.db.prepare("SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = 'wa-auto'").get().count, 2)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})
