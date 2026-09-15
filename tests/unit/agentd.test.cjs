const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const test = require('node:test')
const { AgentdServer } = require('../../agentd/server.cjs')

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

test('agentd persists events, enforces pairing/CSRF, and survives client disconnect', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), pairingCode: '123456', logger: { log() {} } })
  const { origin } = await server.start()
  const originHeaders = { origin }
  assert.equal((await request(origin, 'GET', '/healthz')).status, 200)
  assert.equal((await request(origin, 'GET', '/api/v1/status')).status, 401)
  const pair = await request(origin, 'POST', '/api/v1/pair', { code: '123456' }, originHeaders)
  assert.equal(pair.status, 200)
  const cookie = pair.headers['set-cookie'][0].split(';')[0]
  const auth = { ...originHeaders, cookie }
  assert.equal((await request(origin, 'POST', '/api/v1/pause-all', {}, auth)).status, 403)
  const session = { ...auth, 'x-csrf-token': pair.body.csrfToken }
  assert.equal((await request(origin, 'POST', '/api/v1/events', { channel: 'whatsapp', providerEventId: 'evt-1', conversationId: 'chat-1', payload: { text: 'hello' } }, session)).status, 202)
  const duplicate = await request(origin, 'POST', '/api/v1/events', { channel: 'whatsapp', providerEventId: 'evt-1', conversationId: 'chat-1', payload: { text: 'hello' } }, session)
  assert.deepEqual(duplicate.body, { accepted: true, duplicate: true, id: 1 })
  assert.equal((await request(origin, 'POST', '/api/v1/pause-all', {}, session)).body.paused, true)
  assert.equal((await request(origin, 'GET', '/api/v1/status', undefined, session)).body.events, 1)
  await server.stop()
  const recovered = new AgentdServer({ dataDir, secret: 's'.repeat(32), pairingCode: '654321', logger: { log() {} } })
  const recoveredInfo = await recovered.start()
  const bearer = { authorization: 'Bearer ' + 's'.repeat(32) }
  assert.equal((await request(recoveredInfo.origin, 'GET', '/api/v1/status', undefined, bearer)).body.events, 1)
  assert.equal((await request(recoveredInfo.origin, 'GET', '/api/v1/status', undefined, bearer)).body.paused, true)
  assert.equal((await request(recoveredInfo.origin, 'POST', '/api/v1/resume-all', {}, bearer)).status, 200)
  assert.equal((await request(recoveredInfo.origin, 'GET', '/api/v1/status', undefined, bearer)).body.paused, false)
  await recovered.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd rejects a second owner', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-lock-')
  const first = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  await first.start()
  await assert.rejects(() => new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } }).start(), /Another agentd instance/)
  await first.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd removes a stale lock left by a crashed owner', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-stale-lock-')
  fs.writeFileSync(`${dataDir}/agentd.lock`, '9007199254740991\n', { mode: 0o600 })
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  await server.start()
  assert.equal(fs.existsSync(`${dataDir}/agentd.lock`), true)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
