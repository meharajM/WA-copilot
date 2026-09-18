const crypto = require('node:crypto')

const AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GMAIL_API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me'
const TOKEN_BUFFER_MS = 60 * 1000
const PENDING_TTL_MS = 10 * 60 * 1000
const MAX_RESPONSE_BYTES = 256 * 1024
const SCOPES = Object.freeze([
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
])

function boundedOrigin(origin) {
  let value
  try { value = new URL(origin) } catch { throw new Error('Invalid agentd origin') }
  if (value.protocol !== 'http:' || value.hostname !== '127.0.0.1' || value.username || value.password
    || value.pathname !== '/' || value.search || value.hash || !value.port || !Number.isSafeInteger(Number(value.port))) {
    throw new Error('Invalid agentd origin')
  }
  return value.origin
}

async function readJson(response) {
  const length = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('Google response too large')
  if (!response.body) return {}
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Google response too large')
      }
      chunks.push(Buffer.from(next.value))
    }
  } finally { reader.releaseLock() }
  const text = Buffer.concat(chunks, size).toString('utf8')
  try { return text ? JSON.parse(text) : {} } catch { throw new Error('Google response was invalid') }
}

function safeEmail(value) {
  if (typeof value !== 'string' || value.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(value)) return null
  return value.trim().toLowerCase()
}

function safeHeaderValue(value, max = 998) {
  return typeof value === 'string' && value.length <= max && !/[\r\n\u0000]/.test(value) ? value : null
}

class GmailOAuthService {
  constructor({ credentials = null, fetchImpl = fetch, clientId = process.env.GMAIL_OAUTH_CLIENT_ID || '', clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET || '', logger = console } = {}) {
    this.credentials = credentials
    this.fetchImpl = fetchImpl
    this.clientId = typeof clientId === 'string' ? clientId.trim() : ''
    this.clientSecret = typeof clientSecret === 'string' ? clientSecret.trim() : ''
    this.logger = logger
    this.initialized = false
    this.refreshToken = null
    this.email = null
    this.accessToken = null
    this.accessTokenExpiry = 0
    this.requiresReauthentication = false
    this.credentialUnavailable = false
    this.pending = new Map()
    this.stateGet = () => null
    this.stateSet = () => {}
  }

  configureStateAccessors({ get, set } = {}) {
    if (typeof get === 'function') this.stateGet = get
    if (typeof set === 'function') this.stateSet = set
  }

  async initialize() {
    if (this.initialized) return
    this.initialized = true
    this.email = safeEmail(this.stateGet('gmail_oauth_email'))
    if (!this.credentials) {
      this.credentialUnavailable = true
      this.requiresReauthentication = Boolean(this.email)
      return
    }
    try {
      this.refreshToken = await this.credentials.get('gmail_oauth_refresh_token')
      if (typeof this.refreshToken !== 'string' || !this.refreshToken) this.refreshToken = null
    } catch {
      this.credentialUnavailable = true
      this.requiresReauthentication = true
    }
    if (!this.clientId) {
      try { this.clientId = (await this.credentials.get('gmail_oauth_client_id')) || '' } catch { this.credentialUnavailable = true }
      this.clientId = this.clientId.trim()
    }
  }

  getStatus() {
    return {
      signedIn: Boolean(this.refreshToken) && !this.requiresReauthentication,
      email: this.email || null,
      requiresReauthentication: this.requiresReauthentication,
    }
  }

  async start(origin) {
    await this.initialize()
    if (!this.clientId) throw new Error('Google OAuth is not configured in this app')
    const redirectUri = `${boundedOrigin(origin)}/api/v1/email/oauth/callback`
    const state = crypto.randomBytes(24).toString('base64url')
    const verifier = crypto.randomBytes(32).toString('base64url')
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
    const expiresAt = Date.now() + PENDING_TTL_MS
    for (const [pendingState, pendingRequest] of this.pending) {
      if (pendingRequest.expiresAt <= Date.now()) this.pending.delete(pendingState)
    }
    if (this.pending.size >= 4) this.pending.delete(this.pending.keys().next().value)
    this.pending.set(state, { verifier, redirectUri, expiresAt })
    const url = new URL(AUTHORIZATION_URL)
    url.searchParams.set('client_id', this.clientId)
    url.searchParams.set('redirect_uri', redirectUri)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', SCOPES.join(' '))
    url.searchParams.set('access_type', 'offline')
    url.searchParams.set('prompt', 'consent')
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    return { authorizationUrl: url.toString(), expiresAt }
  }

  async complete({ code, state, error } = {}) {
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(state)) throw new Error('Invalid Google OAuth state')
    const pending = this.pending.get(state)
    this.pending.delete(state)
    if (!pending || pending.expiresAt <= Date.now()) throw new Error('Google OAuth sign-in expired')
    if (error) throw new Error('Google OAuth sign-in was cancelled')
    if (typeof code !== 'string' || code.length < 1 || code.length > 4096 || /[\r\n]/.test(code)) throw new Error('Google OAuth callback did not return an authorization code')
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.clientId, redirect_uri: pending.redirectUri, code_verifier: pending.verifier })
    if (this.clientSecret) body.set('client_secret', this.clientSecret)
    const response = await this.fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const payload = await readJson(response)
    if (!response.ok || typeof payload.access_token !== 'string' || !payload.access_token) throw new Error('Google OAuth token exchange failed')
    this.accessToken = payload.access_token
    this.accessTokenExpiry = Date.now() + (Number.isFinite(payload.expires_in) ? payload.expires_in * 1000 : 3600 * 1000)
    if (typeof payload.refresh_token === 'string' && payload.refresh_token) {
      if (!this.credentials) throw new Error('OS credential store unavailable')
      await this.credentials.set('gmail_oauth_refresh_token', payload.refresh_token)
      this.refreshToken = payload.refresh_token
    }
    if (!this.refreshToken) throw new Error('Google OAuth did not return a refresh token')
    const profile = await this.fetchProfile(this.accessToken)
    this.email = safeEmail(profile.email)
    if (this.email) this.stateSet('gmail_oauth_email', this.email)
    this.requiresReauthentication = false
    this.credentialUnavailable = false
    return this.getStatus()
  }

  async signOut() {
    await this.initialize()
    this.pending.clear()
    this.accessToken = null
    this.accessTokenExpiry = 0
    this.refreshToken = null
    this.email = null
    this.requiresReauthentication = false
    if (this.credentials) {
      try { await this.credentials.delete('gmail_oauth_refresh_token') } catch { this.requiresReauthentication = true; throw new Error('OS credential store operation failed') }
    }
    this.stateSet('gmail_oauth_email', null)
  }

  async getAccessToken() {
    await this.initialize()
    if (this.accessToken && this.accessTokenExpiry > Date.now() + TOKEN_BUFFER_MS) return this.accessToken
    if (!this.refreshToken || !this.clientId) return null
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.refreshToken, client_id: this.clientId })
    if (this.clientSecret) body.set('client_secret', this.clientSecret)
    const response = await this.fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(), redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    const payload = await readJson(response)
    if (!response.ok || typeof payload.access_token !== 'string' || !payload.access_token) {
      if (response.status === 400 || response.status === 401 || response.status === 403 || payload.error === 'invalid_grant' || payload.error === 'unauthorized_client') {
        this.accessToken = null
        this.accessTokenExpiry = 0
        this.requiresReauthentication = true
      }
      throw new Error('Gmail OAuth token refresh failed')
    }
    this.accessToken = payload.access_token
    this.accessTokenExpiry = Date.now() + (Number.isFinite(payload.expires_in) ? payload.expires_in * 1000 : 3600 * 1000)
    return this.accessToken
  }

  async fetchProfile(accessToken) {
    const response = await this.fetchImpl(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    if (!response.ok) return {}
    return readJson(response)
  }

  async request(pathname, init = {}) {
    if (!/^\/[A-Za-z0-9_?=&./:%-]{1,512}$/.test(pathname)) throw new Error('Invalid Gmail API path')
    const accessToken = await this.getAccessToken()
    if (!accessToken) throw new Error('Gmail OAuth token missing')
    const response = await this.fetchImpl(`${GMAIL_API_ROOT}${pathname}`, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
      headers: { ...(init.headers || {}), authorization: `Bearer ${accessToken}` },
    })
    const payload = await readJson(response)
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) this.requiresReauthentication = true
      throw new Error('Gmail API request failed')
    }
    return payload
  }

  async sendText({ to, subject, body, inReplyTo = '', references = '' } = {}) {
    const recipient = safeHeaderValue(to, 320)
    const title = safeHeaderValue(subject, 998)
    if (!recipient || !title || typeof body !== 'string' || !body.trim() || body.length > 32 * 1024 || /[\u0000]/.test(body)) throw new Error('Invalid Gmail message')
    const reply = inReplyTo ? safeHeaderValue(inReplyTo, 998) : ''
    const refs = references ? safeHeaderValue(references, 8192) : ''
    if ((inReplyTo && !reply) || (references && !refs)) throw new Error('Invalid Gmail message headers')
    const lines = [`To: ${recipient}`, `Subject: ${title}`, 'Content-Type: text/plain; charset=UTF-8', ...(reply ? [`In-Reply-To: ${reply}`] : []), ...(refs ? [`References: ${refs}`] : []), '', body]
    const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url')
    const result = await this.request('/messages/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw }) })
    return typeof result?.id === 'string' ? result.id : null
  }
}

module.exports = { GmailOAuthService, SCOPES, GMAIL_API_ROOT, PENDING_TTL_MS }
