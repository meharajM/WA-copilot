const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { PublicRelay } = require('../../relay/public-relay.cjs')

function request(origin, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body))
    const req = http.request(`${origin}${pathname}`, { method, headers: { ...(payload.length ? { 'content-type': 'application/json', 'content-length': payload.length } : {}), ...headers } }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let bodyValue = null
        if (text) {
          try { bodyValue = JSON.parse(text) } catch { bodyValue = text }
        }
        resolve({ status: res.statusCode, body: bodyValue })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

function signature(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`
}

test('public relay verifies, durably accepts, polls and acknowledges provider events', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aica-relay-'))
  const dbPath = path.join(root, 'relay.db')
  const providerSecret = 'p'.repeat(32)
  const agentSecret = 'a'.repeat(32)
  let now = 1_700_000_000_000
  const relay = new PublicRelay({
    dbPath,
    clock: () => now,
    ttlMs: 1_000,
    businessSecrets: { 'business-1:whatsapp-cloud': { providerSecret, agentSecret } },
  })
  const { origin } = await relay.start()
  try {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { display_phone_number: '1555' }, messages: [{ id: 'event-1', from: '1999', text: { body: 'hello' } }] } }] }] })
    assert.equal((await request(origin, 'POST', '/v1/webhooks/business-1/whatsapp-cloud', body, { 'x-hub-signature-256': 'sha256=bad' })).status, 401)
    const accepted = await request(origin, 'POST', '/v1/webhooks/business-1/whatsapp-cloud', body, { 'x-hub-signature-256': signature(providerSecret, body), 'x-provider-account-id': 'phone-1' })
    assert.deepEqual(accepted.body, { accepted: true, duplicate: false, eventId: 'event-1', id: 1 })
    assert.equal((await request(origin, 'POST', '/v1/webhooks/business-1/whatsapp-cloud', body, { 'x-hub-signature-256': signature(providerSecret, body), 'x-provider-account-id': 'phone-1' })).body.duplicate, true)

    const polled = await request(origin, 'GET', '/v1/agents/business-1/events?provider=whatsapp-cloud', undefined, { authorization: `Bearer ${agentSecret}` })
    assert.equal(polled.status, 200)
    assert.equal(polled.body.events.length, 1)
    assert.equal(Buffer.from(polled.body.events[0].body, 'base64').toString('utf8'), body)
    const event = polled.body.events[0]
    assert.equal((await request(origin, 'POST', `/v1/agents/business-1/events/${event.id}/ack`, { leaseToken: event.leaseToken, localCommitId: 'local-1' }, { authorization: `Bearer ${agentSecret}` })).status, 200)
    assert.equal((await request(origin, 'GET', '/v1/agents/business-1/events?provider=whatsapp-cloud', undefined, { authorization: `Bearer ${agentSecret}` })).body.events.length, 0)
    assert.equal((await request(origin, 'POST', '/v1/agents/business-1/send', { text: 'must not be relayed' }, { authorization: `Bearer ${agentSecret}` })).status, 404)
  } finally {
    await relay.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('public relay expires queued events and rejects insecure production configuration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aica-relay-expiry-'))
  const providerSecret = 'p'.repeat(32)
  const agentSecret = 'a'.repeat(32)
  let now = 1_700_000_000_000
  const relay = new PublicRelay({ dbPath: path.join(root, 'relay.db'), clock: () => now, ttlMs: 100, businessSecrets: { 'business-1:provider': { providerSecret, agentSecret } } })
  const { origin } = await relay.start()
  try {
    const body = JSON.stringify({ event_id: 'expiry-1', account_id: 'account-1' })
    assert.equal((await request(origin, 'POST', '/v1/webhooks/business-1/provider', body, { 'x-aica-signature': signature(providerSecret, body) })).status, 202)
    now += 101
    assert.equal(relay.sweep(), 1)
    assert.deepEqual((await request(origin, 'GET', '/v1/agents/business-1/events?provider=provider', undefined, { authorization: `Bearer ${agentSecret}` })).body.events, [])
  } finally {
    await relay.stop()
    fs.rmSync(root, { recursive: true, force: true })
  }
  const missingTls = new PublicRelay({ dbPath: path.join(os.tmpdir(), `aica-relay-tls-${Date.now()}.db`), businessSecrets: { 'business-1:provider': { providerSecret, agentSecret } }, requireTls: true })
  await assert.rejects(() => missingTls.start(), /TLS key and certificate required/)
  missingTls.db.close()
})
