/**
 * Electron-only Antigravity OAuth gateway service.
 *
 * Client credentials are supplied at runtime through environment variables;
 * none are stored in source. Browser/Tauri product paths do not use this
 * service and remain on the authenticated agentd provider boundary.
 */

import { shell } from 'electron'
import * as crypto from 'node:crypto'
import * as http from 'node:http'

const CLIENT_ID = process.env.AICA_ANTIGRAVITY_CLIENT_ID?.trim() || ''
const CLIENT_SECRET = process.env.AICA_ANTIGRAVITY_CLIENT_SECRET?.trim() || ''
const REDIRECT_URI = 'http://localhost:51121/oauth-callback'
const CALLBACK_PORT = 51121
const TOKEN_BUFFER_MS = 60_000
const MAX_BODY_BYTES = 512 * 1024
const DEFAULT_PROJECT_ID = 'rising-fact-p41fc'
const ENDPOINTS = [
    'https://cloudcode-pa.googleapis.com',
    'https://daily-cloudcode-pa.sandbox.googleapis.com',
    'https://autopush-cloudcode-pa.sandbox.googleapis.com',
] as const

export interface AntigravityAuthState {
    signedIn: boolean
    email: string | null
    projectId: string | null
    accessToken: string | null
    accessTokenExpiry: number | null
    refreshToken: string | null
}

interface TokenResponse {
    access_token: string
    expires_in: number
    refresh_token?: string
}

interface UserInfo { email?: string }

interface SecureStore {
    get: (key: string) => Promise<{ value: string | null }>
    set: (key: string, value: string) => Promise<void>
    delete: (key: string) => Promise<void>
}

const emptyState = (): AntigravityAuthState => ({
    signedIn: false,
    email: null,
    projectId: null,
    accessToken: null,
    accessTokenExpiry: null,
    refreshToken: null,
})

const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character] || character))

const codeVerifier = (): string => crypto.randomBytes(32).toString('base64url')
const codeChallenge = (value: string): string => crypto.createHash('sha256').update(value).digest('base64url')

function readTokenResponse(value: unknown): TokenResponse {
    if (!value || typeof value !== 'object') throw new Error('Invalid Antigravity token response')
    const response = value as Record<string, unknown>
    if (typeof response.access_token !== 'string' || !response.access_token
        || typeof response.expires_in !== 'number' || !Number.isSafeInteger(response.expires_in) || response.expires_in <= 0
        || (response.refresh_token !== undefined && typeof response.refresh_token !== 'string')) {
        throw new Error('Invalid Antigravity token response')
    }
    return {
        access_token: response.access_token,
        expires_in: response.expires_in,
        ...(typeof response.refresh_token === 'string' ? { refresh_token: response.refresh_token } : {}),
    }
}

export class AntigravityAuthService {
    private state = emptyState()
    private callbackServer: http.Server | null = null
    private readonly secure: SecureStore

    constructor(deps: { secureGet: SecureStore['get']; secureSet: SecureStore['set']; secureDelete: SecureStore['delete'] }) {
        this.secure = { get: deps.secureGet, set: deps.secureSet, delete: deps.secureDelete }
    }

    async initialize(): Promise<void> {
        const refresh = await this.secure.get('antigravity_refresh_token')
        if (!refresh.value) return
        const email = await this.secure.get('antigravity_email')
        const project = await this.secure.get('antigravity_project_id')
        this.state.refreshToken = refresh.value
        this.state.email = email.value || null
        this.state.projectId = project.value || DEFAULT_PROJECT_ID
        this.state.signedIn = true
    }

    async signIn(): Promise<AntigravityAuthState> {
        if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Antigravity OAuth is not configured')
        const verifier = codeVerifier()
        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
        authUrl.searchParams.set('client_id', CLIENT_ID)
        authUrl.searchParams.set('response_type', 'code')
        authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
        authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs')
        authUrl.searchParams.set('code_challenge', codeChallenge(verifier))
        authUrl.searchParams.set('code_challenge_method', 'S256')
        authUrl.searchParams.set('access_type', 'offline')
        authUrl.searchParams.set('prompt', 'consent')
        const codePromise = this.waitForCallback()
        try {
            await shell.openExternal(authUrl.toString())
        } catch (error) {
            this.callbackServer?.close()
            this.callbackServer = null
            throw error
        }
        const code = await codePromise
        if (!code) throw new Error('OAuth flow was cancelled or failed to receive auth code')
        const tokens = await this.exchangeCode(code, verifier)
        const user = await this.fetchUserInfo(tokens.access_token)
        const projectId = await this.fetchProjectId(tokens.access_token)
        this.state = {
            signedIn: true,
            email: user.email || null,
            projectId: projectId || DEFAULT_PROJECT_ID,
            accessToken: tokens.access_token,
            accessTokenExpiry: Date.now() + tokens.expires_in * 1000,
            refreshToken: tokens.refresh_token || null,
        }
        await this.persistTokens()
        return this.getStatus()
    }

    async signOut(): Promise<void> {
        this.callbackServer?.close()
        this.callbackServer = null
        this.state = emptyState()
        await Promise.all([
            this.secure.delete('antigravity_refresh_token'),
            this.secure.delete('antigravity_email'),
            this.secure.delete('antigravity_project_id'),
        ])
    }

    async getToken(): Promise<string | null> {
        if (!this.state.signedIn || !this.state.refreshToken) return null
        if (this.state.accessToken && this.state.accessTokenExpiry && this.state.accessTokenExpiry > Date.now() + TOKEN_BUFFER_MS) return this.state.accessToken
        try {
            const tokens = await this.refreshToken(this.state.refreshToken)
            this.state.accessToken = tokens.access_token
            this.state.accessTokenExpiry = Date.now() + tokens.expires_in * 1000
            if (tokens.refresh_token) {
                this.state.refreshToken = tokens.refresh_token
                await this.secure.set('antigravity_refresh_token', tokens.refresh_token)
            }
            return this.state.accessToken
        } catch {
            this.state = { ...emptyState(), email: this.state.email, projectId: this.state.projectId }
            return null
        }
    }

    getStatus(): AntigravityAuthState {
        return { ...this.state, accessToken: null, accessTokenExpiry: null, refreshToken: null }
    }

    getHeaders(): Record<string, string> {
        return {
            'User-Agent': 'AICA/1.0 Antigravity gateway',
            'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
            'Client-Metadata': JSON.stringify({ ideType: 'ANTIGRAVITY', platform: process.platform === 'win32' ? 'WINDOWS' : 'MACOS', pluginType: 'GEMINI' }),
        }
    }

    async callGateway(url: string, headers: Record<string, string>, body: string): Promise<unknown> {
        let parsed: URL
        try { parsed = new URL(url) } catch { throw new Error('Invalid Antigravity gateway URL') }
        if (!ENDPOINTS.some((endpoint) => parsed.origin === endpoint) || !parsed.pathname.startsWith('/v1internal:')) throw new Error('Antigravity gateway URL is not allowlisted')
        if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) throw new Error('Antigravity request body is too large')
        const token = await this.getToken()
        if (!token) throw new Error('Antigravity account is not authenticated')
        const safeHeaders = Object.fromEntries(Object.entries(headers || {}).filter(([key]) => !['authorization', 'host', 'content-length'].includes(key.toLowerCase())))
        const response = await fetch(parsed, {
            method: 'POST',
            headers: { ...this.getHeaders(), ...safeHeaders, Authorization: `Bearer ${token}` },
            body,
            signal: AbortSignal.timeout(30_000),
        })
        const text = await response.text()
        if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('Antigravity response is too large')
        let value: unknown = {}
        try { value = text ? JSON.parse(text) : {} } catch { value = { _rawText: text } }
        if (!response.ok) throw new Error(`Antigravity gateway error (${response.status})`)
        return value
    }

    private async waitForCallback(): Promise<string | null> {
        this.callbackServer?.close()
        return new Promise((resolve) => {
            let settled = false
            const finish = (value: string | null) => { if (!settled) { settled = true; if (server.listening) server.close(); this.callbackServer = null; resolve(value) } }
            const server = http.createServer((request, response) => {
                let parsed: URL
                try { parsed = new URL(request.url || '/', REDIRECT_URI) } catch { response.writeHead(400); response.end('Bad request'); return }
                if (parsed.pathname !== '/oauth-callback') { response.writeHead(404); response.end('Not found'); return }
                const error = parsed.searchParams.get('error')
                const code = parsed.searchParams.get('code')
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                response.end(`<h1>${error ? 'Authentication failed' : 'Authentication complete'}</h1><p>${escapeHtml(error || 'You can close this window.')}</p>`)
                finish(error || !code ? null : code)
            })
            const timeout = setTimeout(() => finish(null), 120_000)
            timeout.unref?.()
            server.once('close', () => clearTimeout(timeout))
            server.once('error', () => finish(null))
            server.listen(CALLBACK_PORT, '127.0.0.1')
            this.callbackServer = server
        })
    }

    private async exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
        return this.exchange('authorization_code', { code, redirect_uri: REDIRECT_URI, code_verifier: verifier })
    }

    private async refreshToken(refreshToken: string): Promise<TokenResponse> {
        return this.exchange('refresh_token', { refresh_token: refreshToken })
    }

    private async exchange(grantType: string, values: Record<string, string>): Promise<TokenResponse> {
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: grantType, ...values }),
            signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error(`Antigravity token exchange failed (${response.status})`)
        return readTokenResponse(await response.json())
    }

    private async fetchUserInfo(token: string): Promise<UserInfo> {
        try {
            const response = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) })
            if (!response.ok) return {}
            const value = await response.json() as Record<string, unknown>
            return { email: typeof value.email === 'string' ? value.email : undefined }
        } catch { return {} }
    }

    private async fetchProjectId(token: string): Promise<string> {
        for (const endpoint of ENDPOINTS) {
            try {
                const response = await fetch(`${endpoint}/v1internal:loadCodeAssist`, {
                    method: 'POST',
                    headers: { ...this.getHeaders(), Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ metadata: { ideType: 'ANTIGRAVITY', platform: process.platform === 'win32' ? 'WINDOWS' : 'MACOS', pluginType: 'GEMINI' } }),
                    signal: AbortSignal.timeout(10_000),
                })
                if (!response.ok) continue
                const value = await response.json() as Record<string, unknown>
                const project = value.cloudaicompanionProject
                if (typeof project === 'string' && project) return project
                if (project && typeof project === 'object' && typeof (project as Record<string, unknown>).id === 'string') return (project as Record<string, string>).id
            } catch { /* try next endpoint */ }
        }
        return DEFAULT_PROJECT_ID
    }

    private async persistTokens(): Promise<void> {
        if (this.state.refreshToken) await this.secure.set('antigravity_refresh_token', this.state.refreshToken)
        if (this.state.email) await this.secure.set('antigravity_email', this.state.email)
        if (this.state.projectId) await this.secure.set('antigravity_project_id', this.state.projectId)
    }
}
