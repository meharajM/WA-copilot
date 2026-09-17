const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const test = require('node:test')
const { AgentdServer } = require('../../agentd/server.cjs')

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
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-wa-drafts-')
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
  assert.equal((await request(origin, 'PATCH', `/api/v1/drafts/${id}`, { status: 'sent' }, auth)).body.status, 'sent')
  await server.stop()

  const recovered = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const restarted = await recovered.start()
  assert.equal((await request(restarted.origin, 'GET', `/api/v1/whatsapp/drafts/${id}`, undefined, auth)).body.status, 'sent')
  await request(restarted.origin, 'POST', '/api/v1/pause-all', {}, auth)
  const paused = await request(restarted.origin, 'POST', '/api/v1/whatsapp/events', { channel: 'whatsapp', providerEventId: 'paused-event', conversationId: 'chat', payload: {} }, auth)
  assert.deepEqual(paused.body, { accepted: false, paused: true, duplicate: false })
  assert.equal((await request(restarted.origin, 'GET', '/api/v1/drafts', undefined, auth)).body.drafts.length, 1)
  assert.equal((await request(restarted.origin, 'POST', '/api/v1/whatsapp/events', { channel: 'email', providerEventId: 'bad', conversationId: 'chat', payload: {} }, auth)).status, 400)
  await recovered.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

test('concurrent WhatsApp retries and legacy endpoint ordering stay idempotent', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-wa-race-')
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
