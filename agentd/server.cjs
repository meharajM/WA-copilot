const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const Database = require('better-sqlite3')

const SESSION_TTL_MS = 15 * 60 * 1000
const PAIRING_TTL_MS = 5 * 60 * 1000
const MAX_BODY_BYTES = 256 * 1024

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
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

class AgentdServer {
  constructor({ dataDir, secret, uiRoot = null, logger = console, pairingCode = null } = {}) {
    if (!secret || typeof secret !== 'string' || secret.length < 32) throw new Error('A per-install bearer secret of at least 32 characters is required')
    this.dataDir = dataDir || path.join(process.env.XDG_STATE_HOME || path.join(require('node:os').homedir(), '.local', 'state'), 'aica')
    this.secret = secret
    this.uiRoot = uiRoot
    this.logger = logger
    this.server = null
    this.db = null
    this.lockFd = null
    this.sessions = new Map()
    this.pairingCode = pairingCode || String(crypto.randomInt(100000, 999999))
    this.pairingExpiresAt = Date.now() + PAIRING_TTL_MS
  }

  async start() {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 })
    const lockPath = path.join(this.dataDir, 'agentd.lock')
    try {
      this.lockFd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(this.lockFd, `${process.pid}\n`, { encoding: 'utf8' })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let ownerPid = null
      try { ownerPid = Number.parseInt(fs.readFileSync(lockPath, 'utf8'), 10) } catch {}
      let ownerAlive = false
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
        try { process.kill(ownerPid, 0); ownerAlive = true } catch (probeError) { ownerAlive = probeError.code === 'EPERM' }
      }
      if (ownerAlive) throw new Error('Another agentd instance owns the runtime')
      try { fs.unlinkSync(lockPath) } catch { throw new Error('Another agentd instance owns the runtime') }
      this.lockFd = fs.openSync(lockPath, 'wx', 0o600)
      fs.writeFileSync(this.lockFd, `${process.pid}\n`, { encoding: 'utf8' })
    }
    try {
      this.db = new Database(path.join(this.dataDir, 'agentd.db'))
      this.db.pragma('journal_mode = WAL')
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
        CREATE TABLE IF NOT EXISTS operator_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, created_at INTEGER NOT NULL);
      `)
      this.db.prepare('INSERT INTO agent_state(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING').run('paused', 'false', Date.now())
      await new Promise((resolve, reject) => {
        this.server = http.createServer((req, res) => this.handle(req, res).catch(error => {
          const status = Number.isInteger(error.statusCode) ? error.statusCode : 500
          json(res, status, { error: status === 500 ? 'Internal server error' : error.message })
        }))
        this.server.once('error', reject)
        this.server.listen(0, '127.0.0.1', resolve)
      })
      this.logger.log(`[agentd] listening at ${this.origin}; pairing code: ${this.pairingCode}`)
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

  async stop() {
    if (this.server) await new Promise(resolve => this.server.close(() => resolve()))
    this.server = null
    this.sessions.clear()
    if (this.db) this.db.close()
    this.db = null
    if (this.lockFd !== null) {
      fs.closeSync(this.lockFd)
      try { fs.unlinkSync(path.join(this.dataDir, 'agentd.lock')) } catch {}
      this.lockFd = null
    }
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
    this.checkOrigin(req, true)
    if (mutation && req.headers['x-csrf-token'] !== session.csrfToken) throw Object.assign(new Error('CSRF token required'), { statusCode: 403 })
    session.expiresAt = Date.now() + SESSION_TTL_MS
    return { kind: 'session' }
  }

  async handle(req, res) {
    const url = new URL(req.url, this.origin || 'http://127.0.0.1')
    if (url.pathname === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true })
    if (url.pathname === '/api/v1/pair' && req.method === 'POST') return this.pair(req, res)
    if (url.pathname === '/api/v1/status' && req.method === 'GET') {
      this.authorize(req)
      return json(res, 200, { runtime: 'agentd', paused: this.getState('paused', 'true') === 'true', queueDepth: this.db.prepare("SELECT COUNT(*) AS count FROM inbound_events WHERE status IN ('queued','processing')").get().count, events: this.db.prepare('SELECT COUNT(*) AS count FROM inbound_events').get().count })
    }
    if (url.pathname === '/api/v1/events' && req.method === 'POST') return this.recordEvent(req, res)
    if (url.pathname === '/api/v1/pause-all' && req.method === 'POST') return this.control(req, res, true)
    if (url.pathname === '/api/v1/resume-all' && req.method === 'POST') return this.control(req, res, false)
    if (this.uiRoot && req.method === 'GET' && !url.pathname.startsWith('/api/')) return this.serveUi(url.pathname, res)
    return json(res, 404, { error: 'Not found' })
  }

  async pair(req, res) {
    this.checkOrigin(req, true)
    if (Date.now() > this.pairingExpiresAt) return json(res, 410, { error: 'Pairing code expired' })
    const body = await readBody(req)
    if (String(body.code || '') !== this.pairingCode) return json(res, 401, { error: 'Invalid pairing code' })
    this.pairingExpiresAt = 0
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
    const payload = JSON.stringify(body.payload ?? {})
    const existing = this.db.prepare('SELECT id FROM inbound_events WHERE channel = ? AND provider_event_id = ?').get(body.channel, body.providerEventId)
    if (existing) return json(res, 200, { accepted: true, duplicate: true, id: existing.id })
    const result = this.db.prepare('INSERT INTO inbound_events(channel,provider_event_id,conversation_id,payload,status,created_at) VALUES (?,?,?,?,?,?)').run(body.channel, body.providerEventId, body.conversationId, payload, 'draft', Date.now())
    return json(res, 202, { accepted: true, duplicate: false, id: result.lastInsertRowid })
  }

  control(req, res, paused) {
    const actor = this.authorize(req, { mutation: true })
    this.setState('paused', String(paused))
    this.db.prepare('INSERT INTO operator_actions(action,created_at) VALUES (?,?)').run(paused ? 'pause_all' : 'resume_all', Date.now())
    return json(res, 200, { paused, actor: actor.kind })
  }

  serveUi(requestPath, res) {
    const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '')
    const root = path.resolve(this.uiRoot)
    const target = path.resolve(root, relative)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return json(res, 403, { error: 'Invalid path' })
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return json(res, 404, { error: 'UI asset not found' })
    res.writeHead(200, { 'content-type': target.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })
    fs.createReadStream(target).pipe(res)
  }
}

module.exports = { AgentdServer }
