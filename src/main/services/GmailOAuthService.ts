import { shell, safeStorage } from 'electron'
import Store from 'electron-store'
import * as http from 'node:http'
import * as crypto from 'node:crypto'

const REDIRECT_URI = 'http://localhost:51123/oauth-callback'
const CALLBACK_PORT = 51123
const TOKEN_BUFFER_MS = 60_000
const TOKEN_URL = 'https://oauth2.googleapis.com/token'

const GMAIL_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
]

type TokenResponse = {
  access_token: string
  expires_in: number
  refresh_token?: string
}

type GoogleUserInfo = {
  email?: string
}

export interface GmailOAuthStatus {
  signedIn: boolean
  email: string | null
}

const gmailStore = new Store<Record<string, string>>({
  name: 'gmail-oauth',
  defaults: {},
}) as Store<Record<string, string>> & {
  get: (key: string) => string | undefined
  set: (key: string, value: string) => void
  delete: (key: string) => void
}

function setSecret(key: string, value: string): void {
  if (safeStorage.isEncryptionAvailable()) {
    gmailStore.set(key, safeStorage.encryptString(value).toString('base64'))
  } else {
    gmailStore.set(key, value)
  }
}

function getSecret(key: string): string | null {
  const value = gmailStore.get(key)
  if (!value) return null
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    }
    return value
  } catch {
    return null
  }
}

function deleteSecret(key: string): void {
  gmailStore.delete(key)
}

function generateVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function generateChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

export class GmailOAuthService {
  private initialized = false
  private accessToken: string | null = null
  private accessTokenExpiry: number | null = null
  private refreshToken: string | null = null
  private email: string | null = null
  private clientId: string | null = null
  private clientSecret: string | null = null

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.refreshToken = getSecret('gmail_refresh_token')
    this.email = getSecret('gmail_email')
    const envClientId = (process.env.GMAIL_OAUTH_CLIENT_ID || '').trim()
    const envClientSecret = (process.env.GMAIL_OAUTH_CLIENT_SECRET || '').trim()
    const storedClientId = getSecret('gmail_client_id')
    // Always prefer env to avoid getting stuck on stale local client IDs.
    this.clientId = envClientId || storedClientId || null
    this.clientSecret = envClientSecret || null
    if (this.clientId) {
      setSecret('gmail_client_id', this.clientId)
    }
    // Never persist OAuth client secret in app storage.
    deleteSecret('gmail_client_secret')
    this.initialized = true
  }

  getStatus(): GmailOAuthStatus {
    return {
      signedIn: !!this.refreshToken,
      email: this.email || null,
    }
  }

  async signIn(clientId?: string): Promise<GmailOAuthStatus> {
    await this.initialize()
    const resolvedClientId = (clientId || this.clientId || '').trim()
    if (!resolvedClientId) {
      throw new Error('Google OAuth is not configured in this app. Please contact support.')
    }

    this.clientId = resolvedClientId
    setSecret('gmail_client_id', this.clientId)
    deleteSecret('gmail_client_secret')

    const verifier = generateVerifier()
    const challenge = generateChallenge(verifier)
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', this.clientId)
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', GMAIL_SCOPES.join(' '))
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')

    const codePromise = this.waitForCallback()
    await shell.openExternal(authUrl.toString())
    const code = await codePromise
    if (!code) throw new Error('Google OAuth callback did not return an authorization code')

    const tokens = await this.exchangeCode(code, verifier)
    this.accessToken = tokens.access_token
    this.accessTokenExpiry = Date.now() + tokens.expires_in * 1000
    if (tokens.refresh_token) {
      this.refreshToken = tokens.refresh_token
      setSecret('gmail_refresh_token', tokens.refresh_token)
    }

    const userInfo = await this.fetchUserInfo(this.accessToken)
    this.email = userInfo.email || null
    if (this.email) setSecret('gmail_email', this.email)

    return this.getStatus()
  }

  async signOut(): Promise<void> {
    this.accessToken = null
    this.accessTokenExpiry = null
    this.refreshToken = null
    this.email = null
    deleteSecret('gmail_refresh_token')
    deleteSecret('gmail_email')
  }

  async getAccessToken(): Promise<string | null> {
    await this.initialize()
    if (!this.refreshToken || !this.clientId) return null
    if (this.accessToken && this.accessTokenExpiry && this.accessTokenExpiry > Date.now() + TOKEN_BUFFER_MS) {
      return this.accessToken
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.refreshToken,
      client_id: this.clientId,
    })
    if (this.clientSecret) {
      body.set('client_secret', this.clientSecret)
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const json = await response.json() as TokenResponse & { error?: string; error_description?: string }
    if (!response.ok || !json.access_token) {
      const detail = json.error_description || json.error || 'refresh failed'
      throw new Error(`Gmail OAuth token refresh failed: ${detail}`)
    }

    this.accessToken = json.access_token
    this.accessTokenExpiry = Date.now() + json.expires_in * 1000
    return this.accessToken
  }

  private waitForCallback(): Promise<string | null> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        try {
          const url = new URL(req.url || '', REDIRECT_URI)
          const code = url.searchParams.get('code')
          res.statusCode = 200
          res.setHeader('Content-Type', 'text/html')
          res.end('<html><body><h3>Gmail OAuth complete. You can close this tab.</h3></body></html>')
          resolve(code)
        } catch {
          resolve(null)
        } finally {
          server.close()
        }
      })
      server.listen(CALLBACK_PORT, '127.0.0.1')
      setTimeout(() => {
        try { server.close() } catch {}
        resolve(null)
      }, 180_000)
    })
  }

  private async exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
    if (!this.clientId) throw new Error('Google OAuth Client ID is missing')

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    })
    if (this.clientSecret) {
      body.set('client_secret', this.clientSecret)
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const json = await response.json() as TokenResponse & { error?: string; error_description?: string }
    if (!response.ok || !json.access_token) {
      const detail = this.normalizeGoogleOAuthError(json.error_description || json.error || 'token exchange failed')
      throw new Error(`Gmail OAuth token exchange failed: ${detail}`)
    }
    return json
  }

  private normalizeGoogleOAuthError(rawDetail: string): string {
    const detail = (rawDetail || '').trim()
    const lowered = detail.toLowerCase()

    // PKCE flow must use a Google OAuth client created as "Desktop app".
    // Using a Web client ID can trigger "client_secret is missing" during token exchange.
    if (lowered.includes('client_secret is missing')) {
      return 'This app is missing server-managed Google OAuth config. App owner: set GMAIL_OAUTH_CLIENT_SECRET in the runtime environment and restart.'
    }

    if (lowered.includes('redirect_uri_mismatch')) {
      return 'redirect URI mismatch. Ensure the OAuth client is a "Desktop app" client ID for loopback redirect support.'
    }

    return detail || 'token exchange failed'
  }

  private async fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
    const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) return {}
    return await response.json() as GoogleUserInfo
  }
}

export const gmailOAuthService = new GmailOAuthService()
