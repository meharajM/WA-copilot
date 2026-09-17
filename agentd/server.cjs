const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const Database = require('better-sqlite3')
const { isAllowedCredentialKey } = require('./keyring-credential-store.cjs')

const SESSION_TTL_MS = 15 * 60 * 1000
const PAIRING_TTL_MS = 5 * 60 * 1000
const PAIRING_LOCKOUT_MS = 60 * 1000
const MAX_PAIRING_ATTEMPTS = 5
const MAX_BODY_BYTES = 256 * 1024
const MAX_WHATSAPP_BODY_BYTES = 64 * 1024
const MAX_WHATSAPP_PAYLOAD_BYTES = 32 * 1024
const MAX_DRAFT_TEXT_LENGTH = 4096
const MAX_CHAT_MESSAGES_PER_SESSION = 10_000
const MAX_CHAT_ID_LENGTH = 128
const MAX_CHAT_TITLE_LENGTH = 200
const MAX_CHAT_CONTENT_LENGTH = 32 * 1024
const MAX_ATTACHMENTS_PER_MESSAGE = 8
const MAX_ATTACHMENT_NAME_LENGTH = 256
const MAX_ATTACHMENT_TYPE_LENGTH = 128
const MAX_ATTACHMENT_TEXT_LENGTH = 64 * 1024
const MAX_ATTACHMENT_DATA_URL_LENGTH = 384 * 1024
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024
const MAX_PROVIDER_REQUEST_BYTES = 512 * 1024
const MAX_CHAT_REQUEST_BYTES = MAX_PROVIDER_REQUEST_BYTES + 64 * 1024
const MAX_GENERATION_REQUEST_ID_LENGTH = 128
const MAX_PROVIDER_CONTEXT_MESSAGES = 50
const MAX_LOG_BYTES = 32 * 1024
const REQUEST_TIMEOUT_MS = 30 * 1000
const HEADERS_TIMEOUT_MS = 10 * 1000
const KEEP_ALIVE_TIMEOUT_MS = 5 * 1000
const PROVIDER_ENDPOINTS = Object.freeze({
  openai: 'https://api.openai.com/v1/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
})
const PROVIDER_CHAT_ENDPOINTS = Object.freeze({
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
})
const LLM_SETTINGS_DEFAULTS = Object.freeze({
  preferredProvider: 'auto',
  openaiModel: 'gpt-4o-mini',
  openrouterModel: 'anthropic/claude-3-haiku',
})
const PERSONA_DEFAULTS = Object.freeze({
  name: 'AIConsumerAgent',
  industry: 'Tech Support',
  tone: 'professional',
  coreKnowledge: [],
})
const PRODUCT_PREFERENCES_DEFAULTS = Object.freeze({
  theme: 'dark',
  playwrightBrowser: 'auto',
  playwrightHeadless: false,
  fileSystemSafeMode: true,
  memoryBackend: 'sqlite',
  ttsEnabled: true,
  ttsRate: 1,
  ttsPitch: 1,
  ttsVoice: null,
  speechLang: 'en-US',
  offlineSpeech: false,
  voskModel: 'en-us',
  browserModel: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
})
const WHATSAPP_SETTINGS_DEFAULTS = Object.freeze({
  whatsapp_transport: 'baileys',
  whatsapp_cloud_phone_number_id: '',
  whatsapp_cloud_api_version: 'v23.0',
})

function resolveDataDir(dataDir = process.env.AICA_AGENTD_DATA_DIR) {
  if (dataDir) return dataDir
  const os = require('node:os')
  const stateRoot = process.platform === 'win32'
    ? (process.env.LOCALAPPDATA || process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Local'))
    : (process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'))
  return path.join(stateRoot, 'aica')
}

function writePrivateFileAtomically(filename, contents) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, filename)
  } catch (error) {
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
}

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(payload)
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', chunk => {
      if (tooLarge) return
      size += chunk.length
      if (size > maxBytes) {
        tooLarge = true
        req.resume()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }))
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) }
      catch { reject(Object.assign(new Error('Invalid JSON'), { statusCode: 400 })) }
    })
    req.on('error', reject)
  })
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(value => value.trim().split('='))
    .filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]))
}

function redactPayload(value, key = '') {
  if (/(token|secret|password|cookie|authorization|credential|api[-_]?key)/i.test(key)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map(item => redactPayload(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactPayload(childValue, childKey)]))
}

class AgentdServer {
  constructor({ dataDir, secret, uiRoot = null, logger = console, pairingCode = null, credentials = null, providerFetch = fetch } = {}) {
    if (!secret || typeof secret !== 'string' || secret.length < 32) throw new Error('A per-install bearer secret of at least 32 characters is required')
    this.dataDir = resolveDataDir(dataDir)
    this.secret = secret
    this.uiRoot = uiRoot
    this.logger = logger
    this.credentials = credentials
    this.providerFetch = providerFetch
    this.server = null
    this.db = null
    this.lockDb = null
    this.lockOwned = false
    this.lockToken = crypto.randomUUID()
    this.runtimeId = crypto.randomUUID()
    this.startedAt = null
    this.sessions = new Map()
    this.generations = new Set()
    this.pairingCode = pairingCode || String(crypto.randomInt(100000, 999999))
    this.pairingExpiresAt = Date.now() + PAIRING_TTL_MS
    this.pairingFailures = 0
    this.pairingBlockedUntil = 0
  }

  async start() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(this.dataDir, 0o700)
    try {
      this.acquireRuntimeLock()
      this.db = new Database(path.join(this.dataDir, 'agentd.db'))
      this.db.pragma('journal_mode = WAL')
      this.db.pragma('foreign_keys = ON')
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS inbound_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL,
          provider_event_id TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft',
          created_at INTEGER NOT NULL,
          UNIQUE(channel, provider_event_id)
        );
        CREATE TABLE IF NOT EXISTS whatsapp_drafts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel TEXT NOT NULL CHECK(channel = 'whatsapp'),
          provider_event_id TEXT NOT NULL UNIQUE,
          conversation_id TEXT NOT NULL,
          response_text TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('draft','approved','rejected','sent')) DEFAULT 'draft',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspace_path TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
          content TEXT NOT NULL,
          attachments TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, message_id)
        );
          CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx ON chat_messages(session_id, created_at, message_id);
        CREATE TABLE IF NOT EXISTS chat_generations (
          request_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('openai','openrouter')),
          assistant_message_id TEXT,
          response_text TEXT,
          status TEXT NOT NULL CHECK(status IN ('processing','completed')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS operator_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          payload TEXT NOT NULL
        );
      `)
      const chatColumns = this.db.prepare('PRAGMA table_info(chat_messages)').all()
      if (!chatColumns.some((column) => column.name === 'attachments')) this.db.exec('ALTER TABLE chat_messages ADD COLUMN attachments TEXT')
      const sessionColumns = this.db.prepare('PRAGMA table_info(chat_sessions)').all()
      if (!sessionColumns.some((column) => column.name === 'workspace_path')) this.db.exec('ALTER TABLE chat_sessions ADD COLUMN workspace_path TEXT')
      this.db.prepare('INSERT INTO agent_state(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING').run('paused', 'false', Date.now())
      await new Promise((resolve, reject) => {
        this.server = http.createServer((req, res) => this.handle(req, res).catch(error => {
          const status = Number.isInteger(error.statusCode) ? error.statusCode : 500
          json(res, status, { error: status === 500 ? 'Internal server error' : error.message })
        }))
        this.server.requestTimeout = REQUEST_TIMEOUT_MS
        this.server.headersTimeout = HEADERS_TIMEOUT_MS
        this.server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS
        this.server.once('error', reject)
        this.server.listen(0, '127.0.0.1', resolve)
      })
      this.startedAt = Date.now()
      this.writePairingCode()
      this.writeRuntimeDescriptor()
      this.logger.log(`[agentd] listening at ${this.origin}`)
      return { origin: this.origin, pairingExpiresAt: this.pairingExpiresAt }
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  get origin() {
    const address = this.server?.address()
    return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null
  }

  get lockPath() {
    return path.join(this.dataDir, 'agentd.lock')
  }

  get runtimeDescriptorPath() {
    return path.join(this.dataDir, 'agentd.runtime.json')
  }

  get pairingCodePath() {
    return path.join(this.dataDir, 'agentd.pairing-code')
  }

  acquireRuntimeLock() {
    this.lockDb = new Database(path.join(this.dataDir, 'agentd-runtime-lock.db'))
    this.lockDb.pragma('busy_timeout = 0')
    try {
      this.lockDb.pragma('journal_mode = DELETE')
      this.lockDb.exec('BEGIN EXCLUSIVE')
      this.lockDb.exec('CREATE TABLE IF NOT EXISTS runtime_lock (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, pid INTEGER NOT NULL, started_at INTEGER NOT NULL)')
      this.lockDb.prepare('INSERT OR REPLACE INTO runtime_lock(id,token,pid,started_at) VALUES (1,?,?,?)').run(this.lockToken, process.pid, Date.now())

      // Honor the old PID marker during upgrade; the SQLite lock serializes all new daemons.
      try {
        const previous = fs.readFileSync(this.lockPath, 'utf8').trim()
        let ownerPid = Number.parseInt(previous, 10)
        try { ownerPid = JSON.parse(previous).pid } catch {}
        if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && ownerPid !== process.pid && this.isProcessAlive(ownerPid)) {
          throw new Error('Another agentd instance owns the runtime')
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }

      writePrivateFileAtomically(this.lockPath, JSON.stringify({ protocolVersion: 1, pid: process.pid, token: this.lockToken, startedAt: Date.now() }) + '\n')
      this.lockOwned = true
    } catch (error) {
      try { this.lockDb.exec('ROLLBACK') } catch {}
      this.lockDb.close()
      this.lockDb = null
      if (error.message === 'Another agentd instance owns the runtime' || /locked|busy/i.test(error.message)) {
        throw new Error('Another agentd instance owns the runtime')
      }
      throw error
    }
  }

  isProcessAlive(pid) {
    try { process.kill(pid, 0); return true }
    catch (error) { return error.code === 'EPERM' }
  }

  writePairingCode() {
    writePrivateFileAtomically(this.pairingCodePath, `${this.pairingCode}\n`)
  }

  writeRuntimeDescriptor() {
    writePrivateFileAtomically(this.runtimeDescriptorPath, `${JSON.stringify({
      protocolVersion: 1,
      pid: process.pid,
      origin: this.origin,
      startedAt: this.startedAt,
      // Capture process identity independently from the HTTP runtime start time. The native
      // client compares this value with the OS process start time before reading Keychain state.
      processStartedAt: Math.max(1, Math.round(Date.now() - process.uptime() * 1000)),
      runtimeId: this.runtimeId
    })}\n`)
  }

  removeOwnedFiles() {
    try {
      const descriptor = JSON.parse(fs.readFileSync(this.runtimeDescriptorPath, 'utf8'))
      if (descriptor.runtimeId === this.runtimeId) fs.unlinkSync(this.runtimeDescriptorPath)
    } catch {}
    if (this.pairingCode) {
      try {
        if (fs.readFileSync(this.pairingCodePath, 'utf8').trim() === this.pairingCode) fs.unlinkSync(this.pairingCodePath)
      } catch {}
    }
  }

  removeOwnedLockMarker() {
    if (this.lockOwned) {
      try {
        const marker = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'))
        if (marker.token === this.lockToken) fs.unlinkSync(this.lockPath)
      } catch {}
      this.lockOwned = false
    }
  }

  async stop() {
    if (this.server) await new Promise(resolve => this.server.close(() => resolve()))
    this.server = null
    this.sessions.clear()
    this.generations.clear()
    if (this.db) this.db.close()
    this.db = null
    this.removeOwnedFiles()
    if (this.lockDb) {
      try { this.lockDb.exec('ROLLBACK') } catch {}
      this.lockDb.close()
      this.lockDb = null
    }
    this.removeOwnedLockMarker()
  }

  setState(key, value) {
    this.db.prepare('INSERT INTO agent_state(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').run(key, value, Date.now())
  }

  getState(key, fallback) {
    return this.db.prepare('SELECT value FROM agent_state WHERE key = ?').get(key)?.value ?? fallback
  }

  checkOrigin(req, required) {
    const origin = req.headers.origin
    if (required && origin !== this.origin) throw Object.assign(new Error('Origin is not allowed'), { statusCode: 403 })
    if (origin && origin !== this.origin) throw Object.assign(new Error('Origin is not allowed'), { statusCode: 403 })
  }

  checkHost(req) {
    const expectedHost = this.server?.address()
    if (!expectedHost || typeof expectedHost !== 'object' || req.headers.host !== `127.0.0.1:${expectedHost.port}`) {
      throw Object.assign(new Error('Host is not allowed'), { statusCode: 403 })
    }
  }

  authorize(req, { mutation = false } = {}) {
    const authorization = req.headers.authorization
    if (authorization === `Bearer ${this.secret}`) {
      this.checkOrigin(req, false)
      return { kind: 'bearer' }
    }
    let sessionToken
    try { sessionToken = parseCookies(req.headers.cookie).agentd_session } catch {}
    const session = this.sessions.get(sessionToken)
    if (!session || session.expiresAt <= Date.now()) throw Object.assign(new Error('Authentication required'), { statusCode: 401 })
    // Browser mutations must carry the exact console Origin; same-origin GETs often omit
    // Origin, so allow a missing header for authenticated reads while still rejecting a
    // forged cross-origin header.
    this.checkOrigin(req, mutation)
    if (mutation && req.headers['x-csrf-token'] !== session.csrfToken) throw Object.assign(new Error('CSRF token required'), { statusCode: 403 })
    session.expiresAt = Date.now() + SESSION_TTL_MS
    return { kind: 'session', csrfToken: session.csrfToken, expiresAt: session.expiresAt }
  }

  async handle(req, res) {
    this.checkHost(req)
    const url = new URL(req.url, this.origin || 'http://127.0.0.1')
    if (url.pathname === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true })
    if (url.pathname === '/api/v1/pair' && req.method === 'POST') return this.pair(req, res)
    if (url.pathname === '/api/v1/session' && req.method === 'GET') {
      const session = this.authorize(req)
      if (session.kind !== 'session') return json(res, 401, { error: 'Browser session required' })
      return json(res, 200, { csrfToken: session.csrfToken, expiresAt: session.expiresAt })
    }
    const credentialMatch = /^\/api\/v1\/credentials\/([^/]+)$/.exec(url.pathname)
    if (credentialMatch && ['GET', 'POST', 'DELETE'].includes(req.method)) return this.credential(req, res, credentialMatch[1])
    if (url.pathname === '/api/v1/settings/llm' && ['GET', 'PUT'].includes(req.method)) return this.llmSettings(req, res)
    if (url.pathname === '/api/v1/settings/persona' && ['GET', 'PUT'].includes(req.method)) return this.personaSettings(req, res)
    if (url.pathname === '/api/v1/settings/preferences' && ['GET', 'PUT'].includes(req.method)) return this.productPreferences(req, res)
    if (url.pathname === '/api/v1/settings/whatsapp' && ['GET', 'PUT'].includes(req.method)) return this.whatsappSettings(req, res)
    const providerTestMatch = /^\/api\/v1\/providers\/(openai|openrouter)\/test$/.exec(url.pathname)
    if (providerTestMatch && req.method === 'POST') return this.testProvider(req, res, providerTestMatch[1])
    if (url.pathname === '/api/v1/status' && req.method === 'GET') {
      this.authorize(req)
      return json(res, 200, { runtime: 'agentd', paused: this.getState('paused', 'true') === 'true', queueDepth: this.db.prepare("SELECT COUNT(*) AS count FROM inbound_events WHERE status IN ('queued','processing')").get().count, events: this.db.prepare('SELECT COUNT(*) AS count FROM inbound_events').get().count })
    }
    if (url.pathname === '/api/v1/logs' && ['GET', 'POST'].includes(req.method)) return this.auditLogs(req, res, url)
    if (url.pathname === '/api/v1/sessions' && ['GET', 'POST'].includes(req.method)) return this.chatSessions(req, res)
    const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname)
    if (sessionMatch && req.method === 'PATCH') return this.updateChatSession(req, res, sessionMatch[1])
    if (sessionMatch && req.method === 'DELETE') return this.deleteChatSession(req, res, sessionMatch[1])
    if (sessionMatch && req.method === 'GET') return this.getChatSession(req, res, sessionMatch[1])
    const sessionMessagesMatch = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
    if (sessionMessagesMatch && req.method === 'POST') return this.addChatMessage(req, res, sessionMessagesMatch[1])
    const sessionGenerationMatch = /^\/api\/v1\/sessions\/([^/]+)\/generations$/.exec(url.pathname)
    if (sessionGenerationMatch && req.method === 'POST') return this.generateChat(req, res, sessionGenerationMatch[1])
    if (url.pathname === '/api/v1/events' && req.method === 'POST') return this.recordEvent(req, res)
    if (['/api/v1/whatsapp/events', '/api/v1/whatsapp/inbound', '/api/v1/events/whatsapp'].includes(url.pathname) && req.method === 'POST') return this.recordWhatsAppEvent(req, res)
    if (['/api/v1/drafts', '/api/v1/whatsapp/drafts'].includes(url.pathname) && req.method === 'GET') return this.listDrafts(req, res, url)
    const draftMatch = /^\/api\/v1\/(?:whatsapp\/)?drafts\/(\d+)$/.exec(url.pathname)
    if (draftMatch && req.method === 'GET') return this.getDraft(req, res, Number(draftMatch[1]))
    if (draftMatch && ['PATCH', 'PUT'].includes(req.method)) return this.updateDraftStatus(req, res, Number(draftMatch[1]))
    if (url.pathname === '/api/v1/pause-all' && req.method === 'POST') return this.control(req, res, true)
    if (url.pathname === '/api/v1/resume-all' && req.method === 'POST') return this.control(req, res, false)
    if (this.uiRoot && req.method === 'GET' && !url.pathname.startsWith('/api/')) return this.serveUi(url.pathname, res)
    return json(res, 404, { error: 'Not found' })
  }

  async credential(req, res, encodedKey) {
    let key
    try { key = decodeURIComponent(encodedKey) }
    catch { return json(res, 400, { error: 'Invalid credential key' }) }
    if (!isAllowedCredentialKey(key)) return json(res, 400, { error: 'Invalid credential key' })
    const mutation = req.method !== 'GET'
    this.authorize(req, { mutation })
    if (!this.credentials) return json(res, 503, { error: 'Credential store unavailable' })

    try {
      if (req.method === 'GET') return json(res, 200, { success: true, exists: await this.credentials.exists(key) })
      if (req.method === 'DELETE') {
        await this.credentials.delete(key)
        return json(res, 200, { success: true })
      }
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
      const body = await readBody(req)
      if (typeof body.value !== 'string' || body.value.length === 0 || Buffer.byteLength(body.value, 'utf8') > 64 * 1024) {
        return json(res, 400, { error: 'Invalid credential value' })
      }
      await this.credentials.set(key, body.value)
      return json(res, 200, { success: true })
    } catch {
      return json(res, 503, { error: 'Credential store operation failed' })
    }
  }

  async llmSettings(req, res) {
    this.authorize(req, { mutation: req.method === 'PUT' })
    if (req.method === 'GET') {
      let stored = null
      try { stored = JSON.parse(this.getState('llm_settings', 'null')) } catch {}
      return json(res, 200, parseLlmSettings(stored) || LLM_SETTINGS_DEFAULTS)
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 16 * 1024)
    const settings = parseLlmSettings(body)
    if (!settings) {
      return json(res, 400, { error: 'Invalid LLM settings' })
    }
    this.setState('llm_settings', JSON.stringify(settings))
    return json(res, 200, settings)
  }

  async personaSettings(req, res) {
    this.authorize(req, { mutation: req.method === 'PUT' })
    if (req.method === 'GET') {
      let stored = null
      try { stored = JSON.parse(this.getState('persona_settings', 'null')) } catch {}
      return json(res, 200, parsePersonaSettings(stored) || PERSONA_DEFAULTS)
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 32 * 1024)
    const settings = parsePersonaSettings(body)
    if (!settings) return json(res, 400, { error: 'Invalid persona settings' })
    this.setState('persona_settings', JSON.stringify(settings))
    return json(res, 200, settings)
  }

  async productPreferences(req, res) {
    this.authorize(req, { mutation: req.method === 'PUT' })
    if (req.method === 'GET') {
      let stored = null
      try { stored = JSON.parse(this.getState('product_preferences', 'null')) } catch {}
      return json(res, 200, parseProductPreferences(stored) || PRODUCT_PREFERENCES_DEFAULTS)
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 16 * 1024)
    const preferences = parseProductPreferences(body)
    if (!preferences) return json(res, 400, { error: 'Invalid product preferences' })
    this.setState('product_preferences', JSON.stringify(preferences))
    return json(res, 200, preferences)
  }

  async auditLogs(req, res, url) {
    this.authorize(req, { mutation: req.method === 'POST' })
    if (req.method === 'POST') {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
      const body = await readBody(req, MAX_LOG_BYTES)
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Log entry must be an object' })
      const safe = redactPayload(body)
      const payload = JSON.stringify(safe)
      if (Buffer.byteLength(payload, 'utf8') > MAX_LOG_BYTES) return json(res, 413, { error: 'Log entry too large' })
      const timestamp = new Date().toISOString()
      this.db.prepare('INSERT INTO audit_logs(timestamp,payload) VALUES (?,?)').run(timestamp, payload)
      return json(res, 201, { success: true })
    }
    const requested = Number.parseInt(url.searchParams.get('limit') || '100', 10)
    const limit = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100
    const rows = this.db.prepare('SELECT timestamp,payload FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit)
    return json(res, 200, { entries: rows.reverse().map((row) => ({ timestamp: row.timestamp, ...JSON.parse(row.payload) })) })
  }

  async whatsappSettings(req, res) {
    this.authorize(req, { mutation: req.method === 'PUT' })
    if (req.method === 'GET') {
      let stored = null
      try { stored = JSON.parse(this.getState('whatsapp_settings', 'null')) } catch {}
      return json(res, 200, parseWhatsAppSettings(stored) || WHATSAPP_SETTINGS_DEFAULTS)
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 16 * 1024)
    const settings = parseWhatsAppSettings(body)
    if (!settings) return json(res, 400, { error: 'Invalid WhatsApp settings' })
    this.setState('whatsapp_settings', JSON.stringify(settings))
    return json(res, 200, settings)
  }

  async testProvider(req, res, provider) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) return json(res, 400, { error: 'Provider test accepts no input' })
    const credentialKey = provider === 'openai' ? 'openai_api_key' : 'openrouter_api_key'
    let response
    try {
      const key = await this.credentials?.get(credentialKey)
      if (typeof key !== 'string' || !key) throw new Error('Credential unavailable')
      response = await this.providerFetch(PROVIDER_ENDPOINTS[provider], {
        method: 'GET',
        headers: { authorization: `Bearer ${key}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok || response.redirected) throw new Error('Provider request failed')
      const payload = await readProviderResponse(response)
      if (!Array.isArray(payload?.data)) throw new Error('Provider response invalid')
      return json(res, 200, { success: true, modelCount: payload.data.length })
    } catch {
      try { await response?.body?.cancel() } catch {}
      return json(res, 200, { success: false, error: 'Provider test failed' })
    }
  }

  chatSessionView(row) {
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(typeof row.workspace_path === 'string' && row.workspace_path ? { workspacePath: row.workspace_path } : {}),
    }
  }

  chatMessageView(row) {
    let attachments
    try {
      const parsed = row.attachments ? JSON.parse(row.attachments) : null
      if (Array.isArray(parsed) && parsed.length) attachments = parsed
    } catch {}
    return {
      id: row.message_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      ...(attachments ? { attachments } : {}),
    }
  }

  validChatId(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= MAX_CHAT_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(value)
  }

  validChatTitle(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= MAX_CHAT_TITLE_LENGTH && Buffer.byteLength(value, 'utf8') <= MAX_CHAT_TITLE_LENGTH * 4
  }

  parseChatAttachments(value) {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) return null
    const attachments = []
    for (const item of value) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const keys = Object.keys(item).sort()
      if (keys.some((key) => !['dataUrl', 'name', 'size', 'text', 'type'].includes(key))) return null
      if (!validBoundedText(item.name, MAX_ATTACHMENT_NAME_LENGTH)
        || !validBoundedText(item.type, MAX_ATTACHMENT_TYPE_LENGTH, true)
        || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 16 * 1024 * 1024
        || (item.text !== undefined && (!validBoundedText(item.text, MAX_ATTACHMENT_TEXT_LENGTH, true) || Buffer.byteLength(item.text, 'utf8') > MAX_ATTACHMENT_TEXT_LENGTH))
        || (item.dataUrl !== undefined && (typeof item.dataUrl !== 'string' || item.dataUrl.length > MAX_ATTACHMENT_DATA_URL_LENGTH || !/^data:[^,]{1,128};base64,[A-Za-z0-9+/=]+$/.test(item.dataUrl)))) return null
      if (item.text === undefined && item.dataUrl === undefined) {
        // Metadata-only attachment is valid for formats the browser cannot parse.
      }
      attachments.push({
        name: item.name.trim(),
        type: item.type,
        size: item.size,
        ...(typeof item.text === 'string' && item.text ? { text: item.text } : {}),
        ...(typeof item.dataUrl === 'string' && item.dataUrl ? { dataUrl: item.dataUrl } : {}),
      })
    }
    return attachments
  }

  providerMessage(row) {
    let attachments = []
    try { attachments = row.attachments ? JSON.parse(row.attachments) : [] } catch {}
    const parts = [{ type: 'text', text: row.content || '' }]
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      if (attachment.text) parts.push({ type: 'text', text: `\n[Attached file: ${attachment.name}]\n${attachment.text}` })
      if (attachment.dataUrl && /^data:image\//.test(attachment.dataUrl)) parts.push({ type: 'image_url', image_url: { url: attachment.dataUrl } })
      if (!attachment.text && !attachment.dataUrl) parts.push({ type: 'text', text: `\n[Attached file: ${attachment.name} (${attachment.type || 'unknown type'})]` })
    }
    return { role: row.role, content: parts.length === 1 ? row.content : parts }
  }

  async chatSessions(req, res) {
    const mutation = req.method === 'POST'
    this.authorize(req, { mutation })
    if (req.method === 'GET') {
      const rows = this.db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC, id DESC LIMIT 100').all()
      return json(res, 200, { sessions: rows.map(row => this.chatSessionView(row)) })
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 16 * 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Invalid session' })
    const keys = Object.keys(body).sort()
    if (keys.some(key => !['id', 'title', 'workspacePath'].includes(key))) return json(res, 400, { error: 'Invalid session fields' })
    const id = body.id === undefined ? crypto.randomUUID() : body.id
    const title = body.title === undefined ? 'New chat' : body.title
    const workspacePath = body.workspacePath === undefined || body.workspacePath === null ? null : body.workspacePath
    if (!this.validChatId(id) || !this.validChatTitle(title) || (workspacePath !== null && !validBoundedText(workspacePath, 1024))) return json(res, 400, { error: 'Invalid session' })
    const now = Date.now()
    const result = this.db.transaction(() => {
      const inserted = this.db.prepare('INSERT INTO chat_sessions(id,title,workspace_path,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(id, title, workspacePath, now, now)
      const session = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id)
      return { session, duplicate: inserted.changes === 0 }
    })()
    if (result.duplicate && result.session.title !== title) return json(res, 409, { error: 'Session already exists' })
    return json(res, result.duplicate ? 200 : 201, { session: this.chatSessionView(result.session), duplicate: result.duplicate })
  }

  async updateChatSession(req, res, rawId) {
    this.authorize(req, { mutation: true })
    if (!this.validChatId(rawId)) return json(res, 400, { error: 'Invalid session id' })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 8 * 1024)
    const keys = Object.keys(body || {}).sort()
    const workspacePath = body?.workspacePath === undefined || body.workspacePath === null ? null : body.workspacePath
    if (!body || typeof body !== 'object' || Array.isArray(body) || keys.some((key) => key !== 'workspacePath') || (workspacePath !== null && !validBoundedText(workspacePath, 1024))) return json(res, 400, { error: 'Invalid workspace' })
    const now = Date.now()
    const result = this.db.prepare('UPDATE chat_sessions SET workspace_path = ?, updated_at = ? WHERE id = ?').run(workspacePath, now, rawId)
    if (!result.changes) return json(res, 404, { error: 'Session not found' })
    return json(res, 200, { session: this.chatSessionView(this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(rawId)) })
  }

  async getChatSession(req, res, rawId) {
    this.authorize(req)
    if (!this.validChatId(rawId)) return json(res, 400, { error: 'Invalid session id' })
    const session = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(rawId)
    if (!session) return json(res, 404, { error: 'Session not found' })
    const messages = this.db.prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?').all(rawId, MAX_CHAT_MESSAGES_PER_SESSION)
    return json(res, 200, { session: this.chatSessionView(session), messages: messages.map(row => this.chatMessageView(row)) })
  }

  async deleteChatSession(req, res, rawId) {
    this.authorize(req, { mutation: true })
    if (!this.validChatId(rawId)) return json(res, 400, { error: 'Invalid session id' })
    if ([...this.generations].some(key => key.startsWith(`${rawId}:`))) {
      return json(res, 409, { error: 'Session generation is in progress' })
    }
    const deleted = this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(rawId).changes > 0
    return json(res, 200, { success: true, deleted })
  }

  async addChatMessage(req, res, rawId) {
    this.authorize(req, { mutation: true })
    if (!this.validChatId(rawId)) return json(res, 400, { error: 'Invalid session id' })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, MAX_CHAT_REQUEST_BYTES)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Invalid message' })
    const keys = Object.keys(body).sort()
    const attachments = this.parseChatAttachments(body.attachments)
    if (keys.some(key => !['attachments', 'id', 'role', 'content'].includes(key)) || attachments === null || typeof body.role !== 'string' || !['user', 'assistant', 'system'].includes(body.role) || typeof body.content !== 'string' || (!body.content && attachments.length === 0) || body.content.length > MAX_CHAT_CONTENT_LENGTH || Buffer.byteLength(body.content, 'utf8') > MAX_CHAT_CONTENT_LENGTH) {
      return json(res, 400, { error: 'Invalid message' })
    }
    const messageId = body.id === undefined ? crypto.randomUUID() : body.id
    if (!this.validChatId(messageId)) return json(res, 400, { error: 'Invalid message id' })
    const now = Date.now()
    const result = this.db.transaction(() => {
      const session = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(rawId)
      if (!session) return { missing: true }
      const existing = this.db.prepare('SELECT * FROM chat_messages WHERE session_id = ? AND message_id = ?').get(rawId, messageId)
      if (existing) {
        if (existing.role !== body.role || existing.content !== body.content || (existing.attachments || null) !== (attachments.length ? JSON.stringify(attachments) : null)) return { conflict: true }
        return { duplicate: true, row: existing }
      }
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?').get(rawId).count
      if (count >= MAX_CHAT_MESSAGES_PER_SESSION) return { full: true }
      this.db.prepare('INSERT INTO chat_messages(session_id,message_id,role,content,attachments,created_at) VALUES (?,?,?,?,?,?)').run(rawId, messageId, body.role, body.content, attachments.length ? JSON.stringify(attachments) : null, now)
      this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, rawId)
      return { duplicate: false, row: this.db.prepare('SELECT * FROM chat_messages WHERE session_id = ? AND message_id = ?').get(rawId, messageId) }
    })()
    if (result.missing) return json(res, 404, { error: 'Session not found' })
    if (result.conflict) return json(res, 409, { error: 'Message id already exists' })
    if (result.full) return json(res, 413, { error: 'Session message limit reached' })
    return json(res, result.duplicate ? 200 : 201, { message: this.chatMessageView(result.row), duplicate: result.duplicate })
  }

  async generateChat(req, res, rawId) {
    this.authorize(req, { mutation: true })
    if (!this.validChatId(rawId)) return json(res, 400, { error: 'Invalid session id' })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, MAX_CHAT_REQUEST_BYTES)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Invalid generation request' })
    const keys = Object.keys(body).sort()
    const attachments = this.parseChatAttachments(body.attachments)
    if (keys.some(key => !['attachments', 'requestId', 'content', 'model'].includes(key))
      || typeof body.requestId !== 'string'
      || body.requestId.length < 1
      || body.requestId.length > MAX_GENERATION_REQUEST_ID_LENGTH
      || !/^[A-Za-z0-9_-]+$/.test(body.requestId)
      || typeof body.content !== 'string'
      || body.content.length > MAX_CHAT_CONTENT_LENGTH
      || Buffer.byteLength(body.content, 'utf8') > MAX_CHAT_CONTENT_LENGTH
      || attachments === null
      || (!body.content && attachments.length === 0)
      || (body.model !== undefined && !validModelName(body.model))) {
      return json(res, 400, { error: 'Invalid generation request' })
    }

    const attachmentsJson = attachments.length ? JSON.stringify(attachments) : null

    const requestKey = `${rawId}:${body.requestId}`
    if (this.generations.has(requestKey)) return json(res, 409, { error: 'Generation already in progress' })
    if (!this.db.prepare('SELECT 1 FROM chat_sessions WHERE id = ?').get(rawId)) return json(res, 404, { error: 'Session not found' })

    // Replay completed requests before reading provider credentials. A client
    // retry must remain idempotent even if credentials were removed after the
    // original completion.
    const priorGeneration = this.db.prepare('SELECT * FROM chat_generations WHERE request_id = ?').get(body.requestId)
    if (priorGeneration) {
      if (priorGeneration.session_id !== rawId) return json(res, 409, { error: 'Request id already exists' })
      const priorMessage = this.db.prepare('SELECT role, content, attachments FROM chat_messages WHERE session_id = ? AND message_id = ?').get(rawId, body.requestId)
      if (priorMessage && (priorMessage.role !== 'user' || priorMessage.content !== body.content || (priorMessage.attachments || null) !== attachmentsJson)) return json(res, 409, { error: 'Request id already exists' })
      if (priorGeneration.status === 'completed') {
        if (body.model !== undefined && body.model !== priorGeneration.model) return json(res, 409, { error: 'Request id already exists' })
        return json(res, 200, this.generationView(priorGeneration, true))
      }
    }

    let settings
    try { settings = parseLlmSettings(JSON.parse(this.getState('llm_settings', 'null'))) || LLM_SETTINGS_DEFAULTS } catch { settings = LLM_SETTINGS_DEFAULTS }
    const providers = settings.preferredProvider === 'auto' ? ['openai', 'openrouter'] : [settings.preferredProvider]
    const configuredModels = { openai: settings.openaiModel, openrouter: settings.openrouterModel }
    const requestedModel = body.model === undefined ? null : body.model
    let provider = null
    let apiKey = null
    for (const candidate of providers) {
      const credentialKey = candidate === 'openai' ? 'openai_api_key' : 'openrouter_api_key'
      let candidateKey = null
      try { candidateKey = await this.credentials?.get(credentialKey) } catch {}
      if (typeof candidateKey === 'string' && candidateKey) {
        provider = candidate
        apiKey = candidateKey
        break
      }
    }
    if (!provider || !apiKey) return json(res, 503, { error: 'Provider unavailable' })
    const model = requestedModel || configuredModels[provider]
    if (!validModelName(model)) return json(res, 400, { error: 'Invalid model' })

    const now = Date.now()
    const prepared = this.db.transaction(() => {
      const session = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(rawId)
      if (!session) return { missing: true }
      const existingMessage = this.db.prepare('SELECT * FROM chat_messages WHERE session_id = ? AND message_id = ?').get(rawId, body.requestId)
      if (existingMessage) {
        if (existingMessage.role !== 'user' || existingMessage.content !== body.content || (existingMessage.attachments || null) !== attachmentsJson) return { messageConflict: true }
      }
      const existingGeneration = this.db.prepare('SELECT * FROM chat_generations WHERE request_id = ?').get(body.requestId)
      if (existingGeneration) {
        if (existingGeneration.session_id !== rawId) return { conflict: true }
        if (existingGeneration.status === 'completed') {
          if (body.model !== undefined && body.model !== existingGeneration.model) return { messageConflict: true }
          return { completed: existingGeneration }
        }
        if (this.generations.has(requestKey)) return { processing: true }
        // A process restart may leave a processing row. Reclaim it safely.
        this.db.prepare('UPDATE chat_generations SET model = ?, provider = ?, response_text = NULL, assistant_message_id = NULL, updated_at = ? WHERE request_id = ?').run(model, provider, now, body.requestId)
      } else {
        this.db.prepare('INSERT INTO chat_generations(request_id,session_id,model,provider,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(body.requestId, rawId, model, provider, 'processing', now, now)
      }
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM chat_messages WHERE session_id = ?').get(rawId).count
      if (existingMessage && count >= MAX_CHAT_MESSAGES_PER_SESSION) return { full: true }
      if (!existingMessage && count >= MAX_CHAT_MESSAGES_PER_SESSION - 1) return { full: true }
      if (!existingMessage) {
        this.db.prepare('INSERT INTO chat_messages(session_id,message_id,role,content,attachments,created_at) VALUES (?,?,?,?,?,?)').run(rawId, body.requestId, 'user', body.content, attachmentsJson, now)
        this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, rawId)
      }
      const messages = this.db.prepare('SELECT role,content,attachments FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?').all(rawId, MAX_PROVIDER_CONTEXT_MESSAGES)
      return { messages }
    })()
    if (prepared.missing) return json(res, 404, { error: 'Session not found' })
    if (prepared.conflict || prepared.messageConflict) {
      this.db.prepare('DELETE FROM chat_generations WHERE request_id = ? AND session_id = ? AND status = \'processing\'').run(body.requestId, rawId)
      return json(res, 409, { error: 'Request id already exists' })
    }
    if (prepared.full) {
      this.db.prepare('DELETE FROM chat_generations WHERE request_id = ? AND session_id = ? AND status = \'processing\'').run(body.requestId, rawId)
      return json(res, 413, { error: 'Session message limit reached' })
    }
    if (prepared.processing) return json(res, 409, { error: 'Generation already in progress' })
    if (prepared.completed) return json(res, 200, this.generationView(prepared.completed, true))

    const providerBody = JSON.stringify({ model, messages: prepared.messages.map((message) => this.providerMessage(message)), stream: false, max_tokens: 1024 })
    if (Buffer.byteLength(providerBody, 'utf8') > MAX_PROVIDER_REQUEST_BYTES) {
      this.db.prepare('DELETE FROM chat_generations WHERE request_id = ? AND status = \'processing\'').run(body.requestId)
      return json(res, 413, { error: 'Conversation context too large' })
    }
    this.generations.add(requestKey)
    let response
    try {
      response = await this.providerFetch(PROVIDER_CHAT_ENDPOINTS[provider], {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: providerBody,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok || response.redirected) throw new Error('Provider request failed')
      const payload = await readProviderResponse(response)
      const content = payload?.choices?.[0]?.message?.content
      if (typeof content !== 'string' || !content || content.length > MAX_CHAT_CONTENT_LENGTH || Buffer.byteLength(content, 'utf8') > MAX_CHAT_CONTENT_LENGTH) throw new Error('Provider response invalid')
      const assistantMessageId = `assistant_${body.requestId}`
      const result = this.db.transaction(() => {
        const current = this.db.prepare('SELECT * FROM chat_generations WHERE request_id = ? AND session_id = ?').get(body.requestId, rawId)
        if (!current) throw new Error('Generation missing')
        this.db.prepare('INSERT INTO chat_messages(session_id,message_id,role,content,created_at) VALUES (?,?,?,?,?) ON CONFLICT(session_id,message_id) DO UPDATE SET content = excluded.content, role = excluded.role').run(rawId, assistantMessageId, 'assistant', content, Date.now())
        this.db.prepare('UPDATE chat_generations SET assistant_message_id = ?, response_text = ?, status = \'completed\', updated_at = ? WHERE request_id = ? AND session_id = ?').run(assistantMessageId, content, Date.now(), body.requestId, rawId)
        this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), rawId)
        return this.db.prepare('SELECT * FROM chat_generations WHERE request_id = ?').get(body.requestId)
      })()
      return json(res, 200, this.generationView(result, false))
    } catch {
      try { await response?.body?.cancel() } catch {}
      this.db.prepare('DELETE FROM chat_generations WHERE request_id = ? AND session_id = ? AND status = \'processing\'').run(body.requestId, rawId)
      return json(res, 502, { error: 'Provider generation failed' })
    } finally {
      this.generations.delete(requestKey)
    }
  }

  generationView(row, duplicate) {
    return {
      generation: { sessionId: row.session_id, requestId: row.request_id, provider: row.provider, model: row.model, streaming: false, duplicate },
      message: { id: row.assistant_message_id, role: 'assistant', content: row.response_text, createdAt: row.updated_at },
    }
  }

  async pair(req, res) {
    this.checkOrigin(req, true)
    if (Date.now() > this.pairingExpiresAt) return json(res, 410, { error: 'Pairing code expired' })
    if (Date.now() < this.pairingBlockedUntil) return json(res, 429, { error: 'Too many pairing attempts', 'retry-after': Math.ceil((this.pairingBlockedUntil - Date.now()) / 1000) })
    const body = await readBody(req)
    if (String(body.code || '') !== this.pairingCode) {
      this.pairingFailures += 1
      if (this.pairingFailures >= MAX_PAIRING_ATTEMPTS) {
        this.pairingFailures = 0
        this.pairingBlockedUntil = Date.now() + PAIRING_LOCKOUT_MS
      }
      return json(res, 401, { error: 'Invalid pairing code' })
    }
    this.pairingExpiresAt = 0
    const pairedCode = this.pairingCode
    this.pairingCode = null
    try {
      if (fs.readFileSync(this.pairingCodePath, 'utf8').trim() === pairedCode) fs.unlinkSync(this.pairingCodePath)
    } catch {}
    const token = crypto.randomBytes(32).toString('base64url')
    const csrfToken = crypto.randomBytes(24).toString('base64url')
    this.sessions.set(token, { csrfToken, expiresAt: Date.now() + SESSION_TTL_MS })
    return json(res, 200, { csrfToken, expiresAt: Date.now() + SESSION_TTL_MS }, { 'set-cookie': `agentd_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` })
  }

  async recordEvent(req, res) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req)
    if (!['whatsapp', 'email', 'instagram', 'messenger', 'twitter'].includes(body.channel) || typeof body.providerEventId !== 'string' || !body.providerEventId || body.providerEventId.length > 300 || typeof body.conversationId !== 'string' || !body.conversationId || body.conversationId.length > 500) return json(res, 400, { error: 'Invalid event identity' })
    const payload = JSON.stringify(body.channel === 'whatsapp' ? redactPayload(body.payload ?? {}) : (body.payload ?? {}))
    const existing = this.db.prepare('SELECT id FROM inbound_events WHERE channel = ? AND provider_event_id = ?').get(body.channel, body.providerEventId)
    if (existing) return json(res, 200, { accepted: true, duplicate: true, id: existing.id })
    const result = this.db.prepare('INSERT INTO inbound_events(channel,provider_event_id,conversation_id,payload,status,created_at) VALUES (?,?,?,?,?,?)').run(body.channel, body.providerEventId, body.conversationId, payload, 'draft', Date.now())
    return json(res, 202, { accepted: true, duplicate: false, id: result.lastInsertRowid })
  }

  async recordWhatsAppEvent(req, res) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, MAX_WHATSAPP_BODY_BYTES)
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.channel !== 'whatsapp'
      || typeof body.providerEventId !== 'string' || !/^[\x21-\x7e]{1,300}$/.test(body.providerEventId)
      || typeof body.conversationId !== 'string' || !body.conversationId || body.conversationId.length > 500) {
      return json(res, 400, { error: 'Invalid WhatsApp event' })
    }
    const payload = body.payload === undefined ? {} : body.payload
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(res, 400, { error: 'Invalid WhatsApp payload' })
    let payloadJson
    try { payloadJson = JSON.stringify(redactPayload(payload)) } catch { return json(res, 400, { error: 'Invalid WhatsApp payload' }) }
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_WHATSAPP_PAYLOAD_BYTES) return json(res, 413, { error: 'WhatsApp payload too large' })
    const responseText = typeof body.draftText === 'string' ? body.draftText : 'Thanks for your message. A team member will get back to you.'
    if (!responseText || responseText.length > MAX_DRAFT_TEXT_LENGTH) return json(res, 400, { error: 'Invalid draft text' })
    const now = Date.now()
    const transaction = this.db.transaction(() => {
      if (this.getState('paused', 'true') === 'true') return { paused: true }
      const event = this.db.prepare('INSERT INTO inbound_events(channel,provider_event_id,conversation_id,payload,status,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(channel,provider_event_id) DO NOTHING').run('whatsapp', body.providerEventId, body.conversationId, payloadJson, 'draft', now)
      const existingDraft = this.db.prepare('SELECT id FROM whatsapp_drafts WHERE provider_event_id = ?').get(body.providerEventId)
      if (existingDraft) return { duplicate: true, draftId: existingDraft.id }
      const existingEvent = this.db.prepare('SELECT id,conversation_id FROM inbound_events WHERE channel = ? AND provider_event_id = ?').get('whatsapp', body.providerEventId)
      const draft = this.db.prepare('INSERT INTO whatsapp_drafts(channel,provider_event_id,conversation_id,response_text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run('whatsapp', body.providerEventId, existingEvent?.conversation_id || body.conversationId, responseText, 'draft', now, now)
      return { duplicate: event.changes === 0, draftId: draft.lastInsertRowid }
    })()
    if (transaction.paused) return json(res, 202, { accepted: false, paused: true, duplicate: false })
    return json(res, transaction.duplicate ? 200 : 202, { accepted: true, duplicate: transaction.duplicate, paused: false, draftId: transaction.draftId })
  }

  draftView(row) {
    if (!row) return null
    return { id: row.id, channel: row.channel, providerEventId: row.provider_event_id, conversationId: row.conversation_id, responseText: row.response_text, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at }
  }

  async listDrafts(req, res, url) {
    this.authorize(req)
    const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 100)
    const status = url.searchParams.get('status')
    if (status && !['draft', 'approved', 'rejected', 'sent'].includes(status)) return json(res, 400, { error: 'Invalid draft status' })
    const rows = status
      ? this.db.prepare('SELECT * FROM whatsapp_drafts WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
      : this.db.prepare('SELECT * FROM whatsapp_drafts ORDER BY id DESC LIMIT ?').all(limit)
    return json(res, 200, { drafts: rows.map(row => this.draftView(row)) })
  }

  async getDraft(req, res, id) {
    this.authorize(req)
    const draft = this.draftView(this.db.prepare('SELECT * FROM whatsapp_drafts WHERE id = ?').get(id))
    if (!draft) return json(res, 404, { error: 'Draft not found' })
    return json(res, 200, draft)
  }

  async updateDraftStatus(req, res, id) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 4096)
    const next = body?.status
    if (!['draft', 'approved', 'rejected', 'sent'].includes(next)) return json(res, 400, { error: 'Invalid draft status' })
    const row = this.db.prepare('SELECT * FROM whatsapp_drafts WHERE id = ?').get(id)
    if (!row) return json(res, 404, { error: 'Draft not found' })
    const allowed = { draft: new Set(['draft', 'approved', 'rejected']), approved: new Set(['approved', 'sent']), rejected: new Set(['rejected']), sent: new Set(['sent']) }
    if (!allowed[row.status].has(next)) return json(res, 409, { error: 'Invalid draft status transition' })
    if (next !== row.status) {
      const result = this.db.prepare('UPDATE whatsapp_drafts SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(next, Date.now(), id, row.status)
      if (result.changes === 0) {
        const current = this.db.prepare('SELECT status FROM whatsapp_drafts WHERE id = ?').get(id)
        if (!current) return json(res, 404, { error: 'Draft not found' })
        if (current.status !== next) return json(res, 409, { error: 'Invalid draft status transition' })
      }
    }
    return json(res, 200, this.draftView(this.db.prepare('SELECT * FROM whatsapp_drafts WHERE id = ?').get(id)))
  }

  control(req, res, paused) {
    const actor = this.authorize(req, { mutation: true })
    const now = Date.now()
    this.db.transaction(() => {
      this.setState('paused', String(paused))
      this.db.prepare('INSERT INTO operator_actions(action,created_at) VALUES (?,?)').run(paused ? 'pause_all' : 'resume_all', now)
    })()
    return json(res, 200, { paused, actor: actor.kind })
  }

  serveUi(requestPath, res) {
    let relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '')
    const root = path.resolve(this.uiRoot)
    let target = path.resolve(root, relative)
    // The Vite bundle currently emits tauri.html. Keep root navigation useful
    // for browser launches without requiring a second duplicate HTML entry.
    if (relative === 'index.html' && !fs.existsSync(target)) {
      relative = 'tauri.html'
      target = path.resolve(root, relative)
    }
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return json(res, 403, { error: 'Invalid path' })
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return json(res, 404, { error: 'UI asset not found' })
    const contentTypes = {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.mjs': 'text/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff': 'font/woff',
      '.woff2': 'font/woff2',
    }
    res.writeHead(200, { 'content-type': contentTypes[path.extname(target).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })
    fs.createReadStream(target).pipe(res)
  }
}

function validModelName(value) {
  // Provider model IDs are opaque labels, but must remain single-line ASCII
  // identifiers before they cross the daemon/provider boundary.
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
}

function parseLlmSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (keys.length !== 3 || keys.join(',') !== 'openaiModel,openrouterModel,preferredProvider'
    || !['auto', 'openai', 'openrouter'].includes(value.preferredProvider)
    || !validModelName(value.openaiModel)
    || !validModelName(value.openrouterModel)) return null
  return {
    preferredProvider: value.preferredProvider,
    openaiModel: value.openaiModel,
    openrouterModel: value.openrouterModel,
  }
}

function parsePersonaSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (keys.some((key) => !['name', 'industry', 'tone', 'coreKnowledge', 'customRules'].includes(key))) return null
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 128
    || typeof value.industry !== 'string' || value.industry.length > 128
    || !['professional', 'casual', 'enthusiastic', 'concise'].includes(value.tone)
    || !Array.isArray(value.coreKnowledge) || value.coreKnowledge.length > 100
    || value.coreKnowledge.some((item) => typeof item !== 'string' || item.length > 512)
    || (value.customRules !== undefined && (typeof value.customRules !== 'string' || value.customRules.length > 4096))) return null
  return {
    name: value.name.trim(),
    industry: value.industry,
    tone: value.tone,
    coreKnowledge: [...value.coreKnowledge],
    ...(value.customRules !== undefined && value.customRules.length ? { customRules: value.customRules } : {}),
  }
}

function parseProductPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  const expected = Object.keys(PRODUCT_PREFERENCES_DEFAULTS).sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null
  if (!['dark', 'light', 'system'].includes(value.theme)
    || !['auto', 'chrome', 'msedge', 'firefox', 'webkit', 'chromium'].includes(value.playwrightBrowser)
    || typeof value.playwrightHeadless !== 'boolean'
    || typeof value.fileSystemSafeMode !== 'boolean'
    || !['sqlite', 'server-memory'].includes(value.memoryBackend)
    || typeof value.ttsEnabled !== 'boolean'
    || typeof value.ttsRate !== 'number' || !Number.isFinite(value.ttsRate) || value.ttsRate < 0.25 || value.ttsRate > 4
    || typeof value.ttsPitch !== 'number' || !Number.isFinite(value.ttsPitch) || value.ttsPitch < 0 || value.ttsPitch > 2
    || (value.ttsVoice !== null && !validBoundedText(value.ttsVoice, 256, true))
    || !validBoundedText(value.speechLang, 32)
    || typeof value.offlineSpeech !== 'boolean'
    || !validBoundedText(value.voskModel, 128)
    || !validBoundedText(value.browserModel, 128)) return null
  return {
    theme: value.theme,
    playwrightBrowser: value.playwrightBrowser,
    playwrightHeadless: value.playwrightHeadless,
    fileSystemSafeMode: value.fileSystemSafeMode,
    memoryBackend: value.memoryBackend,
    ttsEnabled: value.ttsEnabled,
    ttsRate: value.ttsRate,
    ttsPitch: value.ttsPitch,
    ttsVoice: value.ttsVoice,
    speechLang: value.speechLang,
    offlineSpeech: value.offlineSpeech,
    voskModel: value.voskModel,
    browserModel: value.browserModel,
  }
}

function validBoundedText(value, max, allowEmpty = false) {
  return typeof value === 'string'
    && (allowEmpty || value.trim().length > 0)
    && [...value].length <= max
}

function parseWhatsAppSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (keys.length !== 3 || keys.join(',') !== 'whatsapp_cloud_api_version,whatsapp_cloud_phone_number_id,whatsapp_transport'
    || !['baileys', 'cloud', 'web'].includes(value.whatsapp_transport)
    || !validBoundedText(value.whatsapp_cloud_phone_number_id, 128, true)
    || !validBoundedText(value.whatsapp_cloud_api_version, 32)) return null
  return {
    whatsapp_transport: value.whatsapp_transport,
    whatsapp_cloud_phone_number_id: value.whatsapp_cloud_phone_number_id,
    whatsapp_cloud_api_version: value.whatsapp_cloud_api_version,
  }
}

async function readProviderResponse(response) {
  const length = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(length) && length > MAX_PROVIDER_RESPONSE_BYTES) throw new Error('Provider response too large')
  if (!response.body) throw new Error('Provider response missing')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('Provider response too large')
    }
    chunks.push(Buffer.from(value))
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
}

module.exports = { AgentdServer, PAIRING_TTL_MS, resolveDataDir, parseWhatsAppSettings, WHATSAPP_SETTINGS_DEFAULTS, parseProductPreferences, PRODUCT_PREFERENCES_DEFAULTS }
