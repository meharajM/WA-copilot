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
  const inbound = await request(origin, 'GET', '/api/v1/whatsapp/inbound?after_id=0&limit=10', undefined, auth)
  assert.equal(inbound.status, 200)
  assert.equal(inbound.body.events.length, 1)
  assert.deepEqual(inbound.body.events[0], {
    id: 1,
    providerEventId: 'evt-1',
    conversationId: 'chat-1',
    payload: { text: 'hello' },
    status: 'draft',
    createdAt: inbound.body.events[0].createdAt,
  })
  assert.equal((await request(origin, 'GET', '/api/v1/whatsapp/inbound?after_id=1&limit=10', undefined, auth)).body.nextAfterId, 1)
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
  assert.equal((await request(origin, 'GET', '/api/v1/credentials/gmail_oauth_refresh_token', undefined, auth)).status, 400)
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
  fs.writeFileSync(path.join(sourceRoot, 'aica-store.json'), JSON.stringify({ theme: 'dark' }))
  fs.writeFileSync(path.join(sourceRoot, 'business_profile.json'), JSON.stringify({ name: 'Owner' }))
  const sourceDb = new (require('better-sqlite3'))(path.join(sourceRoot, 'chat_history.v2.db'))
  sourceDb.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO messages (body) VALUES (\'hello\')')
  sourceDb.close()
  const secret = 's'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const sessionAttempt = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, { origin })
  assert.equal(sessionAttempt.status, 401)
  const bearer = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot: dataDir }, bearer)).status, 400)
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
  assert.deepEqual(fs.readdirSync(path.join(dataDir, '.migration-staging', preview.body.previewId)).sort(), ['electron-chat-history', 'electron-persona', 'electron-settings', 'manifest.json'])
  assert.equal(JSON.stringify(imported.body).includes('dark'), false)
  const repeatedImport = await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)
  assert.equal(repeatedImport.status, 200)
  assert.deepEqual(repeatedImport.body, imported.body)
  const stagedRoot = path.join(dataDir, '.migration-staging', preview.body.previewId)
  const manifestPath = path.join(stagedRoot, 'manifest.json')
  fs.renameSync(manifestPath, `${manifestPath}.partial`)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)).status, 409)
  fs.renameSync(`${manifestPath}.partial`, manifestPath)
  fs.writeFileSync(path.join(stagedRoot, 'electron-settings'), 'tampered')
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)).status, 409)
  const rolledBack = await request(origin, 'POST', '/api/v1/continuity/rollback', { migrationId: imported.body.migrationId }, bearer)
  assert.deepEqual(rolledBack.body, { migrationId: imported.body.migrationId, state: 'rolled-back' })
  assert.equal(fs.existsSync(path.join(dataDir, '.migration-staging', imported.body.migrationId)), false)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)).status, 404)
  const changedPreview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  fs.writeFileSync(path.join(sourceRoot, 'aica-store.json'), JSON.stringify({ theme: 'changed' }))
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/import', { previewId: changedPreview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)).status, 409)
  fs.writeFileSync(path.join(sourceRoot, 'aica-store.json'), JSON.stringify({ apiKey: 'must-not-migrate' }))
  const secretPreview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  assert.equal(secretPreview.status, 400)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(sourceRoot, { recursive: true, force: true })
})

test('agentd inventories Electron credential stores for native reauthentication without exposing secret values', async () => {
  const dataDir = makeTempDir('aica-agentd-credential-continuity-')
  const sourceRoot = makeTempDir('aica-electron-credential-source-')
  const secret = 'electron-safe-storage-ciphertext-never-returned'
  fs.writeFileSync(path.join(sourceRoot, 'aica-secrets.json'), JSON.stringify({
    openai_api_key: secret,
    user_alice_openrouter_api_key: 'user-ciphertext',
    unknown_secret_key: 'must-not-be-listed',
  }))
  fs.writeFileSync(path.join(sourceRoot, 'gmail-oauth.json'), JSON.stringify({
    gmail_client_id: 'client-id',
    gmail_refresh_token: 'refresh-token-never-returned',
    gmail_email: 'owner@example.test',
  }))
  const bearer = 's'.repeat(32)
  const server = new AgentdServer({ dataDir, secret: bearer, logger: { log() {} } })
  const { origin } = await server.start()

  const browserAttempt = await request(origin, 'POST', '/api/v1/continuity/credentials/preview', { sourceRoot, ownerConfirmation: 'INSPECT_ELECTRON_CREDENTIALS' }, { origin })
  assert.equal(browserAttempt.status, 401)
  const native = { authorization: `Bearer ${bearer}` }
  const missingConfirmation = await request(origin, 'POST', '/api/v1/continuity/credentials/preview', { sourceRoot }, native)
  assert.equal(missingConfirmation.status, 403)
  const preview = await request(origin, 'POST', '/api/v1/continuity/credentials/preview', { sourceRoot, ownerConfirmation: 'INSPECT_ELECTRON_CREDENTIALS' }, native)
  assert.equal(preview.status, 200)
  assert.deepEqual(preview.body, {
    version: 1,
    source: 'electron',
    target: 'agentd-os-credential-store',
    state: 'reauthentication-required',
    stores: [
      {
        id: 'electron-credentials',
        present: true,
        entries: [
          { key: 'openai_api_key', scope: 'default', supported: true },
          { key: 'openrouter_api_key', scope: 'user', supported: true },
        ],
      },
      {
        id: 'electron-gmail-oauth',
        present: true,
        entries: [
          { key: 'gmail_oauth_client_id', scope: 'default', supported: true },
          { key: 'gmail_oauth_session', scope: 'default', supported: false },
        ],
      },
    ],
    secretsExcluded: true,
    requiresOwnerConfirmation: true,
    requiresReauthentication: true,
    transferable: false,
    note: 'Electron safe-storage values are not copied; re-enter each supported credential through the native owner flow.',
  })
  assert.equal(JSON.stringify(preview.body).includes(secret), false)
  assert.equal(JSON.stringify(preview.body).includes('user_alice'), false)
  assert.equal(JSON.stringify(preview.body).includes('refresh-token'), false)
  assert.equal(fs.existsSync(path.join(dataDir, 'agentd.db')), true)

  fs.writeFileSync(path.join(sourceRoot, 'aica-secrets.json'), '{"openai_api_key":"a","openai_api_key":"b"}')
  const duplicate = await request(origin, 'POST', '/api/v1/continuity/credentials/preview', { sourceRoot, ownerConfirmation: 'INSPECT_ELECTRON_CREDENTIALS' }, native)
  assert.equal(duplicate.status, 400)
  assert.equal(JSON.stringify(duplicate.body).includes('openai_api_key'), false)

  fs.writeFileSync(path.join(sourceRoot, 'aica-secrets.json'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x20))
  const oversized = await request(origin, 'POST', '/api/v1/continuity/credentials/preview', { sourceRoot, ownerConfirmation: 'INSPECT_ELECTRON_CREDENTIALS' }, native)
  assert.equal(oversized.status, 413)

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
    if (url === 'https://generativelanguage.googleapis.com/v1beta/models') {
      return new Response(JSON.stringify({ models: [
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
      ] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
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
    geminiModel: 'gemini-2.5-flash',
    openrouterModel: 'anthropic/claude-3-haiku',
  })
  const settings = {
    preferredProvider: 'openrouter',
    openaiModel: 'gpt-4.1-mini',
    geminiModel: 'gemini-2.5-flash',
    openrouterModel: 'openai/gpt-4o-mini',
  }
  assert.deepEqual((await request(origin, 'PUT', '/api/v1/settings/llm', settings, auth)).body, settings)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/settings/llm', undefined, auth)).body, settings)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/llm', { ...settings, apiKey: 'must-not-be-stored' }, auth)).status, 400)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/llm', { ...settings, openaiModel: ' ' }, auth)).status, 400)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/llm', { ...settings, preferredProvider: 'gemini' }, auth)).status, 200)
  const browserSettings = { ...settings, preferredProvider: 'browser' }
  assert.deepEqual((await request(origin, 'PUT', '/api/v1/settings/llm', browserSettings, auth)).body, browserSettings)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/settings/llm', undefined, auth)).body, browserSettings)

  assert.deepEqual((await request(origin, 'POST', '/api/v1/providers/openai/test', {}, auth)).body, {
    success: false,
    error: 'Provider test failed',
  })
  const openaiSecret = 'openai-secret-do-not-return'
  const geminiSecret = 'gemini-secret-do-not-return'
  const openrouterSecret = 'openrouter-secret-do-not-return'
  records.set('openai_api_key', openaiSecret)
  records.set('gemini_api_key', geminiSecret)
  records.set('openrouter_api_key', openrouterSecret)
  for (const provider of ['openai', 'gemini', 'openrouter']) {
    const result = await request(origin, 'POST', `/api/v1/providers/${provider}/test`, {}, auth)
    assert.equal(result.body.success, true)
    assert.equal(result.body.modelCount, 2)
    if (provider === 'gemini') assert.deepEqual(result.body.models, ['gemini-2.5-flash', 'gemini-2.0-flash'])
    assert.equal(JSON.stringify(result.body).includes('secret'), false)
  }
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.openai.com/v1/models',
    'https://generativelanguage.googleapis.com/v1beta/models',
    'https://openrouter.ai/api/v1/models',
  ])
  assert.deepEqual(calls.map(call => call.options.redirect), ['manual', 'manual', 'manual'])
  assert.equal(calls[0].options.headers.authorization, `Bearer ${openaiSecret}`)
  assert.equal(calls[1].options.headers['x-goog-api-key'], geminiSecret)
  assert.equal(calls[1].options.headers.authorization, undefined)
  assert.equal(calls[2].options.headers.authorization, `Bearer ${openrouterSecret}`)
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

test('agentd exposes authenticated product system info for browser About labels', async () => {
  const dataDir = makeTempDir('aica-agentd-system-info-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }
  assert.equal((await request(origin, 'GET', '/api/v1/system-info')).status, 401)
  const result = await request(origin, 'GET', '/api/v1/system-info', undefined, auth)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, {
    productName: 'AIConsumerAgent',
    productVersion: require('../../package.json').version,
    runtime: 'agentd',
    platform: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : 'Other',
    engine: `Node.js ${process.versions.node}`,
  })
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

test('agentd persists browser WhatsApp UI state without the autonomous flag', async () => {
  const dataDir = makeTempDir('aica-agentd-whatsapp-ui-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), pairingCode: '975311', logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${'s'.repeat(32)}` }
  const defaults = await request(origin, 'GET', '/api/v1/settings/whatsapp-ui', undefined, bearer)
  assert.deepEqual(defaults.body, { whatsappEnabled: false, targetPhoneNumber: null })
  const settings = { whatsappEnabled: true, targetPhoneNumber: '+1 (415) 555-0199' }
  assert.deepEqual((await request(origin, 'PUT', '/api/v1/settings/whatsapp-ui', settings, bearer)).body, settings)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/settings/whatsapp-ui', undefined, bearer)).body, settings)
  for (const invalid of [
    { ...settings, targetPhoneNumber: 'not-a-phone' },
    { ...settings, targetPhoneNumber: '1'.repeat(16) },
    { ...settings, businessBotMode: true },
  ]) assert.equal((await request(origin, 'PUT', '/api/v1/settings/whatsapp-ui', invalid, bearer)).status, 400)

  const pair = await request(origin, 'POST', '/api/v1/pair', { code: '975311' }, { origin })
  const browser = { origin, cookie: pair.headers['set-cookie'][0].split(';')[0] }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/whatsapp-ui', settings, browser)).status, 403)
  const browserSession = { ...browser, 'x-csrf-token': pair.body.csrfToken }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/whatsapp-ui', { whatsappEnabled: false, targetPhoneNumber: null }, browserSession)).status, 200)
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

test('agentd exposes the supervised MCP lifecycle only after authentication', async () => {
  const dataDir = makeTempDir('aica-agentd-mcp-lifecycle-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), pairingCode: '246810', logger: { log() {} } })
  const { origin } = await server.start()
  assert.equal((await request(origin, 'GET', '/api/v1/mcp')).status, 401)
  const response = await request(origin, 'GET', '/api/v1/mcp', undefined, { authorization: `Bearer ${'s'.repeat(32)}` })
  assert.deepEqual(response.body, {
    runtime: 'agentd',
    management: 'available',
    execution: 'available',
    reason: 'Approved MCP servers run under the supervised agentd worker',
    transports: ['stdio', 'sse', 'http'],
    tools: ['connect', 'disconnect', 'listTools', 'callTool', 'cancel'],
  })
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd persists MCP definitions but exposes only a sanitized browser projection', async () => {
  const dataDir = makeTempDir('aica-agentd-mcp-config-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }
  assert.equal((await request(origin, 'GET', '/api/v1/mcp/servers', undefined, auth)).status, 200)
  const browserPair = await request(origin, 'POST', '/api/v1/pair', { code: fs.readFileSync(path.join(dataDir, 'agentd.pairing-code'), 'utf8').trim() }, { origin })
  const browserCookie = browserPair.headers['set-cookie'][0].split(';')[0]
  const browserPut = await request(origin, 'PUT', '/api/v1/mcp/servers', { servers: [] }, { origin, cookie: browserCookie, 'x-csrf-token': browserPair.body.csrfToken })
  assert.equal(browserPut.status, 200)
  const servers = [{
    id: 'mcp_local',
    name: 'Local test server',
    description: 'Bounded config',
    type: 'stdio',
    command: 'node',
    args: ['server.mjs'],
    allowedTools: ['lookup'],
    autoConnect: false,
    envKeys: ['API_TOKEN'],
  }]
  const saved = await request(origin, 'PUT', '/api/v1/mcp/servers', { servers }, auth)
  assert.deepEqual(saved.body.servers, [{ id: 'mcp_local', name: 'Local test server', description: 'Bounded config', type: 'stdio', command: 'node', args: ['server.mjs'], allowedTools: ['lookup'], envKeys: ['API_TOKEN'], execution: 'available', connected: false, tools: [], autoConnect: false }])
  assert.equal(JSON.stringify(saved.body).includes('secret-value'), false)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/mcp/servers', undefined, auth)).body.servers, [{ id: 'mcp_local', name: 'Local test server', description: 'Bounded config', type: 'stdio', command: 'node', args: ['server.mjs'], allowedTools: ['lookup'], envKeys: ['API_TOKEN'], execution: 'available', connected: false, tools: [], autoConnect: false }])
  for (const invalid of [
    [{ ...servers[0], id: 'bad id' }],
    [{ ...servers[0], type: 'stdio', command: '' }],
    [{ ...servers[0], envKeys: ['BAD-NAME'] }],
    [{ ...servers[0], url: 'http://user:password@example.com/sse', type: 'sse', command: undefined, args: undefined }],
  ]) assert.equal((await request(origin, 'PUT', '/api/v1/mcp/servers', { servers: invalid }, auth)).status, 400)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd routes browser MCP management and calls through the supervised worker boundary', async () => {
  const dataDir = makeTempDir('aica-agentd-mcp-routes-')
  const tool = { name: 'convert_to_markdown', description: 'Convert a document', inputSchema: { type: 'object' } }
  let connected = false
  const calls = []
  const mcpWorker = {
    lifecycle: () => ({ runtime: 'agentd', management: 'available', execution: 'available', reason: 'fake worker', transports: ['stdio', 'sse', 'http'], tools: ['connect', 'disconnect', 'listTools', 'callTool', 'cancel'] }),
    projectRuntime: server => ({ id: server.id, name: server.name, description: server.description, type: server.type, command: server.command, args: server.args, allowedTools: server.allowedTools, envKeys: server.envKeys, execution: 'available', connected, tools: connected ? [tool] : [], autoConnect: server.autoConnect }),
    connect: async () => { connected = true },
    disconnect: async () => { connected = false },
    listTools: () => connected ? [tool] : [],
    call: async (server, toolName, args, requestId) => { calls.push({ serverId: server.id, toolName, args, requestId }); return { converted: true } },
    cancel: async requestId => requestId === 'request-1',
    closeAll: async () => {},
  }
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), pairingCode: '864210', mcpWorker, logger: { log() {}, warn() {} } })
  const { origin } = await server.start()
  const pair = await request(origin, 'POST', '/api/v1/pair', { code: '864210' }, { origin })
  const browser = { origin, cookie: pair.headers['set-cookie'][0].split(';')[0], 'x-csrf-token': pair.body.csrfToken }
  const definition = { id: 'mcp_safe', name: 'Safe converter', description: 'Approved', type: 'stdio', command: 'uvx', args: ['markitdown-mcp[all]'], allowedTools: ['convert_to_markdown'], envKeys: ['OPENAI_API_KEY'], autoConnect: false }
  assert.equal((await request(origin, 'PUT', '/api/v1/mcp/servers', { servers: [definition] }, browser)).status, 200)
  assert.equal((await request(origin, 'POST', '/api/v1/mcp/servers/mcp_safe/connect', {}, browser)).body.server.connected, true)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/mcp/servers/mcp_safe/tools', undefined, browser)).body.tools, [tool])
  const call = await request(origin, 'POST', '/api/v1/mcp/servers/mcp_safe/call', { toolName: 'convert_to_markdown', args: { file: 'notes.md' }, requestId: 'request-1' }, browser)
  assert.deepEqual(call.body, { result: { converted: true }, requestId: 'request-1' })
  assert.deepEqual(calls, [{ serverId: 'mcp_safe', toolName: 'convert_to_markdown', args: { file: 'notes.md' }, requestId: 'request-1' }])
  assert.deepEqual((await request(origin, 'POST', '/api/v1/mcp/cancel', { requestId: 'request-1' }, browser)).body, { cancelled: true })
  assert.equal((await request(origin, 'POST', '/api/v1/mcp/servers/mcp_safe/disconnect', {}, { origin, cookie: browser.cookie })).status, 403)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd persists authenticated email drafts without renderer storage', async () => {
  const dataDir = makeTempDir('aica-agentd-email-drafts-')
  const server = new AgentdServer({ dataDir, secret: 's'.repeat(32), logger: { log() {} } })
  const { origin } = await server.start()
  const auth = { authorization: `Bearer ${'s'.repeat(32)}` }
  const draft = {
    id: 'draft_email_1',
    responseText: 'Thanks for getting in touch.',
    originalFrom: 'customer@example.com',
    originalSubject: 'Support request',
    replyTo: 'customer@example.com',
    inReplyTo: '<message-1@example.com>',
    references: '<message-1@example.com>',
    accountName: 'default',
    policyDecision: {
      action: 'draft',
      confidence: 0.6,
      rationale: 'Needs owner review',
      hasSensitiveTopic: false,
      sensitiveTopics: [],
    },
    createdAt: Date.now(),
    status: 'pending_review',
  }
  assert.equal((await request(origin, 'GET', '/api/v1/email/drafts', undefined, auth)).body.drafts.length, 0)
  assert.equal((await request(origin, 'POST', '/api/v1/email/drafts', draft, auth)).status, 200)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/email/drafts', undefined, auth)).body.drafts, [draft])
  const updated = await request(origin, 'PATCH', '/api/v1/email/drafts/draft_email_1', { responseText: 'Updated reply', status: 'approved' }, auth)
  assert.equal(updated.status, 200)
  assert.equal(updated.body.responseText, 'Updated reply')
  assert.equal(updated.body.status, 'approved')
  assert.equal((await request(origin, 'GET', '/api/v1/email/drafts?status=approved', undefined, auth)).body.drafts[0].id, draft.id)
  assert.equal((await request(origin, 'DELETE', '/api/v1/email/drafts/draft_email_1', undefined, auth)).body.success, true)
  assert.equal((await request(origin, 'GET', '/api/v1/email/drafts', undefined, auth)).body.drafts.length, 0)
  for (const invalid of [
    { ...draft, id: 'not-safe' },
    { ...draft, policyDecision: { ...draft.policyDecision, confidence: 2 } },
    { ...draft, responseText: 'x'.repeat(32 * 1024 + 1) },
    { ...draft, status: 'sent' },
  ]) assert.equal((await request(origin, 'POST', '/api/v1/email/drafts', invalid, auth)).status, 400)
  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
