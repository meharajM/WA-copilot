import type {
  ChatClient,
  ChatGenerationRequest,
  ChatHealth,
  ChatMessage,
  ChatSession,
} from '../../../shared/chat-protocol'
import type {
  CredentialKey,
  LlmSettings,
  NativeHealth,
  NativeResult,
  ProviderTestResult,
  PersonaSettings,
  WhatsAppSettings,
} from '../../../shared/native-bridge'
import { readGeneration, readMessage, readSession } from './tauri-chat-client'

export class BrowserAgentdError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'BrowserAgentdError'
    this.status = status
  }
}

export interface BrowserAgentdClientOptions {
  origin?: string
  fetch?: typeof globalThis.fetch
}

type Json = Record<string, unknown> | unknown[]

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const errorText = (value: unknown, fallback: string): string => (
  typeof value === 'string' && value.trim() ? value : fallback
)

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  if (!text) return null
  try { return JSON.parse(text) as unknown } catch { return null }
}

const readNativeHealth = (value: unknown): NativeHealth => {
  if (!isRecord(value) || (value.runtime !== 'agentd' && typeof value.runtime !== 'undefined')) {
    throw new Error('Invalid agentd status response')
  }
  return {
    status: 'ready',
    ...(typeof value.paused === 'boolean' ? { paused: value.paused } : {}),
    ...(typeof value.queueDepth === 'number' ? { queueDepth: value.queueDepth } : {}),
    ...(typeof value.events === 'number' ? { events: value.events } : {}),
  }
}

const readResult = (value: unknown): NativeResult => {
  if (!isRecord(value) || typeof value.success !== 'boolean') throw new Error('Invalid agentd operation response')
  return { success: value.success, ...(typeof value.error === 'string' ? { error: value.error } : {}) }
}

const readCredentialPresence = (value: unknown): NativeResult & { exists: boolean } => {
  if (!isRecord(value) || typeof value.exists !== 'boolean') throw new Error('Invalid credential presence response')
  return { ...readResult(value), exists: value.exists }
}

const readLlmSettings = (value: unknown): LlmSettings => {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'openaiModel,openrouterModel,preferredProvider'
    || !['auto', 'openai', 'openrouter'].includes(value.preferredProvider as string)
    || typeof value.openaiModel !== 'string'
    || typeof value.openrouterModel !== 'string') throw new Error('Invalid LLM settings response')
  return value as unknown as LlmSettings
}

const readWhatsAppSettings = (value: unknown): WhatsAppSettings => {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'whatsapp_cloud_api_version,whatsapp_cloud_phone_number_id,whatsapp_transport'
    || !['baileys', 'cloud', 'web'].includes(value.whatsapp_transport as string)
    || typeof value.whatsapp_cloud_phone_number_id !== 'string'
    || typeof value.whatsapp_cloud_api_version !== 'string') throw new Error('Invalid WhatsApp settings response')
  return value as unknown as WhatsAppSettings
}

const readPersonaSettings = (value: unknown): PersonaSettings => {
  if (!isRecord(value)
    || typeof value.name !== 'string'
    || typeof value.industry !== 'string'
    || !['professional', 'casual', 'enthusiastic', 'concise'].includes(value.tone as string)
    || !Array.isArray(value.coreKnowledge)
    || value.coreKnowledge.some((item) => typeof item !== 'string')
    || (value.customRules !== undefined && typeof value.customRules !== 'string')) throw new Error('Invalid persona settings response')
  return {
    name: value.name,
    industry: value.industry,
    tone: value.tone as PersonaSettings['tone'],
    coreKnowledge: value.coreKnowledge as string[],
    ...(typeof value.customRules === 'string' && value.customRules ? { customRules: value.customRules } : {}),
  }
}

const normaliseOrigin = (origin: string): string => {
  const url = new URL(origin)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Agentd origin must use HTTP(S)')
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid agentd origin')
  return url.origin
}

export interface BrowserAgentdClient extends ChatClient {
  pair(code: string): Promise<{ expiresAt: number }>
  readiness(): Promise<'ready' | 'pairing' | 'unavailable'>
  status(): Promise<NativeHealth>
  getLlmSettings(): Promise<LlmSettings>
  saveLlmSettings(settings: LlmSettings): Promise<LlmSettings>
  getWhatsAppSettings(): Promise<WhatsAppSettings>
  saveWhatsAppSettings(settings: WhatsAppSettings): Promise<WhatsAppSettings>
  getPersonaSettings(): Promise<PersonaSettings>
  savePersonaSettings(settings: PersonaSettings): Promise<PersonaSettings>
  setCredential(key: CredentialKey, value: string): Promise<NativeResult>
  hasCredential(key: CredentialKey): Promise<NativeResult & { exists: boolean }>
  deleteCredential(key: CredentialKey): Promise<NativeResult>
  testProvider(provider: 'openai' | 'openrouter'): Promise<ProviderTestResult>
}

export function createBrowserAgentdClient(options: BrowserAgentdClientOptions = {}): BrowserAgentdClient {
  const windowOrigin = typeof window !== 'undefined' && typeof window.location?.origin === 'string' ? window.location.origin : null
  const baseOrigin = normaliseOrigin(options.origin || windowOrigin || 'http://127.0.0.1')
  const fetcher = options.fetch || globalThis.fetch.bind(globalThis)
  const csrfSlot = '__AICA_AGENTD_CSRF_TOKEN__'
  const readSharedCsrf = (): string | null => {
    if (typeof window === 'undefined') return null
    const value = (window as Window & { [csrfSlot]?: unknown })[csrfSlot]
    return typeof value === 'string' && value ? value : null
  }
  const writeSharedCsrf = (value: string | null): void => {
    if (typeof window !== 'undefined') (window as Window & { [csrfSlot]?: unknown })[csrfSlot] = value || undefined
  }
  // The token is intentionally memory-only. The window slot also keeps the
  // token shared when Vite splits the browser entry and lazy App into chunks.
  let csrfToken: string | null = readSharedCsrf()

  const request = async <T = unknown>(path: string, init: RequestInit = {}, mutation = false): Promise<T> => {
    const headers = new Headers(init.headers)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    if (mutation && csrfToken) headers.set('x-csrf-token', csrfToken)
    const response = await fetcher(new URL(path, `${baseOrigin}/`).toString(), {
      ...init,
      headers,
      credentials: 'include',
    })
    const body = await readJson(response)
    if (!response.ok) {
      const message = isRecord(body) ? errorText(body.error, `Agentd request failed (${response.status})`) : `Agentd request failed (${response.status})`
      throw new BrowserAgentdError(message, response.status || 500)
    }
    return body as T
  }

  const pair = async (code: string): Promise<{ expiresAt: number }> => {
    if (!/^\d{6}$/.test(code)) throw new Error('Pairing code must be six digits')
    const body = await request<{ csrfToken?: unknown; expiresAt?: unknown }>('/api/v1/pair', {
      method: 'POST',
      body: JSON.stringify({ code }),
    })
    if (typeof body.csrfToken !== 'string' || !Number.isSafeInteger(body.expiresAt)) throw new Error('Invalid pairing response')
    csrfToken = body.csrfToken
    writeSharedCsrf(csrfToken)
    return { expiresAt: body.expiresAt as number }
  }

  const status = async (): Promise<NativeHealth> => readNativeHealth(await request('/api/v1/status'))

  const readiness = async (): Promise<'ready' | 'pairing' | 'unavailable'> => {
    try {
      await request('/healthz')
      await status()
      if (!csrfToken) {
        const session = await request<{ csrfToken?: unknown; expiresAt?: unknown }>('/api/v1/session')
        if (typeof session.csrfToken !== 'string' || !Number.isSafeInteger(session.expiresAt)) throw new Error('Invalid browser session response')
        csrfToken = session.csrfToken
        writeSharedCsrf(csrfToken)
      }
      return 'ready'
    } catch (error) {
      if (error instanceof BrowserAgentdError && error.status === 401) return 'pairing'
      return 'unavailable'
    }
  }

  const health = async (): Promise<ChatHealth> => {
    try {
      await status()
      return { status: 'ready', mode: 'daemon' }
    } catch (error) {
      return {
        status: 'unavailable',
        mode: 'daemon',
        error: error instanceof Error ? error.message : 'Agentd is unavailable',
      }
    }
  }

  const loadSessions = async (): Promise<ChatSession[]> => {
    const list = await request<{ sessions?: unknown }>('/api/v1/sessions')
    if (!Array.isArray(list.sessions)) throw new Error('Invalid agentd chat session response')
    const sessions = await Promise.all(list.sessions.map(async (summary) => {
      if (!isRecord(summary) || typeof summary.id !== 'string') throw new Error('Invalid agentd chat session response')
      const value = await request<{ session?: unknown; messages?: unknown }>(`/api/v1/sessions/${encodeURIComponent(summary.id)}`)
      if (!isRecord(value) || !Array.isArray(value.messages)) throw new Error('Invalid agentd chat session response')
      return readSession({ ...(value.session as Record<string, unknown>), messages: value.messages })
    }))
    return sessions
  }

  const createSession = async (sessionId: string, title: string): Promise<void> => {
    await request('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ id: sessionId, title }) }, true)
  }

  const deleteSession = async (sessionId: string): Promise<void> => {
    await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, true)
  }

  const appendMessage = async (sessionId: string, message: ChatMessage): Promise<void> => {
    await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ id: message.id, role: message.role, content: message.content }),
    }, true)
  }

  const generate = async (requestBody: ChatGenerationRequest, onEvent: Parameters<ChatClient['generate']>[1], signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw new DOMException('Chat generation canceled', 'AbortError')
    const value = await request<unknown>(`/api/v1/sessions/${encodeURIComponent(requestBody.sessionId)}/generations`, {
      method: 'POST',
      body: JSON.stringify({ requestId: requestBody.requestId, content: requestBody.content, ...(requestBody.model ? { model: requestBody.model } : {}) }),
    }, true)
    if (signal?.aborted) throw new DOMException('Chat generation canceled', 'AbortError')
    const message = readGeneration(value, requestBody)
    onEvent({ type: 'assistant.delta', sessionId: requestBody.sessionId, requestId: requestBody.requestId, sequence: 1, delta: message.content })
    onEvent({ type: 'assistant.done', sessionId: requestBody.sessionId, requestId: requestBody.requestId, sequence: 2 })
  }

  const getLlmSettings = async () => readLlmSettings(await request('/api/v1/settings/llm'))
  const saveLlmSettings = async (settings: LlmSettings) => readLlmSettings(await request('/api/v1/settings/llm', { method: 'PUT', body: JSON.stringify(settings) }, true))
  const getWhatsAppSettings = async () => readWhatsAppSettings(await request('/api/v1/settings/whatsapp'))
  const saveWhatsAppSettings = async (settings: WhatsAppSettings) => readWhatsAppSettings(await request('/api/v1/settings/whatsapp', { method: 'PUT', body: JSON.stringify(settings) }, true))
  const getPersonaSettings = async () => readPersonaSettings(await request('/api/v1/settings/persona'))
  const savePersonaSettings = async (settings: PersonaSettings) => readPersonaSettings(await request('/api/v1/settings/persona', { method: 'PUT', body: JSON.stringify(settings) }, true))
  const setCredential = async (key: CredentialKey, value: string) => readResult(await request(`/api/v1/credentials/${encodeURIComponent(key)}`, { method: 'POST', body: JSON.stringify({ value }) }, true))
  const hasCredential = async (key: CredentialKey) => readCredentialPresence(await request(`/api/v1/credentials/${encodeURIComponent(key)}`))
  const deleteCredential = async (key: CredentialKey) => readResult(await request(`/api/v1/credentials/${encodeURIComponent(key)}`, { method: 'DELETE' }, true))
  const testProvider = async (provider: 'openai' | 'openrouter') => {
    const value = await request<unknown>(`/api/v1/providers/${provider}/test`, { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || typeof value.success !== 'boolean') throw new Error('Invalid provider test response')
    return value as unknown as ProviderTestResult
  }

  return {
    pair,
    readiness,
    status,
    health,
    loadSessions,
    createSession,
    deleteSession,
    appendMessage,
    generate,
    getLlmSettings,
    saveLlmSettings,
    getWhatsAppSettings,
    saveWhatsAppSettings,
    getPersonaSettings,
    savePersonaSettings,
    setCredential,
    hasCredential,
    deleteCredential,
    testProvider,
  }
}

let browserAgentdClient: BrowserAgentdClient | null = null

export const getBrowserAgentdClient = (): BrowserAgentdClient => {
  browserAgentdClient ??= createBrowserAgentdClient()
  return browserAgentdClient
}
