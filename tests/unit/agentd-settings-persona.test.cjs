const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const test = require('node:test')
const Database = require('better-sqlite3')
const { AgentdServer } = require('../../agentd/server.cjs')
const { makeTempDir } = require('./temp-dir.cjs')

const request = (origin, method, pathname, body, headers = {}) => new Promise((resolve, reject) => {
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = http.request(`${origin}${pathname}`, { method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
    let text = ''
    res.on('data', chunk => { text += chunk })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }))
  })
  req.on('error', reject)
  req.end(payload)
})

const settings = {
  preferredProvider: 'ollama', openaiModel: 'gpt-4o-mini', openrouterModel: 'openai/gpt-4o',
  ollamaModel: 'qwen2.5:3b', ollamaBaseUrl: 'http://127.0.0.1:11434',
  theme: 'light', playwrightBrowser: 'auto', playwrightHeadless: false, fileSystemSafeMode: true,
  memoryBackend: 'sqlite', ttsEnabled: true, ttsRate: 1, ttsPitch: 1, ttsVoice: null,
  speechLang: 'en-US', offlineSpeech: false, voskModel: 'en-us', browserModel: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
}

function sourceFixture() {
  const sourceRoot = makeTempDir('aica-electron-settings-persona-')
  fs.writeFileSync(path.join(sourceRoot, 'aica-store.json'), JSON.stringify({ 'aica-settings': { state: settings, version: 0 } }))
  fs.writeFileSync(path.join(sourceRoot, 'business_profile.json'), JSON.stringify({ name: 'Northwind', industry: 'Retail', tone: 'concise', coreKnowledge: ['Returns'], customRules: 'Never promise a refund.' }))
  const db = new Database(path.join(sourceRoot, 'chat_history.v2.db'))
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  db.close()
  return sourceRoot
}

const migrationTest = process.platform === 'win32' ? test.skip : test
const windowsMigrationTest = process.platform === 'win32' ? test : test.skip

migrationTest('native settings/persona cutover is schema-aware, transactional, fenced, and idempotent', async () => {
  const dataDir = makeTempDir('aica-agentd-settings-persona-')
  const sourceRoot = sourceFixture()
  const secret = 's'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  const browserAttempt = await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: 'x', scope: 'settings-persona' }, { origin })
  assert.equal(browserAttempt.status, 401)

  const preview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  assert.equal(preview.status, 200)
  const staged = await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)
  assert.equal(staged.status, 200)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: preview.body.previewId, scope: 'settings-persona' }, bearer)
  assert.equal(confirmation.status, 200)
  assert.equal(confirmation.body.state, 'confirmed')
  assert.equal(typeof confirmation.body.confirmationToken, 'string')
  assert.equal((await request(origin, 'GET', `/api/v1/continuity/settings-persona/status?previewId=${preview.body.previewId}`, undefined, bearer)).body.state, 'confirmed')

  const releaseActive = server.beginActiveOperation()
  let applySettled = false
  const applying = request(origin, 'POST', '/api/v1/continuity/settings-persona/apply', { previewId: preview.body.previewId, confirmationToken: confirmation.body.confirmationToken }, bearer).then(result => { applySettled = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(applySettled, false)
  const concurrentConfirmation = await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: preview.body.previewId, scope: 'settings-persona' }, bearer)
  assert.equal(concurrentConfirmation.status, 409)
  assert.equal(concurrentConfirmation.body.confirmationToken, undefined)
  releaseActive()
  const applied = await applying
  assert.equal(applied.status, 200)
  assert.equal(applied.body.state, 'applied')
  assert.equal(applied.body.confirmationToken, undefined)
  assert.equal(fs.statSync(applied.body.backupSha256 && fs.readdirSync(path.join(dataDir, 'migration-backups')).map(name => path.join(dataDir, 'migration-backups', name))[0]).mode & 0o077, 0)
  assert.deepEqual((await request(origin, 'GET', '/api/v1/settings/persona', undefined, bearer)).body, { name: 'Northwind', industry: 'Retail', tone: 'concise', coreKnowledge: ['Returns'], customRules: 'Never promise a refund.' })
  assert.deepEqual((await request(origin, 'GET', '/api/v1/settings/llm', undefined, bearer)).body, { preferredProvider: 'ollama', openaiModel: 'gpt-4o-mini', openrouterModel: 'openai/gpt-4o' })
  server.migrationHold = true
  assert.equal((await request(origin, 'POST', '/api/v1/whatsapp/messages', { to: '+15551234567', text: 'blocked' }, bearer)).status, 409)
  server.migrationHold = false
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/settings-persona/apply', { previewId: preview.body.previewId, confirmationToken: confirmation.body.confirmationToken }, bearer)).status, 403)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/settings-persona/apply', { previewId: preview.body.previewId }, bearer)).body.state, 'applied')
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/settings-persona/rollback', { previewId: preview.body.previewId }, bearer)).body.state, 'rolled-back')
  assert.equal(server.migrationHold, false)
  assert.equal(server.migrationHold, false)

  await server.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(sourceRoot, { recursive: true, force: true })
})

migrationTest('settings/persona rejects duplicate or unknown Electron settings fields', async () => {
  const dataDir = makeTempDir('aica-agentd-settings-schema-')
  const sourceRoot = sourceFixture()
  const secret = 's'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  fs.writeFileSync(path.join(sourceRoot, 'aica-store.json'), '{"aica-settings":{"state":{"theme":"light","unknown":"reject"},"version":0}}')
  const preview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: preview.body.previewId, scope: 'settings-persona' }, bearer)).status, 400)
  fs.writeFileSync(path.join(sourceRoot, 'aica-store.json'), '{"aica-settings":{"state":{"theme":"light","theme":"dark"},"version":0}}')
  const duplicatePreview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  await request(origin, 'POST', '/api/v1/continuity/import', { previewId: duplicatePreview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: duplicatePreview.body.previewId, scope: 'settings-persona' }, bearer)).status, 400)
  fs.rmSync(sourceRoot, { recursive: true, force: true })
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

migrationTest('cutover status survives restart and rollback rejects tampered backups', async () => {
  const dataDir = makeTempDir('aica-agentd-settings-restart-')
  const sourceRoot = sourceFixture()
  const secret = 's'.repeat(32)
  let server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  let { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  const preview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: preview.body.previewId, scope: 'settings-persona' }, bearer)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/settings-persona/apply', { previewId: preview.body.previewId, confirmationToken: confirmation.body.confirmationToken }, bearer)).body.state, 'applied')
  await server.stop()
  server = new AgentdServer({ dataDir, secret, logger: { log() {} } }); ({ origin } = await server.start())
  assert.equal((await request(origin, 'GET', `/api/v1/continuity/settings-persona/status?previewId=${preview.body.previewId}`, undefined, bearer)).body.state, 'applied')
  const backup = fs.readdirSync(path.join(dataDir, 'migration-backups'))[0]
  fs.appendFileSync(path.join(dataDir, 'migration-backups', backup), 'tamper')
  const rolledBack = await request(origin, 'POST', '/api/v1/continuity/settings-persona/rollback', { previewId: preview.body.previewId }, bearer)
  assert.equal(rolledBack.status, 500)
  assert.equal(rolledBack.body.state, 'needs-recovery')
  assert.equal(server.migrationHold, true)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

migrationTest('cutover refuses malformed or secret-bearing prior settings before creating a backup', async () => {
  const dataDir = makeTempDir('aica-agentd-settings-unsafe-prior-')
  const sourceRoot = sourceFixture()
  const secret = 'u'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  const preview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)
  const confirmation = await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: preview.body.previewId, scope: 'settings-persona' }, bearer)
  server.db.prepare('INSERT INTO agent_state(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .run('llm_settings', JSON.stringify({ preferredProvider: 'ollama', openaiModel: 'gpt-4o-mini', openrouterModel: 'openai/gpt-4o', openaiApiKey: 'sk-secret-value' }), Date.now())
  const applied = await request(origin, 'POST', '/api/v1/continuity/settings-persona/apply', { previewId: preview.body.previewId, confirmationToken: confirmation.body.confirmationToken }, bearer)
  assert.equal(applied.status, 500)
  assert.equal(applied.body.state, 'needs-recovery')
  assert.equal(applied.body.manualRecoveryRequired, true)
  assert.equal(server.migrationHold, true)
  assert.equal(fs.existsSync(path.join(dataDir, 'migration-backups')), false)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

migrationTest('restart converts an interrupted applying cutover with a backup reference into manual recovery', async () => {
  const dataDir = makeTempDir('aica-agentd-settings-applying-restart-')
  const sourceRoot = sourceFixture()
  const secret = 'v'.repeat(32)
  let server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  let { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  const preview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)
  await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: preview.body.previewId, scope: 'settings-persona' }, bearer)
  server.db.prepare('UPDATE settings_persona_cutovers SET state = ?, backup_path = ?, backup_sha256 = ? WHERE preview_id = ?')
    .run('applying', path.join(dataDir, 'migration-backups', 'interrupted.json'), '00'.repeat(32), preview.body.previewId)
  await server.stop()
  server = new AgentdServer({ dataDir, secret, logger: { log() {} } }); ({ origin } = await server.start())
  const status = await request(origin, 'GET', `/api/v1/continuity/settings-persona/status?previewId=${preview.body.previewId}`, undefined, bearer)
  assert.equal(status.body.state, 'needs-recovery')
  assert.equal(status.body.manualRecoveryRequired, true)
  assert.equal(server.migrationHold, true)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

migrationTest('confirmed cutover restart requires fresh native confirmation', async () => {
  const dataDir = makeTempDir('aica-agentd-settings-token-restart-')
  const sourceRoot = sourceFixture()
  const secret = 'x'.repeat(32)
  let server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  let { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  const preview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)
  const first = await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: preview.body.previewId, scope: 'settings-persona' }, bearer)
  const oldToken = first.body.confirmationToken
  await server.stop()
  server = new AgentdServer({ dataDir, secret, logger: { log() {} } }); ({ origin } = await server.start())
  const status = await request(origin, 'GET', `/api/v1/continuity/settings-persona/status?previewId=${preview.body.previewId}`, undefined, bearer)
  assert.equal(status.body.state, 'confirmed')
  assert.equal(status.body.confirmationToken, undefined)
  assert.equal(status.body.requiresReconfirmation, true)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/settings-persona/apply', { previewId: preview.body.previewId, confirmationToken: oldToken }, bearer)).status, 403)
  const second = await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: preview.body.previewId, scope: 'settings-persona' }, bearer)
  assert.equal(second.status, 200)
  assert.notEqual(second.body.confirmationToken, oldToken)
  assert.equal((await request(origin, 'POST', '/api/v1/continuity/settings-persona/apply', { previewId: preview.body.previewId, confirmationToken: second.body.confirmationToken }, bearer)).status, 200)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})

migrationTest('settings PUT routes are fenced while cutover owns the migration hold', async () => {
  const dataDir = makeTempDir('aica-agentd-settings-put-fence-')
  const secret = 'z'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  server.migrationHold = true
  server.migrationOwner = true
  const bodies = {
    '/api/v1/settings/llm': { preferredProvider: 'ollama', openaiModel: 'gpt-4o-mini', openrouterModel: 'openai/gpt-4o' },
    '/api/v1/settings/persona': { name: 'AICA', industry: 'Support', tone: 'professional', coreKnowledge: [] },
    '/api/v1/settings/preferences': settings,
    '/api/v1/settings/ollama': { baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:3b' },
  }
  for (const [pathname, body] of Object.entries(bodies)) assert.equal((await request(origin, 'PUT', pathname, body, bearer)).status, 409)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true })
})

windowsMigrationTest('Windows settings/persona cutover fails closed without no-reparse descriptor support', async () => {
  const dataDir = makeTempDir('aica-agentd-settings-windows-gate-')
  const sourceRoot = sourceFixture()
  const secret = 'w'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  const preview = await request(origin, 'POST', '/api/v1/continuity/preview', { sourceRoot }, bearer)
  await request(origin, 'POST', '/api/v1/continuity/import', { previewId: preview.body.previewId, ownerConfirmation: 'IMPORT_ELECTRON_DATA' }, bearer)
  const confirmed = await request(origin, 'POST', '/api/v1/continuity/settings-persona/confirm', { previewId: preview.body.previewId, scope: 'settings-persona' }, bearer)
  assert.equal(confirmed.status, 503)
  await server.stop(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(sourceRoot, { recursive: true, force: true })
})
