const crypto = require('node:crypto')
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')
const http = require('node:http')
const net = require('node:net')
const path = require('node:path')
const tls = require('node:tls')
const { pathToFileURL } = require('node:url')
const Database = require('better-sqlite3')
const { isPublicCredentialKey } = require('./keyring-credential-store.cjs')
const { GmailOAuthService } = require('./gmail-oauth.cjs')
const { GmailInboundWorker, pollGmail } = require('./gmail-api.cjs')
const { WhatsAppBaileysService, isSupportedMediaMime } = require('./whatsapp-baileys.cjs')
const continuityMigration = require('./continuity-migration.cjs')
const { sendTextEmail } = require('./email-transport.cjs')
const { EmailInboundWorker, pollMailbox } = require('./email-inbound-worker.cjs')
const { MAX_SCANNED_EMAIL_ATTACHMENT_BYTES, scanEmailAttachment } = require('./email-attachment-safety.cjs')
const { McpWorker, MCP_LIFECYCLE } = require('./mcp-worker.cjs')

const SESSION_TTL_MS = 15 * 60 * 1000
const PAIRING_TTL_MS = 5 * 60 * 1000
const EMAIL_INBOUND_CLAIM_TTL_MS = 5 * 60 * 1000
const PAIRING_LOCKOUT_MS = 60 * 1000
const MAX_PAIRING_ATTEMPTS = 5
const MAX_BODY_BYTES = 256 * 1024
const MAX_WHATSAPP_BODY_BYTES = 64 * 1024
const MAX_WHATSAPP_PAYLOAD_BYTES = 32 * 1024
const MAX_WHATSAPP_MEDIA_BYTES = 8 * 1024 * 1024
const MAX_WHATSAPP_MEDIA_BODY_BYTES = Math.ceil(MAX_WHATSAPP_MEDIA_BYTES * 4 / 3) + 64 * 1024
const MAX_EMAIL_INBOUND_BODY_BYTES = 128 * 1024
const MAX_EMAIL_INBOUND_BATCH = 50
const MAX_EMAIL_DRAFT_BATCH = 100
const MAX_EMAIL_DRAFT_BODY_BYTES = 15 * 1024 * 1024
const MAX_EMAIL_DRAFT_TEXT_LENGTH = 32 * 1024
const MAX_EMAIL_DRAFT_ATTACHMENT_COUNT = 5
const MAX_EMAIL_DRAFT_ATTACHMENT_TOTAL_BYTES = 10 * 1024 * 1024
const MAX_EMAIL_DRAFT_ATTACHMENT_BASE64_LENGTH = Math.ceil(MAX_EMAIL_DRAFT_ATTACHMENT_TOTAL_BYTES * 4 / 3) + 64
const MAX_EMAIL_ATTACHMENT_COUNT = 20
const MAX_EMAIL_ATTACHMENT_NAME_LENGTH = 256
const MAX_EMAIL_ATTACHMENT_MIME_LENGTH = 128
const MAX_EMAIL_ATTACHMENT_RESPONSE_BYTES = Math.ceil(MAX_SCANNED_EMAIL_ATTACHMENT_BYTES * 4 / 3) + 32 * 1024
const MAX_WHATSAPP_INBOUND_BATCH = 50
const MAX_DRAFT_TEXT_LENGTH = 4096
const WHATSAPP_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000
const WHATSAPP_INACTIVITY_SWEEP_MS = 60 * 1000
const WHATSAPP_RESOLUTION_PROMPT = "It's been a while! Just checking in—did that resolve your inquiry? (Reply 'Yes' or 'No', or feel free to ask more questions!)"
const OUTBOX_QUARANTINED_ERROR = 'Quarantined by operator'
const OUTBOX_CANCELLED_ERROR = 'Cancelled by operator'
const CONTINUITY_CREDENTIAL_KEYS = Object.freeze([
  'openai_api_key',
  'gemini_api_key',
  'openrouter_api_key',
  'email_mcp_password',
  'email_imap_password',
  'email_smtp_password',
  'gmail_oauth_client_id',
  'whatsapp_cloud_access_token',
  'whatsapp_cloud_app_secret',
  'whatsapp_cloud_verify_token',
])
const CONTINUITY_STORE_CONTRACT = Object.freeze([
  { id: 'electron-settings', source: 'electron', target: 'settings.json', format: 'json', schemaVersion: 'electron.settings.v1', requiresReauthentication: true },
  { id: 'electron-persona', source: 'electron', target: 'persona.json', format: 'json', schemaVersion: 'persona.v1', requiresReauthentication: false },
  { id: 'electron-chat-history', source: 'electron', target: 'chat-history.db', format: 'sqlite', schemaVersion: 'chat-history.v1', requiresReauthentication: true },
  { id: 'agentd-state', source: 'agentd', target: 'agentd.db', format: 'sqlite', schemaVersion: 'agentd.v1', requiresReauthentication: true },
])
const MAX_CHAT_MESSAGES_PER_SESSION = 10_000
const MAX_CHAT_ID_LENGTH = 128
const MAX_CHAT_TITLE_LENGTH = 200
const MAX_CHAT_CHANNEL_LENGTH = 32
const MAX_CHAT_CONTACT_LENGTH = 512
const MAX_CHAT_THREAD_LENGTH = 256
const MAX_CHAT_CONTENT_LENGTH = 32 * 1024
const MAX_ATTACHMENTS_PER_MESSAGE = 8
const MAX_ATTACHMENT_NAME_LENGTH = 256
const MAX_ATTACHMENT_TYPE_LENGTH = 128
const MAX_ATTACHMENT_TEXT_LENGTH = 64 * 1024
const MAX_ATTACHMENT_DATA_URL_LENGTH = 384 * 1024
const MAX_KNOWLEDGE_NAME_LENGTH = 256
const MAX_KNOWLEDGE_PATH_LENGTH = 1024
const MAX_KNOWLEDGE_TYPE_LENGTH = 128
const MAX_KNOWLEDGE_CONTENT_LENGTH = 512 * 1024
const MAX_KNOWLEDGE_BODY_BYTES = MAX_KNOWLEDGE_CONTENT_LENGTH + 32 * 1024
const MAX_KNOWLEDGE_BINARY_BYTES = 16 * 1024 * 1024
const MAX_KNOWLEDGE_CONVERSION_BODY_BYTES = Math.ceil(MAX_KNOWLEDGE_BINARY_BYTES * 4 / 3) + 64 * 1024
const MAX_INTELLIGENCE_DETAILS_LENGTH = 4096
const MAX_MEMORY_NAME_LENGTH = 256
const MAX_MEMORY_TYPE_LENGTH = 128
const MAX_MEMORY_DESCRIPTION_LENGTH = 4096
const MAX_MEMORY_METADATA_BYTES = 32 * 1024
const MAX_MEMORY_QUERY_LENGTH = 512
const MAX_MEMORY_EXPORT_ENTITIES = 10_000
const MAX_MEMORY_EXPORT_BYTES = 2 * 1024 * 1024
const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024
const MAX_PROVIDER_REQUEST_BYTES = 512 * 1024
const MAX_CHAT_REQUEST_BYTES = MAX_PROVIDER_REQUEST_BYTES + 64 * 1024
const MAX_GENERATION_REQUEST_ID_LENGTH = 128
const MAX_PROVIDER_CONTEXT_MESSAGES = 50
const MAX_LOG_BYTES = 32 * 1024
const REQUEST_TIMEOUT_MS = 30 * 1000
const HEADERS_TIMEOUT_MS = 10 * 1000
const KEEP_ALIVE_TIMEOUT_MS = 5 * 1000
const SETTINGS_PERSONA_SCOPE = 'settings-persona'
const SETTINGS_PERSONA_TOKEN_TTL_MS = 5 * 60 * 1000
const SETTINGS_PERSONA_MAX_SOURCE_BYTES = 512 * 1024
const CHAT_HISTORY_SCOPE = 'chat-history'
const CHAT_HISTORY_TOKEN_TTL_MS = 5 * 60 * 1000
const CHAT_HISTORY_MAX_SOURCE_BYTES = 64 * 1024 * 1024
const CHAT_HISTORY_MAX_SESSIONS = 10_000
const CHAT_HISTORY_MAX_MESSAGES = 100_000
const CHAT_HISTORY_MAX_METADATA_BYTES = 128 * 1024
const PROVIDER_ENDPOINTS = Object.freeze({
  openai: 'https://api.openai.com/v1/models',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
  openrouter: 'https://openrouter.ai/api/v1/models',
})
const PROVIDER_CHAT_ENDPOINTS = Object.freeze({
  openai: 'https://api.openai.com/v1/chat/completions',
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
})
const LLM_SETTINGS_DEFAULTS = Object.freeze({
  preferredProvider: 'auto',
  openaiModel: 'gpt-4o-mini',
  geminiModel: 'gemini-2.5-flash',
  openrouterModel: 'anthropic/claude-3-haiku',
})
const OLLAMA_SETTINGS_DEFAULTS = Object.freeze({
  baseUrl: 'http://127.0.0.1:11434',
  model: 'qwen2.5:3b',
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
const SAFE_IGNORED_ELECTRON_SETTINGS_KEYS = Object.freeze(['activeUserId', 'isSyncing', 'lastSyncTime', 'openaiBaseUrl'])
const WHATSAPP_SETTINGS_DEFAULTS = Object.freeze({
  whatsapp_transport: 'baileys',
  whatsapp_cloud_phone_number_id: '',
  whatsapp_cloud_api_version: 'v23.0',
})
const WHATSAPP_UI_DEFAULTS = Object.freeze({
  whatsappEnabled: false,
  businessBotMode: false,
  targetPhoneNumber: null,
})
const EMAIL_SETTINGS_DEFAULTS = Object.freeze({
  accountName: 'default',
  provider: 'imap-smtp',
  gmailAuthMode: 'app-password',
  imapHost: '',
  imapPort: 993,
  smtpHost: '',
  smtpPort: 587,
  emailAddress: '',
  userName: '',
  imapTls: true,
  smtpTls: true,
  pollingIntervalSeconds: 60,
  enabled: false,
  autoReplyMode: false,
  draftMode: true,
})
const MARKITDOWN_KNOWLEDGE_SERVER = Object.freeze({
  id: 'builtin_markitdown',
  name: 'Built-in document converter',
  description: 'Bounded browser knowledge conversion',
  type: 'stdio',
  command: 'uvx',
  args: ['markitdown-mcp[all]'],
  allowedTools: ['convert_to_markdown'],
  autoConnect: false,
})

const PRODUCT_NAME = 'AIConsumerAgent'
const PRODUCT_VERSION = (() => {
  for (const candidate of [path.join(__dirname, 'package.json'), path.join(__dirname, '..', 'package.json')]) {
    try {
      const value = JSON.parse(fs.readFileSync(candidate, 'utf8')).version
      if (typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)) return value
    } catch {}
  }
  return 'unknown'
})()
const PLATFORM_LABEL = Object.freeze({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' })[process.platform] || 'Other'
const AGENTD_ENGINE = `Node.js ${process.versions.node}`

const EMAIL_PROBE_TIMEOUT_MS = 10 * 1000
const EMAIL_DRAFT_STATUSES = Object.freeze(['pending_review', 'approved', 'rejected', 'escalated', 'sent', 'failed'])
const MAX_MCP_SERVERS = 50
const MAX_MCP_NAME_LENGTH = 128
const MAX_MCP_DESCRIPTION_LENGTH = 512
const MAX_MCP_COMMAND_LENGTH = 256
const MAX_MCP_ARGUMENTS = 32
const MAX_MCP_ARGUMENT_LENGTH = 512
const MAX_MCP_URL_LENGTH = 2048
const MAX_MCP_ALLOWED_TOOLS = 128
const MAX_MCP_TOOL_NAME_LENGTH = 128
const MAX_MCP_ENV_KEYS = 64
const MAX_MCP_ENV_KEY_LENGTH = 128

function parseMcpServer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  const required = ['id', 'name', 'description', 'type', 'autoConnect']
  if (keys.some(key => !['id', 'name', 'description', 'type', 'command', 'args', 'url', 'allowedTools', 'autoConnect', 'envKeys'].includes(key))) return null
  if (required.some(key => !keys.includes(key))) return null
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > MAX_MCP_NAME_LENGTH
    || typeof value.description !== 'string' || value.description.length > MAX_MCP_DESCRIPTION_LENGTH
    || !['stdio', 'sse', 'http'].includes(value.type)
    || typeof value.autoConnect !== 'boolean') return null
  if (value.type === 'stdio') {
    if (typeof value.command !== 'string' || !value.command.trim() || value.command.length > MAX_MCP_COMMAND_LENGTH) return null
    if (value.args !== undefined && (!Array.isArray(value.args) || value.args.length > MAX_MCP_ARGUMENTS || value.args.some(arg => typeof arg !== 'string' || arg.length > MAX_MCP_ARGUMENT_LENGTH))) return null
  } else {
    if (typeof value.url !== 'string' || value.url.length > MAX_MCP_URL_LENGTH) return null
    let parsed
    try { parsed = new URL(value.url) } catch { return null }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) return null
  }
  if (value.allowedTools !== undefined && (!Array.isArray(value.allowedTools) || value.allowedTools.length > MAX_MCP_ALLOWED_TOOLS || value.allowedTools.some(tool => typeof tool !== 'string' || !tool.trim() || tool.length > MAX_MCP_TOOL_NAME_LENGTH))) return null
  if (value.envKeys !== undefined && (!Array.isArray(value.envKeys) || value.envKeys.length > MAX_MCP_ENV_KEYS || value.envKeys.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)))) return null
  return {
    id: value.id,
    name: value.name.trim(),
    description: value.description,
    type: value.type,
    ...(value.command !== undefined ? { command: value.command.trim() } : {}),
    ...(value.args !== undefined ? { args: [...value.args] } : {}),
    ...(value.url !== undefined ? { url: value.url } : {}),
    ...(value.allowedTools !== undefined ? { allowedTools: [...new Set(value.allowedTools)] } : {}),
    autoConnect: value.autoConnect,
    ...(value.envKeys !== undefined ? { envKeys: [...new Set(value.envKeys)] } : {}),
  }
}

function parseMcpServers(value) {
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVERS) return null
  const parsed = value.map(parseMcpServer)
  if (parsed.some(item => !item)) return null
  const ids = new Set(parsed.map(item => item.id))
  return ids.size === parsed.length ? parsed : null
}

function createProtocolReader(socket) {
  let buffer = ''
  let closed = false
  const waiters = []
  const onData = chunk => {
    buffer += chunk.toString('utf8')
    while (true) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      waiters.shift()?.resolve(line)
    }
  }
  const fail = error => {
    closed = true
    while (waiters.length) waiters.shift().reject(error)
  }
  socket.on('data', onData)
  socket.once('error', () => fail(new Error('Email endpoint unavailable')))
  socket.once('close', () => fail(new Error('Email endpoint closed before response')))
  return {
    next(timeoutMs = EMAIL_PROBE_TIMEOUT_MS) {
      if (closed) return Promise.reject(new Error('Email endpoint closed'))
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve: value => { clearTimeout(timer); resolve(value) },
          reject: error => { clearTimeout(timer); reject(error) },
        }
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(new Error('Email endpoint timed out'))
        }, timeoutMs)
        waiters.push(waiter)
      })
    },
    close() { socket.removeListener('data', onData) },
  }
}

function openSocket(host, port, secure) {
  return secure
    ? tls.connect({ host, port, servername: host, rejectUnauthorized: true })
    : net.connect({ host, port })
}

async function probeImap(host, port, secure) {
  const socket = openSocket(host, port, secure)
  const reader = createProtocolReader(socket)
  try {
    const line = await reader.next()
    if (!/^\* (?:OK|PREAUTH)\b/i.test(line)) throw new Error('Invalid IMAP greeting')
    return { reachable: true, tls: secure }
  } finally {
    reader.close()
    socket.destroy()
  }
}

async function probeSmtp(host, port, secure) {
  const directTls = secure && port === 465
  const socket = openSocket(host, port, directTls)
  const reader = createProtocolReader(socket)
  try {
    const greeting = await reader.next()
    if (!/^220\b/.test(greeting)) throw new Error('Invalid SMTP greeting')
    if (!secure || directTls) return { reachable: true, tls: secure }
    socket.write('EHLO localhost\r\n')
    let ehlo = await reader.next()
    if (!/^250[ -]/.test(ehlo)) throw new Error('SMTP EHLO failed')
    while (/^250-/.test(ehlo)) ehlo = await reader.next()
    socket.write('STARTTLS\r\n')
    const startTls = await reader.next()
    if (!/^220\b/.test(startTls)) throw new Error('SMTP STARTTLS unavailable')
    return { reachable: true, tls: true }
  } finally {
    reader.close()
    socket.destroy()
  }
}

async function probeEmailTransport(settings) {
  const [imap, smtp] = await Promise.all([
    probeImap(settings.imapHost, settings.imapPort, settings.imapTls),
    probeSmtp(settings.smtpHost, settings.smtpPort, settings.smtpTls),
  ])
  return { imap, smtp }
}

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

function readMigrationFile(filename, maxBytes = null) {
  if (process.platform === 'win32' && fs.constants.O_NOFOLLOW === undefined) {
    const reader = process.env.AICA_AGENTD_MIGRATION_READER || path.resolve(__dirname, '..', `aica-migration-reader${process.platform === 'win32' ? '.exe' : ''}`)
    if (!fs.existsSync(reader)) throw Object.assign(new Error('Settings migration requires trusted native no-reparse file access on Windows'), { statusCode: 503 })
    try {
      const args = [filename]
      if (Number.isSafeInteger(maxBytes) && maxBytes >= 0) args.push(String(maxBytes))
      return execFileSync(reader, args, { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes + 1 : 64 * 1024 * 1024 + 1 })
    } catch {
      if (error?.status === 3) throw Object.assign(new Error('Migration file is too large'), { statusCode: 413 })
      throw Object.assign(new Error('Migration file unavailable'), { statusCode: 409 })
    }
  }
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  let handle
  try {
    handle = fs.openSync(filename, flags)
    const stat = fs.fstatSync(handle)
    if (!stat.isFile()) throw new Error('unsafe')
    if (Number.isSafeInteger(maxBytes) && maxBytes >= 0 && stat.size > maxBytes) {
      throw Object.assign(new Error('Migration file is too large'), { statusCode: 413 })
    }
    return fs.readFileSync(handle)
  } finally {
    if (handle !== undefined) fs.closeSync(handle)
  }
}

function parseJsonWithoutDuplicateKeys(bytes, label) {
  const text = bytes.toString('utf8')
  let index = 0
  const whitespace = () => { while (/\s/.test(text[index] || '')) index += 1 }
  const string = () => {
    if (text[index] !== '"') throw new Error(`Invalid ${label}`)
    const start = index++
    while (index < text.length) {
      if (text[index] === '\\') index += 2
      else if (text[index++] === '"') return JSON.parse(text.slice(start, index))
    }
    throw new Error(`Invalid ${label}`)
  }
  const value = () => {
    whitespace()
    if (text[index] === '{') {
      index += 1; whitespace(); const keys = new Set()
      if (text[index] === '}') { index += 1; return }
      while (true) {
        const key = string()
        if (keys.has(key)) throw new Error(`Duplicate JSON key: ${key}`)
        keys.add(key); whitespace()
        if (text[index++] !== ':') throw new Error(`Invalid ${label}`)
        value(); whitespace()
        if (text[index] === '}') { index += 1; return }
        if (text[index++] !== ',') throw new Error(`Invalid ${label}`)
        whitespace()
      }
    }
    if (text[index] === '[') {
      index += 1; whitespace()
      if (text[index] === ']') { index += 1; return }
      while (true) { value(); whitespace(); if (text[index] === ']') { index += 1; return }; if (text[index++] !== ',') throw new Error(`Invalid ${label}`); whitespace() }
    }
    if (text[index] === '"') { string(); return }
    const match = text.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)
    if (!match) throw new Error(`Invalid ${label}`)
    index += match[0].length
  }
  value(); whitespace()
  if (index !== text.length) throw new Error(`Invalid ${label}`)
  return JSON.parse(text)
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

function whatsappInactivityProviderEventId(sessionId, messageId) {
  return `inactivity:${crypto.createHash('sha256').update(`${sessionId}\0${messageId}`).digest('hex')}`
}

class AgentdServer {
  constructor({ dataDir, secret, uiRoot = null, logger = console, pairingCode = null, credentials = null, providerFetch = fetch, emailProbe = probeEmailTransport, emailSend = sendTextEmail, emailPoll = undefined, gmailPoll: configuredGmailPoll = undefined, whatsappService = null, mcpWorker = null } = {}) {
    if (!secret || typeof secret !== 'string' || secret.length < 32) throw new Error('A per-install bearer secret of at least 32 characters is required')
    this.dataDir = resolveDataDir(dataDir)
    this.secret = secret
    this.uiRoot = uiRoot
    this.logger = logger
    this.credentials = credentials
    this.providerFetch = providerFetch
    this.emailProbe = emailProbe
    this.emailSend = emailSend
    this.emailPoll = emailPoll
    this.gmailPoll = configuredGmailPoll
    this.emailInboundWorker = null
    this.whatsappInactivityTimer = null
    this.whatsappInactivityAuditRunning = false
    this.whatsappInactivityAuditPromise = null
    this.mcpWorker = mcpWorker || new McpWorker({ logger, credentials })
    this.gmailOAuth = new GmailOAuthService({ credentials, fetchImpl: providerFetch, logger })
    this.whatsappBaileys = whatsappService || new WhatsAppBaileysService({
      dataDir: this.dataDir,
      logger,
      onState: state => {
        if (this.db) this.setState('whatsapp_connection_state', JSON.stringify(state))
      },
      onMessage: message => this.ingestWhatsAppServiceMessage(message),
    })
    this.server = null
    this.db = null
    this.lockDb = null
    this.lockOwned = false
    this.lockToken = crypto.randomUUID()
    this.runtimeId = crypto.randomUUID()
    this.startedAt = null
    this.sessions = new Map()
    this.generations = new Set()
    this.generationControllers = new Map()
    this.continuityPreviews = new Map()
    this.settingsPersonaCutovers = new Map()
    this.chatHistoryCutovers = new Map()
    this.migrationHold = false
    this.migrationOwner = false
    this.migrationScope = null
    this.migrationRecoveryScope = null
    this.activeOperations = new Set()
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
        CREATE TABLE IF NOT EXISTS whatsapp_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          draft_id INTEGER NOT NULL UNIQUE REFERENCES whatsapp_drafts(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK(status IN ('pending','sent','failed')) DEFAULT 'pending',
          provider_message_id TEXT,
          error TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS email_drafts (
          id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK(status IN ('pending_review','approved','rejected','escalated','sent','failed')),
          payload TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS email_delivery_locks (
          draft_id TEXT PRIMARY KEY REFERENCES email_drafts(id) ON DELETE CASCADE,
          started_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          workspace_path TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          channel TEXT,
          contact_id TEXT,
          thread_id TEXT,
          topic TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_messages (
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
          content TEXT NOT NULL,
          attachments TEXT,
          metadata TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY(session_id, message_id)
        );
          CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx ON chat_messages(session_id, created_at, message_id);
      CREATE TABLE IF NOT EXISTS chat_generations (
          request_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          model TEXT NOT NULL,
          provider TEXT NOT NULL CHECK(provider IN ('openai','openrouter','ollama','gemini')),
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
        CREATE TABLE IF NOT EXISTS settings_persona_cutovers (
          preview_id TEXT PRIMARY KEY,
          manifest TEXT NOT NULL,
          manifest_hash TEXT NOT NULL,
          scope TEXT NOT NULL,
          target_runtime TEXT NOT NULL,
          state TEXT NOT NULL,
          confirmed_at INTEGER,
          expires_at INTEGER,
          token_hash TEXT,
          consumed_at INTEGER,
          backup_path TEXT,
          backup_sha256 TEXT,
          result TEXT,
          error TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS chat_history_cutovers (
          preview_id TEXT PRIMARY KEY,
          manifest TEXT NOT NULL,
          manifest_hash TEXT NOT NULL,
          scope TEXT NOT NULL,
          target_runtime TEXT NOT NULL,
          source_hash TEXT,
          state TEXT NOT NULL,
          confirmed_at INTEGER,
          expires_at INTEGER,
          token_hash TEXT,
          consumed_at INTEGER,
          backup_path TEXT,
          backup_sha256 TEXT,
          result TEXT,
          error TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS knowledge_documents (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_path TEXT NOT NULL,
          file_name TEXT NOT NULL,
          file_type TEXT NOT NULL,
          content TEXT NOT NULL,
          size INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS knowledge_documents_created_idx ON knowledge_documents(created_at DESC, id DESC);
        CREATE TABLE IF NOT EXISTS intelligence_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          event TEXT NOT NULL,
          details TEXT,
          timestamp TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_entities (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          description TEXT NOT NULL,
          observations TEXT NOT NULL,
          metadata TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_entities_name_idx ON memory_entities(name);
        CREATE TABLE IF NOT EXISTS memory_relations (
          id TEXT PRIMARY KEY,
          from_entity_id TEXT NOT NULL,
          to_entity_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          description TEXT NOT NULL,
          metadata TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_relations_from_idx ON memory_relations(from_entity_id);
        CREATE INDEX IF NOT EXISTS memory_relations_to_idx ON memory_relations(to_entity_id);
      `)
      const inboundColumns = this.db.prepare('PRAGMA table_info(inbound_events)').all()
      if (!inboundColumns.some((column) => column.name === 'claimed_at')) this.db.exec('ALTER TABLE inbound_events ADD COLUMN claimed_at INTEGER')
      const generationSchema = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_generations'").get()?.sql || ''
      if (generationSchema && !generationSchema.includes("'gemini'")) {
        this.db.transaction(() => {
          this.db.exec('ALTER TABLE chat_generations RENAME TO chat_generations_legacy')
          this.db.exec(`CREATE TABLE chat_generations (
            request_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
            model TEXT NOT NULL,
            provider TEXT NOT NULL CHECK(provider IN ('openai','openrouter','ollama','gemini')),
            assistant_message_id TEXT,
            response_text TEXT,
            status TEXT NOT NULL CHECK(status IN ('processing','completed')),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          )`)
          this.db.exec('INSERT INTO chat_generations(request_id,session_id,model,provider,assistant_message_id,response_text,status,created_at,updated_at) SELECT request_id,session_id,model,provider,assistant_message_id,response_text,status,created_at,updated_at FROM chat_generations_legacy')
          this.db.exec('DROP TABLE chat_generations_legacy')
        })()
      }
      const chatColumns = this.db.prepare('PRAGMA table_info(chat_messages)').all()
      if (!chatColumns.some((column) => column.name === 'attachments')) this.db.exec('ALTER TABLE chat_messages ADD COLUMN attachments TEXT')
      if (!chatColumns.some((column) => column.name === 'metadata')) this.db.exec('ALTER TABLE chat_messages ADD COLUMN metadata TEXT')
      const sessionColumns = this.db.prepare('PRAGMA table_info(chat_sessions)').all()
      if (!sessionColumns.some((column) => column.name === 'workspace_path')) this.db.exec('ALTER TABLE chat_sessions ADD COLUMN workspace_path TEXT')
      if (!sessionColumns.some((column) => column.name === 'status')) this.db.exec("ALTER TABLE chat_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'")
      if (!sessionColumns.some((column) => column.name === 'channel')) this.db.exec('ALTER TABLE chat_sessions ADD COLUMN channel TEXT')
      if (!sessionColumns.some((column) => column.name === 'contact_id')) this.db.exec('ALTER TABLE chat_sessions ADD COLUMN contact_id TEXT')
      if (!sessionColumns.some((column) => column.name === 'thread_id')) this.db.exec('ALTER TABLE chat_sessions ADD COLUMN thread_id TEXT')
      if (!sessionColumns.some((column) => column.name === 'topic')) this.db.exec('ALTER TABLE chat_sessions ADD COLUMN topic TEXT')
      if (!sessionColumns.some((column) => column.name === 'metadata')) this.db.exec('ALTER TABLE chat_sessions ADD COLUMN metadata TEXT')
      const chatCutoverColumns = this.db.prepare('PRAGMA table_info(chat_history_cutovers)').all()
      if (!chatCutoverColumns.some((column) => column.name === 'source_hash')) this.db.exec('ALTER TABLE chat_history_cutovers ADD COLUMN source_hash TEXT')
      this.db.prepare('INSERT INTO agent_state(key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO NOTHING').run('paused', 'false', Date.now())
      this.gmailOAuth.configureStateAccessors({
        get: key => this.getState(key, null),
        set: (key, value) => {
          if (value === null || value === undefined) this.db.prepare('DELETE FROM agent_state WHERE key = ?').run(key)
          else this.setState(key, value)
        },
      })
      this.whatsappBaileys.configureStateAccessors({
        get: key => this.getState(key, null),
        set: (key, value) => {
          if (value === null || value === undefined) this.db.prepare('DELETE FROM agent_state WHERE key = ?').run(key)
          else this.setState(key, value)
        },
      })
      await this.whatsappBaileys.initialize()
      this.restoreSettingsPersonaCutovers()
      this.restoreChatHistoryCutovers()
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
      this.startEmailInboundPolling()
      this.startWhatsAppInactivityAudit()
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
    this.stopEmailInboundPolling()
    await this.stopWhatsAppInactivityAudit()
    try { await this.mcpWorker?.closeAll() } catch {}
    try { await this.whatsappBaileys?.disconnect(false) } catch {}
    if (this.server) await new Promise(resolve => this.server.close(() => resolve()))
    this.server = null
    this.sessions.clear()
    this.generations.clear()
    this.settingsPersonaCutovers.clear()
    this.chatHistoryCutovers.clear()
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

  getEmailSettings() {
    try { return parseEmailSettings(JSON.parse(this.getState('email_settings', 'null'))) } catch { return null }
  }

  startEmailInboundPolling() {
    if (this.migrationHold) return
    const settings = this.getEmailSettings()
    if (this.emailInboundWorker || !settings?.enabled) return
    const onMessage = async (settings, message) => {
      if (this.migrationHold) return
      const providerEventId = `${settings.provider === 'gmail-api' ? 'gmail' : 'imap'}:${settings.accountName}:${message.uid}`
      const from = message.payload.from || 'unknown'
      const messageId = message.payload.messageId || providerEventId
      this.ingestEmailInbound({ providerEventId, conversationId: `email::${from}::${messageId}`, payload: message.payload })
    }
    if (settings.provider === 'gmail-api' && settings.gmailAuthMode === 'google-oauth') {
      this.emailInboundWorker = new GmailInboundWorker({
        oauth: this.gmailOAuth,
        getSettings: () => this.getEmailSettings(),
        getCursor: () => Number.parseInt(this.getState('email_gmail_last_sync_ms', '0'), 10) || 0,
        setCursor: cursor => this.setState('email_gmail_last_sync_ms', String(cursor)),
        poll: async (...args) => {
          const release = this.beginActiveOperation()
          if (!release) return { messages: [], nextCursor: 0 }
          try { return await (this.gmailPoll || pollGmail)(...args) } finally { release() }
        },
        logger: this.logger,
        onMessage,
      })
    } else if (this.credentials && ['imap-smtp', 'gmail-api'].includes(settings.provider)
      && settings.gmailAuthMode === 'app-password' && settings.imapTls && settings.imapHost) {
      this.emailInboundWorker = new EmailInboundWorker({
        credentials: this.credentials,
        getSettings: () => this.getEmailSettings(),
        getCursor: () => Number.parseInt(this.getState('email_imap_last_uid', '0'), 10) || 0,
        setCursor: uid => this.setState('email_imap_last_uid', String(uid)),
        poll: async (...args) => {
          const release = this.beginActiveOperation()
          if (!release) return []
          try { return await (this.emailPoll || pollMailbox)(...args) } finally { release() }
        },
        logger: this.logger,
        onMessage,
      })
    }
    if (!this.emailInboundWorker) return
    this.emailInboundWorker.start().catch(() => {})
  }

  stopEmailInboundPolling() {
    this.emailInboundWorker?.stop()
    this.emailInboundWorker = null
  }

  startWhatsAppInactivityAudit() {
    if (this.migrationHold || this.whatsappInactivityTimer) return
    const run = () => {
      const promise = this.auditWhatsAppInactivity().catch(error => {
        this.logger.log(`[agentd] WhatsApp inactivity audit failed: ${error?.message || 'unknown error'}`)
      })
      this.whatsappInactivityAuditPromise = promise
      void promise.then(() => {
        if (this.whatsappInactivityAuditPromise === promise) this.whatsappInactivityAuditPromise = null
      })
    }
    this.whatsappInactivityTimer = setInterval(run, WHATSAPP_INACTIVITY_SWEEP_MS)
    this.whatsappInactivityTimer.unref?.()
    run()
  }

  async stopWhatsAppInactivityAudit() {
    if (this.whatsappInactivityTimer) clearInterval(this.whatsappInactivityTimer)
    this.whatsappInactivityTimer = null
    await this.whatsappInactivityAuditPromise
    this.whatsappInactivityAuditPromise = null
    this.whatsappInactivityAuditRunning = false
  }

  async auditWhatsAppInactivity() {
    if (!this.db || this.migrationHold || this.whatsappInactivityAuditRunning) return
    this.whatsappInactivityAuditRunning = true
    try {
      if (this.getState('paused', 'true') === 'true') return
      let storedUi = null
      try { storedUi = JSON.parse(this.getState('whatsapp_ui_settings', 'null')) } catch {}
      const uiSettings = parseWhatsAppUiSettings(storedUi) || WHATSAPP_UI_DEFAULTS
      if (!uiSettings.whatsappEnabled && !uiSettings.businessBotMode) return

      const cutoff = Date.now() - WHATSAPP_INACTIVITY_TIMEOUT_MS
      const rows = this.db.prepare(`
        SELECT s.id AS session_id, s.contact_id, m.message_id, m.role, m.content
        FROM chat_sessions s
        JOIN chat_messages m ON m.session_id = s.id
        WHERE s.status = 'active'
          AND s.channel = 'whatsapp'
          AND s.contact_id IS NOT NULL
          AND s.updated_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM chat_messages newer
            WHERE newer.session_id = m.session_id
              AND (newer.created_at > m.created_at OR (newer.created_at = m.created_at AND newer.rowid > m.rowid))
          )
      `).all(cutoff)

      for (const row of rows) {
        if (row.role === 'user') {
          const details = `WhatsApp session ${row.session_id} inactive after user message ${row.message_id}`
          const seen = this.db.prepare("SELECT 1 FROM intelligence_logs WHERE type = 'accuracy' AND event = 'user_silence' AND details = ? LIMIT 1").get(details)
          if (!seen) this.db.prepare('INSERT INTO intelligence_logs(type,event,details,timestamp) VALUES (?,?,?,?)').run('accuracy', 'user_silence', details, new Date().toISOString())
          continue
        }
        if (row.role !== 'assistant' || row.content === WHATSAPP_RESOLUTION_PROMPT || typeof row.contact_id !== 'string' || !row.contact_id.trim()) continue

        const providerEventId = whatsappInactivityProviderEventId(row.session_id, row.message_id)
        const existingDraft = this.db.prepare('SELECT id FROM whatsapp_drafts WHERE provider_event_id = ?').get(providerEventId)
        if (existingDraft) continue

        const now = Date.now()
        const inserted = this.db.transaction(() => {
          const payload = JSON.stringify(redactPayload({ kind: 'inactivity_followup', sessionId: row.session_id, relatedMessageId: row.message_id }))
          this.db.prepare('INSERT INTO inbound_events(channel,provider_event_id,conversation_id,payload,status,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(channel,provider_event_id) DO NOTHING').run('whatsapp', providerEventId, row.contact_id.slice(0, 500), payload, 'draft', now)
          this.db.prepare('INSERT INTO whatsapp_drafts(channel,provider_event_id,conversation_id,response_text,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(provider_event_id) DO NOTHING').run('whatsapp', providerEventId, row.contact_id.slice(0, 500), WHATSAPP_RESOLUTION_PROMPT, 'draft', now, now)
          const current = this.db.prepare('SELECT id FROM whatsapp_drafts WHERE provider_event_id = ?').get(providerEventId)
          return { draftId: current?.id }
        })()
        if (!inserted.draftId) continue

        let admitted = true
        if (uiSettings.businessBotMode) {
          this.db.prepare("UPDATE whatsapp_drafts SET status = 'approved', updated_at = ? WHERE id = ? AND status = 'draft'").run(Date.now(), inserted.draftId)
          const result = await this.performWhatsAppDraftSend(inserted.draftId)
          admitted = result.status === 200 && result.body?.success === true
        }
        if (!admitted) continue

        const messageId = `assistant_${providerEventId}`
        this.db.transaction(() => {
          const duplicate = this.db.prepare('SELECT 1 FROM chat_messages WHERE session_id = ? AND message_id = ?').get(row.session_id, messageId)
          if (!duplicate) this.db.prepare('INSERT INTO chat_messages(session_id,message_id,role,content,created_at) VALUES (?,?,?,?,?)').run(row.session_id, messageId, 'assistant', WHATSAPP_RESOLUTION_PROMPT, Date.now())
          this.db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(Date.now(), row.session_id)
        })()
      }
    } finally {
      this.whatsappInactivityAuditRunning = false
    }
  }

  ingestEmailInbound(body) {
    if (this.migrationHold) throw Object.assign(new Error('Settings migration is committing'), { statusCode: 409 })
    if (!parseEmailInbound(body)) throw new Error('Invalid email inbound event')
    const payload = JSON.stringify(body.payload)
    if (Buffer.byteLength(payload, 'utf8') > MAX_EMAIL_INBOUND_BODY_BYTES) throw new Error('Email inbound payload too large')
    const existing = this.db.prepare('SELECT id FROM inbound_events WHERE channel = ? AND provider_event_id = ?').get('email', body.providerEventId)
    if (existing) return { accepted: true, duplicate: true, id: existing.id }
    const result = this.db.prepare('INSERT INTO inbound_events(channel,provider_event_id,conversation_id,payload,status,created_at) VALUES (?,?,?,?,?,?)').run('email', body.providerEventId, body.conversationId, payload, 'queued', Date.now())
    return { accepted: true, duplicate: false, id: result.lastInsertRowid }
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
    if (url.pathname === '/api/v1/settings/whatsapp-ui' && ['GET', 'PUT'].includes(req.method)) return this.whatsappUiSettings(req, res)
    if (url.pathname === '/api/v1/settings/ollama' && ['GET', 'PUT'].includes(req.method)) return this.ollamaSettings(req, res)
    if (url.pathname === '/api/v1/settings/email' && ['GET', 'PUT'].includes(req.method)) return this.emailSettings(req, res)
    if (url.pathname === '/api/v1/email/oauth/callback' && req.method === 'GET') return this.emailOAuthCallback(req, res, url)
    if (url.pathname === '/api/v1/email/oauth/status' && req.method === 'GET') return this.emailOAuthStatus(req, res)
    if (url.pathname === '/api/v1/email/oauth/start' && req.method === 'POST') return this.emailOAuthStart(req, res)
    if (url.pathname === '/api/v1/email/oauth/signout' && req.method === 'POST') return this.emailOAuthSignOut(req, res)
    if (url.pathname === '/api/v1/whatsapp/connection' && req.method === 'GET') return this.whatsappConnection(req, res)
    if (url.pathname === '/api/v1/whatsapp/connect' && req.method === 'POST') return this.whatsappConnect(req, res)
    if (url.pathname === '/api/v1/whatsapp/disconnect' && req.method === 'POST') return this.whatsappDisconnect(req, res)
    if (url.pathname === '/api/v1/whatsapp/target' && req.method === 'POST') return this.whatsappTarget(req, res)
    if (url.pathname === '/api/v1/email/test' && req.method === 'POST') return this.testEmail(req, res)
    if (url.pathname === '/api/v1/email/inbound/ack' && req.method === 'POST') return this.acknowledgeEmailInbound(req, res)
    if (url.pathname === '/api/v1/email/inbound/claim' && req.method === 'POST') return this.claimEmailInbound(req, res)
    if (url.pathname === '/api/v1/email/inbound' && ['GET', 'POST'].includes(req.method)) return this.emailInbound(req, res, url)
    if (url.pathname === '/api/v1/email/attachments' && req.method === 'GET') return this.emailAttachments(req, res, url)
    const emailAttachmentMatch = /^\/api\/v1\/email\/attachments\/([^/]+)\/([^/]+)$/.exec(url.pathname)
    if (emailAttachmentMatch && req.method === 'POST') return this.retrieveGmailAttachmentRoute(req, res, decodeURIComponent(emailAttachmentMatch[1]), decodeURIComponent(emailAttachmentMatch[2]))
    if (url.pathname === '/api/v1/email/drafts' && ['GET', 'POST'].includes(req.method)) return this.emailDrafts(req, res, url)
    const emailDraftMatch = /^\/api\/v1\/email\/drafts\/([^/]+)$/.exec(url.pathname)
    const emailDraftSendMatch = /^\/api\/v1\/email\/drafts\/([^/]+)\/send$/.exec(url.pathname)
    if (emailDraftSendMatch && req.method === 'POST') return this.sendEmailDraft(req, res, decodeURIComponent(emailDraftSendMatch[1]))
    if (emailDraftMatch && ['PATCH', 'DELETE'].includes(req.method)) return this.emailDraft(req, res, decodeURIComponent(emailDraftMatch[1]))
    if (url.pathname === '/api/v1/whatsapp/messages' && req.method === 'POST') return this.sendWhatsAppMessage(req, res)
    if (url.pathname === '/api/v1/whatsapp/media' && req.method === 'POST') return this.sendWhatsAppMedia(req, res)
    const providerTestMatch = /^\/api\/v1\/providers\/(openai|openrouter|ollama|gemini)\/test$/.exec(url.pathname)
    if (providerTestMatch && req.method === 'POST') return this.testProvider(req, res, providerTestMatch[1])
    if (url.pathname === '/api/v1/status' && req.method === 'GET') {
      this.authorize(req)
      return json(res, 200, { runtime: 'agentd', paused: this.getState('paused', 'true') === 'true', queueDepth: this.db.prepare("SELECT COUNT(*) AS count FROM inbound_events WHERE status IN ('queued','processing')").get().count, events: this.db.prepare('SELECT COUNT(*) AS count FROM inbound_events').get().count })
    }
    if (url.pathname === '/api/v1/system-info' && req.method === 'GET') return this.systemInfo(req, res)
    if (url.pathname === '/api/v1/mcp' && req.method === 'GET') {
      this.authorize(req)
      return json(res, 200, this.mcpWorker.lifecycle())
    }
    if (url.pathname === '/api/v1/mcp/servers' && ['GET', 'PUT'].includes(req.method)) return this.mcpServers(req, res)
    const mcpConnectMatch = /^\/api\/v1\/mcp\/servers\/([^/]+)\/(connect|disconnect|tools)$/.exec(url.pathname)
    if (mcpConnectMatch && ((mcpConnectMatch[2] === 'tools' && req.method === 'GET') || (['connect', 'disconnect'].includes(mcpConnectMatch[2]) && req.method === 'POST'))) {
      return this.mcpServerAction(req, res, decodeURIComponent(mcpConnectMatch[1]), mcpConnectMatch[2])
    }
    const mcpCallMatch = /^\/api\/v1\/mcp\/servers\/([^/]+)\/call$/.exec(url.pathname)
    if (mcpCallMatch && req.method === 'POST') return this.mcpCall(req, res, decodeURIComponent(mcpCallMatch[1]))
    if (url.pathname === '/api/v1/mcp/cancel' && req.method === 'POST') return this.mcpCancel(req, res)
    if (url.pathname === '/api/v1/continuity/status' && req.method === 'GET') return this.continuityStatus(req, res)
    if (url.pathname === '/api/v1/continuity/preview' && req.method === 'POST') return this.continuityPreview(req, res)
    if (url.pathname === '/api/v1/continuity/credentials/preview' && req.method === 'POST') return this.credentialContinuityPreview(req, res)
    if (url.pathname === '/api/v1/continuity/import' && req.method === 'POST') return this.continuityImport(req, res)
    if (url.pathname === '/api/v1/continuity/rollback' && req.method === 'POST') return this.continuityRollback(req, res)
    if (url.pathname === '/api/v1/continuity/settings-persona/confirm' && req.method === 'POST') return this.settingsPersonaConfirm(req, res)
    if (url.pathname === '/api/v1/continuity/settings-persona/apply' && req.method === 'POST') return this.settingsPersonaApply(req, res)
    if (url.pathname === '/api/v1/continuity/settings-persona/rollback' && req.method === 'POST') return this.settingsPersonaRollback(req, res)
    if (url.pathname === '/api/v1/continuity/settings-persona/status' && req.method === 'GET') return this.settingsPersonaStatus(req, res)
    if (url.pathname === '/api/v1/continuity/chat-history/confirm' && req.method === 'POST') return this.chatHistoryConfirm(req, res)
    if (url.pathname === '/api/v1/continuity/chat-history/apply' && req.method === 'POST') return this.chatHistoryApply(req, res)
    if (url.pathname === '/api/v1/continuity/chat-history/rollback' && req.method === 'POST') return this.chatHistoryRollback(req, res)
    if (url.pathname === '/api/v1/continuity/chat-history/status' && req.method === 'GET') return this.chatHistoryStatus(req, res)
    if (url.pathname === '/api/v1/autonomy/metrics' && req.method === 'GET') return this.autonomyMetrics(req, res, url)
    if (url.pathname === '/api/v1/logs' && ['GET', 'POST'].includes(req.method)) return this.auditLogs(req, res, url)
    if (url.pathname === '/api/v1/knowledge/convert' && req.method === 'POST') return this.convertKnowledge(req, res)
    if (url.pathname === '/api/v1/knowledge' && ['GET', 'POST'].includes(req.method)) return this.knowledge(req, res, url)
    const knowledgeMatch = /^\/api\/v1\/knowledge\/(\d+)$/.exec(url.pathname)
    if (knowledgeMatch && req.method === 'DELETE') return this.deleteKnowledge(req, res, Number(knowledgeMatch[1]))
    if (url.pathname === '/api/v1/knowledge/search' && req.method === 'GET') return this.searchKnowledge(req, res, url)
    if (url.pathname === '/api/v1/intelligence/logs' && req.method === 'GET') return this.intelligenceLogs(req, res, url)
    if (url.pathname === '/api/v1/intelligence/stats' && req.method === 'GET') return this.intelligenceStats(req, res)
    if (url.pathname === '/api/v1/intelligence/accuracy' && req.method === 'POST') return this.logIntelligenceAccuracy(req, res)
    if (url.pathname === '/api/v1/memory/stats' && req.method === 'GET') return this.memoryStats(req, res)
    if (url.pathname === '/api/v1/memory/export' && req.method === 'GET') return this.memoryExport(req, res)
    if (url.pathname === '/api/v1/memory/tools' && req.method === 'POST') return this.memoryTool(req, res)
    if (url.pathname === '/api/v1/sessions' && ['GET', 'POST'].includes(req.method)) return this.chatSessions(req, res)
    const sessionMatch = /^\/api\/v1\/sessions\/([^/]+)$/.exec(url.pathname)
    if (sessionMatch && req.method === 'PATCH') return this.updateChatSession(req, res, sessionMatch[1])
    if (sessionMatch && req.method === 'DELETE') return this.deleteChatSession(req, res, sessionMatch[1])
    if (sessionMatch && req.method === 'GET') return this.getChatSession(req, res, sessionMatch[1])
    const sessionMessagesMatch = /^\/api\/v1\/sessions\/([^/]+)\/messages$/.exec(url.pathname)
    if (sessionMessagesMatch && req.method === 'POST') return this.addChatMessage(req, res, sessionMessagesMatch[1])
    const sessionGenerationMatch = /^\/api\/v1\/sessions\/([^/]+)\/generations$/.exec(url.pathname)
    if (sessionGenerationMatch && req.method === 'POST') return this.generateChat(req, res, sessionGenerationMatch[1])
    const cancelGenerationMatch = /^\/api\/v1\/sessions\/([^/]+)\/generations\/([^/]+)\/cancel$/.exec(url.pathname)
    if (cancelGenerationMatch && req.method === 'POST') return this.cancelGeneration(req, res, cancelGenerationMatch[1], cancelGenerationMatch[2])
    if (url.pathname === '/api/v1/events' && req.method === 'POST') return this.recordEvent(req, res)
    if (['/api/v1/whatsapp/events', '/api/v1/whatsapp/inbound', '/api/v1/events/whatsapp'].includes(url.pathname) && ['GET', 'POST'].includes(req.method)) return this.whatsappInbound(req, res, url)
    if (['/api/v1/drafts', '/api/v1/whatsapp/drafts'].includes(url.pathname) && req.method === 'GET') return this.listDrafts(req, res, url)
    const draftMatch = /^\/api\/v1\/(?:whatsapp\/)?drafts\/(\d+)$/.exec(url.pathname)
    const draftSendMatch = /^\/api\/v1\/whatsapp\/drafts\/(\d+)\/send$/.exec(url.pathname)
    const draftRetryMatch = /^\/api\/v1\/whatsapp\/drafts\/(\d+)\/retry$/.exec(url.pathname)
    const draftQuarantineMatch = /^\/api\/v1\/whatsapp\/drafts\/(\d+)\/quarantine$/.exec(url.pathname)
    const draftCancelMatch = /^\/api\/v1\/whatsapp\/drafts\/(\d+)\/cancel$/.exec(url.pathname)
    if (draftSendMatch && req.method === 'POST') return this.sendWhatsAppDraft(req, res, Number(draftSendMatch[1]))
    if (draftRetryMatch && req.method === 'POST') return this.retryWhatsAppDraft(req, res, Number(draftRetryMatch[1]))
    if (draftQuarantineMatch && req.method === 'POST') return this.dispositionWhatsAppDraft(req, res, Number(draftQuarantineMatch[1]), OUTBOX_QUARANTINED_ERROR)
    if (draftCancelMatch && req.method === 'POST') return this.dispositionWhatsAppDraft(req, res, Number(draftCancelMatch[1]), OUTBOX_CANCELLED_ERROR)
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
    if (!isPublicCredentialKey(key)) return json(res, 400, { error: 'Invalid credential key' })
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

  async mcpServers(req, res) {
    const read = () => {
      let stored = []
      try { stored = JSON.parse(this.getState('mcp_servers', '[]')) } catch {}
      return parseMcpServers(stored) || []
    }
    const project = server => this.mcpWorker.projectRuntime(server)
    if (req.method === 'GET') {
      this.authorize(req)
      return json(res, 200, { servers: read().map(project), execution: MCP_LIFECYCLE.execution, reason: MCP_LIFECYCLE.reason })
    }
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    let body
    try { body = await readBody(req) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    const servers = parseMcpServers(body?.servers)
    if (!servers) return json(res, 400, { error: 'Invalid MCP server configuration' })
    const previous = read()
    const nextIds = new Set(servers.map(server => server.id))
    await Promise.all(previous.filter(server => !nextIds.has(server.id)).map(server => this.mcpWorker.disconnect(server.id)))
    for (const server of servers) {
      const old = previous.find(item => item.id === server.id)
      if (old && JSON.stringify(old) !== JSON.stringify(server)) await this.mcpWorker.disconnect(server.id)
    }
    this.setState('mcp_servers', JSON.stringify(servers))
    return json(res, 200, { servers: servers.map(project), execution: MCP_LIFECYCLE.execution, reason: MCP_LIFECYCLE.reason })
  }

  async mcpServerAction(req, res, serverId, action) {
    this.authorize(req, { mutation: action !== 'tools' })
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(serverId)) return json(res, 400, { error: 'Invalid MCP server ID' })
    let stored = []
    try { stored = JSON.parse(this.getState('mcp_servers', '[]')) } catch {}
    const servers = parseMcpServers(stored) || []
    const server = servers.find(item => item.id === serverId)
    if (!server) return json(res, 404, { error: 'MCP server not found' })
    try {
      if (action === 'connect') await this.mcpWorker.connect(server)
      else if (action === 'disconnect') await this.mcpWorker.disconnect(server.id)
      else {
        const tools = this.mcpWorker.listTools(server)
        return json(res, 200, { server: this.mcpWorker.projectRuntime(server), tools })
      }
      return json(res, 200, { server: this.mcpWorker.projectRuntime(server) })
    } catch (error) {
      this.logger.warn?.('[agentd] MCP operation failed', { serverId, action, error: error instanceof Error ? error.message : 'MCP operation failed' })
      return json(res, 409, { error: error instanceof Error ? error.message : 'MCP operation failed' })
    }
  }

  async mcpCall(req, res, serverId) {
    this.authorize(req, { mutation: true })
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(serverId)) return json(res, 400, { error: 'Invalid MCP server ID' })
    let body
    try { body = await readBody(req, 128 * 1024) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    if (!body || typeof body.toolName !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(body.toolName) || body.toolName === 'evaluate' || body.toolName === 'browser_run_code') return json(res, 400, { error: 'Invalid or disallowed MCP tool name' })
    const args = body.args === undefined ? {} : body.args
    if (!args || typeof args !== 'object' || Array.isArray(args)) return json(res, 400, { error: 'MCP arguments must be an object' })
    try {
      if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 64 * 1024) return json(res, 413, { error: 'MCP arguments exceed 64KB' })
    } catch { return json(res, 400, { error: 'MCP arguments are not serializable' }) }
    const requestId = body.requestId === undefined ? crypto.randomUUID() : body.requestId
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(requestId)) return json(res, 400, { error: 'Invalid MCP request ID' })
    let stored = []
    try { stored = JSON.parse(this.getState('mcp_servers', '[]')) } catch {}
    const server = (parseMcpServers(stored) || []).find(item => item.id === serverId)
    if (!server) return json(res, 404, { error: 'MCP server not found' })
    try {
      const result = await this.mcpWorker.call(server, body.toolName, args, requestId)
      return json(res, 200, { result, requestId })
    } catch (error) {
      this.logger.warn?.('[agentd] MCP tool call failed', { serverId, toolName: body.toolName, requestId, error: error instanceof Error ? error.message : 'MCP tool call failed' })
      return json(res, 409, { error: error instanceof Error ? error.message : 'MCP tool call failed', requestId })
    }
  }

  async mcpCancel(req, res) {
    this.authorize(req, { mutation: true })
    let body
    try { body = await readBody(req, 16 * 1024) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    if (typeof body?.requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(body.requestId)) return json(res, 400, { error: 'Invalid MCP request ID' })
    return json(res, 200, { cancelled: await this.mcpWorker.cancel(body.requestId) })
  }

  async continuityStatus(req, res) {
    this.authorize(req)
    const count = (table) => this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
    const credentials = []
    for (const key of CONTINUITY_CREDENTIAL_KEYS) {
      let present = false
      let available = Boolean(this.credentials)
      if (this.credentials) {
        try { present = await this.credentials.exists(key) } catch { available = false }
      }
      credentials.push({ key, present, available })
    }
    return json(res, 200, {
      version: 1,
      runtime: 'agentd',
      migration: {
        source: 'electron',
        target: 'agentd',
        state: 'native-owner-action-required',
        secretsExcluded: true,
        note: 'Electron stores require an explicit owner-approved native migration; this read-only endpoint never reads or imports them.',
      },
      stores: CONTINUITY_STORE_CONTRACT.map(store => ({
        ...store,
        state: store.id === 'agentd-state' ? 'active' : 'pending',
      })),
      data: {
        sessions: count('chat_sessions'),
        messages: count('chat_messages'),
        knowledgeDocuments: count('knowledge_documents'),
        inboundEvents: count('inbound_events'),
        drafts: count('whatsapp_drafts') + count('email_drafts'),
      },
      credentials,
    })
  }

  authorizeNative(req) {
    const authorization = req.headers.authorization
    if (authorization !== `Bearer ${this.secret}`) throw Object.assign(new Error('Native owner authorization required'), { statusCode: 401 })
    this.checkOrigin(req, false)
  }

  async continuityPreview(req, res) {
    this.authorizeNative(req)
    const body = await readBody(req, 16 * 1024)
    const preview = continuityMigration.createPreview(body.sourceRoot, this.dataDir)
    this.continuityPreviews.set(preview.previewId, preview)
    this.settingsPersonaCutovers.set(preview.previewId, {
      previewId: preview.previewId,
      manifest: preview.manifest,
      manifestHash: this.migrationManifestHash(preview.manifest),
      scope: SETTINGS_PERSONA_SCOPE,
      targetRuntime: this.runtimeId,
      state: 'previewed',
    })
    this.persistSettingsPersonaCutover(this.settingsPersonaCutovers.get(preview.previewId))
    // Keep preview manifests short-lived and memory-only. They contain paths and
    // hashes, never store contents or credentials.
    setTimeout(() => this.continuityPreviews.delete(preview.previewId), 10 * 60 * 1000).unref?.()
    return json(res, 200, {
      previewId: preview.previewId,
      createdAt: preview.createdAt,
      source: 'electron',
      target: 'agentd-staging',
      entries: preview.manifest.entries,
      secretsExcluded: true,
      requiresOwnerConfirmation: true,
      requiresReauthentication: preview.manifest.entries.some(entry => entry.requiresReauthentication),
    })
  }

  async credentialContinuityPreview(req, res) {
    // This is intentionally native-owner-only. Browser sessions may inspect
    // target credential presence through continuity/status, but may not submit
    // arbitrary filesystem paths or inspect legacy encrypted stores.
    this.authorizeNative(req)
    let body
    try { body = await readBody(req, 16 * 1024) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    if (typeof body?.sourceRoot !== 'string' || !body.sourceRoot.trim()) return json(res, 400, { error: 'Source folder is required' })
    if (body.ownerConfirmation !== 'INSPECT_ELECTRON_CREDENTIALS') return json(res, 403, { error: 'Explicit owner confirmation required' })
    try {
      const preview = continuityMigration.inspectCredentialSources(body.sourceRoot, this.dataDir, filename => readMigrationFile(filename, 2 * 1024 * 1024))
      return json(res, 200, preview)
    } catch (error) {
      return json(res, error.statusCode || 500, { error: error.statusCode === 500 ? 'Credential continuity preview failed' : error.message })
    }
  }

  async continuityImport(req, res) {
    this.authorizeNative(req)
    const body = await readBody(req, 16 * 1024)
    const persisted = this.settingsPersonaCutovers.get(body.previewId)
    const preview = this.continuityPreviews.get(body.previewId) || this.cutoverPreview(persisted)
    if (!preview && !persisted) return json(res, 404, { error: 'Migration preview expired' })
    if (body.ownerConfirmation !== 'IMPORT_ELECTRON_DATA') {
      return json(res, 403, { error: 'Explicit owner confirmation required' })
    }
    const result = continuityMigration.importPreview(preview, this.dataDir)
    // Keep the short-lived preview so a native caller can safely retry after a
    // lost response. The migration helper validates the existing staged
    // snapshot and remains idempotent; the TTL still bounds replay lifetime.
    return json(res, 200, { ...result, secretsExcluded: true, liveDataChanged: false })
  }

  async continuityRollback(req, res) {
    this.authorizeNative(req)
    const body = await readBody(req, 8 * 1024)
    const result = continuityMigration.rollback(body.migrationId, this.dataDir)
    this.continuityPreviews.delete(body.migrationId)
    const cutover = this.settingsPersonaCutovers.get(body.migrationId)
    if (!cutover || ['previewed', 'confirmed'].includes(cutover.state)) {
      this.settingsPersonaCutovers.delete(body.migrationId)
      this.db.prepare('DELETE FROM settings_persona_cutovers WHERE preview_id = ?').run(body.migrationId)
    }
    return json(res, 200, result)
  }

  migrationFence(req, res) {
    if (!this.migrationHold) return false
    json(res, 409, { error: 'Settings migration is committing' })
    return true
  }

  beginActiveOperation() {
    if (this.migrationHold) return null
    let release
    const done = new Promise(resolve => { release = () => { this.activeOperations.delete(done); resolve() } })
    this.activeOperations.add(done)
    return release
  }

  assertMigrationOpen() {
    if (this.migrationHold) throw Object.assign(new Error('Settings migration is committing'), { statusCode: 409 })
  }

  assertMigrationCommitReady() {
    if (!this.migrationHold || !this.migrationOwner || this.activeOperations.size) throw Object.assign(new Error('Migration work is still active'), { statusCode: 409 })
  }

  claimMigrationOwner(scope, allowRecovery = false) {
    if (this.migrationOwner || (this.migrationHold && !(allowRecovery && this.migrationRecoveryScope === scope))) return false
    this.migrationHold = true
    this.migrationOwner = true
    this.migrationScope = scope
    return true
  }

  releaseMigrationOwner(scope, priorHold, clearRecovery = false) {
    if (!this.migrationOwner || this.migrationScope !== scope) return
    this.migrationOwner = false
    this.migrationScope = null
    this.migrationHold = clearRecovery ? false : priorHold
    if (!this.migrationHold) this.migrationRecoveryScope = null
    if (!this.migrationHold) this.startEmailInboundPolling()
  }

  markMigrationRecovery(scope) {
    if (this.migrationRecoveryScope && this.migrationRecoveryScope !== scope) this.migrationRecoveryScope = 'multiple'
    else this.migrationRecoveryScope = scope
    this.migrationHold = true
  }

  async drainActiveOperations() {
    while (this.activeOperations.size) await Promise.all([...this.activeOperations])
  }

  persistSettingsPersonaCutover(record) {
    this.db.prepare(`INSERT INTO settings_persona_cutovers
      (preview_id,manifest,manifest_hash,scope,target_runtime,state,confirmed_at,expires_at,token_hash,consumed_at,backup_path,backup_sha256,result,error,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(preview_id) DO UPDATE SET manifest=excluded.manifest,manifest_hash=excluded.manifest_hash,scope=excluded.scope,target_runtime=excluded.target_runtime,state=excluded.state,confirmed_at=excluded.confirmed_at,expires_at=excluded.expires_at,token_hash=excluded.token_hash,consumed_at=excluded.consumed_at,backup_path=excluded.backup_path,backup_sha256=excluded.backup_sha256,result=excluded.result,error=excluded.error,updated_at=excluded.updated_at`).run(
      record.previewId, JSON.stringify(record.manifest), record.manifestHash, record.scope, record.targetRuntime, record.state,
      record.confirmedAt || null, record.expiresAt || null, record.token ? crypto.createHash('sha256').update(record.token).digest('hex') : null,
      record.consumedAt || null, record.backupPath || null, record.backupSha256 || null, record.result ? JSON.stringify(record.result) : null, record.error || null, Date.now())
  }

  restoreSettingsPersonaCutovers() {
    for (const row of this.db.prepare('SELECT * FROM settings_persona_cutovers').all()) {
      let manifest; let result
      try { manifest = JSON.parse(row.manifest); result = row.result ? JSON.parse(row.result) : undefined } catch { continue }
      const record = { previewId: row.preview_id, manifest, manifestHash: row.manifest_hash, scope: row.scope, targetRuntime: row.target_runtime, state: row.state, confirmedAt: row.confirmed_at || undefined, expiresAt: row.expires_at || undefined, consumedAt: row.consumed_at || undefined, backupPath: row.backup_path || undefined, backupSha256: row.backup_sha256 || undefined, result, error: row.error || undefined }
      if (record.state === 'applying') {
        record.state = 'needs-recovery'
        record.error = record.backupPath
          ? 'Migration interrupted after backup creation; manual rollback required'
          : 'Migration interrupted before backup reference; manual recovery required'
        this.persistSettingsPersonaCutover(record)
      }
      this.settingsPersonaCutovers.set(record.previewId, record)
      if (record.state === 'needs-recovery' || record.state === 'applying') {
        this.markMigrationRecovery(SETTINGS_PERSONA_SCOPE)
      }
    }
  }

  cutoverPreview(record) {
    if (!record) return null
    return this.continuityPreviews.get(record.previewId) || { previewId: record.previewId, createdAt: record.manifest.createdAt, manifest: record.manifest }
  }

  migrationManifestHash(manifest) {
    return crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
  }

  readSettingsPersonaInput(preview) {
    if (!preview || !preview.manifest || !Array.isArray(preview.manifest.entries)) throw Object.assign(new Error('Migration preview expired'), { statusCode: 404 })
    if (process.platform === 'win32' && fs.constants.O_NOFOLLOW === undefined) throw Object.assign(new Error('Settings migration requires trusted native no-reparse file access on Windows'), { statusCode: 503 })
    const entries = preview.manifest.entries
    const required = ['electron-settings', 'electron-persona']
    if (required.some(id => !entries.some(entry => entry.id === id))) throw Object.assign(new Error('Settings/persona stores are missing from preview'), { statusCode: 409 })
    const stagingRoot = path.join(this.dataDir, '.migration-staging', preview.previewId)
    const manifestPath = path.join(stagingRoot, 'manifest.json')
    let persisted
    try { persisted = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { throw Object.assign(new Error('Staged migration manifest is unavailable'), { statusCode: 409 }) }
    if (persisted.previewId !== preview.previewId || JSON.stringify(persisted.manifest) !== JSON.stringify(preview.manifest)) throw Object.assign(new Error('Staged migration manifest does not match preview'), { statusCode: 409 })
    const bytesFor = (id) => {
      const entry = entries.find(item => item.id === id)
      const staged = path.join(stagingRoot, id)
      let bytes
      try {
        bytes = readMigrationFile(staged)
      } catch { throw Object.assign(new Error(`Staged migration file unavailable: ${id}`), { statusCode: 409 }) }
      if (bytes.length !== entry.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Object.assign(new Error(`Staged migration file changed: ${id}`), { statusCode: 409 })
      if (bytes.length > SETTINGS_PERSONA_MAX_SOURCE_BYTES) throw Object.assign(new Error(`Migration store too large: ${id}`), { statusCode: 413 })
      return bytes
    }
    const sourceFor = (id, relativePath) => {
      const source = path.join(preview.manifest.sourceRoot, relativePath)
      try {
        const bytes = readMigrationFile(source)
        const entry = entries.find(item => item.id === id)
        if (bytes.length !== entry.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw Object.assign(new Error(`Source changed after preview: ${id}`), { statusCode: 409 })
      } catch (error) {
        if (error.statusCode) throw error
        throw Object.assign(new Error(`Source changed after preview: ${id}`), { statusCode: 409 })
      }
    }
    sourceFor('electron-settings', 'aica-store.json')
    sourceFor('electron-persona', 'business_profile.json')
    let settingsRaw
    let personaRaw
    try { settingsRaw = parseJsonWithoutDuplicateKeys(bytesFor('electron-settings'), 'settings'); personaRaw = parseJsonWithoutDuplicateKeys(bytesFor('electron-persona'), 'persona') } catch { throw Object.assign(new Error('Invalid or duplicate JSON in settings/persona stores'), { statusCode: 400 }) }
    const denySecretKeys = value => {
      if (Array.isArray(value)) return value.forEach(denySecretKeys)
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        if (/(?:api[_.-]?key|secret|token|password|oauth|credential|bearer|authorization|private[_.-]?key|encryption)/i.test(key)) throw Object.assign(new Error(`Secret field refused: ${key}`), { statusCode: 400 })
        denySecretKeys(child)
      }
    }
    denySecretKeys(settingsRaw)
    denySecretKeys(personaRaw)
    const persona = parsePersonaSettings(personaRaw)
    if (!persona) throw Object.assign(new Error('Invalid business persona schema'), { statusCode: 400 })
    const settingKeys = Object.keys(settingsRaw || {})
    if (settingKeys.length !== 1 || settingKeys[0] !== 'aica-settings' || !settingsRaw['aica-settings'] || typeof settingsRaw['aica-settings'] !== 'object' || Array.isArray(settingsRaw['aica-settings'])) throw Object.assign(new Error('Invalid Electron settings wrapper'), { statusCode: 400 })
    const wrapper = settingsRaw['aica-settings']
    const wrapperKeys = Object.keys(wrapper).sort()
    if (wrapperKeys.some(key => !['state', 'version'].includes(key)) || !Object.prototype.hasOwnProperty.call(wrapper, 'state') || (wrapper.version !== undefined && (!Number.isSafeInteger(wrapper.version) || wrapper.version < 0))) throw Object.assign(new Error('Invalid Electron settings wrapper'), { statusCode: 400 })
    const state = wrapper.state
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw Object.assign(new Error('Invalid Electron settings schema'), { statusCode: 400 })
    const allowedStateKeys = new Set(['preferredProvider', 'openaiModel', 'geminiModel', 'openrouterModel', 'ollamaModel', 'ollamaBaseUrl', ...Object.keys(PRODUCT_PREFERENCES_DEFAULTS), ...SAFE_IGNORED_ELECTRON_SETTINGS_KEYS])
    if (Object.keys(state).some(key => !allowedStateKeys.has(key))) throw Object.assign(new Error('Unknown Electron settings field'), { statusCode: 400 })
    let currentLlm; let currentOllama; let currentPreferences
    try { currentLlm = parseLlmSettings(JSON.parse(this.getState('llm_settings', 'null'))) || LLM_SETTINGS_DEFAULTS } catch { currentLlm = LLM_SETTINGS_DEFAULTS }
    try { currentOllama = parseOllamaSettings(JSON.parse(this.getState('ollama_settings', 'null'))) || OLLAMA_SETTINGS_DEFAULTS } catch { currentOllama = OLLAMA_SETTINGS_DEFAULTS }
    try { currentPreferences = parseProductPreferences(JSON.parse(this.getState('product_preferences', 'null'))) || PRODUCT_PREFERENCES_DEFAULTS } catch { currentPreferences = PRODUCT_PREFERENCES_DEFAULTS }
    const pick = (keys) => Object.fromEntries(keys.filter(key => Object.prototype.hasOwnProperty.call(state, key)).map(key => [key, state[key]]))
    const llm = parseLlmSettings({ ...currentLlm, ...pick(['preferredProvider', 'openaiModel', 'geminiModel', 'openrouterModel']) })
    const ollama = parseOllamaSettings({
      baseUrl: state.ollamaBaseUrl ?? currentOllama.baseUrl,
      model: state.ollamaModel ?? currentOllama.model,
    })
    const preferences = parseProductPreferences({ ...currentPreferences, ...pick(Object.keys(PRODUCT_PREFERENCES_DEFAULTS)) })
    if (!llm || !ollama || !preferences) throw Object.assign(new Error('Electron settings contain invalid allowlisted values'), { statusCode: 400 })
    return { persona, llm, ollama, preferences, manifestHash: this.migrationManifestHash(preview.manifest) }
  }

  writeMigrationBackup(record, prior) {
    const backupDir = path.join(this.dataDir, 'migration-backups')
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    fs.chmodSync(backupDir, 0o700)
    if ((fs.statSync(backupDir).mode & 0o777) !== 0o700) throw new Error('Migration backup directory is not private')
    const filename = path.join(backupDir, `${SETTINGS_PERSONA_SCOPE}-${record.previewId}-${crypto.randomUUID()}.json`)
    const payload = { version: 1, scope: SETTINGS_PERSONA_SCOPE, previewId: record.previewId, manifest: record.manifest, previewHash: record.manifestHash, prior }
    const bytes = Buffer.from(JSON.stringify(payload) + '\n')
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    const complete = Buffer.from(JSON.stringify({ ...payload, sha256 }) + '\n')
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`
    const handle = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(handle, complete); fs.fsyncSync(handle); fs.closeSync(handle); fs.renameSync(temporary, filename); fs.chmodSync(filename, 0o600)
      if ((fs.statSync(filename).mode & 0o777) !== 0o600) throw new Error('Migration backup is not private')
      const directory = fs.openSync(backupDir, fs.constants.O_RDONLY)
      try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
    } catch (error) { try { fs.closeSync(handle) } catch {}; try { fs.unlinkSync(temporary) } catch {}; throw error }
    return { path: filename, sha256: crypto.createHash('sha256').update(complete).digest('hex') }
  }

  validateMigrationBackupPrior(prior) {
    const parsers = {
      persona_settings: parsePersonaSettings,
      llm_settings: parseLlmSettings,
      ollama_settings: parseOllamaSettings,
      product_preferences: parseProductPreferences,
    }
    const keys = Object.keys(parsers)
    if (!prior || typeof prior !== 'object' || Array.isArray(prior) || Object.keys(prior).length !== keys.length
      || keys.some(key => !Object.prototype.hasOwnProperty.call(prior, key))) {
      throw Object.assign(new Error('Current settings are not safe to back up'), { migrationRecovery: true })
    }
    for (const key of keys) {
      const raw = prior[key]
      if (raw === null) continue
      if (typeof raw !== 'string') throw Object.assign(new Error(`Current ${key} value is not safe to back up`), { migrationRecovery: true })
      let parsed
      try { parsed = JSON.parse(raw) } catch { throw Object.assign(new Error(`Current ${key} value is not valid JSON`), { migrationRecovery: true }) }
      const normalized = parsers[key](parsed)
      if (!normalized || JSON.stringify(normalized) !== JSON.stringify(parsed)
        || /(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|-----BEGIN [^-]+ PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._~-]{16,})/.test(JSON.stringify(parsed))) {
        throw Object.assign(new Error(`Current ${key} value is not safe to back up`), { migrationRecovery: true })
      }
    }
  }

  readVerifiedMigrationBackup(record) {
    const bytes = readMigrationFile(record.backupPath)
    const expected = Buffer.from(String(record.backupSha256 || ''), 'hex')
    const actual = crypto.createHash('sha256').update(bytes).digest()
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) throw new Error('Migration backup integrity check failed')
    let backup
    try { backup = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('Migration backup is invalid') }
    const embedded = String(backup.sha256 || '')
    const payload = { ...backup }; delete payload.sha256
    const payloadHash = crypto.createHash('sha256').update(Buffer.from(JSON.stringify(payload) + '\n')).digest('hex')
    const embeddedBytes = Buffer.from(embedded, 'hex'); const payloadBytes = Buffer.from(payloadHash, 'hex')
    if (embeddedBytes.length !== payloadBytes.length || !crypto.timingSafeEqual(embeddedBytes, payloadBytes)) throw new Error('Migration backup integrity check failed')
    if (backup.scope !== SETTINGS_PERSONA_SCOPE || backup.previewId !== record.previewId || !backup.prior || Object.keys(backup.prior).some(key => !['persona_settings', 'llm_settings', 'ollama_settings', 'product_preferences'].includes(key))) throw new Error('Invalid migration backup')
    return backup
  }

  async settingsPersonaConfirm(req, res) {
    this.authorizeNative(req)
    const body = await readBody(req, 16 * 1024)
    if (body?.scope !== SETTINGS_PERSONA_SCOPE) return json(res, 400, { error: 'Invalid migration scope' })
    const persisted = this.settingsPersonaCutovers.get(body.previewId)
    const preview = this.continuityPreviews.get(body.previewId) || this.cutoverPreview(persisted)
    if (!preview) return json(res, 404, { error: 'Migration preview expired' })
    const effectivePreview = preview || this.cutoverPreview(persisted)
    const existing = persisted
    if (this.migrationOwner || existing?.state === 'applying') return json(res, 409, { error: 'Settings migration is committing' })
    if (existing && ['applied', 'rolled-back', 'needs-recovery'].includes(existing.state)) return json(res, 200, this.settingsPersonaPublic(existing))
    if (existing?.state === 'confirmed' && existing.token) return json(res, 200, this.settingsPersonaPublic(existing))
    const input = this.readSettingsPersonaInput(effectivePreview)
    const record = existing || { previewId: effectivePreview.previewId, manifest: effectivePreview.manifest, manifestHash: input.manifestHash, scope: SETTINGS_PERSONA_SCOPE, targetRuntime: this.runtimeId, state: 'previewed' }
    record.state = 'confirmed'; record.confirmedAt = Date.now(); record.expiresAt = Date.now() + SETTINGS_PERSONA_TOKEN_TTL_MS
    record.token = record.token || crypto.randomBytes(32).toString('hex')
    record.input = input
    this.settingsPersonaCutovers.set(effectivePreview.previewId, record)
    this.persistSettingsPersonaCutover(record)
    return json(res, 200, this.settingsPersonaPublic(record))
  }

  settingsPersonaPublic(record) {
    const output = {
      previewId: record.previewId,
      scope: record.scope,
      targetRuntime: record.targetRuntime,
      state: record.state,
      manifestHash: record.manifestHash,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      ...(record.state === 'confirmed' && record.token ? { confirmationToken: record.token } : {}),
      ...(record.state === 'confirmed' && !record.token ? { requiresReconfirmation: true } : {}),
      ...(record.state === 'needs-recovery' ? { manualRecoveryRequired: true } : {}),
      ...(record.result || {}),
    }
    return output
  }

  async settingsPersonaApply(req, res) {
    this.authorizeNative(req)
    const body = await readBody(req, 16 * 1024)
    const record = this.settingsPersonaCutovers.get(body?.previewId)
    if (!record) return json(res, 404, { error: 'Migration preview expired' })
    if (record.state === 'applied' || record.state === 'rolled-back') {
      if (body.confirmationToken !== undefined) return json(res, 403, { error: 'Confirmation token already consumed' })
      return json(res, 200, this.settingsPersonaPublic(record))
    }
    const supplied = typeof body.confirmationToken === 'string' ? Buffer.from(body.confirmationToken) : null
    const expected = record.token ? Buffer.from(record.token) : null
    if (record.state !== 'confirmed' || !supplied || !expected || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected) || Date.now() > record.expiresAt) return json(res, 403, { error: 'Valid native confirmation token required' })
    const priorHold = this.migrationHold
    const allowRecovery = record.state === 'needs-recovery' && this.migrationRecoveryScope === SETTINGS_PERSONA_SCOPE
    if (!this.claimMigrationOwner(SETTINGS_PERSONA_SCOPE, allowRecovery)) return json(res, 409, { error: 'Another migration is committing' })
    let prior = null
    try {
      record.token = null
      record.consumedAt = Date.now()
      record.state = 'applying'
      this.persistSettingsPersonaCutover(record)
      this.stopEmailInboundPolling()
      for (const controller of this.generationControllers.values()) controller.abort()
      await this.drainActiveOperations()
      const input = this.readSettingsPersonaInput(this.cutoverPreview(record))
      if (input.manifestHash !== record.manifestHash) throw Object.assign(new Error('Preview changed after confirmation'), { statusCode: 409 })
      prior = Object.fromEntries(['persona_settings', 'llm_settings', 'ollama_settings', 'product_preferences'].map(key => [key, this.getState(key, null)]))
      this.validateMigrationBackupPrior(prior)
      const backup = this.writeMigrationBackup(record, prior)
      record.backupPath = backup.path
      record.backupSha256 = backup.sha256
      this.persistSettingsPersonaCutover(record)
      const finalInput = this.readSettingsPersonaInput(this.cutoverPreview(record))
      if (finalInput.manifestHash !== record.manifestHash || JSON.stringify(finalInput) !== JSON.stringify(input)) throw Object.assign(new Error('Source or staged migration changed before commit'), { statusCode: 409 })
      this.assertMigrationCommitReady()
      this.db.transaction(() => {
        this.setState('persona_settings', JSON.stringify(finalInput.persona))
        this.setState('llm_settings', JSON.stringify(finalInput.llm))
        this.setState('ollama_settings', JSON.stringify(finalInput.ollama))
        this.setState('product_preferences', JSON.stringify(finalInput.preferences))
      })()
      record.state = 'applied'; record.appliedAt = Date.now()
      record.result = { backupSha256: backup.sha256, liveDataChanged: true }
      this.persistSettingsPersonaCutover(record)
      this.releaseMigrationOwner(SETTINGS_PERSONA_SCOPE, priorHold, allowRecovery)
      return json(res, 200, this.settingsPersonaPublic(record))
    } catch (error) {
      const keys = ['persona_settings', 'llm_settings', 'ollama_settings', 'product_preferences']
      const restored = !prior || keys.every(key => this.getState(key, null) === prior[key])
      const requiresRecovery = error?.migrationRecovery === true
      record.state = requiresRecovery || !restored ? 'needs-recovery' : 'rolled-back'; record.error = error.message
      try { this.persistSettingsPersonaCutover(record) } catch {}
      if (requiresRecovery || !restored) {
        this.migrationOwner = false
        this.migrationScope = null
        this.markMigrationRecovery(SETTINGS_PERSONA_SCOPE)
      } else {
        this.releaseMigrationOwner(SETTINGS_PERSONA_SCOPE, priorHold)
      }
      return json(res, error.statusCode || 500, { ...this.settingsPersonaPublic(record), error: error.message })
    }
  }

  async settingsPersonaRollback(req, res) {
    this.authorizeNative(req)
    const body = await readBody(req, 16 * 1024)
    const record = this.settingsPersonaCutovers.get(body?.previewId)
    if (!record || !record.backupPath) return json(res, 404, { error: 'Migration backup not found' })
    const priorHold = this.migrationHold
    const allowRecovery = record.state === 'needs-recovery' && this.migrationRecoveryScope === SETTINGS_PERSONA_SCOPE
    if (!this.claimMigrationOwner(SETTINGS_PERSONA_SCOPE, allowRecovery)) return json(res, 409, { error: 'Another migration is committing' })
    try {
      const backup = this.readVerifiedMigrationBackup(record)
      await this.drainActiveOperations()
      this.assertMigrationCommitReady()
      this.db.transaction(() => Object.entries(backup.prior).forEach(([key, value]) => value === null ? this.db.prepare('DELETE FROM agent_state WHERE key = ?').run(key) : this.setState(key, value)))()
      record.state = 'rolled-back'; record.rolledBackAt = Date.now(); record.result = { liveDataChanged: true }
      this.persistSettingsPersonaCutover(record)
      this.releaseMigrationOwner(SETTINGS_PERSONA_SCOPE, priorHold, allowRecovery)
      return json(res, 200, this.settingsPersonaPublic(record))
    } catch (error) {
      record.state = 'needs-recovery'; record.error = error.message
      try { this.persistSettingsPersonaCutover(record) } catch {}
      this.migrationOwner = false
      this.migrationScope = null
      this.markMigrationRecovery(SETTINGS_PERSONA_SCOPE)
      return json(res, 500, { ...this.settingsPersonaPublic(record), error: error.message })
    }
  }

  chatHistoryStagedPath(preview) {
    if (!preview?.previewId || !preview.manifest?.entries?.some(entry => entry.id === 'electron-chat-history')) {
      throw Object.assign(new Error('Chat-history store is missing from preview'), { statusCode: 409 })
    }
    const stagingRoot = path.join(this.dataDir, '.migration-staging', preview.previewId)
    try {
      continuityMigration.assertNoSqliteSidecars(preview.manifest.sourceRoot)
      continuityMigration.assertNoSqliteSidecars(stagingRoot, 'electron-chat-history')
    } catch (error) {
      throw Object.assign(new Error(error.message), { statusCode: error.statusCode || 409 })
    }
    const manifestPath = path.join(stagingRoot, 'manifest.json')
    let persisted
    try { persisted = JSON.parse(readMigrationFile(manifestPath).toString('utf8')) } catch {
      throw Object.assign(new Error('Staged migration manifest is unavailable'), { statusCode: 409 })
    }
    if (persisted.previewId !== preview.previewId || JSON.stringify(persisted.manifest) !== JSON.stringify(preview.manifest)) {
      throw Object.assign(new Error('Staged migration manifest does not match preview'), { statusCode: 409 })
    }
    const entry = preview.manifest.entries.find(item => item.id === 'electron-chat-history')
    const file = path.join(stagingRoot, entry.id)
    let bytes
    try { bytes = readMigrationFile(file) } catch { throw Object.assign(new Error('Staged chat-history file is unavailable'), { statusCode: 409 }) }
    if (bytes.length !== entry.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      throw Object.assign(new Error('Staged chat-history file changed'), { statusCode: 409 })
    }
    if (bytes.length > CHAT_HISTORY_MAX_SOURCE_BYTES) throw Object.assign(new Error('Chat-history store too large'), { statusCode: 413 })
    const sourcePath = path.join(preview.manifest.sourceRoot, 'chat_history.v2.db')
    let sourceBytes
    try { sourceBytes = readMigrationFile(sourcePath) } catch { throw Object.assign(new Error('Electron chat-history source changed or is unavailable'), { statusCode: 409 }) }
    if (sourceBytes.length !== entry.byteSize || crypto.createHash('sha256').update(sourceBytes).digest('hex') !== entry.sha256) {
      throw Object.assign(new Error('Electron chat-history source changed after preview'), { statusCode: 409 })
    }
    return { file, bytes, sourceHash: entry.sha256 }
  }

  createChatHistorySnapshot(bytes) {
    const snapshotDir = fs.mkdtempSync(path.join(this.dataDir, '.chat-history-snapshot-'))
    let handle
    let snapshotPath
    try {
      fs.chmodSync(snapshotDir, 0o700)
      snapshotPath = path.join(snapshotDir, 'chat_history.v2.db')
      handle = fs.openSync(snapshotPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
      fs.writeFileSync(handle, bytes)
      fs.fsyncSync(handle)
      fs.closeSync(handle)
      handle = undefined
      fs.chmodSync(snapshotPath, 0o400)
      // better-sqlite3 accepts a pathname, so keep the verified copy in a
      // private, non-writable directory for the entire SQLite read.
      fs.chmodSync(snapshotDir, 0o500)
      let cleaned = false
      return {
        path: snapshotPath,
        cleanup: () => {
          if (cleaned) return
          cleaned = true
          try { fs.chmodSync(snapshotDir, 0o700) } catch {}
          try { fs.unlinkSync(snapshotPath) } catch {}
          try { fs.rmdirSync(snapshotDir) } catch {}
        },
      }
    } catch (error) {
      if (handle !== undefined) {
        try { fs.closeSync(handle) } catch {}
      }
      try { fs.chmodSync(snapshotDir, 0o700) } catch {}
      try { if (snapshotPath) fs.unlinkSync(snapshotPath) } catch {}
      try { fs.rmdirSync(snapshotDir) } catch {}
      throw error
    }
  }

  readChatHistoryInput(preview) {
    const staged = this.chatHistoryStagedPath(preview)
    const snapshot = this.createChatHistorySnapshot(staged.bytes)
    let sourceDb
    const parseJson = (raw, label) => {
      if (raw === null || raw === undefined || raw === '') return null
      if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > CHAT_HISTORY_MAX_METADATA_BYTES) throw Object.assign(new Error(`${label} is too large`), { statusCode: 413 })
      let value
      try { value = parseJsonWithoutDuplicateKeys(Buffer.from(raw), label) } catch { throw Object.assign(new Error(`Invalid ${label}`), { statusCode: 400 }) }
      const walk = (item, location = '$') => {
        if (Array.isArray(item)) return item.forEach((child, index) => walk(child, `${location}[${index}]`))
        if (!item || typeof item !== 'object') return
        for (const [key, child] of Object.entries(item)) {
          if (continuityMigration.isSecretMigrationKey(key)) throw Object.assign(new Error(`Secret field refused: ${label}.${key}`), { statusCode: 400 })
          walk(child, `${location}.${key}`)
        }
      }
      walk(value)
      return value
    }
    const bounded = (value, max, allowEmpty = false) => validBoundedText(value, max, allowEmpty) && Buffer.byteLength(value, 'utf8') <= max * 4
    try {
      // Recheck the copy immediately before opening SQLite. Any replacement or
      // reparse is rejected before better-sqlite3 can parse unverified bytes.
      const snapshotBytes = readMigrationFile(snapshot.path)
      if (!snapshotBytes.equals(staged.bytes)) throw Object.assign(new Error('Immutable chat-history snapshot changed'), { statusCode: 409 })
      sourceDb = new Database(snapshot.path, { readonly: true, fileMustExist: true })
      const integrity = sourceDb.pragma('integrity_check')
      if (!Array.isArray(integrity) || integrity.some(row => row.integrity_check !== 'ok')) throw Object.assign(new Error('SQLite integrity check failed'), { statusCode: 400 })
      const tables = new Map(sourceDb.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('sessions','session_messages')").all().map(row => [row.name, row.sql]))
      if (!tables.has('sessions') || !tables.has('session_messages')) throw Object.assign(new Error('Invalid chat-history schema'), { statusCode: 400 })
      const required = {
        sessions: ['id', 'title', 'createdAt', 'updatedAt', 'channel', 'contact_id', 'status', 'workspacePath', 'topic', 'extra_data'],
        session_messages: ['id', 'sessionId', 'role', 'content', 'timestamp', 'thought', 'toolCalls', 'actions', 'findings', 'plan'],
      }
      for (const [table, columns] of Object.entries(required)) {
        const actual = new Set(sourceDb.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name))
        if (columns.some(column => !actual.has(column))) throw Object.assign(new Error('Invalid chat-history schema'), { statusCode: 400 })
      }
      const sessions = sourceDb.prepare('SELECT id,title,createdAt,updatedAt,channel,contact_id,status,workspacePath,topic,extra_data FROM sessions ORDER BY id').all()
      const messages = sourceDb.prepare('SELECT id,sessionId,role,content,timestamp,thought,toolCalls,actions,findings,plan FROM session_messages ORDER BY sessionId,timestamp,id').all()
      if (sessions.length > CHAT_HISTORY_MAX_SESSIONS || messages.length > CHAT_HISTORY_MAX_MESSAGES) throw Object.assign(new Error('Chat-history row limit exceeded'), { statusCode: 413 })
      const sessionIds = new Set()
      const messageIds = new Set()
      const allowedChannels = new Set(['whatsapp', 'email', 'telegram', 'instagram', 'twitter', 'messenger', 'web'])
      const allowedTopics = new Set(['Product Queries', 'Order Status', 'Returns/Refunds', 'Technical Support', 'Other'])
      const normalizedSessions = sessions.map(row => {
        if (sessionIds.has(row.id) || !this.validChatId(row.id) || !this.validChatTitle(row.title)
          || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0 || !Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0
          || (row.channel !== null && (!bounded(row.channel, MAX_CHAT_CHANNEL_LENGTH) || !allowedChannels.has(row.channel)))
          || (row.contact_id !== null && !bounded(row.contact_id, MAX_CHAT_CONTACT_LENGTH))
          || (row.status !== null && !['active', 'resolved'].includes(row.status))
          || (row.workspacePath !== null && !bounded(row.workspacePath, 1024))
          || (row.topic !== null && (!bounded(row.topic, 64) || !allowedTopics.has(row.topic)))) throw Object.assign(new Error('Invalid chat-history session'), { statusCode: 400 })
        sessionIds.add(row.id)
        const metadata = parseJson(row.extra_data, 'session metadata')
        if (metadata !== null && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) throw Object.assign(new Error('Invalid session metadata'), { statusCode: 400 })
        return { id: row.id, title: row.title, workspace_path: row.workspacePath, status: row.status || 'active', channel: row.channel, contact_id: row.contact_id, thread_id: null, topic: row.topic, metadata: metadata ? JSON.stringify(metadata) : null, created_at: row.createdAt, updated_at: row.updatedAt }
      })
      const normalizedMessages = messages.map(row => {
        if (messageIds.has(row.id) || !this.validChatId(row.id) || !sessionIds.has(row.sessionId) || !['user', 'assistant', 'system'].includes(row.role)
          || (row.content !== null && !bounded(row.content, MAX_CHAT_CONTENT_LENGTH, true)) || !Number.isSafeInteger(row.timestamp) || row.timestamp < 0) throw Object.assign(new Error('Invalid chat-history message'), { statusCode: 400 })
        messageIds.add(row.id)
        const metadataValues = {}
        for (const [key, value] of [['thought', row.thought], ['toolCalls', row.toolCalls], ['actions', row.actions], ['findings', row.findings], ['plan', row.plan]]) {
          const parsed = key === 'thought'
            ? (value === null || value === undefined || value === '' ? null : (bounded(value, MAX_CHAT_CONTENT_LENGTH, true) ? value : (() => { throw Object.assign(new Error('Message thought is too large'), { statusCode: 413 }) })()))
            : parseJson(value, `message ${key}`)
          if (parsed !== null) metadataValues[key] = parsed
        }
        const metadata = Object.keys(metadataValues).length ? JSON.stringify(metadataValues) : null
        if (metadata && Buffer.byteLength(metadata, 'utf8') > CHAT_HISTORY_MAX_METADATA_BYTES) throw Object.assign(new Error('Message metadata is too large'), { statusCode: 413 })
        return { session_id: row.sessionId, message_id: row.id, role: row.role, content: row.content || '', attachments: null, metadata, created_at: row.timestamp }
      })
      return { ...staged, sessions: normalizedSessions, messages: normalizedMessages }
    } finally {
      try { sourceDb?.close() } finally { snapshot.cleanup() }
    }
  }

  async settingsPersonaStatus(req, res) {
    this.authorizeNative(req)
    const body = new URL(req.url, this.origin).searchParams
    const record = this.settingsPersonaCutovers.get(body.get('previewId'))
    if (!record) return json(res, 404, { error: 'Migration preview not found' })
    return json(res, 200, this.settingsPersonaPublic(record))
  }

  chatHistoryPublic(record) {
    return {
      previewId: record.previewId,
      scope: record.scope,
      targetRuntime: record.targetRuntime,
      state: record.state,
      manifestHash: record.manifestHash,
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      ...(record.state === 'confirmed' && record.token ? { confirmationToken: record.token } : {}),
      ...(record.state === 'confirmed' && !record.token ? { requiresReconfirmation: true } : {}),
      ...(record.state === 'needs-recovery' ? { manualRecoveryRequired: true } : {}),
      ...(record.result || {}),
    }
  }

  persistChatHistoryCutover(record) {
    this.db.prepare(`INSERT INTO chat_history_cutovers
      (preview_id,manifest,manifest_hash,scope,target_runtime,source_hash,state,confirmed_at,expires_at,token_hash,consumed_at,backup_path,backup_sha256,result,error,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(preview_id) DO UPDATE SET manifest=excluded.manifest,manifest_hash=excluded.manifest_hash,scope=excluded.scope,target_runtime=excluded.target_runtime,source_hash=excluded.source_hash,state=excluded.state,confirmed_at=excluded.confirmed_at,expires_at=excluded.expires_at,token_hash=excluded.token_hash,consumed_at=excluded.consumed_at,backup_path=excluded.backup_path,backup_sha256=excluded.backup_sha256,result=excluded.result,error=excluded.error,updated_at=excluded.updated_at`).run(
      record.previewId, JSON.stringify(record.manifest), record.manifestHash, record.scope, record.targetRuntime, record.sourceHash || null, record.state,
      record.confirmedAt || null, record.expiresAt || null, record.token ? crypto.createHash('sha256').update(record.token).digest('hex') : null,
      record.consumedAt || null, record.backupPath || null, record.backupSha256 || null, record.result ? JSON.stringify(record.result) : null, record.error || null, Date.now())
  }

  restoreChatHistoryCutovers() {
    for (const row of this.db.prepare('SELECT * FROM chat_history_cutovers').all()) {
      let manifest; let result
      try { manifest = JSON.parse(row.manifest); result = row.result ? JSON.parse(row.result) : undefined } catch { continue }
      const record = { previewId: row.preview_id, manifest, manifestHash: row.manifest_hash, scope: row.scope, targetRuntime: row.target_runtime, sourceHash: row.source_hash || undefined, state: row.state, confirmedAt: row.confirmed_at || undefined, expiresAt: row.expires_at || undefined, consumedAt: row.consumed_at || undefined, backupPath: row.backup_path || undefined, backupSha256: row.backup_sha256 || undefined, result, error: row.error || undefined }
      if (record.state === 'applying') {
        record.state = 'needs-recovery'
        record.error = record.backupPath ? 'Chat-history cutover interrupted after backup creation; manual rollback required' : 'Chat-history cutover interrupted before backup reference; manual recovery required'
        this.persistChatHistoryCutover(record)
      }
      this.chatHistoryCutovers.set(record.previewId, record)
      if (record.state === 'needs-recovery') {
        this.markMigrationRecovery(CHAT_HISTORY_SCOPE)
      }
    }
  }

  async chatHistoryConfirm(req, res) {
    this.authorizeNative(req)
    const body = await readBody(req, 16 * 1024)
    if (body?.scope !== CHAT_HISTORY_SCOPE) return json(res, 400, { error: 'Invalid migration scope' })
    const persisted = this.chatHistoryCutovers.get(body.previewId)
    const preview = this.continuityPreviews.get(body.previewId) || this.cutoverPreview(persisted)
    if (!preview) return json(res, 404, { error: 'Migration preview expired' })
    const existing = persisted
    if (this.migrationOwner || existing?.state === 'applying') return json(res, 409, { error: 'Chat-history migration is committing' })
    if (existing?.state === 'applied' || existing?.state === 'needs-recovery' || existing?.state === 'rolled-back') return json(res, 200, this.chatHistoryPublic(existing))
    const input = this.readChatHistoryInput(preview)
    const record = existing || { previewId: preview.previewId, manifest: preview.manifest, manifestHash: this.migrationManifestHash(preview.manifest), scope: CHAT_HISTORY_SCOPE, targetRuntime: this.runtimeId, state: 'previewed' }
    record.state = 'confirmed'; record.confirmedAt = Date.now(); record.expiresAt = Date.now() + CHAT_HISTORY_TOKEN_TTL_MS
    record.token = crypto.randomBytes(32).toString('hex'); record.sourceHash = input.sourceHash
    this.chatHistoryCutovers.set(preview.previewId, record)
    this.persistChatHistoryCutover(record)
    return json(res, 200, this.chatHistoryPublic(record))
  }

  async chatHistoryApply(req, res) {
    this.authorizeNative(req)
    const body = await readBody(req, 16 * 1024)
    const record = this.chatHistoryCutovers.get(body?.previewId)
    if (!record) return json(res, 404, { error: 'Migration preview expired' })
    if (record.state === 'applied' || record.state === 'rolled-back') {
      if (body.confirmationToken !== undefined) return json(res, 403, { error: 'Confirmation token already consumed' })
      return json(res, 200, this.chatHistoryPublic(record))
    }
    const supplied = typeof body.confirmationToken === 'string' ? Buffer.from(body.confirmationToken) : null
    const expected = record.token ? Buffer.from(record.token) : null
    if (record.state !== 'confirmed' || !supplied || !expected || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected) || Date.now() > record.expiresAt) return json(res, 403, { error: 'Valid native confirmation token required' })
    const priorHold = this.migrationHold
    const allowRecovery = record.state === 'needs-recovery' && this.migrationRecoveryScope === CHAT_HISTORY_SCOPE
    if (!this.claimMigrationOwner(CHAT_HISTORY_SCOPE, allowRecovery)) return json(res, 409, { error: 'Another migration is committing' })
    let committed = false
    try {
      record.token = null; record.consumedAt = Date.now(); record.state = 'applying'; this.persistChatHistoryCutover(record)
      this.stopEmailInboundPolling()
      for (const controller of this.generationControllers.values()) controller.abort()
      await this.drainActiveOperations()
      const input = this.readChatHistoryInput(this.cutoverPreview(record))
      if (this.migrationManifestHash(record.manifest) !== record.manifestHash || input.sourceHash !== record.sourceHash) throw Object.assign(new Error('Source or staged chat-history changed before commit'), { statusCode: 409 })
      this.assertMigrationCommitReady()
      const sessionSelect = this.db.prepare('SELECT id,title,workspace_path,status,channel,contact_id,thread_id,topic,metadata,created_at,updated_at FROM chat_sessions WHERE id = ?')
      const messageSelect = this.db.prepare('SELECT session_id,message_id,role,content,attachments,metadata,created_at FROM chat_messages WHERE session_id = ? AND message_id = ?')
      const insertedSessions = []; const insertedMessages = []
      const existingSessions = []; const existingMessages = []
      for (const row of input.sessions) {
        const existing = sessionSelect.get(row.id)
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(row)) throw Object.assign(new Error(`Conflicting existing session id: ${row.id}`), { statusCode: 409 })
          existingSessions.push(existing)
        } else insertedSessions.push(row)
      }
      for (const row of input.messages) {
        const existing = messageSelect.get(row.session_id, row.message_id)
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(row)) throw Object.assign(new Error(`Conflicting existing message id: ${row.message_id}`), { statusCode: 409 })
          existingMessages.push(existing)
        } else insertedMessages.push(row)
      }
      const backupDir = path.join(this.dataDir, 'migration-backups')
      fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 }); fs.chmodSync(backupDir, 0o700)
      const backupPath = path.join(backupDir, `${CHAT_HISTORY_SCOPE}-${record.previewId}-${crypto.randomUUID()}.json`)
      const backupPayload = { version: 1, scope: CHAT_HISTORY_SCOPE, previewId: record.previewId, manifest: record.manifest, previewHash: record.manifestHash, sourceHash: input.sourceHash, existingSessions, existingMessages, insertedSessions, insertedMessages }
      const backupBytes = Buffer.from(JSON.stringify(backupPayload) + '\n')
      const backupHash = crypto.createHash('sha256').update(backupBytes).digest('hex')
      const completeBackup = Buffer.from(JSON.stringify({ ...backupPayload, sha256: backupHash }) + '\n')
      writePrivateFileAtomically(backupPath, completeBackup)
      record.backupPath = backupPath; record.backupSha256 = crypto.createHash('sha256').update(completeBackup).digest('hex'); this.persistChatHistoryCutover(record)
      const result = this.db.transaction(() => {
        for (const row of insertedSessions) this.db.prepare('INSERT INTO chat_sessions(id,title,workspace_path,status,channel,contact_id,thread_id,topic,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(row.id, row.title, row.workspace_path, row.status, row.channel, row.contact_id, row.thread_id, row.topic, row.metadata, row.created_at, row.updated_at)
        for (const row of insertedMessages) this.db.prepare('INSERT INTO chat_messages(session_id,message_id,role,content,attachments,metadata,created_at) VALUES (?,?,?,?,?,?,?)').run(row.session_id, row.message_id, row.role, row.content, row.attachments, row.metadata, row.created_at)
        return { sessionsImported: insertedSessions.length, messagesImported: insertedMessages.length, sessionsAlreadyPresent: existingSessions.length, messagesAlreadyPresent: existingMessages.length, backupSha256: record.backupSha256, liveDataChanged: Boolean(insertedSessions.length || insertedMessages.length) }
      })()
      committed = true
      record.state = 'applied'; record.appliedAt = Date.now(); record.result = result; this.persistChatHistoryCutover(record)
      this.releaseMigrationOwner(CHAT_HISTORY_SCOPE, priorHold, allowRecovery)
      return json(res, 200, this.chatHistoryPublic(record))
    } catch (error) {
      if (committed) {
        record.state = 'needs-recovery'; record.error = error.message
        try { this.persistChatHistoryCutover(record) } catch {}
        this.migrationOwner = false; this.migrationScope = null; this.markMigrationRecovery(CHAT_HISTORY_SCOPE)
        return json(res, error.statusCode || 500, { ...this.chatHistoryPublic(record), error: error.message })
      }
      record.state = 'rolled-back'; record.error = error.message; try { this.persistChatHistoryCutover(record) } catch {}
      this.releaseMigrationOwner(CHAT_HISTORY_SCOPE, priorHold)
      return json(res, error.statusCode || 500, { ...this.chatHistoryPublic(record), error: error.message })
    }
  }

  async chatHistoryRollback(req, res) {
    this.authorizeNative(req)
    const body = await readBody(req, 16 * 1024)
    const record = this.chatHistoryCutovers.get(body?.previewId)
    if (!record || !record.backupPath) return json(res, 404, { error: 'Migration backup not found' })
    if (record.state === 'rolled-back') return json(res, 200, this.chatHistoryPublic(record))
    const priorHold = this.migrationHold
    const allowRecovery = record.state === 'needs-recovery' && this.migrationRecoveryScope === CHAT_HISTORY_SCOPE
    if (!this.claimMigrationOwner(CHAT_HISTORY_SCOPE, allowRecovery)) return json(res, 409, { error: 'Another migration is committing' })
    let rollbackCommitted = false
    try {
      const bytes = readMigrationFile(record.backupPath)
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== record.backupSha256) throw new Error('Migration backup integrity check failed')
      const backup = JSON.parse(bytes.toString('utf8'))
      const embedded = { ...backup }; delete embedded.sha256
      if (backup.scope !== CHAT_HISTORY_SCOPE || backup.previewId !== record.previewId || crypto.createHash('sha256').update(Buffer.from(JSON.stringify(embedded) + '\n')).digest('hex') !== backup.sha256) throw new Error('Invalid migration backup')
      await this.drainActiveOperations(); this.assertMigrationCommitReady()
      const sessionSelect = this.db.prepare('SELECT id,title,workspace_path,status,channel,contact_id,thread_id,topic,metadata,created_at,updated_at FROM chat_sessions WHERE id = ?')
      const messageSelect = this.db.prepare('SELECT session_id,message_id,role,content,attachments,metadata,created_at FROM chat_messages WHERE session_id = ? AND message_id = ?')
      const importedRowsAbsent = backup.insertedMessages.every(row => !messageSelect.get(row.session_id, row.message_id))
        && backup.insertedSessions.every(row => !sessionSelect.get(row.id))
      if (!importedRowsAbsent) {
        for (const row of backup.insertedMessages) if (JSON.stringify(messageSelect.get(row.session_id, row.message_id)) !== JSON.stringify(row)) throw new Error('Imported chat-history changed; manual recovery required')
        for (const row of backup.insertedSessions) {
          if (JSON.stringify(sessionSelect.get(row.id)) !== JSON.stringify(row)) throw new Error('Imported chat-history changed; manual recovery required')
          const expectedMessages = backup.insertedMessages.filter(message => message.session_id === row.id)
          const actualMessages = this.db.prepare('SELECT session_id,message_id,role,content,attachments,metadata,created_at FROM chat_messages WHERE session_id = ?').all(row.id)
          if (actualMessages.length !== expectedMessages.length || actualMessages.some(actual => {
            const expected = expectedMessages.find(message => message.message_id === actual.message_id)
            return !expected || JSON.stringify(actual) !== JSON.stringify(expected)
          })) throw new Error('Imported chat-history changed; manual recovery required')
        }
        this.db.transaction(() => {
          for (const row of backup.insertedMessages) this.db.prepare('DELETE FROM chat_messages WHERE session_id = ? AND message_id = ?').run(row.session_id, row.message_id)
          for (const row of backup.insertedSessions) this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(row.id)
        })()
        rollbackCommitted = true
      }
      record.state = 'rolled-back'; record.rolledBackAt = Date.now(); record.result = { ...(record.result || {}), liveDataChanged: Boolean(backup.insertedSessions.length || backup.insertedMessages.length) }; this.persistChatHistoryCutover(record)
      this.releaseMigrationOwner(CHAT_HISTORY_SCOPE, priorHold, allowRecovery)
      return json(res, 200, this.chatHistoryPublic(record))
    } catch (error) {
      record.state = 'needs-recovery'; record.error = rollbackCommitted ? `Rollback data deletion committed; ${error.message}` : error.message; try { this.persistChatHistoryCutover(record) } catch {}; this.migrationOwner = false; this.migrationScope = null; this.markMigrationRecovery(CHAT_HISTORY_SCOPE)
      return json(res, 500, { ...this.chatHistoryPublic(record), error: error.message })
    }
  }

  async chatHistoryStatus(req, res) {
    this.authorizeNative(req)
    const previewId = new URL(req.url, this.origin).searchParams.get('previewId')
    const record = this.chatHistoryCutovers.get(previewId)
    if (!record) return json(res, 404, { error: 'Migration preview not found' })
    return json(res, 200, this.chatHistoryPublic(record))
  }

  async llmSettings(req, res) {
    this.authorize(req, { mutation: req.method === 'PUT' })
    if (req.method === 'GET') {
      let stored = null
      try { stored = JSON.parse(this.getState('llm_settings', 'null')) } catch {}
      return json(res, 200, parseLlmSettings(stored) || LLM_SETTINGS_DEFAULTS)
    }
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
      const body = await readBody(req, 16 * 1024)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'geminiModel,openaiModel,openrouterModel,preferredProvider') return json(res, 400, { error: 'Invalid LLM settings' })
      const settings = parseLlmSettings(body)
      if (!settings) return json(res, 400, { error: 'Invalid LLM settings' })
      this.setState('llm_settings', JSON.stringify(settings))
      return json(res, 200, settings)
    } finally {
      releaseOperation()
    }
  }

  async personaSettings(req, res) {
    this.authorize(req, { mutation: req.method === 'PUT' })
    if (req.method === 'GET') {
      let stored = null
      try { stored = JSON.parse(this.getState('persona_settings', 'null')) } catch {}
      return json(res, 200, parsePersonaSettings(stored) || PERSONA_DEFAULTS)
    }
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
      const body = await readBody(req, 32 * 1024)
      const settings = parsePersonaSettings(body)
      if (!settings) return json(res, 400, { error: 'Invalid persona settings' })
      this.setState('persona_settings', JSON.stringify(settings))
      return json(res, 200, settings)
    } finally {
      releaseOperation()
    }
  }

  async productPreferences(req, res) {
    this.authorize(req, { mutation: req.method === 'PUT' })
    if (req.method === 'GET') {
      let stored = null
      try { stored = JSON.parse(this.getState('product_preferences', 'null')) } catch {}
      return json(res, 200, parseProductPreferences(stored) || PRODUCT_PREFERENCES_DEFAULTS)
    }
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
      const body = await readBody(req, 16 * 1024)
      const preferences = parseProductPreferences(body)
      if (!preferences) return json(res, 400, { error: 'Invalid product preferences' })
      this.setState('product_preferences', JSON.stringify(preferences))
      return json(res, 200, preferences)
    } finally {
      releaseOperation()
    }
  }

  async emailSettings(req, res) {
    this.authorize(req, { mutation: req.method === 'PUT' })
    if (req.method === 'GET') {
      let stored = null
      try { stored = JSON.parse(this.getState('email_settings', 'null')) } catch {}
      return json(res, 200, parseEmailSettings(stored) || EMAIL_SETTINGS_DEFAULTS)
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 16 * 1024)
    const settings = parseEmailSettings(body)
    if (!settings) return json(res, 400, { error: 'Invalid email settings' })
    this.setState('email_settings', JSON.stringify(settings))
    this.stopEmailInboundPolling()
    if (settings.enabled) this.startEmailInboundPolling()
    return json(res, 200, settings)
  }

  async emailOAuthStatus(req, res) {
    this.authorize(req)
    await this.gmailOAuth.initialize()
    return json(res, 200, this.gmailOAuth.getStatus())
  }

  async emailOAuthStart(req, res) {
    this.authorize(req, { mutation: true })
    try {
      return json(res, 200, await this.gmailOAuth.start(this.origin))
    } catch {
      return json(res, 409, { error: 'Google OAuth is not configured for this local agent' })
    }
  }

  async emailOAuthSignOut(req, res) {
    this.authorize(req, { mutation: true })
    try {
      await this.gmailOAuth.signOut()
      return json(res, 200, { success: true })
    } catch {
      return json(res, 503, { success: false, error: 'Google OAuth disconnect failed' })
    }
  }

  async emailOAuthCallback(req, res, url) {
    try {
      await this.gmailOAuth.complete({
        code: url.searchParams.get('code'),
        state: url.searchParams.get('state'),
        error: url.searchParams.get('error'),
      })
      res.statusCode = 200
      res.setHeader('content-type', 'text/html; charset=utf-8')
      return res.end('<!doctype html><meta charset="utf-8"><title>Google sign-in complete</title><p>Google sign-in complete. Return to the AICA browser tab.</p>')
    } catch {
      res.statusCode = 400
      res.setHeader('content-type', 'text/html; charset=utf-8')
      return res.end('<!doctype html><meta charset="utf-8"><title>Google sign-in failed</title><p>Google sign-in could not be completed. Return to AICA and try again.</p>')
    }
  }

  async testEmail(req, res) {
    this.authorize(req, { mutation: true })
    let stored = null
    try { stored = JSON.parse(this.getState('email_settings', 'null')) } catch {}
    const settings = parseEmailSettings(stored)
    const gmailOAuthTransport = settings?.provider === 'gmail-api' && settings?.gmailAuthMode === 'google-oauth'
    if (!settings || !settings.emailAddress || (!gmailOAuthTransport && (!settings.imapHost || !settings.smtpHost))) {
      return json(res, 400, { success: false, error: 'Complete email settings before testing the connection' })
    }
    if (settings.provider === 'custom-mcp') {
      return json(res, 409, { success: false, error: 'Custom MCP email transport is not available in browser mode' })
    }
    if (gmailOAuthTransport) {
      try {
        const token = await this.gmailOAuth.getAccessToken()
        if (!token) return json(res, 409, { success: false, error: 'Google Sign-In is not connected' })
        await this.gmailOAuth.request('/profile')
        return json(res, 200, {
          success: true,
          credentialConfigured: true,
          oauth: { signedIn: this.gmailOAuth.getStatus().signedIn, email: this.gmailOAuth.getStatus().email },
          transport: { gmailApi: { reachable: true, tls: true } },
        })
      } catch {
        return json(res, 502, { success: false, error: 'Gmail API could not be reached with the connected Google account' })
      }
    }
    if (!this.credentials) return json(res, 503, { success: false, error: 'Credential store unavailable' })
    let credentialConfigured = false
    for (const key of ['email_mcp_password', 'email_imap_password', 'email_smtp_password']) {
      try {
        if (await this.credentials.exists(key)) {
          credentialConfigured = true
          break
        }
      } catch {
        return json(res, 503, { success: false, error: 'Credential store operation failed' })
      }
    }
    if (!credentialConfigured) return json(res, 400, { success: false, error: 'Email app password is not configured' })
    try {
      const transport = await this.emailProbe(settings)
      return json(res, 200, { success: true, credentialConfigured: true, transport })
    } catch {
      // Keep endpoint diagnostics generic: host and provider details stay out of logs/responses.
      return json(res, 502, { success: false, error: 'Email server could not be reached over the configured secure transport' })
    }
  }

  async emailInbound(req, res, url) {
    this.authorize(req, { mutation: req.method === 'POST' })
    if (req.method === 'POST' && this.migrationFence(req, res)) return
    if (req.method === 'GET') {
      const requestedAfter = Number.parseInt(url.searchParams.get('after_id') || '0', 10)
      const afterId = Number.isSafeInteger(requestedAfter) && requestedAfter >= 0 ? requestedAfter : 0
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '20', 10)
      const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), MAX_EMAIL_INBOUND_BATCH) : 20
      const status = url.searchParams.get('status')
      if (status && !['queued', 'processing', 'completed'].includes(status)) return json(res, 400, { error: 'Invalid email inbound status' })
      const rows = status
        ? this.db.prepare('SELECT id,provider_event_id,conversation_id,payload,status,created_at FROM inbound_events WHERE channel = ? AND id > ? AND status = ? ORDER BY id ASC LIMIT ?').all('email', afterId, status, limit)
        : this.db.prepare('SELECT id,provider_event_id,conversation_id,payload,status,created_at FROM inbound_events WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT ?').all('email', afterId, limit)
      return json(res, 200, {
        events: rows.map(row => ({
          id: row.id,
          providerEventId: row.provider_event_id,
          conversationId: row.conversation_id,
          payload: JSON.parse(row.payload),
          status: row.status,
          createdAt: row.created_at,
        })),
        nextAfterId: rows.length ? rows[rows.length - 1].id : afterId,
      })
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, MAX_EMAIL_INBOUND_BODY_BYTES)
    if (!parseEmailInbound(body)) return json(res, 400, { error: 'Invalid email inbound event' })
    try {
      const result = this.ingestEmailInbound(body)
      return json(res, result.duplicate ? 200 : 202, result)
    } catch (error) {
      return json(res, /too large/i.test(error.message) ? 413 : 400, { error: error.message })
    }
  }

  emailAttachments(req, res, url) {
    this.authorize(req)
    const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '20', 10)
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 20
    const rows = this.db.prepare("SELECT id,provider_event_id,payload,created_at FROM inbound_events WHERE channel = 'email' AND payload IS NOT NULL ORDER BY created_at DESC LIMIT 100").all()
    const attachments = []
    for (const row of rows) {
      if (attachments.length >= limit) break
      let payload
      try { payload = JSON.parse(row.payload) } catch { continue }
      if (!Array.isArray(payload?.attachments)) continue
      for (const attachment of payload.attachments) {
        if (attachments.length >= limit) break
        const parsed = parseEmailAttachmentMetadata(attachment)
        if (!parsed) continue
        attachments.push({
          inboundId: String(row.id),
          messageId: typeof payload.id === 'string' ? payload.id : (typeof payload.messageId === 'string' ? payload.messageId : row.provider_event_id),
          ...parsed,
          receivedAt: row.created_at,
        })
      }
    }
    return json(res, 200, { attachments })
  }

  async retrieveGmailAttachmentRoute(req, res, messageId, attachmentId) {
    this.authorize(req, { mutation: true })
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(messageId) || !/^[A-Za-z0-9_-]{1,256}$/.test(attachmentId)) return json(res, 400, { error: 'Invalid Gmail attachment identity' })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    let body
    try { body = await readBody(req, 16 * 1024) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['mimeType', 'name'].includes(key))) return json(res, 400, { error: 'Invalid Gmail attachment metadata' })
    const metadata = {
      ...(typeof body.mimeType === 'string' && body.mimeType.length <= MAX_EMAIL_ATTACHMENT_MIME_LENGTH ? { mimeType: body.mimeType } : {}),
      ...(typeof body.name === 'string' && body.name.length <= MAX_EMAIL_ATTACHMENT_NAME_LENGTH ? { name: body.name } : {}),
    }
    if (body.mimeType !== undefined && !metadata.mimeType) return json(res, 400, { error: 'Invalid Gmail attachment MIME type' })
    if (body.name !== undefined && !metadata.name) return json(res, 400, { error: 'Invalid Gmail attachment name' })
    const settings = this.getEmailSettings()
    if (!settings || settings.provider !== 'gmail-api' || settings.gmailAuthMode !== 'google-oauth') return json(res, 409, { error: 'Gmail OAuth attachment inspection is unavailable for the selected transport' })
    try {
      const payload = await this.gmailOAuth.request(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, {}, MAX_EMAIL_ATTACHMENT_RESPONSE_BYTES)
      const encoded = payload && typeof payload.data === 'string' ? payload.data : ''
      if (!encoded || encoded.length > Math.ceil(MAX_SCANNED_EMAIL_ATTACHMENT_BYTES * 4 / 3) + 32) return json(res, 502, { error: 'Gmail attachment payload is missing or too large' })
      if (!/^[A-Za-z0-9+/_=-]+$/.test(encoded)) return json(res, 502, { error: 'Gmail attachment payload is invalid' })
      const bytes = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
      const scan = scanEmailAttachment({ bytes, mimeType: metadata.mimeType, name: metadata.name })
      if (Number.isFinite(payload.size) && Number(payload.size) !== bytes.byteLength) return json(res, 200, { scan: { ...scan, safe: false, reason: 'attachment_size_mismatch' } })
      return json(res, 200, { scan, ...(scan.safe ? { bytes: bytes.toString('base64') } : {}) })
    } catch {
      return json(res, 502, { error: 'Gmail attachment retrieval failed' })
    }
  }

  async acknowledgeEmailInbound(req, res) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    let body
    try { body = await readBody(req, 16 * 1024) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'eventIds')
      || !Array.isArray(body.eventIds) || body.eventIds.length < 1 || body.eventIds.length > MAX_EMAIL_INBOUND_BATCH
      || body.eventIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
      return json(res, 400, { error: 'Invalid email inbound acknowledgement' })
    }
    const eventIds = [...new Set(body.eventIds)]
    const placeholders = eventIds.map(() => '?').join(',')
    const acknowledgedIds = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id,status FROM inbound_events WHERE channel = 'email' AND id IN (${placeholders})`).all(...eventIds)
      const acknowledged = []
      for (const row of rows) {
        if (row.status === 'queued' || row.status === 'processing') {
          this.db.prepare("UPDATE inbound_events SET status = 'completed', claimed_at = NULL WHERE channel = 'email' AND id = ?").run(row.id)
          acknowledged.push(row.id)
        } else if (row.status === 'completed') {
          // Idempotent replay after a browser retry or reload.
          acknowledged.push(row.id)
        }
      }
      return acknowledged.sort((a, b) => a - b)
    })()
    return json(res, 200, { acknowledgedIds })
  }

  async claimEmailInbound(req, res) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    let body
    try { body = await readBody(req, 16 * 1024) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'limit')) {
      return json(res, 400, { error: 'Invalid email inbound claim' })
    }
    const requestedLimit = body.limit === undefined ? 20 : body.limit
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_EMAIL_INBOUND_BATCH) {
      return json(res, 400, { error: 'Invalid email inbound claim limit' })
    }
    const events = this.db.transaction(() => {
      const staleBefore = Date.now() - EMAIL_INBOUND_CLAIM_TTL_MS
      this.db.prepare("UPDATE inbound_events SET status = 'queued', claimed_at = NULL WHERE channel = 'email' AND status = 'processing' AND (claimed_at IS NULL OR claimed_at < ?)").run(staleBefore)
      const rows = this.db.prepare("SELECT id,provider_event_id,conversation_id,payload,status,created_at FROM inbound_events WHERE channel = 'email' AND status = 'queued' ORDER BY id ASC LIMIT ?").all(requestedLimit)
      const claimedAt = Date.now()
      for (const row of rows) this.db.prepare("UPDATE inbound_events SET status = 'processing', claimed_at = ? WHERE channel = 'email' AND id = ? AND status = 'queued'").run(claimedAt, row.id)
      return rows.map(row => ({
        id: row.id,
        providerEventId: row.provider_event_id,
        conversationId: row.conversation_id,
        payload: JSON.parse(row.payload),
        status: 'processing',
        createdAt: row.created_at,
      }))
    })()
    return json(res, 200, { events })
  }

  async emailDrafts(req, res, url) {
    this.authorize(req, { mutation: req.method === 'POST' })
    if (req.method === 'GET') {
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '100', 10)
      const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), MAX_EMAIL_DRAFT_BATCH) : MAX_EMAIL_DRAFT_BATCH
      const status = url.searchParams.get('status')
      if (status && !EMAIL_DRAFT_STATUSES.includes(status)) return json(res, 400, { error: 'Invalid email draft status' })
      const rows = status
        ? this.db.prepare('SELECT payload FROM email_drafts WHERE status = ? ORDER BY updated_at DESC LIMIT ?').all(status, limit)
        : this.db.prepare('SELECT payload FROM email_drafts ORDER BY updated_at DESC LIMIT ?').all(limit)
      return json(res, 200, { drafts: rows.map((row) => JSON.parse(row.payload)) })
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    let body
    try { body = await readBody(req, MAX_EMAIL_DRAFT_BODY_BYTES) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    const draft = parseEmailDraft(body)
    if (!draft) return json(res, 400, { error: 'Invalid email draft' })
    if (!['pending_review', 'approved', 'rejected', 'escalated'].includes(draft.status)) return json(res, 400, { error: 'Email delivery status is owned by the daemon transport' })
    const now = Date.now()
    this.db.prepare(`INSERT INTO email_drafts(id,status,payload,created_at,updated_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(draft.id, draft.status, JSON.stringify(draft), draft.createdAt, now)
    return json(res, 200, draft)
  }

  async emailDraft(req, res, id) {
    this.authorize(req, { mutation: true })
    if (!/^draft_[A-Za-z0-9_-]{1,120}$/.test(id)) return json(res, 400, { error: 'Invalid email draft id' })
    const row = this.db.prepare('SELECT payload FROM email_drafts WHERE id = ?').get(id)
    if (!row) return json(res, 404, { error: 'Email draft not found' })
    if (req.method === 'DELETE') {
      this.db.prepare('DELETE FROM email_drafts WHERE id = ?').run(id)
      return json(res, 200, { success: true })
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    let body
    try { body = await readBody(req, MAX_EMAIL_DRAFT_BODY_BYTES) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['responseText', 'status', 'attachments'].includes(key))) return json(res, 400, { error: 'Invalid email draft update' })
    const current = parseEmailDraft(JSON.parse(row.payload))
    if (!current) return json(res, 500, { error: 'Stored email draft is invalid' })
    const candidate = { ...current, ...(Object.prototype.hasOwnProperty.call(body, 'responseText') ? { responseText: body.responseText } : {}), ...(Object.prototype.hasOwnProperty.call(body, 'attachments') ? { attachments: body.attachments } : {}), ...(Object.prototype.hasOwnProperty.call(body, 'status') ? { status: body.status } : {}) }
    const draft = parseEmailDraft(candidate)
    if (!draft) return json(res, 400, { error: 'Invalid email draft update' })
    if (body.status !== undefined) {
      const transitions = {
        pending_review: new Set(['pending_review', 'approved', 'rejected']),
        escalated: new Set(['escalated', 'approved', 'rejected']),
        approved: new Set(['approved']),
        rejected: new Set(['rejected']),
        sent: new Set(['sent']),
        failed: new Set(['failed']),
      }
      if (!transitions[current.status]?.has(draft.status)) return json(res, 409, { error: 'Invalid email draft status transition' })
      if (['sent', 'failed'].includes(draft.status)) return json(res, 409, { error: 'Email delivery status is owned by the daemon transport' })
    }
    const now = Date.now()
    this.db.prepare('UPDATE email_drafts SET status = ?, payload = ?, updated_at = ? WHERE id = ?').run(draft.status, JSON.stringify(draft), now, id)
    return json(res, 200, draft)
  }

  async sendEmailDraft(req, res, id) {
    this.authorize(req, { mutation: true })
    if (this.migrationFence(req, res)) return
    if (!/^draft_[A-Za-z0-9_-]{1,120}$/.test(id)) return json(res, 400, { error: 'Invalid email draft id' })
    let settings = null
    try { settings = parseEmailSettings(JSON.parse(this.getState('email_settings', 'null'))) } catch {}
    const gmailOAuthTransport = settings?.provider === 'gmail-api' && settings?.gmailAuthMode === 'google-oauth'
    if (!settings || !settings.enabled || !['imap-smtp', 'gmail-api'].includes(settings.provider)
      || (!gmailOAuthTransport && settings.gmailAuthMode !== 'app-password')) {
      return json(res, 409, { success: false, error: 'Browser email delivery requires an enabled supported transport' })
    }
    if (!settings.emailAddress || (!gmailOAuthTransport && (!settings.smtpHost || !settings.userName))) return json(res, 400, { success: false, error: 'Complete email delivery settings before sending email' })
    if (!gmailOAuthTransport && !settings.smtpTls) return json(res, 409, { success: false, error: 'Browser email delivery requires SMTP TLS or STARTTLS' })
    const row = this.db.prepare('SELECT payload,status FROM email_drafts WHERE id = ?').get(id)
    if (!row) return json(res, 404, { error: 'Email draft not found' })
    const draft = parseEmailDraft(JSON.parse(row.payload))
    if (!draft) return json(res, 500, { error: 'Stored email draft is invalid' })
    if (draft.status === 'sent') return json(res, 200, { success: true, duplicate: true, draft })
    if (draft.status !== 'approved') return json(res, 409, { success: false, error: 'Email draft must be approved before sending' })
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { success: false, error: 'Settings migration is committing' })
    if (!gmailOAuthTransport && !this.credentials) { releaseOperation(); return json(res, 503, { success: false, error: 'Credential store unavailable' }) }
    let password = null
    if (!gmailOAuthTransport) {
      // Keep the original browser email credential as a read-only fallback;
      // new browser writes use transport-specific keys.
      for (const key of ['email_smtp_password', 'email_imap_password', 'email_mcp_password']) {
        try {
          password = await this.credentials.get(key)
          if (password) break
        } catch {
          releaseOperation()
          return json(res, 503, { success: false, error: 'Credential store operation failed' })
        }
      }
    }
    if (!gmailOAuthTransport && !password) { releaseOperation(); return json(res, 400, { success: false, error: 'Email app password is not configured' }) }
    const lockNow = Date.now()
    this.db.prepare('DELETE FROM email_delivery_locks WHERE draft_id = ? AND started_at < ?').run(id, lockNow - 10 * 60 * 1000)
    try {
      this.db.prepare('INSERT INTO email_delivery_locks(draft_id,started_at) VALUES (?,?)').run(id, lockNow)
    } catch {
      releaseOperation()
      return json(res, 409, { success: false, error: 'Email draft delivery is already in progress' })
    }
    const recipient = draft.replyTo || draft.originalFrom
    try {
      this.assertMigrationOpen()
      if (gmailOAuthTransport) {
        await this.gmailOAuth.sendText({
          to: recipient,
          subject: draft.originalSubject ? (draft.originalSubject.startsWith('Re:') ? draft.originalSubject : `Re: ${draft.originalSubject}`) : '(no subject)',
          body: draft.responseText,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
          attachments: draft.attachments,
        })
      } else {
        await this.emailSend({
          host: settings.smtpHost,
          port: settings.smtpPort,
          secure: settings.smtpTls,
          username: settings.userName || settings.emailAddress,
          password,
          from: settings.emailAddress,
          to: recipient,
          subject: draft.originalSubject ? (draft.originalSubject.startsWith('Re:') ? draft.originalSubject : `Re: ${draft.originalSubject}`) : '(no subject)',
          body: draft.responseText,
          inReplyTo: draft.inReplyTo,
          references: draft.references,
          attachments: draft.attachments,
        })
      }
      const sent = { ...draft, status: 'sent' }
      this.db.prepare('UPDATE email_drafts SET status = ?, payload = ?, updated_at = ? WHERE id = ? AND status = ?').run('sent', JSON.stringify(sent), Date.now(), id, 'approved')
      this.db.prepare('DELETE FROM email_delivery_locks WHERE draft_id = ?').run(id)
      return json(res, 200, { success: true, duplicate: false, draft: sent })
    } catch {
      const failed = { ...draft, status: 'failed' }
      this.db.prepare('UPDATE email_drafts SET status = ?, payload = ?, updated_at = ? WHERE id = ? AND status = ?').run('failed', JSON.stringify(failed), Date.now(), id, 'approved')
      this.db.prepare('DELETE FROM email_delivery_locks WHERE draft_id = ?').run(id)
      return json(res, 502, { success: false, error: 'Email delivery failed over the configured secure SMTP transport' })
    } finally {
      releaseOperation()
      if (typeof password === 'string') password = ''
    }
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

  systemInfo(req, res) {
    this.authorize(req)
    return json(res, 200, {
      productName: PRODUCT_NAME,
      productVersion: PRODUCT_VERSION,
      runtime: 'agentd',
      platform: PLATFORM_LABEL,
      engine: AGENTD_ENGINE,
    })
  }

  knowledgeView(row) {
    return {
      id: row.id,
      file_path: row.file_path,
      file_name: row.file_name,
      created_at: row.created_at,
      ...(typeof row.file_type === 'string' ? { file_type: row.file_type } : {}),
      ...(Number.isSafeInteger(row.size) ? { size: row.size } : {}),
    }
  }

  persistKnowledgeDocument({ fileName, filePath, fileType, content, size }) {
    const now = new Date().toISOString()
    const result = this.db.transaction(() => {
      this.db.prepare('DELETE FROM knowledge_documents WHERE file_path = ?').run(filePath)
      const inserted = this.db.prepare('INSERT INTO knowledge_documents(file_path,file_name,file_type,content,size,created_at) VALUES (?,?,?,?,?,?)')
        .run(filePath, fileName.trim(), fileType, content, size, now)
      this.db.prepare('INSERT INTO intelligence_logs(type,event,details,timestamp) VALUES (?,?,?,?)')
        .run('training', 'completed', `Successfully indexed ${fileName.trim()}`, now)
      return this.db.prepare('SELECT id,file_path,file_name,file_type,size,created_at FROM knowledge_documents WHERE id = ?').get(inserted.lastInsertRowid)
    })()
    return this.knowledgeView(result)
  }

  async convertKnowledge(req, res) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    let body
    try { body = await readBody(req, MAX_KNOWLEDGE_CONVERSION_BODY_BYTES) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    const keys = Object.keys(body || {}).sort()
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || keys.some(key => !['dataBase64', 'fileName', 'fileType', 'size'].includes(key))
      || !validBoundedText(body.fileName, MAX_KNOWLEDGE_NAME_LENGTH)
      || !validBoundedText(body.fileType, MAX_KNOWLEDGE_TYPE_LENGTH, true)
      || typeof body.dataBase64 !== 'string'
      || body.dataBase64.length === 0
      || body.dataBase64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.dataBase64)
      || !Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_KNOWLEDGE_BINARY_BYTES) {
      return json(res, 400, { error: 'Invalid knowledge conversion request' })
    }
    const bytes = Buffer.from(body.dataBase64, 'base64')
    if (bytes.length !== body.size) return json(res, 400, { error: 'Invalid knowledge conversion request' })
    const tempDir = fs.mkdtempSync(path.join(this.dataDir, '.knowledge-conversion-'))
    // MarkItDown selects its parser from the source extension. Keep only a safe,
    // bounded extension derived from the display name; never use the full name as
    // a path because browser-provided names may contain separators or dot segments.
    const rawExtension = path.extname(body.fileName.trim()).toLowerCase()
    const extension = /^[.][a-z0-9]{1,16}$/.test(rawExtension) ? rawExtension : '.bin'
    const sourcePath = path.join(tempDir, `source${extension}`)
    let content = ''
    try {
      fs.writeFileSync(sourcePath, bytes, { flag: 'wx', mode: 0o600 })
      const result = await this.mcpWorker.call(
        MARKITDOWN_KNOWLEDGE_SERVER,
        'convert_to_markdown',
        { uri: pathToFileURL(sourcePath).href },
        `knowledge-convert-${crypto.randomUUID()}`,
      )
      if (result?.isError) throw new Error('Knowledge conversion failed')
      content = Array.isArray(result?.content)
        ? result.content.filter(item => item && item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n')
        : ''
      if (!content.trim() || content.length > MAX_KNOWLEDGE_CONTENT_LENGTH || Buffer.byteLength(content, 'utf8') > MAX_KNOWLEDGE_CONTENT_LENGTH) throw new Error('Knowledge conversion output is too large or empty')
    } catch {
      // Do not log converter details: parser errors can contain the generated
      // native temp path or document metadata that must stay inside agentd.
      this.logger.warn?.('[agentd] knowledge conversion failed')
      return json(res, 422, { error: 'Knowledge conversion failed for this file' })
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }) } catch {}
    }
    const document = this.persistKnowledgeDocument({
      fileName: body.fileName,
      filePath: `browser://knowledge/${encodeURIComponent(body.fileName.trim())}`,
      fileType: 'text/markdown',
      content,
      size: body.size,
    })
    return json(res, 201, { success: true, document })
  }

  async knowledge(req, res, url) {
    this.authorize(req, { mutation: req.method === 'POST' })
    if (req.method === 'GET') {
      const requested = Number.parseInt(url.searchParams.get('limit') || '100', 10)
      const limit = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 500) : 100
      const rows = this.db.prepare('SELECT id,file_path,file_name,file_type,size,created_at FROM knowledge_documents ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
      return json(res, 200, { documents: rows.map(row => this.knowledgeView(row)) })
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, MAX_KNOWLEDGE_BODY_BYTES)
    const keys = Object.keys(body || {}).sort()
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || keys.some(key => !['content', 'fileName', 'filePath', 'fileType', 'size'].includes(key))
      || !validBoundedText(body.fileName, MAX_KNOWLEDGE_NAME_LENGTH)
      || !validBoundedText(body.filePath, MAX_KNOWLEDGE_PATH_LENGTH)
      || !validBoundedText(body.fileType, MAX_KNOWLEDGE_TYPE_LENGTH, true)
      || typeof body.content !== 'string' || !body.content.trim()
      || body.content.length > MAX_KNOWLEDGE_CONTENT_LENGTH
      || Buffer.byteLength(body.content, 'utf8') > MAX_KNOWLEDGE_CONTENT_LENGTH
      || !Number.isSafeInteger(body.size) || body.size < 0 || body.size > 16 * 1024 * 1024) {
      return json(res, 400, { error: 'Invalid knowledge document' })
    }
    const document = this.persistKnowledgeDocument(body)
    return json(res, 201, { success: true, document })
  }

  async deleteKnowledge(req, res, id) {
    this.authorize(req, { mutation: true })
    const result = this.db.prepare('DELETE FROM knowledge_documents WHERE id = ?').run(id)
    return json(res, 200, { success: true, deleted: result.changes > 0 })
  }

  async searchKnowledge(req, res, url) {
    this.authorize(req)
    const query = url.searchParams.get('query') || ''
    const requested = Number.parseInt(url.searchParams.get('limit') || '5', 10)
    const limit = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 20) : 5
    if (!query.trim() || query.length > 512) return json(res, 400, { error: 'Invalid knowledge query' })
    const terms = query.normalize('NFKC').toLowerCase().split(/[^\p{L}\p{M}\p{N}_]+/u).filter(Boolean).slice(0, 24)
    if (!terms.length) return json(res, 200, { results: [] })
    const rows = this.db.prepare('SELECT id,file_path,file_name,content FROM knowledge_documents ORDER BY created_at DESC, id DESC').all()
    const ranked = rows.map(row => {
      const haystack = row.content.toLowerCase()
      const score = terms.reduce((total, term) => total + (haystack.split(term).length - 1), 0)
      return { row, score }
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.row.id - a.row.id).slice(0, limit)
    return json(res, 200, { results: ranked.map(({ row, score }) => ({ id: row.id, file_path: row.file_path, file_name: row.file_name, content: row.content, rank: -score })) })
  }

  async intelligenceLogs(req, res, url) {
    this.authorize(req)
    const requested = Number.parseInt(url.searchParams.get('limit') || '20', 10)
    const limit = Number.isSafeInteger(requested) ? Math.min(Math.max(requested, 1), 200) : 20
    const rows = this.db.prepare('SELECT id,type,event,details,timestamp FROM intelligence_logs ORDER BY id DESC LIMIT ?').all(limit)
    return json(res, 200, { logs: rows.reverse() })
  }

  async intelligenceStats(req, res) {
    this.authorize(req)
    const total = this.db.prepare("SELECT COUNT(*) AS count FROM intelligence_logs WHERE type = 'accuracy'").get().count
    const resolved = this.db.prepare("SELECT COUNT(*) AS count FROM intelligence_logs WHERE type = 'accuracy' AND event = 'resolved'").get().count
    const training = this.db.prepare("SELECT COUNT(*) AS count FROM intelligence_logs WHERE type = 'training'").get().count
    const learning = this.db.prepare("SELECT COUNT(*) AS count FROM intelligence_logs WHERE type = 'learning'").get().count
    return json(res, 200, { success: true, stats: { totalQueries: total, resolvedQueries: resolved, autonomyRate: total > 0 ? (resolved / total) * 100 : 0, trainingCount: training, learningCount: learning } })
  }

  async logIntelligenceAccuracy(req, res) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, MAX_INTELLIGENCE_DETAILS_LENGTH + 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.event !== 'string' || !/^[\x21-\x7e]{1,64}$/.test(body.event)
      || (body.details !== undefined && (typeof body.details !== 'string' || body.details.length > MAX_INTELLIGENCE_DETAILS_LENGTH))) {
      return json(res, 400, { error: 'Invalid intelligence event' })
    }
    this.db.prepare('INSERT INTO intelligence_logs(type,event,details,timestamp) VALUES (?,?,?,?)').run('accuracy', body.event, body.details || null, new Date().toISOString())
    return json(res, 200, { success: true })
  }

  parseMemoryJson(value, fallback) {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' ? parsed : fallback
    } catch {
      return fallback
    }
  }

  memoryEntityView(row) {
    if (!row) return null
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      description: row.description,
      observations: this.parseMemoryJson(row.observations, []),
      metadata: this.parseMemoryJson(row.metadata, {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  memoryRelationView(row) {
    if (!row) return null
    return {
      id: row.id,
      from_entity_id: row.from_entity_id,
      to_entity_id: row.to_entity_id,
      relation_type: row.relation_type,
      description: row.description,
      metadata: this.parseMemoryJson(row.metadata, {}),
      created_at: row.created_at,
    }
  }

  validMemoryMetadata(value) {
    if (value === undefined) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    let serialized
    try { serialized = JSON.stringify(value) } catch { return null }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_MEMORY_METADATA_BYTES) return null
    const check = (candidate) => {
      if (Array.isArray(candidate)) return candidate.every(check)
      if (!candidate || typeof candidate !== 'object') return true
      return Object.entries(candidate).every(([key, child]) => !/(password|token|secret|authorization|api[-_]?key)/i.test(key) && check(child))
    }
    return check(value) ? value : null
  }

  validMemoryObservations(value) {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 50) return null
    return value.every(item => validBoundedText(item, 1024, true)) ? value : null
  }

  memoryStatsValue() {
    const entityCount = this.db.prepare('SELECT COUNT(*) AS count FROM memory_entities').get().count
    const relationCount = this.db.prepare('SELECT COUNT(*) AS count FROM memory_relations').get().count
    let storageSize = 0
    try { storageSize = fs.statSync(path.join(this.dataDir, 'agentd.db')).size } catch {}
    return { entityCount, relationCount, storageSize, avgSearchLatency: 0, backend: 'agentd-sqlite' }
  }

  async memoryStats(req, res) {
    this.authorize(req)
    return json(res, 200, { success: true, stats: this.memoryStatsValue() })
  }

  async memoryExport(req, res) {
    this.authorize(req)
    const entities = this.db.prepare('SELECT * FROM memory_entities ORDER BY created_at ASC, id ASC LIMIT ?').all(MAX_MEMORY_EXPORT_ENTITIES).map(row => this.memoryEntityView(row))
    const relations = this.db.prepare('SELECT * FROM memory_relations ORDER BY created_at ASC, id ASC LIMIT ?').all(MAX_MEMORY_EXPORT_ENTITIES).map(row => this.memoryRelationView(row))
    const payload = { entities, relations, metadata: { exportedAt: new Date().toISOString(), version: '1.0.0', backend: 'agentd-sqlite' } }
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_MEMORY_EXPORT_BYTES) return json(res, 413, { error: 'Memory export too large' })
    return json(res, 200, { success: true, data: payload })
  }

  async memoryTool(req, res) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, MAX_MEMORY_METADATA_BYTES + MAX_MEMORY_DESCRIPTION_LENGTH + 16 * 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.name !== 'string' || !/^memory_[a-z_]+$/.test(body.name) || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) return json(res, 400, { error: 'Invalid memory tool request' })
    const name = body.name
    const args = body.args
    try {
      if (name === 'memory_create_entity') {
        if (!validBoundedText(args.name, MAX_MEMORY_NAME_LENGTH) || !validBoundedText(args.type, MAX_MEMORY_TYPE_LENGTH) || !validBoundedText(args.description, MAX_MEMORY_DESCRIPTION_LENGTH, true)) return json(res, 400, { error: 'Invalid memory entity' })
        const metadata = this.validMemoryMetadata(args.metadata)
        const observations = this.validMemoryObservations(args.observations === undefined && args.observation !== undefined ? [args.observation] : args.observations)
        if (metadata === null || observations === null) return json(res, 400, { error: 'Invalid memory entity' })
        const now = new Date().toISOString()
        const entity = { id: crypto.randomUUID(), name: args.name.trim(), type: args.type.trim(), description: args.description || '', observations, metadata, created_at: now, updated_at: now }
        this.db.prepare('INSERT INTO memory_entities(id,name,type,description,observations,metadata,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(entity.id, entity.name, entity.type, entity.description, JSON.stringify(entity.observations), JSON.stringify(entity.metadata), now, now)
        return json(res, 200, { success: true, result: entity })
      }
      if (name === 'memory_search') {
        if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > MAX_MEMORY_QUERY_LENGTH) return json(res, 400, { error: 'Invalid memory query' })
        const requested = Number.isSafeInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 100) : 10
        const query = `%${args.query.trim()}%`
        const rows = this.db.prepare('SELECT * FROM memory_entities WHERE name LIKE ? OR description LIKE ? OR observations LIKE ? ORDER BY updated_at DESC, id DESC LIMIT ?').all(query, query, query, requested)
        return json(res, 200, { success: true, result: rows.map(row => this.memoryEntityView(row)) })
      }
      if (name === 'memory_read_entity') {
        if ((args.id !== undefined && !validBoundedText(args.id, 128)) || (args.name !== undefined && !validBoundedText(args.name, MAX_MEMORY_NAME_LENGTH))) return json(res, 400, { error: 'Invalid memory lookup' })
        const row = args.id ? this.db.prepare('SELECT * FROM memory_entities WHERE id = ?').get(args.id) : this.db.prepare('SELECT * FROM memory_entities WHERE name = ?').get(args.name)
        return json(res, 200, { success: true, result: this.memoryEntityView(row) })
      }
      if (name === 'memory_update_entity') {
        if ((args.id !== undefined && !validBoundedText(args.id, 128)) || (args.name !== undefined && !validBoundedText(args.name, MAX_MEMORY_NAME_LENGTH))) return json(res, 400, { error: 'Invalid memory lookup' })
        const row = args.id ? this.db.prepare('SELECT * FROM memory_entities WHERE id = ?').get(args.id) : this.db.prepare('SELECT * FROM memory_entities WHERE name = ?').get(args.name)
        if (!row) return json(res, 200, { success: true, result: null, error: `Entity not found: ${args.id || args.name || '(missing id/name)'}` })
        const metadataUpdate = this.validMemoryMetadata(args.metadata)
        if (metadataUpdate === null || (args.description !== undefined && !validBoundedText(args.description, MAX_MEMORY_DESCRIPTION_LENGTH, true)) || (args.observation !== undefined && !validBoundedText(args.observation, 1024))) return json(res, 400, { error: 'Invalid memory update' })
        const existing = this.memoryEntityView(row)
        const observations = args.observation === undefined ? existing.observations : [...existing.observations, args.observation].slice(-50)
        const metadata = { ...existing.metadata, ...(metadataUpdate || {}) }
        const updatedAt = new Date().toISOString()
        this.db.prepare('UPDATE memory_entities SET description = ?, observations = ?, metadata = ?, updated_at = ? WHERE id = ?').run(args.description ?? existing.description, JSON.stringify(observations), JSON.stringify(metadata), updatedAt, existing.id)
        return json(res, 200, { success: true, result: this.memoryEntityView(this.db.prepare('SELECT * FROM memory_entities WHERE id = ?').get(existing.id)) })
      }
      if (name === 'memory_delete_entity') {
        if ((args.id !== undefined && !validBoundedText(args.id, 128)) || (args.name !== undefined && !validBoundedText(args.name, MAX_MEMORY_NAME_LENGTH))) return json(res, 400, { error: 'Invalid memory lookup' })
        const row = args.id ? this.db.prepare('SELECT * FROM memory_entities WHERE id = ?').get(args.id) : this.db.prepare('SELECT * FROM memory_entities WHERE name = ?').get(args.name)
        if (!row) return json(res, 200, { success: true, result: { deleted: false, reason: 'not_found' } })
        this.db.transaction(() => {
          this.db.prepare('DELETE FROM memory_relations WHERE from_entity_id = ? OR to_entity_id = ?').run(row.id, row.id)
          this.db.prepare('DELETE FROM memory_entities WHERE id = ?').run(row.id)
        })()
        return json(res, 200, { success: true, result: { deleted: true, id: row.id, name: row.name } })
      }
      if (name === 'memory_create_relation') {
        if (!validBoundedText(args.from_entity_id, 128) || !validBoundedText(args.to_entity_id, 128) || !validBoundedText(args.relation_type, MAX_MEMORY_TYPE_LENGTH) || (args.description !== undefined && !validBoundedText(args.description, MAX_MEMORY_DESCRIPTION_LENGTH, true))) return json(res, 400, { error: 'Invalid memory relation' })
        if (!this.db.prepare('SELECT id FROM memory_entities WHERE id = ?').get(args.from_entity_id) || !this.db.prepare('SELECT id FROM memory_entities WHERE id = ?').get(args.to_entity_id)) return json(res, 404, { error: 'Memory entity not found' })
        const metadata = this.validMemoryMetadata(args.metadata)
        if (metadata === null) return json(res, 400, { error: 'Invalid memory relation' })
        const relation = { id: `${args.from_entity_id}-${args.relation_type}-${args.to_entity_id}`, from_entity_id: args.from_entity_id, to_entity_id: args.to_entity_id, relation_type: args.relation_type.trim(), description: args.description || '', metadata: metadata || {}, created_at: new Date().toISOString() }
        this.db.prepare('INSERT OR REPLACE INTO memory_relations(id,from_entity_id,to_entity_id,relation_type,description,metadata,created_at) VALUES (?,?,?,?,?,?,?)').run(relation.id, relation.from_entity_id, relation.to_entity_id, relation.relation_type, relation.description, JSON.stringify(relation.metadata), relation.created_at)
        return json(res, 200, { success: true, result: relation })
      }
      return json(res, 400, { error: `Unknown memory tool: ${name}` })
    } catch (error) {
      return json(res, 400, { error: error instanceof Error ? error.message : 'Memory tool failed' })
    }
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
    if (settings.whatsapp_transport !== 'baileys') await this.whatsappBaileys.disconnect(false)
    return json(res, 200, settings)
  }

  async whatsappUiSettings(req, res) {
    this.authorize(req, { mutation: req.method === 'PUT' })
    if (req.method === 'GET') {
      let stored = null
      try { stored = JSON.parse(this.getState('whatsapp_ui_settings', 'null')) } catch {}
      return json(res, 200, parseWhatsAppUiSettings(stored) || WHATSAPP_UI_DEFAULTS)
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 8 * 1024)
    const settings = parseWhatsAppUiSettings(body)
    if (!settings) return json(res, 400, { error: 'Invalid WhatsApp UI settings' })
    this.setState('whatsapp_ui_settings', JSON.stringify(settings))
    return json(res, 200, settings)
  }

  async whatsappConnection(req, res) {
    this.authorize(req)
    return json(res, 200, this.whatsappBaileys.getState())
  }

  async whatsappConnect(req, res) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 8 * 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'targetPhoneNumber') || (body.targetPhoneNumber !== undefined && typeof body.targetPhoneNumber !== 'string')) return json(res, 400, { error: 'Invalid WhatsApp connection request' })
    try {
      const state = await this.whatsappBaileys.connect(body.targetPhoneNumber)
      return json(res, 200, state)
    } catch {
      return json(res, 502, { error: 'WhatsApp connection could not be started' })
    }
  }

  async whatsappDisconnect(req, res) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 8 * 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'clearAuth') || (body.clearAuth !== undefined && typeof body.clearAuth !== 'boolean')) return json(res, 400, { error: 'Invalid WhatsApp disconnect request' })
    await this.whatsappBaileys.disconnect(body.clearAuth !== false)
    return json(res, 200, this.whatsappBaileys.getState())
  }

  async whatsappTarget(req, res) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 8 * 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.phoneNumber !== 'string') return json(res, 400, { error: 'Invalid WhatsApp target request' })
    const result = await this.whatsappBaileys.setTargetPhoneNumber(body.phoneNumber)
    return json(res, result.success ? 200 : 409, result)
  }

  async ollamaSettings(req, res) {
    this.authorize(req, { mutation: req.method === 'PUT' })
    if (req.method === 'GET') {
      let stored = null
      try { stored = JSON.parse(this.getState('ollama_settings', 'null')) } catch {}
      return json(res, 200, parseOllamaSettings(stored) || OLLAMA_SETTINGS_DEFAULTS)
    }
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
      const body = await readBody(req, 8 * 1024)
      const settings = parseOllamaSettings(body)
      if (!settings) return json(res, 400, { error: 'Invalid Ollama settings' })
      this.setState('ollama_settings', JSON.stringify(settings))
      return json(res, 200, settings)
    } finally {
      releaseOperation()
    }
  }

  async ollamaModels() {
    let stored = null
    try { stored = JSON.parse(this.getState('ollama_settings', 'null')) } catch {}
    const settings = parseOllamaSettings(stored) || OLLAMA_SETTINGS_DEFAULTS
    const response = await this.providerFetch(`${settings.baseUrl}/api/tags`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok || response.redirected) throw new Error('Ollama request failed')
    const payload = await readProviderResponse(response)
    const models = Array.isArray(payload?.models)
      ? payload.models.map((item) => item && typeof item.name === 'string' ? item.name : '').filter(validModelName).slice(0, 100)
      : []
    return { settings, models }
  }

  async sendWhatsAppCloudMessage(to, text) {
    let storedSettings = null
    try { storedSettings = JSON.parse(this.getState('whatsapp_settings', 'null')) } catch {}
    const settings = parseWhatsAppSettings(storedSettings) || WHATSAPP_SETTINGS_DEFAULTS
    if (settings.whatsapp_transport !== 'cloud') throw Object.assign(new Error('WhatsApp Cloud transport is not enabled'), { statusCode: 409 })
    if (!/^\d{5,32}$/.test(settings.whatsapp_cloud_phone_number_id)
      || !/^v\d+(?:\.\d+)?$/.test(settings.whatsapp_cloud_api_version)) {
      throw Object.assign(new Error('WhatsApp Cloud transport is not configured'), { statusCode: 409 })
    }
    if (!/^\+?[0-9\s().-]{8,32}$/.test(to.trim())) throw Object.assign(new Error('Invalid WhatsApp recipient'), { statusCode: 400 })
    const recipient = to.replace(/\D/g, '')
    if (!/^\d{8,15}$/.test(recipient)) throw Object.assign(new Error('Invalid WhatsApp recipient'), { statusCode: 400 })
    if (typeof text !== 'string' || !text.trim() || [...text].length > MAX_DRAFT_TEXT_LENGTH) throw Object.assign(new Error('Invalid WhatsApp message'), { statusCode: 400 })

    let accessToken
    try { accessToken = await this.credentials?.get('whatsapp_cloud_access_token') } catch {}
    if (typeof accessToken !== 'string' || !accessToken) throw Object.assign(new Error('WhatsApp Cloud credentials are not configured'), { statusCode: 409 })

    let response
    try {
      response = await this.providerFetch(`https://graph.facebook.com/${settings.whatsapp_cloud_api_version}/${settings.whatsapp_cloud_phone_number_id}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient, type: 'text', text: { body: text.trim() } }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      const payload = await readProviderResponse(response)
      const providerMessageId = payload?.messages?.[0]?.id
      if (!response.ok || typeof providerMessageId !== 'string' || !providerMessageId) throw new Error('WhatsApp Cloud message failed')
      return { providerMessageId }
    } catch (error) {
      try { await response?.body?.cancel() } catch {}
      if (error?.statusCode) throw error
      throw Object.assign(new Error('WhatsApp Cloud message failed'), { statusCode: 502 })
    }
  }

  async sendWhatsAppCloudMedia(to, media) {
    let storedSettings = null
    try { storedSettings = JSON.parse(this.getState('whatsapp_settings', 'null')) } catch {}
    const settings = parseWhatsAppSettings(storedSettings) || WHATSAPP_SETTINGS_DEFAULTS
    if (settings.whatsapp_transport !== 'cloud') throw Object.assign(new Error('WhatsApp Cloud transport is not enabled'), { statusCode: 409 })
    if (!/^\d{5,32}$/.test(settings.whatsapp_cloud_phone_number_id)
      || !/^v\d+(?:\.\d+)?$/.test(settings.whatsapp_cloud_api_version)) {
      throw Object.assign(new Error('WhatsApp Cloud transport is not configured'), { statusCode: 409 })
    }
    if (!/^\+?[0-9\s().-]{8,32}$/.test(to.trim())) throw Object.assign(new Error('Invalid WhatsApp recipient'), { statusCode: 400 })
    const recipient = to.replace(/\D/g, '')
    if (!/^\d{8,15}$/.test(recipient)) throw Object.assign(new Error('Invalid WhatsApp recipient'), { statusCode: 400 })
    if (!isSupportedMediaMime(media.type, media.mimeType)) throw Object.assign(new Error('Unsupported WhatsApp media MIME type'), { statusCode: 415 })

    let accessToken
    try { accessToken = await this.credentials?.get('whatsapp_cloud_access_token') } catch {}
    if (typeof accessToken !== 'string' || !accessToken) throw Object.assign(new Error('WhatsApp Cloud credentials are not configured'), { statusCode: 409 })
    if (typeof FormData !== 'function' || typeof Blob !== 'function') throw Object.assign(new Error('WhatsApp Cloud media upload is unavailable'), { statusCode: 503 })

    const endpoint = `https://graph.facebook.com/${settings.whatsapp_cloud_api_version}/${settings.whatsapp_cloud_phone_number_id}`
    let uploadResponse
    try {
      const form = new FormData()
      form.append('messaging_product', 'whatsapp')
      form.append('file', new Blob([media.bytes], { type: media.mimeType }), media.fileName)
      uploadResponse = await this.providerFetch(`${endpoint}/media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        body: form,
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000),
      })
      const upload = await readProviderResponse(uploadResponse)
      if (!uploadResponse.ok || typeof upload?.id !== 'string' || !upload.id) throw new Error('WhatsApp Cloud media upload failed')
      const mediaObject = { id: upload.id, ...(media.type !== 'audio' && media.caption.trim() ? { caption: media.caption.trim() } : {}) }
      const sentResponse = await this.providerFetch(`${endpoint}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient, type: media.type, [media.type]: mediaObject }),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      })
      const sent = await readProviderResponse(sentResponse)
      const providerMessageId = sent?.messages?.[0]?.id
      if (!sentResponse.ok || typeof providerMessageId !== 'string' || !providerMessageId) throw new Error('WhatsApp Cloud media message failed')
      return { providerMessageId }
    } catch (error) {
      try { await uploadResponse?.body?.cancel() } catch {}
      if (error?.statusCode) throw error
      throw Object.assign(new Error('WhatsApp Cloud media message failed'), { statusCode: 502 })
    }
  }

  async sendWhatsAppConfiguredMessage(to, text) {
    let storedSettings = null
    try { storedSettings = JSON.parse(this.getState('whatsapp_settings', 'null')) } catch {}
    const settings = parseWhatsAppSettings(storedSettings) || WHATSAPP_SETTINGS_DEFAULTS
    if (settings.whatsapp_transport === 'baileys') return this.whatsappBaileys.sendText(to, text)
    if (settings.whatsapp_transport === 'cloud') return this.sendWhatsAppCloudMessage(to, text)
    throw Object.assign(new Error('WhatsApp Web transport is not available in browser mode'), { statusCode: 409 })
  }

  async sendWhatsAppConfiguredMedia(to, media) {
    let storedSettings = null
    try { storedSettings = JSON.parse(this.getState('whatsapp_settings', 'null')) } catch {}
    const settings = parseWhatsAppSettings(storedSettings) || WHATSAPP_SETTINGS_DEFAULTS
    if (settings.whatsapp_transport === 'baileys') return this.whatsappBaileys.sendMedia(to, media.bytes, media)
    if (settings.whatsapp_transport === 'cloud') return this.sendWhatsAppCloudMedia(to, media)
    throw Object.assign(new Error('WhatsApp Web transport is not available in browser mode'), { statusCode: 409 })
  }

  async sendWhatsAppMessage(req, res) {
    this.authorize(req, { mutation: true })
    if (this.migrationFence(req, res)) return
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 16 * 1024)
    const keys = Object.keys(body || {}).sort()
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || keys.length !== 2 || keys[0] !== 'text' || keys[1] !== 'to'
      || typeof body.to !== 'string' || typeof body.text !== 'string'
      || !body.to.trim() || !body.text.trim()
      || [...body.to].length > 32 || [...body.text].length > MAX_DRAFT_TEXT_LENGTH) {
      return json(res, 400, { error: 'Invalid WhatsApp message' })
    }

    let releaseOperation = null
    try {
      releaseOperation = this.beginActiveOperation()
      if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
      this.assertMigrationOpen()
      const { providerMessageId } = await this.sendWhatsAppConfiguredMessage(body.to, body.text)
      releaseOperation()
      return json(res, 200, { success: true, providerMessageId })
    } catch (error) {
      releaseOperation?.()
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 502
      return json(res, statusCode, { success: false, error: statusCode === 502 ? 'WhatsApp Cloud message failed' : error.message })
    }
  }

  async sendWhatsAppMedia(req, res) {
    this.authorize(req, { mutation: true })
    if (this.migrationFence(req, res)) return
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    let body
    try { body = await readBody(req, MAX_WHATSAPP_MEDIA_BODY_BYTES) } catch (error) { return json(res, error.statusCode || 400, { error: error.message }) }
    const keys = Object.keys(body || {}).sort()
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || keys.some(key => !['caption', 'dataBase64', 'fileName', 'mimeType', 'size', 'to', 'type'].includes(key))
      || !['caption', 'dataBase64', 'fileName', 'mimeType', 'size', 'to', 'type'].every(key => Object.prototype.hasOwnProperty.call(body, key))
      || typeof body.to !== 'string' || !body.to.trim() || [...body.to].length > 32
      || !['image', 'video', 'audio', 'document'].includes(body.type)
      || typeof body.fileName !== 'string' || !body.fileName.trim() || body.fileName.length > 256 || /[\0\r\n\\/]/.test(body.fileName)
      || typeof body.mimeType !== 'string' || !body.mimeType.trim() || body.mimeType.length > 128 || /[\0\r\n]/.test(body.mimeType)
      || !isSupportedMediaMime(body.type, body.mimeType)
      || typeof body.caption !== 'string' || body.caption.length > MAX_DRAFT_TEXT_LENGTH
      || typeof body.dataBase64 !== 'string' || body.dataBase64.length === 0 || body.dataBase64.length > Math.ceil(MAX_WHATSAPP_MEDIA_BYTES * 4 / 3) + 64
      || body.dataBase64.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.dataBase64)
      || !Number.isSafeInteger(body.size) || body.size < 1 || body.size > MAX_WHATSAPP_MEDIA_BYTES) {
      return json(res, 400, { error: 'Invalid WhatsApp media' })
    }
    const bytes = Buffer.from(body.dataBase64, 'base64')
    if (bytes.length !== body.size) return json(res, 400, { error: 'Invalid WhatsApp media' })
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
      this.assertMigrationOpen()
      const { providerMessageId } = await this.sendWhatsAppConfiguredMedia(body.to, {
        bytes,
        type: body.type,
        fileName: body.fileName,
        mimeType: body.mimeType,
        caption: body.caption,
      })
      return json(res, 200, { success: true, providerMessageId })
    } catch (error) {
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 502
      return json(res, statusCode, { success: false, error: statusCode === 502 ? 'WhatsApp media message failed' : error.message })
    } finally {
      releaseOperation()
    }
  }

  async testProvider(req, res, provider) {
    this.authorize(req, { mutation: true })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) return json(res, 400, { error: 'Provider test accepts no input' })
    if (provider === 'ollama') {
      try {
        const { models } = await this.ollamaModels()
        return json(res, 200, { success: true, modelCount: models.length, models })
      } catch {
        return json(res, 200, { success: false, error: 'Ollama provider test failed' })
      }
    }
    const credentialKey = provider === 'openai' ? 'openai_api_key' : provider === 'gemini' ? 'gemini_api_key' : 'openrouter_api_key'
    let response
    try {
      const key = await this.credentials?.get(credentialKey)
      if (typeof key !== 'string' || !key) throw new Error('Credential unavailable')
      response = await this.providerFetch(PROVIDER_ENDPOINTS[provider], {
        method: 'GET',
        headers: provider === 'gemini' ? { 'x-goog-api-key': key } : { authorization: `Bearer ${key}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      })
      if (!response.ok || response.redirected) throw new Error('Provider request failed')
      const payload = await readProviderResponse(response)
      if (provider === 'gemini') {
        const models = Array.isArray(payload?.models)
          ? payload.models
            .filter(model => !Array.isArray(model?.supportedGenerationMethods) || model.supportedGenerationMethods.includes('generateContent'))
            .map(model => typeof model?.name === 'string' ? model.name.split('/').pop() : null)
            .filter(model => validGeminiModelName(model))
          : []
        return json(res, 200, { success: true, modelCount: models.length, models: models.slice(0, 100) })
      }
      if (!Array.isArray(payload?.data)) throw new Error('Provider response invalid')
      return json(res, 200, { success: true, modelCount: payload.data.length })
    } catch {
      try { await response?.body?.cancel() } catch {}
      return json(res, 200, { success: false, error: 'Provider test failed' })
    }
  }

  chatSessionView(row) {
    let metadata
    try { metadata = row.metadata ? JSON.parse(row.metadata) : null } catch {}
    return {
      id: row.id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status === 'resolved' ? 'resolved' : 'active',
      ...(typeof row.channel === 'string' && row.channel ? { channel: row.channel } : {}),
      ...(typeof row.contact_id === 'string' && row.contact_id ? { contactId: row.contact_id } : {}),
      ...(typeof row.thread_id === 'string' && row.thread_id ? { threadId: row.thread_id } : {}),
      ...(typeof row.workspace_path === 'string' && row.workspace_path ? { workspacePath: row.workspace_path } : {}),
      ...(typeof row.topic === 'string' && row.topic ? { topic: row.topic } : {}),
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { metadata } : {}),
    }
  }

  chatMessageView(row) {
    let attachments
    let metadata
    try {
      const parsed = row.attachments ? JSON.parse(row.attachments) : null
      if (Array.isArray(parsed) && parsed.length) attachments = parsed
    } catch {}
    try {
      const parsed = row.metadata ? JSON.parse(row.metadata) : null
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed
    } catch {}
    return {
      id: row.message_id,
      role: row.role,
      content: row.content,
      createdAt: row.created_at,
      ...(attachments ? { attachments } : {}),
      ...(metadata ? metadata : {}),
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

  geminiProviderBody(rows) {
    const systemParts = []
    const contents = []
    for (const row of rows) {
      const message = this.providerMessage(row)
      if (row.role === 'system') {
        const text = typeof message.content === 'string' ? message.content : ''
        if (text) systemParts.push({ text })
        continue
      }
      const role = row.role === 'assistant' ? 'model' : 'user'
      const openaiParts = Array.isArray(message.content)
        ? message.content
        : [{ type: 'text', text: typeof message.content === 'string' ? message.content : '' }]
      const parts = openaiParts.flatMap(part => {
        if (part?.type === 'text' && typeof part.text === 'string') return [{ text: part.text }]
        if (part?.type === 'image_url' && typeof part.image_url?.url === 'string') {
          const match = /^data:([^;,]{1,128});base64,([A-Za-z0-9+/=]+)$/.exec(part.image_url.url)
          if (match) return [{ inlineData: { mimeType: match[1], data: match[2] } }]
        }
        return []
      })
      if (parts.length) contents.push({ role, parts })
    }
    return {
      contents,
      ...(systemParts.length ? { systemInstruction: { parts: systemParts } } : {}),
      generationConfig: { maxOutputTokens: 1024 },
    }
  }

  async chatSessions(req, res) {
    const mutation = req.method === 'POST'
    this.authorize(req, { mutation })
    if (req.method === 'GET') {
      const rows = this.db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC, id DESC LIMIT 100').all()
      return json(res, 200, { sessions: rows.map(row => this.chatSessionView(row)) })
    }
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 16 * 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Invalid session' })
    const keys = Object.keys(body).sort()
    if (keys.some(key => !['channel', 'contactId', 'id', 'status', 'threadId', 'title', 'workspacePath', 'topic'].includes(key))) return json(res, 400, { error: 'Invalid session fields' })
    const id = body.id === undefined ? crypto.randomUUID() : body.id
    const title = body.title === undefined ? 'New chat' : body.title
    const workspacePath = body.workspacePath === undefined || body.workspacePath === null ? null : body.workspacePath
    const status = body.status === undefined ? 'active' : body.status
    const channel = body.channel === undefined || body.channel === null ? null : body.channel
    const contactId = body.contactId === undefined || body.contactId === null ? null : body.contactId
    const threadId = body.threadId === undefined || body.threadId === null ? null : body.threadId
    const topic = body.topic === undefined || body.topic === null ? null : body.topic
    if (!this.validChatId(id) || !this.validChatTitle(title)
      || (workspacePath !== null && !validBoundedText(workspacePath, 1024))
      || !['active', 'resolved'].includes(status)
      || (channel !== null && (!validBoundedText(channel, MAX_CHAT_CHANNEL_LENGTH) || !['whatsapp', 'email', 'telegram', 'instagram', 'twitter', 'messenger', 'web'].includes(channel)))
      || (contactId !== null && !validBoundedText(contactId, MAX_CHAT_CONTACT_LENGTH))
      || (threadId !== null && !validBoundedText(threadId, MAX_CHAT_THREAD_LENGTH))
      || (topic !== null && (!validBoundedText(topic, 64) || !['Product Queries', 'Order Status', 'Returns/Refunds', 'Technical Support', 'Other'].includes(topic)))) return json(res, 400, { error: 'Invalid session' })
    const now = Date.now()
    const result = this.db.transaction(() => {
      const inserted = this.db.prepare('INSERT INTO chat_sessions(id,title,workspace_path,status,channel,contact_id,thread_id,topic,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING').run(id, title, workspacePath, status, channel, contactId, threadId, topic, now, now)
      const session = this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id)
      return { session, duplicate: inserted.changes === 0 }
    })()
    if (result.duplicate && result.session.title !== title) return json(res, 409, { error: 'Session already exists' })
    return json(res, result.duplicate ? 200 : 201, { session: this.chatSessionView(result.session), duplicate: result.duplicate })
    } finally {
      releaseOperation()
    }
  }

  async updateChatSession(req, res, rawId) {
    this.authorize(req, { mutation: true })
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
    if (!this.validChatId(rawId)) return json(res, 400, { error: 'Invalid session id' })
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req, 8 * 1024)
    const keys = Object.keys(body || {}).sort()
    if (!body || typeof body !== 'object' || Array.isArray(body) || keys.some((key) => !['channel', 'contactId', 'status', 'threadId', 'workspacePath', 'topic'].includes(key))) return json(res, 400, { error: 'Invalid session update' })
    if (!keys.length) return json(res, 400, { error: 'Invalid session update' })
    const workspacePath = body.workspacePath === undefined || body.workspacePath === null ? null : body.workspacePath
    const status = body.status === undefined ? undefined : body.status
    const channel = body.channel === undefined || body.channel === null ? null : body.channel
    const contactId = body.contactId === undefined || body.contactId === null ? null : body.contactId
    const threadId = body.threadId === undefined || body.threadId === null ? null : body.threadId
    const topic = body.topic === undefined || body.topic === null ? null : body.topic
    if ((keys.includes('workspacePath') && workspacePath !== null && !validBoundedText(workspacePath, 1024))
      || (keys.includes('status') && !['active', 'resolved'].includes(status))
      || (keys.includes('channel') && channel !== null && (!validBoundedText(channel, MAX_CHAT_CHANNEL_LENGTH) || !['whatsapp', 'email', 'telegram', 'instagram', 'twitter', 'messenger', 'web'].includes(channel)))
      || (keys.includes('contactId') && contactId !== null && !validBoundedText(contactId, MAX_CHAT_CONTACT_LENGTH))
      || (keys.includes('threadId') && threadId !== null && !validBoundedText(threadId, MAX_CHAT_THREAD_LENGTH))
      || (keys.includes('topic') && topic !== null && (!validBoundedText(topic, 64) || !['Product Queries', 'Order Status', 'Returns/Refunds', 'Technical Support', 'Other'].includes(topic)))) return json(res, 400, { error: 'Invalid session update' })
    const now = Date.now()
    const assignments = []
    const values = []
    if (keys.includes('workspacePath')) { assignments.push('workspace_path = ?'); values.push(workspacePath) }
    if (keys.includes('status')) { assignments.push('status = ?'); values.push(status) }
    if (keys.includes('channel')) { assignments.push('channel = ?'); values.push(channel) }
    if (keys.includes('contactId')) { assignments.push('contact_id = ?'); values.push(contactId) }
    if (keys.includes('threadId')) { assignments.push('thread_id = ?'); values.push(threadId) }
    if (keys.includes('topic')) { assignments.push('topic = ?'); values.push(topic) }
    assignments.push('updated_at = ?')
    values.push(now, rawId)
    const result = this.db.prepare(`UPDATE chat_sessions SET ${assignments.join(', ')} WHERE id = ?`).run(...values)
    if (!result.changes) return json(res, 404, { error: 'Session not found' })
    return json(res, 200, { session: this.chatSessionView(this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(rawId)) })
    } finally {
      releaseOperation()
    }
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
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
    if (!this.validChatId(rawId)) return json(res, 400, { error: 'Invalid session id' })
    if ([...this.generations].some(key => key.startsWith(`${rawId}:`))) {
      return json(res, 409, { error: 'Session generation is in progress' })
    }
    const deleted = this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(rawId).changes > 0
    return json(res, 200, { success: true, deleted })
    } finally {
      releaseOperation()
    }
  }

  async cancelGeneration(req, res, rawId, rawRequestId) {
    this.authorize(req, { mutation: true })
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
    if (!this.validChatId(rawId) || !/^[A-Za-z0-9_-]{1,128}$/.test(rawRequestId)) return json(res, 400, { error: 'Invalid generation id' })
    const requestKey = `${rawId}:${rawRequestId}`
    const controller = this.generationControllers.get(requestKey)
    if (controller) controller.abort()
    const deleted = this.db.prepare('DELETE FROM chat_generations WHERE request_id = ? AND session_id = ? AND status = \'processing\'').run(rawRequestId, rawId).changes > 0
    return json(res, 200, { cancelled: Boolean(controller || deleted) })
    } finally {
      releaseOperation()
    }
  }

  async addChatMessage(req, res, rawId) {
    this.authorize(req, { mutation: true })
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
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
    } finally {
      releaseOperation()
    }
  }

  async generateChat(req, res, rawId) {
    this.authorize(req, { mutation: true })
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return json(res, 409, { error: 'Settings migration is committing' })
    try {
      return await this.generateChatAdmitted(req, res, rawId)
    } finally {
      releaseOperation()
    }
  }

  async generateChatAdmitted(req, res, rawId) {
    if (this.migrationFence(req, res)) return
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
    let ollamaSettings
    try { ollamaSettings = parseOllamaSettings(JSON.parse(this.getState('ollama_settings', 'null'))) || OLLAMA_SETTINGS_DEFAULTS } catch { ollamaSettings = OLLAMA_SETTINGS_DEFAULTS }
    // Browser WebGPU is executed in the browser renderer, never by agentd.
    // Keep an explicit browser choice fail-closed instead of treating it as an
    // OpenRouter credential lookup through the shared server route.
    const providers = settings.preferredProvider === 'auto'
      ? ['openai', 'openrouter', 'gemini', 'ollama']
      : settings.preferredProvider === 'browser' ? [] : [settings.preferredProvider]
    const configuredModels = { openai: settings.openaiModel, gemini: settings.geminiModel, openrouter: settings.openrouterModel, ollama: ollamaSettings.model }
    const requestedModel = body.model === undefined ? null : body.model
    let provider = null
    let apiKey = null
    for (const candidate of providers) {
      if (candidate === 'ollama') {
        try {
          const response = await this.providerFetch(`${ollamaSettings.baseUrl}/api/tags`, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(3000),
          })
          if (!response.ok || response.redirected) continue
          const payload = await readProviderResponse(response)
          if (!Array.isArray(payload?.models) || !payload.models.length) continue
          provider = 'ollama'
          break
        } catch {}
        continue
      }
      const credentialKey = candidate === 'openai' ? 'openai_api_key' : candidate === 'gemini' ? 'gemini_api_key' : 'openrouter_api_key'
      let candidateKey = null
      try { candidateKey = await this.credentials?.get(credentialKey) } catch {}
      if (typeof candidateKey === 'string' && candidateKey) {
        provider = candidate
        apiKey = candidateKey
        break
      }
    }
    if (!provider || (provider !== 'ollama' && !apiKey)) return json(res, 503, { error: 'Provider unavailable' })
    const model = requestedModel || configuredModels[provider]
    if (!validModelName(model) || (provider === 'gemini' && !validGeminiModelName(model))) return json(res, 400, { error: 'Invalid model' })
    if (this.migrationFence(req, res)) return

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

    const wantsStream = /(?:^|,)\s*text\/event-stream\s*(?:;|,|$)/i.test(String(req.headers.accept || ''))
    const providerBody = provider === 'gemini'
      ? JSON.stringify(this.geminiProviderBody(prepared.messages))
      : JSON.stringify({ model, messages: prepared.messages.map((message) => this.providerMessage(message)), stream: wantsStream, max_tokens: 1024 })
    if (Buffer.byteLength(providerBody, 'utf8') > MAX_PROVIDER_REQUEST_BYTES) {
      this.db.prepare('DELETE FROM chat_generations WHERE request_id = ? AND status = \'processing\'').run(body.requestId)
      return json(res, 413, { error: 'Conversation context too large' })
    }
    this.generations.add(requestKey)
    const providerController = new AbortController()
    this.generationControllers.set(requestKey, providerController)
    const abortProvider = () => providerController.abort()
    req.once('aborted', abortProvider)
    res.once('close', abortProvider)
    const timeout = setTimeout(() => providerController.abort(), REQUEST_TIMEOUT_MS)
    if (wantsStream) res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
    let response
    try {
      const endpoint = provider === 'ollama'
        ? `${ollamaSettings.baseUrl}/v1/chat/completions`
        : provider === 'gemini'
          ? `https://generativelanguage.googleapis.com/v1beta/models/${model}:` + (wantsStream ? 'streamGenerateContent?alt=sse' : 'generateContent')
          : PROVIDER_CHAT_ENDPOINTS[provider]
      const providerHeaders = provider === 'gemini'
        ? { 'x-goog-api-key': apiKey }
        : provider === 'ollama' ? {} : { authorization: `Bearer ${apiKey}` }
      response = await this.providerFetch(endpoint, {
        method: 'POST',
        headers: { ...providerHeaders, 'content-type': 'application/json', ...(wantsStream ? { accept: 'text/event-stream' } : {}) },
        body: providerBody,
        redirect: 'manual',
        signal: providerController.signal,
      })
      if (!response.ok || response.redirected) throw new Error('Provider request failed')
      let content
      const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase()
      if (wantsStream && contentType.includes('text/event-stream')) {
        const readStream = provider === 'gemini' ? readGeminiStream : readProviderStream
        content = await readStream(response, (delta) => {
          if (!writeSse(res, { type: 'assistant.delta', sessionId: rawId, requestId: body.requestId, sequence: 1, delta })) throw new Error('Client disconnected')
        })
      } else {
        const payload = await readProviderResponse(response)
        content = provider === 'gemini' ? extractGeminiText(payload) : payload?.choices?.[0]?.message?.content
        if (wantsStream && typeof content === 'string' && content && !writeSse(res, { type: 'assistant.delta', sessionId: rawId, requestId: body.requestId, sequence: 1, delta: content })) throw new Error('Client disconnected')
      }
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
      if (wantsStream) {
        writeSse(res, { type: 'assistant.done', sessionId: rawId, requestId: body.requestId, sequence: 2 })
        res.end()
        return
      }
      return json(res, 200, this.generationView(result, false))
    } catch (error) {
      try { await response?.body?.cancel() } catch {}
      this.db.prepare('DELETE FROM chat_generations WHERE request_id = ? AND session_id = ? AND status = \'processing\'').run(body.requestId, rawId)
      if (wantsStream && res.headersSent && !res.destroyed && !res.writableEnded) {
        writeSse(res, { type: 'error', sessionId: rawId, requestId: body.requestId, sequence: 1, message: 'Provider generation failed' })
        res.end()
        return
      }
      if (!res.destroyed && !res.writableEnded) return json(res, 502, { error: 'Provider generation failed' })
    } finally {
      clearTimeout(timeout)
      req.off('aborted', abortProvider)
      res.off('close', abortProvider)
      this.generationControllers.delete(requestKey)
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
    if (this.migrationFence(req, res)) return
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'application/json required' })
    const body = await readBody(req)
    if (!['whatsapp', 'email', 'instagram', 'messenger', 'twitter'].includes(body.channel) || typeof body.providerEventId !== 'string' || !body.providerEventId || body.providerEventId.length > 300 || typeof body.conversationId !== 'string' || !body.conversationId || body.conversationId.length > 500) return json(res, 400, { error: 'Invalid event identity' })
    const payload = JSON.stringify(body.channel === 'whatsapp' ? redactPayload(body.payload ?? {}) : (body.payload ?? {}))
    const existing = this.db.prepare('SELECT id FROM inbound_events WHERE channel = ? AND provider_event_id = ?').get(body.channel, body.providerEventId)
    if (existing) return json(res, 200, { accepted: true, duplicate: true, id: existing.id })
    const result = this.db.prepare('INSERT INTO inbound_events(channel,provider_event_id,conversation_id,payload,status,created_at) VALUES (?,?,?,?,?,?)').run(body.channel, body.providerEventId, body.conversationId, payload, 'draft', Date.now())
    return json(res, 202, { accepted: true, duplicate: false, id: result.lastInsertRowid })
  }

  ingestWhatsAppServiceMessage(message) {
    if (this.migrationHold || !message || message.isFromMe === true || typeof message.providerEventId !== 'string' || !/^[\x21-\x7e]{1,300}$/.test(message.providerEventId) || typeof message.conversationId !== 'string' || !message.conversationId.trim()) return
    const payload = {
      from: typeof message.from === 'string' ? message.from : 'unknown',
      to: typeof message.to === 'string' ? message.to : '',
      body: typeof message.content === 'string' ? message.content : '',
      bodyType: 'text',
      timestamp: Number.isSafeInteger(message.timestamp) ? message.timestamp : Date.now(),
      messageId: typeof message.id === 'string' ? message.id : message.providerEventId,
      isFromMe: false,
      ...(typeof message.type === 'string' ? { messageType: message.type } : {}),
    }
    const payloadJson = JSON.stringify(redactPayload(payload))
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_WHATSAPP_PAYLOAD_BYTES) return
    this.db.prepare('INSERT INTO inbound_events(channel,provider_event_id,conversation_id,payload,status,created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(channel,provider_event_id) DO NOTHING').run('whatsapp', message.providerEventId, message.conversationId.slice(0, 500), payloadJson, 'draft', Date.now())
  }

  async whatsappInbound(req, res, url) {
    this.authorize(req, { mutation: req.method === 'POST' })
    if (req.method === 'POST' && this.migrationFence(req, res)) return
    if (req.method === 'GET') {
      const requestedAfter = Number.parseInt(url.searchParams.get('after_id') || '0', 10)
      const afterId = Number.isSafeInteger(requestedAfter) && requestedAfter >= 0 ? requestedAfter : 0
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '20', 10)
      const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), MAX_WHATSAPP_INBOUND_BATCH) : 20
      const rows = this.db.prepare('SELECT id,provider_event_id,conversation_id,payload,status,created_at FROM inbound_events WHERE channel = ? AND id > ? ORDER BY id ASC LIMIT ?').all('whatsapp', afterId, limit)
      return json(res, 200, {
        events: rows.map(row => ({
          id: row.id,
          providerEventId: row.provider_event_id,
          conversationId: row.conversation_id,
          payload: JSON.parse(row.payload),
          status: row.status,
          createdAt: row.created_at,
        })),
        nextAfterId: rows.length ? rows[rows.length - 1].id : afterId,
      })
    }
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
    const outbox = this.db.prepare('SELECT status,provider_message_id,error,attempts FROM whatsapp_outbox WHERE draft_id = ?').get(row.id)
    return {
      id: row.id,
      channel: row.channel,
      providerEventId: row.provider_event_id,
      conversationId: row.conversation_id,
      responseText: row.response_text,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(outbox ? {
        sendStatus: outbox.status,
        ...(typeof outbox.provider_message_id === 'string' ? { providerMessageId: outbox.provider_message_id } : {}),
        ...(typeof outbox.error === 'string' ? { sendError: outbox.error } : {}),
        sendAttempts: outbox.attempts,
      } : {}),
    }
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
    if (next === 'sent') return json(res, 409, { error: 'Use the WhatsApp send route to mark a draft sent' })
    const allowed = { draft: new Set(['draft', 'approved', 'rejected']), approved: new Set(['approved']), rejected: new Set(['rejected']), sent: new Set(['sent']) }
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

  async performWhatsAppDraftSend(id) {
    const releaseOperation = this.beginActiveOperation()
    if (!releaseOperation) return { status: 409, body: { error: 'Settings migration is committing' } }
    try {
      const draft = this.db.prepare('SELECT * FROM whatsapp_drafts WHERE id = ?').get(id)
      if (!draft) return { status: 404, body: { error: 'Draft not found' } }
      if (!['approved', 'sent'].includes(draft.status)) return { status: 409, body: { error: 'Draft must be approved before sending' } }

      const existing = this.db.prepare('SELECT * FROM whatsapp_outbox WHERE draft_id = ?').get(id)
      if (existing?.status === 'failed' && [OUTBOX_QUARANTINED_ERROR, OUTBOX_CANCELLED_ERROR].includes(existing.error)) {
        return { status: 409, body: { error: `Draft outbox is ${existing.error.toLowerCase()}` } }
      }
      if (existing?.status === 'sent' && existing.provider_message_id) {
        return { status: 200, body: { success: true, duplicate: true, providerMessageId: existing.provider_message_id, draft: this.draftView(draft) } }
      }
      if (existing?.status === 'pending') return { status: 409, body: { error: 'WhatsApp send is already pending' } }

      const now = Date.now()
      const claimed = this.db.transaction(() => {
        const current = this.db.prepare('SELECT * FROM whatsapp_drafts WHERE id = ?').get(id)
        if (!current) return { missing: true }
        if (!['approved', 'sent'].includes(current.status)) return { invalid: true }
        const prior = this.db.prepare('SELECT * FROM whatsapp_outbox WHERE draft_id = ?').get(id)
        if (prior?.status === 'sent' && prior.provider_message_id) return { sent: prior }
        if (prior?.status === 'pending') return { pending: true }
        this.db.prepare(`INSERT INTO whatsapp_outbox(draft_id,status,attempts,created_at,updated_at)
          VALUES (?,?,?,?,?)
          ON CONFLICT(draft_id) DO UPDATE SET status = 'pending', error = NULL, attempts = whatsapp_outbox.attempts + 1, updated_at = excluded.updated_at`).run(id, 'pending', prior?.attempts ? prior.attempts + 1 : 1, now, now)
        return { current }
      })()
      if (claimed.missing) return { status: 404, body: { error: 'Draft not found' } }
      if (claimed.invalid) return { status: 409, body: { error: 'Draft must be approved before sending' } }
      if (claimed.sent) return { status: 200, body: { success: true, duplicate: true, providerMessageId: claimed.sent.provider_message_id, draft: this.draftView(draft) } }
      if (claimed.pending) return { status: 409, body: { error: 'WhatsApp send is already pending' } }

      // Inbound conversation IDs may be stored as `+15551234567` or as a
      // WhatsApp JID. Strip only the known JID suffix; never guess a recipient.
      const recipient = draft.conversation_id.replace(/@s\.whatsapp\.net$/i, '')
      this.assertMigrationOpen()
      const { providerMessageId } = await this.sendWhatsAppConfiguredMessage(recipient, draft.response_text)
      this.db.transaction(() => {
        this.db.prepare("UPDATE whatsapp_outbox SET status = 'sent', provider_message_id = ?, error = NULL, updated_at = ? WHERE draft_id = ?").run(providerMessageId, Date.now(), id)
        this.db.prepare("UPDATE whatsapp_drafts SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'approved'").run(Date.now(), id)
      })()
      return { status: 200, body: { success: true, duplicate: false, providerMessageId, draft: this.draftView(this.db.prepare('SELECT * FROM whatsapp_drafts WHERE id = ?').get(id)) } }
    } catch (error) {
      const message = Number.isInteger(error?.statusCode) && error.statusCode !== 502 ? error.message : 'WhatsApp message failed'
      this.db.prepare("UPDATE whatsapp_outbox SET status = 'failed', error = ?, updated_at = ? WHERE draft_id = ?").run(message, Date.now(), id)
      const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 502
      return { status: statusCode, body: { success: false, error: message } }
    } finally {
      releaseOperation()
    }
  }

  async readEmptyDraftMutation(req, res, message) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      json(res, 415, { error: 'application/json required' })
      return false
    }
    let body
    try { body = await readBody(req, 1024) } catch (error) {
      json(res, Number.isInteger(error?.statusCode) ? error.statusCode : 400, { error: error?.statusCode === 413 ? 'Request body too large' : 'Invalid JSON' })
      return false
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
      json(res, 400, { error: message })
      return false
    }
    return true
  }

  async sendWhatsAppDraft(req, res, id) {
    this.authorize(req, { mutation: true })
    if (this.migrationFence(req, res)) return
    if (!await this.readEmptyDraftMutation(req, res, 'Draft send accepts no input')) return
    const result = await this.performWhatsAppDraftSend(id)
    return json(res, result.status, result.body)
  }

  async retryWhatsAppDraft(req, res, id) {
    this.authorize(req, { mutation: true })
    if (this.migrationFence(req, res)) return
    if (!await this.readEmptyDraftMutation(req, res, 'Draft retry accepts no input')) return
    const outbox = this.db.prepare('SELECT status,error FROM whatsapp_outbox WHERE draft_id = ?').get(id)
    if (!outbox) return json(res, 409, { error: 'Draft has no failed outbox to retry' })
    if (outbox.status === 'pending') return json(res, 409, { error: 'WhatsApp send is already pending' })
    if (outbox.status === 'sent') return json(res, 409, { error: 'WhatsApp draft is already sent' })
    if (outbox.error === OUTBOX_QUARANTINED_ERROR || outbox.error === OUTBOX_CANCELLED_ERROR) return json(res, 409, { error: 'Draft outbox is operator-disposed' })
    if (outbox.status !== 'failed') return json(res, 409, { error: 'Draft outbox is not retryable' })
    const result = await this.performWhatsAppDraftSend(id)
    return json(res, result.status, result.body)
  }

  async dispositionWhatsAppDraft(req, res, id, disposition) {
    this.authorize(req, { mutation: true })
    if (!await this.readEmptyDraftMutation(req, res, 'Draft disposition accepts no input')) return
    const draft = this.db.prepare('SELECT * FROM whatsapp_drafts WHERE id = ?').get(id)
    if (!draft) return json(res, 404, { error: 'Draft not found' })
    const outbox = this.db.prepare('SELECT status,error FROM whatsapp_outbox WHERE draft_id = ?').get(id)
    if (!outbox) return json(res, 409, { error: 'Draft has no outbound attempt to dispose' })
    if (outbox.status === 'sent') return json(res, 409, { error: 'Sent drafts cannot be disposed' })
    if (outbox.status === 'pending') return json(res, 409, { error: 'Pending sends cannot be disposed while provider work is active' })
    if (outbox.status !== 'failed') return json(res, 409, { error: 'Draft outbox is not disposable' })
    if (outbox.error === OUTBOX_QUARANTINED_ERROR || outbox.error === OUTBOX_CANCELLED_ERROR) {
      if (outbox.error !== disposition) return json(res, 409, { error: 'Draft outbox already has an operator disposition' })
      return json(res, 200, this.draftView(draft))
    }
    const updated = this.db.prepare(`UPDATE whatsapp_outbox
      SET error = ?, updated_at = ?
      WHERE draft_id = ? AND status = ? AND (error IS NULL OR error NOT IN (?, ?))`)
      .run(disposition, Date.now(), id, 'failed', OUTBOX_QUARANTINED_ERROR, OUTBOX_CANCELLED_ERROR)
    if (updated.changes === 0) return json(res, 409, { error: 'Draft outbox changed before the operator disposition was applied' })
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

  autonomyMetrics(req, res, url) {
    this.authorize(req)
    const requestedDays = Number.parseInt(url.searchParams.get('days') || '14', 10)
    const days = Number.isSafeInteger(requestedDays) ? Math.min(Math.max(requestedDays, 1), 90) : 14
    const since = Date.now() - days * 24 * 60 * 60 * 1000
    const inbound = this.db.prepare('SELECT COUNT(*) AS count FROM inbound_events WHERE created_at >= ?').get(since).count
    const draftCounts = this.db.prepare("SELECT status,COUNT(*) AS count FROM whatsapp_drafts WHERE created_at >= ? GROUP BY status").all(since)
    const outboxCounts = this.db.prepare("SELECT status,COUNT(*) AS count FROM whatsapp_outbox WHERE created_at >= ? GROUP BY status").all(since)
    const generationCounts = this.db.prepare("SELECT COUNT(*) AS count FROM chat_generations WHERE created_at >= ? AND status = 'completed'").get(since).count
    const draftByStatus = Object.fromEntries(draftCounts.map((row) => [row.status, row.count]))
    const outboxByStatus = Object.fromEntries(outboxCounts.map((row) => [row.status, row.count]))
    const totalDrafts = Object.values(draftByStatus).reduce((sum, count) => sum + count, 0)
    const approvedDrafts = (draftByStatus.approved || 0) + (draftByStatus.sent || 0)
    return json(res, 200, {
      inbound,
      sent: outboxByStatus.sent || 0,
      escalated: 0,
      drafts: (draftByStatus.draft || 0) + (draftByStatus.approved || 0),
      failed: outboxByStatus.failed || 0,
      averageDecisionLatencyMs: 0,
      llmCalls: generationCounts,
      averageLlmLatencyMs: 0,
      groundedDecisionRate: 0,
      deliveryUnknown: outboxByStatus.pending || 0,
      draftApprovalRate: totalDrafts ? approvedDrafts / totalDrafts : 0,
      averageDraftEditingTimeMs: 0,
      estimatedCostPerResolvedConversation: 0,
      reviewedDecisions: 0,
      reviewAccuracy: 0,
      escalationPrecision: 0,
      unnecessaryEscalations: 0,
      missedEscalations: 0,
      recoveryDrills: 0,
      averageRecoveryTimeMs: 0,
      days,
    })
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

function validGeminiModelName(value) {
  return validModelName(value) && /^gemini-[A-Za-z0-9._:-]+$/.test(value)
}

function parseLlmSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  const legacy = keys.length === 3 && keys.join(',') === 'openaiModel,openrouterModel,preferredProvider'
  const current = keys.length === 4 && keys.join(',') === 'geminiModel,openaiModel,openrouterModel,preferredProvider'
  if ((!legacy && !current)
    || !['auto', 'openai', 'openrouter', 'ollama', 'gemini', 'browser'].includes(value.preferredProvider)
    || !validModelName(value.openaiModel)
    || (current && !validGeminiModelName(value.geminiModel))
    || !validModelName(value.openrouterModel)) return null
  return {
    preferredProvider: value.preferredProvider,
    openaiModel: value.openaiModel,
    geminiModel: current ? value.geminiModel : LLM_SETTINGS_DEFAULTS.geminiModel,
    openrouterModel: value.openrouterModel,
  }
}

function parseOllamaSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys.join(',') !== 'baseUrl,model'
    || !validModelName(value.model)
    || typeof value.baseUrl !== 'string' || value.baseUrl.length > 256) return null
  let parsed
  try { parsed = new URL(value.baseUrl) } catch { return null }
  if (parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname)) return null
  const baseUrl = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
  return { baseUrl, model: value.model }
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
  // The browser product has one durable memory implementation today: the
  // daemon-owned SQLite store. Keep accepting the legacy Electron
  // `server-memory` value so an older browser profile can recover, but
  // canonicalize it before it is returned or persisted. This prevents the
  // settings UI from advertising a backend that agentd cannot instantiate.
  return {
    theme: value.theme,
    playwrightBrowser: value.playwrightBrowser,
    playwrightHeadless: value.playwrightHeadless,
    fileSystemSafeMode: value.fileSystemSafeMode,
    memoryBackend: value.memoryBackend === 'server-memory' ? 'sqlite' : value.memoryBackend,
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

function parseWhatsAppUiSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  const legacyShape = keys.length === 2 && keys.join(',') === 'targetPhoneNumber,whatsappEnabled'
  const currentShape = keys.length === 3 && keys.join(',') === 'businessBotMode,targetPhoneNumber,whatsappEnabled'
  if ((!legacyShape && !currentShape)
    || typeof value.whatsappEnabled !== 'boolean'
    || (currentShape && typeof value.businessBotMode !== 'boolean')
    || (value.targetPhoneNumber !== null
      && (typeof value.targetPhoneNumber !== 'string'
        || value.targetPhoneNumber.length > 32
        || !/^\+?[0-9\s().-]+$/.test(value.targetPhoneNumber)
        || !/^\d{8,15}$/.test(value.targetPhoneNumber.replace(/\D/g, ''))))) return null
  return {
    whatsappEnabled: value.whatsappEnabled,
    businessBotMode: currentShape ? value.businessBotMode : false,
    targetPhoneNumber: value.targetPhoneNumber,
  }
}

function parseEmailSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value).sort()
  const expected = Object.keys(EMAIL_SETTINGS_DEFAULTS).sort()
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return null
  if (!validBoundedText(value.accountName, 128)
    || !['imap-smtp', 'gmail-api', 'outlook-api', 'custom-mcp'].includes(value.provider)
    || !['app-password', 'google-oauth'].includes(value.gmailAuthMode)
    || !validBoundedText(value.imapHost, 256, true)
    || !Number.isSafeInteger(value.imapPort) || value.imapPort < 1 || value.imapPort > 65535
    || !validBoundedText(value.smtpHost, 256, true)
    || !Number.isSafeInteger(value.smtpPort) || value.smtpPort < 1 || value.smtpPort > 65535
    || !validBoundedText(value.emailAddress, 320, true)
    || !validBoundedText(value.userName, 320, true)
    || typeof value.imapTls !== 'boolean' || typeof value.smtpTls !== 'boolean'
    || !Number.isSafeInteger(value.pollingIntervalSeconds) || value.pollingIntervalSeconds < 30 || value.pollingIntervalSeconds > 86400
    || typeof value.enabled !== 'boolean' || typeof value.autoReplyMode !== 'boolean' || typeof value.draftMode !== 'boolean') return null
  return {
    accountName: value.accountName.trim(),
    provider: value.provider,
    gmailAuthMode: value.gmailAuthMode,
    imapHost: value.imapHost.trim(),
    imapPort: value.imapPort,
    smtpHost: value.smtpHost.trim(),
    smtpPort: value.smtpPort,
    emailAddress: value.emailAddress.trim(),
    userName: value.userName.trim(),
    imapTls: value.imapTls,
    smtpTls: value.smtpTls,
    pollingIntervalSeconds: value.pollingIntervalSeconds,
    enabled: value.enabled,
    autoReplyMode: value.autoReplyMode,
    draftMode: value.draftMode,
  }
}

function parseEmailInbound(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!validBoundedText(value.providerEventId, 300) || !validBoundedText(value.conversationId, 500)) return null
  const payload = value.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  if (!validBoundedText(payload.from, 320) || !validBoundedText(payload.to, 320, true)
    || !validBoundedText(payload.subject, 998, true) || !validBoundedText(payload.body, 128 * 1024, true)
    || !['text', 'html'].includes(payload.bodyType)
    || !Number.isFinite(payload.timestamp) || payload.timestamp < 0
    || (payload.messageId !== undefined && !validBoundedText(payload.messageId, 998, true))
    || (payload.inReplyTo !== undefined && !validBoundedText(payload.inReplyTo, 998, true))
    || (payload.references !== undefined && !validBoundedText(payload.references, 8192, true))
    || (payload.isFromMe !== undefined && typeof payload.isFromMe !== 'boolean')
    || (payload.attachments !== undefined && (!Array.isArray(payload.attachments) || payload.attachments.length > MAX_EMAIL_ATTACHMENT_COUNT || payload.attachments.some(attachment => !parseEmailAttachmentMetadata(attachment))))) return null
  return { providerEventId: value.providerEventId, conversationId: value.conversationId, payload }
}

function parseEmailAttachmentMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.some(key => !['id', 'name', 'mimeType', 'size'].includes(key))) return null
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.id)) return null
  if (value.name !== undefined && (!validBoundedText(value.name, MAX_EMAIL_ATTACHMENT_NAME_LENGTH, true) || /[\u0000\r\n]/.test(value.name))) return null
  if (value.mimeType !== undefined && (!validBoundedText(value.mimeType, MAX_EMAIL_ATTACHMENT_MIME_LENGTH, true) || /[\u0000\r\n]/.test(value.mimeType))) return null
  if (value.size !== undefined && (!Number.isSafeInteger(value.size) || value.size < 0 || value.size > MAX_SCANNED_EMAIL_ATTACHMENT_BYTES)) return null
  return {
    id: value.id,
    ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim() } : {}),
    ...(typeof value.mimeType === 'string' && value.mimeType.trim() ? { mimeType: value.mimeType.trim() } : {}),
    ...(Number.isSafeInteger(value.size) ? { size: value.size } : {}),
  }
}

function parseEmailDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const allowedKeys = ['accountName', 'attachments', 'createdAt', 'id', 'inReplyTo', 'originalFrom', 'originalSubject', 'policyDecision', 'references', 'replyTo', 'responseText', 'status']
  if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return null
  const policy = value.policyDecision
  if (!/^draft_[A-Za-z0-9_-]{1,120}$/.test(value.id || '')
    || !validBoundedText(value.responseText, MAX_EMAIL_DRAFT_TEXT_LENGTH)
    || !validBoundedText(value.originalFrom, 320)
    || !validBoundedText(value.originalSubject, 998, true)
    || !validBoundedText(value.replyTo, 320)
    || (value.inReplyTo !== undefined && !validBoundedText(value.inReplyTo, 998, true))
    || (value.references !== undefined && !validBoundedText(value.references, 8192, true))
    || (value.accountName !== undefined && !validBoundedText(value.accountName, 128, true))
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || !EMAIL_DRAFT_STATUSES.includes(value.status)
    || !policy || typeof policy !== 'object' || Array.isArray(policy)
    || !['send', 'draft', 'escalate'].includes(policy.action)
    || typeof policy.confidence !== 'number' || !Number.isFinite(policy.confidence) || policy.confidence < 0 || policy.confidence > 1
    || !validBoundedText(policy.rationale, 4096, true)
    || typeof policy.hasSensitiveTopic !== 'boolean'
    || !Array.isArray(policy.sensitiveTopics) || policy.sensitiveTopics.length > 32
    || policy.sensitiveTopics.some((topic) => !validBoundedText(topic, 128))
    || (value.attachments !== undefined && (!Array.isArray(value.attachments) || value.attachments.length > MAX_EMAIL_DRAFT_ATTACHMENT_COUNT || value.attachments.some((attachment) => !parseEmailDraftAttachment(attachment))))) return null
  const attachments = Array.isArray(value.attachments) ? value.attachments.map(parseEmailDraftAttachment) : []
  if (attachments.some((attachment) => !attachment) || attachments.reduce((total, attachment) => total + (attachment?.size || 0), 0) > MAX_EMAIL_DRAFT_ATTACHMENT_TOTAL_BYTES) return null
  return {
    id: value.id,
    responseText: value.responseText,
    originalFrom: value.originalFrom,
    originalSubject: value.originalSubject,
    replyTo: value.replyTo,
    ...(value.inReplyTo !== undefined && value.inReplyTo ? { inReplyTo: value.inReplyTo } : {}),
    ...(value.references !== undefined && value.references ? { references: value.references } : {}),
    ...(value.accountName !== undefined && value.accountName ? { accountName: value.accountName } : {}),
    ...(attachments.length ? { attachments } : {}),
    policyDecision: {
      action: policy.action,
      confidence: policy.confidence,
      rationale: policy.rationale,
      hasSensitiveTopic: policy.hasSensitiveTopic,
      sensitiveTopics: [...policy.sensitiveTopics],
    },
    createdAt: value.createdAt,
    status: value.status,
  }
}

function parseEmailDraftAttachment(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const keys = Object.keys(value)
  if (keys.some((key) => !['dataBase64', 'mimeType', 'name', 'size'].includes(key))) return null
  if (!validBoundedText(value.name, MAX_EMAIL_ATTACHMENT_NAME_LENGTH) || /[\u0000\r\n\\/]/.test(value.name)) return null
  if (!validBoundedText(value.mimeType, MAX_EMAIL_ATTACHMENT_MIME_LENGTH) || /[\u0000\r\n]/.test(value.mimeType)) return null
  const mimeType = value.mimeType.trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) return null
  if (typeof value.dataBase64 !== 'string' || value.dataBase64.length > MAX_EMAIL_DRAFT_ATTACHMENT_BASE64_LENGTH || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.dataBase64) || value.dataBase64.length % 4 === 1) return null
  const bytes = Buffer.from(value.dataBase64, 'base64')
  if (!bytes.length || bytes.toString('base64') !== value.dataBase64 || !Number.isSafeInteger(value.size) || value.size !== bytes.length || value.size > MAX_EMAIL_DRAFT_ATTACHMENT_TOTAL_BYTES) return null
  const scan = scanEmailAttachment({ bytes: new Uint8Array(bytes), mimeType })
  if (!scan.safe) return null
  return { name: value.name.trim(), mimeType, size: value.size, dataBase64: value.dataBase64 }
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

function extractGeminiText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return null
  const text = parts.map(part => typeof part?.text === 'string' ? part.text : '').join('')
  return text || null
}

async function readGeminiStream(response, onDelta) {
  if (!response.body) throw new Error('Provider response missing')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventData = []
  let size = 0
  let content = ''
  let sawDone = false

  const consume = raw => {
    const data = raw.trim()
    if (!data) return
    let payload
    try { payload = JSON.parse(data) } catch { throw new Error('Provider stream response invalid') }
    if (payload?.error) throw new Error('Provider stream response invalid')
    const candidateText = extractGeminiText(payload)
    const eventText = payload?.event_type === 'content.delta' && payload?.delta?.type === 'text' ? payload.delta.text : null
    const delta = typeof candidateText === 'string' ? candidateText : eventText
    if (typeof delta !== 'string' || !delta) return
    content += delta
    if (content.length > MAX_CHAT_CONTENT_LENGTH || Buffer.byteLength(content, 'utf8') > MAX_CHAT_CONTENT_LENGTH) throw new Error('Provider response too large')
    onDelta(delta)
    sawDone = true
  }

  const flushEvent = () => {
    if (!eventData.length) return
    const data = eventData.join('\n')
    eventData = []
    consume(data)
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('Provider response too large')
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line) flushEvent()
      else if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart())
    }
  }
  buffer += decoder.decode()
  for (const line of buffer.split(/\r?\n/)) {
    if (!line) flushEvent()
    else if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart())
  }
  flushEvent()
  if (!sawDone || !content) throw new Error('Provider stream ended before completion')
  return content
}

function writeSse(res, payload) {
  if (res.destroyed || res.writableEnded) return false
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
  return true
}

async function readProviderStream(response, onDelta) {
  if (!response.body) throw new Error('Provider response missing')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventData = []
  let size = 0
  let content = ''
  let done = false

  const consume = (raw) => {
    const data = raw.trim()
    if (!data || data === '[DONE]') {
      if (data === '[DONE]') done = true
      return
    }
    let payload
    try { payload = JSON.parse(data) } catch { throw new Error('Provider stream response invalid') }
    if (payload?.error) throw new Error('Provider stream response invalid')
    const delta = payload?.choices?.[0]?.delta?.content
    if (delta === undefined || delta === null) return
    if (typeof delta !== 'string') throw new Error('Provider stream response invalid')
    content += delta
    if (content.length > MAX_CHAT_CONTENT_LENGTH || Buffer.byteLength(content, 'utf8') > MAX_CHAT_CONTENT_LENGTH) throw new Error('Provider response too large')
    onDelta(delta)
  }

  const flushEvent = () => {
    if (!eventData.length) return
    const data = eventData.join('\n')
    eventData = []
    consume(data)
  }

  while (!done) {
    const { done: readerDone, value } = await reader.read()
    if (readerDone) break
    size += value.byteLength
    if (size > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('Provider response too large')
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line) flushEvent()
      else if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart())
    }
  }
  buffer += decoder.decode()
  for (const line of buffer.split(/\r?\n/)) {
    if (!line) flushEvent()
    else if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart())
  }
  flushEvent()
  if (!done) throw new Error('Provider stream ended before completion')
  return content
}

module.exports = { AgentdServer, MCP_LIFECYCLE, PAIRING_TTL_MS, resolveDataDir, parseWhatsAppSettings, WHATSAPP_SETTINGS_DEFAULTS, parseWhatsAppUiSettings, WHATSAPP_UI_DEFAULTS, parseOllamaSettings, OLLAMA_SETTINGS_DEFAULTS, parseProductPreferences, PRODUCT_PREFERENCES_DEFAULTS }
