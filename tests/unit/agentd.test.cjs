const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
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

function rawRequest(origin, pathname) {
  return new Promise((resolve, reject) => {
    http.get(`${origin}${pathname}`, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
    }).on('error', reject)
  })
}

test('agentd persists events, enforces pairing/CSRF, and survives client disconnect', async () => {
  const dataDir = makeTempDir('aica-agentd-')
  const logMessages = []
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), pairingCode: '123456', logger: { log: message => logMessages.push(message) } })
  const { origin } = await server.start()
  const originHeaders = { origin }
  const descriptorPath = path.join(dataDir, 'agentd.runtime.json')
  const descriptor = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'))
  assert.deepEqual(Object.keys(descriptor).sort(), ['origin', 'pid', 'processStartedAt', 'protocolVersion', 'runtimeId', 'startedAt'].sort())
  assert.equal(descriptor.origin, origin)
  assert.equal(descriptor.pid, process.pid)
  assert.ok(Number.isSafeInteger(descriptor.processStartedAt) && descriptor.processStartedAt > 0)
  assert.equal(server.server.requestTimeout, 30_000)
  assert.equal(server.server.headersTimeout, 10_000)
  assert.equal(server.server.keepAliveTimeout, 5_000)
  assert.equal(fs.existsSync(path.join(dataDir, 'agentd.pairing-code')), true)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dataDir).mode & 0o077, 0)
    assert.equal(fs.statSync(descriptorPath).mode & 0o077, 0)
    assert.equal(fs.statSync(path.join(dataDir, 'agentd.pairing-code')).mode & 0o077, 0)
  }
  const pairCodeCommand = path.resolve(__dirname, '../../scripts/agentd-pair-code.cjs')
  assert.equal(execFileSync(process.execPath, [pairCodeCommand], { env: { ...process.env, AICA_AGENTD_DATA_DIR: dataDir }, encoding: 'utf8' }).trim(), '123456')
  assert.equal(logMessages.some(message => message.includes('123456')), false)
  assert.equal((await request(origin, 'GET', '/healthz')).status, 200)
  const forgedHost = await request(origin, 'GET', '/healthz', undefined, { host: 'localhost:12345' })
  assert.equal(forgedHost.status, 403)
  assert.equal((await request(origin, 'GET', '/api/v1/status')).status, 401)
  assert.equal((await request(origin, 'GET', '/api/v1/status', undefined, { authorization: 'Bearer ' + 's'.repeat(32), host: 'localhost:12345' })).status, 403)
  assert.equal((await request(origin, 'POST', '/api/v1/pair', { code: '123456' }, { ...originHeaders, host: 'localhost:12345' })).status, 403)
  const pair = await request(origin, 'POST', '/api/v1/pair', { code: '123456' }, originHeaders)
  assert.equal(pair.status, 200)
  assert.equal(fs.existsSync(path.join(dataDir, 'agentd.pairing-code')), false)
  const cookie = pair.headers['set-cookie'][0].split(';')[0]
  const auth = { ...originHeaders, cookie }
  const csrfBootstrap = await request(origin, 'GET', '/api/v1/session', undefined, auth)
  assert.equal(csrfBootstrap.status, 200)
  assert.equal(csrfBootstrap.body.csrfToken, pair.body.csrfToken)
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
  assert.equal(fs.existsSync(descriptorPath), false)
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd rejects a second owner', async () => {
  const dataDir = makeTempDir('aica-agentd-lock-')
  const first = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  await first.start()
  await assert.rejects(() => new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } }).start(), /Another agentd instance/)
  await first.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd removes a stale lock left by a crashed owner', async () => {
  const dataDir = makeTempDir('aica-agentd-stale-lock-')
  fs.writeFileSync(`${dataDir}/agentd.lock`, '9007199254740991\n', { mode: 0o600 })
  const servers = [0, 1].map(() => new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } }))
  const results = await Promise.allSettled(servers.map(server => server.start()))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  const winner = servers[results.findIndex(result => result.status === 'fulfilled')]
  assert.equal(fs.existsSync(`${dataDir}/agentd.lock`), true)
  await winner.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd rate-limits wrong pairing codes without logging secrets', async () => {
  const dataDir = makeTempDir('aica-agentd-pair-limit-')
  const logMessages = []
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), pairingCode: '123456', logger: { log: message => logMessages.push(message) } })
  const { origin } = await server.start()
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await request(origin, 'POST', '/api/v1/pair', { code: '000000' }, { origin })).status, 401)
  }
  const blocked = await request(origin, 'POST', '/api/v1/pair', { code: '123456' }, { origin })
  assert.equal(blocked.status, 429)
  server.pairingBlockedUntil = Date.now() - 1
  const pair = await request(origin, 'POST', '/api/v1/pair', { code: '123456' }, { origin })
  assert.equal(pair.status, 200)
  assert.equal(logMessages.some(message => message.includes('123456')), false)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd exposes allowlisted credential set, presence, and delete without returning secret values', async () => {
  const dataDir = makeTempDir('aica-agentd-credentials-')
  const records = new Map()
  const credentials = {
    get: async key => records.get(key) ?? null,
    exists: async key => records.has(key),
    set: async (key, value) => { records.set(key, value) },
    delete: async key => { records.delete(key) },
  }
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), pairingCode: '246810', credentials, logger: { log() {} } })
  const { origin } = await server.start()
  assert.equal((await request(origin, 'GET', '/api/v1/credentials/openai_api_key')).status, 401)

  const pair = await request(origin, 'POST', '/api/v1/pair', { code: '246810' }, { origin })
  const auth = { origin, cookie: pair.headers['set-cookie'][0].split(';')[0] }
  const session = { ...auth, 'x-csrf-token': pair.body.csrfToken }
  const secret = 'test-key-never-return-this'
  assert.equal((await request(origin, 'POST', '/api/v1/credentials/openai_api_key', { value: secret }, auth)).status, 403)
  const set = await request(origin, 'POST', '/api/v1/credentials/openai_api_key', { value: secret }, session)
  assert.equal(set.status, 200)
  assert.equal(set.body.success, true)
  assert.equal(JSON.stringify(set.body).includes(secret), false)
  assert.equal((await request(origin, 'GET', '/api/v1/credentials/openai_api_key', undefined, auth)).body.exists, true)
  assert.equal((await request(origin, 'GET', '/api/v1/credentials/user_demo_openai_api_key', undefined, auth)).body.exists, false)
  assert.equal((await request(origin, 'GET', '/api/v1/credentials/arbitrary', undefined, auth)).status, 400)
  assert.equal((await request(origin, 'DELETE', '/api/v1/credentials/openai_api_key', undefined, session)).body.success, true)
  assert.equal((await request(origin, 'GET', '/api/v1/credentials/openai_api_key', undefined, auth)).body.exists, false)
  assert.equal(records.size, 0)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd exposes read-only continuity status without returning credential values or importing Electron stores', async () => {
  const dataDir = makeTempDir('aica-agentd-continuity-')
  const records = new Map([['openai_api_key', 'secret-never-return-this']])
  const credentials = {
    get: async key => records.get(key) ?? null,
    exists: async key => records.has(key),
    set: async (key, value) => { records.set(key, value) },
    delete: async key => { records.delete(key) },
  }
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), pairingCode: '135790', credentials, logger: { log() {} } })
  const { origin } = await server.start()
  const pair = await request(origin, 'POST', '/api/v1/pair', { code: '135790' }, { origin })
  const session = { origin, cookie: pair.headers['set-cookie'][0].split(';')[0] }
  const result = await request(origin, 'GET', '/api/v1/continuity/status', undefined, session)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.migration, {
    source: 'electron',
    target: 'agentd',
    state: 'native-owner-action-required',
    secretsExcluded: true,
    note: 'Electron stores require an explicit owner-approved native migration; this read-only endpoint never reads or imports them.',
  })
  assert.equal(result.body.stores.find(store => store.id === 'agentd-state').state, 'active')
  assert.equal(result.body.stores.find(store => store.id === 'electron-settings').state, 'pending')
  assert.equal(result.body.credentials.find(credential => credential.key === 'openai_api_key').present, true)
  assert.equal(JSON.stringify(result.body).includes('secret-never-return-this'), false)
  assert.deepEqual(result.body.data, { sessions: 0, messages: 0, knowledgeDocuments: 0, inboundEvents: 0, drafts: 0 })
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd stages owner-approved continuity imports without touching live data or secrets', async () => {
  const dataDir = makeTempDir('aica-agentd-continuity-stage-')
  const sourceRoot = makeTempDir('aica-electron-source-')
  fs.writeFileSync(path.join(sourceRoot, 'settings.json'), JSON.stringify({ theme: 'dark' }))
  fs.writeFileSync(path.join(sourceRoot, 'persona.json'), JSON.stringify({ name: 'Owner' }))
  const sourceDb = new (require('better-sqlite3'))(path.join(sourceRoot, 'chat-history.db'))
  sourceDb.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO messages (body) VALUES (\'hello\')')
  sourceDb.close()
  const secret = 's'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const sessionAttempt = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, { origin })
  assert.equal(sessionAttempt.status, 401)
  const bearer = { authorization: `Bearer ${secret}` }
  const preview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  assert.equal(preview.status, 200)
  assert.equal(preview.body.secretsExcluded, true)
  assert.equal(preview.body.target, 'agentd-staging')
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId }, bearer)).status, 403)
  const imported = await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA', reauthenticated: true }, bearer)
  assert.equal(imported.status, 200)
  assert.equal(imported.body.liveDataChanged, false)
  assert.equal(fs.existsSync(path.join(dataDir, 'agentd.db')), true)
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-staging', preview.body.previewId, 'electron-settings')), true)
  assert.equal(JSON.stringify(imported.body).includes('dark'), false)
  const rolledBack = await request(origin, 'POST', '/api/v1/continuity/rollback', { migrationId: imported.body.migrationId }, bearer)
  assert.deepEqual(rolledBack.body, { migrationId: imported.body.migrationId, state: 'rolled-back' })
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-staging', imported.body.migrationId)), false)
  fs.writeFileSync(path.join(sourceRoot, 'settings.json'), JSON.stringify({ apiKey: 'must-not-migrate' }))
  const secretPreview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  assert.equal(secretPreview.status, 400)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('agentd persists exact LLM preferences and probes only fixed providers with stored credentials', async () => {
  const dataDir = makeTempDir('aica-agentd-llm-')
  const records = new Map()
  const calls = []
  let upstreamFailureMode = false
  const credentials = {
    get: async key => records.get(key) ?? null,
    exists: async key => records.has(key),
    set: async (key, value) => { records.set(key, value) },
    delete: async key => { records.delete(key) },
  }
  const providerFetch = async (url, options) => {
    calls.push({ url, options })
    return upstreamFailureMode
      ? new Response('upstream error contains openai-secret-do-not-return', { status: 401 })
      : new Response(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
  }
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), credentials, providerFetch, logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }
  const defaults = await request(origin, 'GET', '/api/v1/settings/llm', undefined, auth)
  assert.deepEqual(defaults.body, {
    preferredProvider: 'auto',
    openaiModel: 'gpt-4o-mini',
    openrouterModel: 'anthropic/claude-3-haiku',
  })
  const settings = {
    preferredProvider: 'openrouter',
    openaiModel: 'gpt-4.1-mini',
    openrouterModel: 'openai/gpt-4o-mini',
  }
  assert.deepEqual((await request(origin, 'PUT', '/api/v1/settings/llm', settings, auth)).body, settings)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/settings/llm', undefined, auth)).body, settings)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/llm', { ...settings, apiKey: 'must-not-be-stored' }, auth)).status, 400)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/llm', { ...settings, openaiModel: ' ' }, auth)).status, 400)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/llm', { ...settings, preferredProvider: 'gemini' }, auth)).status, 400)

  assert.deepEqual((await request(origin, 'POST', '/api/v1/providers/openai/test', {}, auth)).body, {
    success: false,
    error: 'Provider test failed',
  })
  const openaiSecret = 'openai-secret-do-not-return'
  const openrouterSecret = 'openrouter-secret-do-not-return'
  records.set('openai_api_key', openaiSecret)
  records.set('openrouter_api_key', openrouterSecret)
  for (const provider of ['openai', 'openrouter']) {
    const result = await request(origin, 'POST', `/api/v1/providers/${provider}/test`, {}, auth)
    assert.deepEqual(result.body, { success: true, modelCount: 2 })
    assert.equal(JSON.stringify(result.body).includes('secret'), false)
  }
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.openai.com/v1/models',
    'https://openrouter.ai/api/v1/models',
  ])
  assert.deepEqual(calls.map(call => call.options.redirect), ['manual', 'manual'])
  assert.deepEqual(calls.map(call => call.options.headers.authorization), [
    `Bearer ${openaiSecret}`,
    `Bearer ${openrouterSecret}`,
  ])
  assert.equal((await request(origin, 'POST', '/api/v1/providers/custom/test', {}, auth)).status, 404)
  assert.equal((await request(origin, 'POST', '/api/v1/providers/openai/test', { url: 'https://attacker.test', key: 'renderer-secret' }, auth)).status, 400)
  upstreamFailureMode = true
  const upstreamFailure = await request(origin, 'POST', '/api/v1/providers/openai/test', {}, auth)
  assert.deepEqual(upstreamFailure.body, { success: false, error: 'Provider test failed' })
  assert.equal(JSON.stringify(upstreamFailure.body).includes('openai-secret-do-not-return'), false)

  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd persists allowlisted persona settings without accepting unknown fields', async () => {
  const dataDir = makeTempDir('aica-agentd-persona-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }
  assert.deepEqual((await request(origin, 'GET', '/api/v1/settings/persona', undefined, auth)).body, {
    name: 'AIConsumerAgent',
    industry: 'Tech Support',
    tone: 'professional',
    coreKnowledge: [],
  })
  const persona = {
    name: 'Northwind Support',
    industry: 'Retail',
    tone: 'concise',
    coreKnowledge: ['Returns within 30 days'],
    customRules: 'Never promise a refund before checking the order.',
  }
  assert.deepEqual((await request(origin, 'PUT', '/api/v1/settings/persona', persona, auth)).body, persona)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/settings/persona', undefined, auth)).body, persona)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/persona', { ...persona, apiKey: 'never' }, auth)).status, 400)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/persona', { ...persona, tone: 'unsafe' }, auth)).status, 400)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd persists bounded product preferences and redacts browser audit logs', async () => {
  const dataDir = makeTempDir('aica-agentd-preferences-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }
  const defaults = await request(origin, 'GET', '/api/v1/settings/preferences', undefined, auth)
  assert.equal(defaults.status, 200)
  assert.equal(defaults.body.theme, 'dark')
  assert.equal(defaults.body.memoryBackend, 'sqlite')
  const preferences = {
    ...defaults.body,
    theme: 'light',
    playwrightBrowser: 'msedge',
    playwrightHeadless: true,
    ttsRate: 1.25,
    ttsVoice: 'Microsoft Jenny',
  }
  assert.deepEqual((await request(origin, 'PUT', '/api/v1/settings/preferences', preferences, auth)).body, preferences)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/settings/preferences', undefined, auth)).body, preferences)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/preferences', { ...preferences, unknown: true }, auth)).status, 400)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/preferences', { ...preferences, ttsRate: 99 }, auth)).status, 400)

  const log = await request(origin, 'POST', '/api/v1/logs', { eventType: 'LLM_REQUEST', details: { apiKey: 'never-return', prompt: 'hello' } }, auth)
  assert.equal(log.status, 201)
  const logs = await request(origin, 'GET', '/api/v1/logs?limit=10', undefined, auth)
  assert.equal(logs.status, 200)
  assert.equal(logs.body.entries.length, 1)
  assert.equal(logs.body.entries[0].details.apiKey, '[REDACTED]')
  assert.equal(JSON.stringify(logs.body).includes('never-return'), false)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd persists bounded WhatsApp transport settings and never returns Cloud secrets', async () => {
  const dataDir = makeTempDir('aica-agentd-whatsapp-settings-')
  const records = new Map()
  const credentials = {
    get: async key => records.get(key) ?? null,
    exists: async key => records.has(key),
    set: async (key, value) => { records.set(key, value) },
    delete: async key => { records.delete(key) },
  }
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), credentials, pairingCode: '975310', logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }
  const defaults = await request(origin, 'GET', '/api/v1/settings/whatsapp', undefined, auth)
  assert.deepEqual(defaults.body, {
    whatsapp_transport: 'baileys',
    whatsapp_cloud_phone_number_id: '',
    whatsapp_cloud_api_version: 'v23.0',
  })
  const settings = {
    whatsapp_transport: 'cloud',
    whatsapp_cloud_phone_number_id: '1234567890',
    whatsapp_cloud_api_version: 'v23.0',
  }
  assert.deepEqual((await request(origin, 'PUT', '/api/v1/settings/whatsapp', settings, auth)).body, settings)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/settings/whatsapp', undefined, auth)).body, settings)
  for (const invalid of [
    { ...settings, whatsapp_transport: 'custom' },
    { ...settings, whatsapp_cloud_api_version: '' },
    { ...settings, whatsapp_cloud_phone_number_id: 'x'.repeat(129) },
    { ...settings, extra: 'unknown' },
  ]) assert.equal((await request(origin, 'PUT', '/api/v1/settings/whatsapp', invalid, auth)).status, 400)

  const secret = 'cloud-access-token-must-never-return'
  assert.equal((await request(origin, 'POST', '/api/v1/credentials/whatsapp_cloud_access_token', { value: secret }, auth)).status, 200)
  const presence = await request(origin, 'GET', '/api/v1/credentials/whatsapp_cloud_access_token', undefined, auth)
  assert.deepEqual(presence.body, { success: true, exists: true })
  assert.equal(JSON.stringify(presence.body).includes(secret), false)
  assert.equal(JSON.stringify(defaults.body).includes(secret), false)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd serves the browser bundle with executable asset MIME types', async () => {
  const dataDir = makeTempDir('aica-agentd-ui-')
  const uiRoot = makeTempDir('aica-agentd-ui-root-')
  fs.writeFileSync(path.join(uiRoot, 'tauri.html'), '<script type="module" src="/assets/app.js"></script>')
  fs.mkdirSync(path.join(uiRoot, 'assets'))
  fs.writeFileSync(path.join(uiRoot, 'assets', 'app.js'), 'export default 1')
  const server = new AgentdServer({ dataDir, uiRoot, secret: 's'.repeat(32), logger: { log() {} } })
  const { origin } = await server.start()
  const html = await rawRequest(origin, '/')
  assert.equal(html.status, 200)
  assert.equal(html.headers['content-type'], 'text/html; charset=utf-8')
  const script = await rawRequest(origin, '/assets/app.js')
  assert.equal(script.status, 200)
  assert.equal(script.headers['content-type'], 'text/javascript; charset=utf-8')
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(uiRoot, { recursive: true, force: true })
})
