import { credentialKeys } from '../../../shared/native-bridge'
import type {
  ChatClient,
  ChatGenerationRequest,
  ChatHealth,
  ChatMessage,
  ChatSessionMetadata,
  ChatSession,
} from '../../../shared/chat-protocol'
import type {
  CredentialKey,
  LlmSettings,
  NativeHealth,
  NativeResult,
  ProviderTestResult,
  PersonaSettings,
  ProductPreferences,
  WhatsAppSettings,
  EmailSettings,
} from '../../../shared/native-bridge'
import { readGeneration, readMessage, readSession } from './tauri-chat-client'

/** Keep browser knowledge imports below agentd's JSON/content limit before reading them into memory. */
export const MAX_BROWSER_KNOWLEDGE_CONTENT_BYTES = 512 * 1024
export const MAX_BROWSER_KNOWLEDGE_FILE_BYTES = 16 * 1024 * 1024
export const MAX_BROWSER_WHATSAPP_MEDIA_BYTES = 8 * 1024 * 1024

export async function readBrowserKnowledgeFile(file: File): Promise<{ content: string; size: number; fileType: string }> {
  if (file.size > MAX_BROWSER_KNOWLEDGE_FILE_BYTES) {
    throw new Error('Browser knowledge files must be 16 MB or smaller')
  }
  const content = await file.text()
  if (new TextEncoder().encode(content).byteLength > MAX_BROWSER_KNOWLEDGE_CONTENT_BYTES) {
    throw new Error('Browser knowledge text must be 512 KiB or smaller')
  }
  return { content, size: file.size, fileType: file.type || 'text/plain' }
}

/** Read a bounded binary file without exposing a native path to the browser. */
export async function readBrowserKnowledgeBinaryFile(file: File): Promise<{ dataBase64: string; size: number; fileType: string }> {
  if (file.size > MAX_BROWSER_KNOWLEDGE_FILE_BYTES) {
    throw new Error('Browser knowledge files must be 16 MB or smaller')
  }
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return { dataBase64: btoa(binary), size: file.size, fileType: file.type || 'application/octet-stream' }
}

export async function readBrowserWhatsAppMediaFile(file: File): Promise<{ dataBase64: string; size: number; fileType: string }> {
  if (file.size > MAX_BROWSER_WHATSAPP_MEDIA_BYTES) throw new Error('WhatsApp media files must be 8 MB or smaller')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return { dataBase64: btoa(binary), size: file.size, fileType: file.type || 'application/octet-stream' }
}

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

export interface BrowserEmailTestResult {
  success: true
  credentialConfigured: true
  transport: {
    imap?: { reachable: true; tls: boolean }
    smtp?: { reachable: true; tls: boolean }
    gmailApi?: { reachable: true; tls: true }
  }
  oauth?: { signedIn: boolean; email: string | null }
}

export interface BrowserEmailAttachment {
  inboundId: string
  messageId: string
  id: string
  name?: string
  mimeType?: string
  size?: number
  receivedAt: number
}

export interface BrowserEmailAttachmentScan {
  safe: boolean
  reason: string
  size: number
  sha256: string
  detectedType: 'pdf' | 'png' | 'jpeg' | 'text' | 'unknown'
}

export interface BrowserEmailAttachmentResult {
  scan: BrowserEmailAttachmentScan
  bytes?: Uint8Array
}

export interface BrowserEmailInboundAttachmentResult {
  fileName: string
  mimeType: string
  size: number
  bytes: Uint8Array
  scan: BrowserEmailAttachmentScan
}

export interface BrowserGmailOAuthStatus {
  signedIn: boolean
  email: string | null
  requiresReauthentication: boolean
}

export interface BrowserMcpLifecycle {
  runtime: 'agentd'
  management: 'available' | 'unavailable'
  execution: 'available' | 'unavailable'
  reason: string
  transports: string[]
  tools: string[]
}

export interface BrowserMcpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface BrowserMcpServer {
  id: string
  name: string
  description: string
  type: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  url?: string
  allowedTools?: string[]
  envKeys?: string[]
  execution: 'available' | 'unavailable'
  connected: boolean
  tools: BrowserMcpTool[]
  autoConnect: boolean
  error?: string
}

export interface BrowserEmailInboundEvent {
  id: number
  providerEventId: string
  conversationId: string
  payload: {
    from: string
    to: string
    subject: string
    body: string
    bodyType: 'text' | 'html'
    timestamp: number
    sourceId?: string
    messageId?: string
    inReplyTo?: string
    references?: string
    isFromMe?: boolean
    attachments?: Array<{ id: string; name?: string; mimeType?: string; size?: number }>
  }
  status: 'queued' | 'draft' | 'processing' | 'completed'
  createdAt: number
}

export interface BrowserWhatsAppConnectionState {
  status: 'disconnected' | 'connecting' | 'qr_required' | 'connected' | 'logged_out' | 'blocked' | 'error'
  qrCode: string | null
  error: string | null
  phoneNumber: string | null
  workerNumber: string | null
  handshakeStatus: 'idle' | 'pending' | 'expired' | 'verified' | null
}

export interface BrowserWhatsAppUiSettings {
  whatsappEnabled: boolean
  businessBotMode: boolean
  targetPhoneNumber: string | null
}

export type BrowserEmailDraftStatus = 'pending_review' | 'approved' | 'rejected' | 'escalated' | 'sent' | 'failed'

export interface BrowserEmailDraftAttachment {
  name: string
  mimeType: string
  size: number
  dataBase64: string
}

export interface BrowserEmailDraft {
  id: string
  responseText: string
  originalFrom: string
  originalSubject: string
  replyTo: string
  inReplyTo?: string
  references?: string
  accountName?: string
  attachments?: BrowserEmailDraftAttachment[]
  policyDecision: {
    action: 'send' | 'draft' | 'escalate'
    confidence: number
    rationale: string
    hasSensitiveTopic: boolean
    sensitiveTopics: string[]
  }
  createdAt: number
  status: BrowserEmailDraftStatus
}

export interface BrowserWhatsAppInboundEvent {
  id: number
  providerEventId: string
  conversationId: string
  payload: Record<string, unknown>
  status: 'queued' | 'draft' | 'processing' | 'completed'
  createdAt: number
}

export interface BrowserWhatsAppInboundMedia {
  fileName: string
  mimeType: string
  size: number
  mediaUrl: string
  dataUrl?: string
}

type Json = Record<string, unknown> | unknown[]

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const errorText = (value: unknown, fallback: string): string => (
  typeof value === 'string' && value.trim() ? value : fallback
)

const readEmailDraftAttachments = (value: unknown): BrowserEmailDraftAttachment[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 5) throw new Error('Invalid agentd email draft response')
  let total = 0
  return value.map((item) => {
    if (!isRecord(item)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 256 || item.name.includes('\0') || /[\r\n\\/]/.test(item.name)
      || typeof item.mimeType !== 'string' || !item.mimeType.trim() || item.mimeType.length > 128 || item.mimeType.includes('\0') || /[\r\n]/.test(item.mimeType)
      || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 10 * 1024 * 1024
      || typeof item.dataBase64 !== 'string' || item.dataBase64.length > Math.ceil(10 * 1024 * 1024 * 4 / 3) + 64
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.dataBase64) || item.dataBase64.length % 4 === 1) {
      throw new Error('Invalid agentd email draft response')
    }
    const size = item.size as number
    total += size
    if (total > 10 * 1024 * 1024) throw new Error('Invalid agentd email draft response')
    return { name: item.name, mimeType: item.mimeType, size, dataBase64: item.dataBase64 }
  })
}

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text()
  if (!text) return null
  try { return JSON.parse(text) as unknown } catch { return null }
}

const readNativeHealth = (value: unknown): NativeHealth => {
  if (!isRecord(value) || (value.runtime !== 'agentd' && typeof value.runtime !== 'undefined')) {
    throw new Error('Invalid agentd status response')
  }
  if (value.recoveryMode !== undefined && typeof value.recoveryMode !== 'boolean') throw new Error('Invalid agentd recovery status response')
  if (value.recoveryReason !== undefined && value.recoveryReason !== null && typeof value.recoveryReason !== 'string') throw new Error('Invalid agentd recovery status response')
  return {
    status: 'ready',
    ...(typeof value.paused === 'boolean' ? { paused: value.paused } : {}),
    ...(typeof value.recoveryMode === 'boolean' ? { recoveryMode: value.recoveryMode } : {}),
    ...(value.recoveryReason === null || typeof value.recoveryReason === 'string' ? { recoveryReason: value.recoveryReason as string | null } : {}),
    ...(typeof value.queueDepth === 'number' ? { queueDepth: value.queueDepth } : {}),
    ...(typeof value.events === 'number' ? { events: value.events } : {}),
  }
}

const readMcpLifecycle = (value: unknown): BrowserMcpLifecycle => {
  if (!isRecord(value)
    || value.runtime !== 'agentd'
    || !['available', 'unavailable'].includes(value.management as string)
    || !['available', 'unavailable'].includes(value.execution as string)
    || typeof value.reason !== 'string'
    || !Array.isArray(value.transports) || value.transports.some(item => typeof item !== 'string')
    || !Array.isArray(value.tools) || value.tools.some(item => typeof item !== 'string')) {
    throw new Error('Invalid agentd MCP lifecycle response')
  }
  return value as unknown as BrowserMcpLifecycle
}

const readMcpServers = (value: unknown): { servers: BrowserMcpServer[]; execution: 'available' | 'unavailable'; reason: string } => {
  if (!isRecord(value) || !['available', 'unavailable'].includes(value.execution as string) || typeof value.reason !== 'string' || !Array.isArray(value.servers)) throw new Error('Invalid agentd MCP server response')
  const servers = value.servers.map((item) => {
    if (!isRecord(item) || typeof item.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 128
      || typeof item.description !== 'string' || item.description.length > 512
      || !['stdio', 'sse', 'http'].includes(item.type as string)
      || !['available', 'unavailable'].includes(item.execution as string)
      || typeof item.connected !== 'boolean' || typeof item.autoConnect !== 'boolean'
      || !Array.isArray(item.tools)) throw new Error('Invalid agentd MCP server response')
    if (item.command !== undefined && (typeof item.command !== 'string' || item.command.length > 256)) throw new Error('Invalid agentd MCP server response')
    if (item.args !== undefined && (!Array.isArray(item.args) || item.args.length > 32 || item.args.some(arg => typeof arg !== 'string' || arg.length > 512))) throw new Error('Invalid agentd MCP server response')
    if (item.url !== undefined && (typeof item.url !== 'string' || item.url.length > 2048)) throw new Error('Invalid agentd MCP server response')
    if (item.allowedTools !== undefined && (!Array.isArray(item.allowedTools) || item.allowedTools.length > 128 || item.allowedTools.some(tool => typeof tool !== 'string' || tool.length > 128))) throw new Error('Invalid agentd MCP server response')
    if (item.envKeys !== undefined && (!Array.isArray(item.envKeys) || item.envKeys.length > 64 || item.envKeys.some(key => typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)))) throw new Error('Invalid agentd MCP server response')
    const tools = item.tools.map((tool): BrowserMcpTool => {
      if (!isRecord(tool) || typeof tool.name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(tool.name)
        || typeof tool.description !== 'string' || !isRecord(tool.inputSchema)) throw new Error('Invalid agentd MCP server response')
      return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
    })
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      type: item.type as BrowserMcpServer['type'],
      ...(typeof item.command === 'string' ? { command: item.command } : {}),
      ...(Array.isArray(item.args) ? { args: item.args as string[] } : {}),
      ...(typeof item.url === 'string' ? { url: item.url } : {}),
      ...(Array.isArray(item.allowedTools) ? { allowedTools: item.allowedTools as string[] } : {}),
      ...(Array.isArray(item.envKeys) ? { envKeys: item.envKeys as string[] } : {}),
      execution: item.execution as BrowserMcpServer['execution'],
      connected: item.connected as boolean,
      tools,
      autoConnect: item.autoConnect as boolean,
      ...(typeof item.error === 'string' ? { error: item.error } : {}),
    }
  })
  return { servers, execution: value.execution as 'available' | 'unavailable', reason: value.reason }
}

const readContinuityStatus = (value: unknown): BrowserContinuityStatus => {
  if (!isRecord(value) || value.version !== 1 || value.runtime !== 'agentd' || !isRecord(value.migration)
    || value.migration.source !== 'electron' || value.migration.target !== 'agentd'
    || value.migration.state !== 'native-owner-action-required' || value.migration.secretsExcluded !== true
    || typeof value.migration.note !== 'string' || !Array.isArray(value.stores) || !isRecord(value.data) || !Array.isArray(value.credentials)) {
    throw new Error('Invalid agentd continuity status response')
  }
  const stores = value.stores.map((store) => {
    if (!isRecord(store)
      || !['electron-settings', 'electron-persona', 'electron-chat-history', 'agentd-state'].includes(store.id as string)
      || !['electron', 'agentd'].includes(store.source as string)
      || typeof store.target !== 'string' || !['json', 'sqlite'].includes(store.format as string)
      || typeof store.schemaVersion !== 'string' || typeof store.requiresReauthentication !== 'boolean'
      || !['pending', 'active'].includes(store.state as string)) throw new Error('Invalid agentd continuity status response')
    return store
  })
  const dataKeys = ['sessions', 'messages', 'knowledgeDocuments', 'inboundEvents', 'drafts']
  if (dataKeys.some((key) => !Number.isSafeInteger(value.data![key]) || (value.data![key] as number) < 0)) throw new Error('Invalid agentd continuity status response')
  const credentials = value.credentials.map((credential) => {
    if (!isRecord(credential) || typeof credential.key !== 'string' || !credentialKeys.includes(credential.key as CredentialKey) || typeof credential.present !== 'boolean' || typeof credential.available !== 'boolean') throw new Error('Invalid agentd continuity status response')
    return credential
  })
  return {
    version: 1,
    runtime: 'agentd',
    migration: value.migration as BrowserContinuityStatus['migration'],
    stores: stores as BrowserContinuityStatus['stores'],
    data: value.data as unknown as BrowserContinuityStatus['data'],
    credentials: credentials as BrowserContinuityStatus['credentials'],
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
    || Object.keys(value).sort().join(',') !== 'geminiModel,openaiModel,openrouterModel,preferredProvider'
    || !['auto', 'openai', 'openrouter', 'ollama', 'gemini', 'browser'].includes(value.preferredProvider as string)
    || typeof value.openaiModel !== 'string'
    || typeof value.geminiModel !== 'string'
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

const readWhatsAppConnectionState = (value: unknown): BrowserWhatsAppConnectionState => {
  if (!isRecord(value)
    || !['disconnected', 'connecting', 'qr_required', 'connected', 'logged_out', 'blocked', 'error'].includes(value.status as string)
    || (value.qrCode !== null && typeof value.qrCode !== 'string')
    || (value.error !== null && typeof value.error !== 'string')
    || (value.phoneNumber !== null && typeof value.phoneNumber !== 'string')
    || (value.workerNumber !== null && typeof value.workerNumber !== 'string')
    || (value.handshakeStatus !== null && !['idle', 'pending', 'expired', 'verified'].includes(value.handshakeStatus as string))) throw new Error('Invalid WhatsApp connection response')
  return {
    status: value.status as BrowserWhatsAppConnectionState['status'],
    qrCode: value.qrCode as string | null,
    error: value.error as string | null,
    phoneNumber: value.phoneNumber as string | null,
    workerNumber: value.workerNumber as string | null,
    handshakeStatus: value.handshakeStatus as BrowserWhatsAppConnectionState['handshakeStatus'],
  }
}

const readWhatsAppUiSettings = (value: unknown): BrowserWhatsAppUiSettings => {
  if (!isRecord(value)
    || typeof value.whatsappEnabled !== 'boolean'
    || typeof value.businessBotMode !== 'boolean'
    || (value.targetPhoneNumber !== null
      && (typeof value.targetPhoneNumber !== 'string'
        || value.targetPhoneNumber.length > 32
        || !/^\+?[0-9\s().-]+$/.test(value.targetPhoneNumber)
        || !/^\d{8,15}$/.test(value.targetPhoneNumber.replace(/\D/g, ''))))) throw new Error('Invalid WhatsApp UI settings response')
  return {
    whatsappEnabled: value.whatsappEnabled,
    businessBotMode: value.businessBotMode,
    targetPhoneNumber: value.targetPhoneNumber as string | null,
  }
}

const readOllamaSettings = (value: unknown): BrowserOllamaSettings => {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== 'baseUrl,model'
    || typeof value.baseUrl !== 'string'
    || !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(value.baseUrl)
    || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 128) throw new Error('Invalid Ollama settings response')
  return { baseUrl: value.baseUrl, model: value.model }
}

const readEmailSettings = (value: unknown): EmailSettings => {
  if (!isRecord(value)) throw new Error('Invalid email settings response')
  const expected = ['accountName', 'autoReplyMode', 'draftMode', 'emailAddress', 'enabled', 'gmailAuthMode', 'imapHost', 'imapPort', 'imapTls', 'pollingIntervalSeconds', 'provider', 'smtpHost', 'smtpPort', 'smtpTls', 'userName']
  if (Object.keys(value).sort().join(',') !== expected.join(',')
    || typeof value.accountName !== 'string'
    || !['imap-smtp', 'gmail-api', 'outlook-api', 'custom-mcp'].includes(value.provider as string)
    || !['app-password', 'google-oauth'].includes(value.gmailAuthMode as string)
    || typeof value.imapHost !== 'string' || !Number.isSafeInteger(value.imapPort)
    || typeof value.smtpHost !== 'string' || !Number.isSafeInteger(value.smtpPort)
    || typeof value.emailAddress !== 'string' || typeof value.userName !== 'string'
    || typeof value.imapTls !== 'boolean' || typeof value.smtpTls !== 'boolean'
    || !Number.isSafeInteger(value.pollingIntervalSeconds)
    || typeof value.enabled !== 'boolean' || typeof value.autoReplyMode !== 'boolean' || typeof value.draftMode !== 'boolean') throw new Error('Invalid email settings response')
  return value as unknown as EmailSettings
}

const readEmailDraft = (value: unknown): BrowserEmailDraft => {
  if (!isRecord(value)) throw new Error('Invalid agentd email draft response')
  const attachments = readEmailDraftAttachments(value.attachments)
  if (typeof value.id !== 'string' || !/^draft_[A-Za-z0-9_-]{1,120}$/.test(value.id)
    || typeof value.responseText !== 'string'
    || typeof value.originalFrom !== 'string'
    || typeof value.originalSubject !== 'string'
    || typeof value.replyTo !== 'string'
    || (value.inReplyTo !== undefined && typeof value.inReplyTo !== 'string')
    || (value.references !== undefined && typeof value.references !== 'string')
    || (value.accountName !== undefined && typeof value.accountName !== 'string')
    || !Number.isSafeInteger(value.createdAt)
    || !['pending_review', 'approved', 'rejected', 'escalated', 'sent', 'failed'].includes(value.status as string)
    || !isRecord(value.policyDecision)
    || !['send', 'draft', 'escalate'].includes(value.policyDecision.action as string)
    || typeof value.policyDecision.confidence !== 'number'
    || typeof value.policyDecision.rationale !== 'string'
    || typeof value.policyDecision.hasSensitiveTopic !== 'boolean'
    || !Array.isArray(value.policyDecision.sensitiveTopics)
    || value.policyDecision.sensitiveTopics.some((item) => typeof item !== 'string')) throw new Error('Invalid agentd email draft response')
  return { ...value, ...(attachments ? { attachments } : {}) } as unknown as BrowserEmailDraft
}

const readEmailAttachmentMetadata = (value: unknown): BrowserEmailAttachment => {
  if (!isRecord(value)
    || typeof value.inboundId !== 'string'
    || typeof value.messageId !== 'string'
    || !/^[A-Za-z0-9_.:@-]{1,512}$/.test(value.messageId)
    || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.id)
    || (value.name !== undefined && typeof value.name !== 'string')
    || (value.mimeType !== undefined && typeof value.mimeType !== 'string')
    || !Number.isSafeInteger(value.receivedAt)
    || (value.size !== undefined && (!Number.isSafeInteger(value.size) || (value.size as number) < 0 || (value.size as number) > 10 * 1024 * 1024))) throw new Error('Invalid agentd email attachment metadata')
  return {
    inboundId: value.inboundId,
    messageId: value.messageId,
    id: value.id,
    ...(typeof value.name === 'string' && value.name ? { name: value.name } : {}),
    ...(typeof value.mimeType === 'string' && value.mimeType ? { mimeType: value.mimeType } : {}),
    ...(Number.isSafeInteger(value.size) ? { size: value.size as number } : {}),
    receivedAt: value.receivedAt as number,
  }
}

const readEmailAttachmentScan = (value: unknown): BrowserEmailAttachmentScan => {
  if (!isRecord(value)
    || typeof value.safe !== 'boolean'
    || typeof value.reason !== 'string'
    || !Number.isSafeInteger(value.size) || (value.size as number) < 0
    || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !['pdf', 'png', 'jpeg', 'text', 'unknown'].includes(value.detectedType as string)) throw new Error('Invalid agentd email attachment scan')
  return {
    safe: value.safe,
    reason: value.reason,
    size: value.size as number,
    sha256: value.sha256,
    detectedType: value.detectedType as BrowserEmailAttachmentScan['detectedType'],
  }
}

const validInboundEmailAttachments = (value: unknown): value is Array<{ id: string; name?: string; mimeType?: string; size?: number }> => (
  value === undefined
  || (Array.isArray(value) && value.length <= 20 && value.every((item) => isRecord(item)
    && typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(item.id)
    && (item.name === undefined || typeof item.name === 'string')
    && (item.mimeType === undefined || typeof item.mimeType === 'string')
    && (item.size === undefined || (Number.isSafeInteger(item.size) && (item.size as number) >= 0 && (item.size as number) <= 10 * 1024 * 1024))))
)

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

const readProductPreferences = (value: unknown): ProductPreferences => {
  if (!isRecord(value)
    || !['dark', 'light', 'system'].includes(value.theme as string)
    || !['auto', 'chrome', 'msedge', 'firefox', 'webkit', 'chromium'].includes(value.playwrightBrowser as string)
    || typeof value.playwrightHeadless !== 'boolean'
    || typeof value.fileSystemSafeMode !== 'boolean'
    || !['sqlite', 'server-memory'].includes(value.memoryBackend as string)
    || typeof value.ttsEnabled !== 'boolean'
    || typeof value.ttsRate !== 'number'
    || typeof value.ttsPitch !== 'number'
    || (value.ttsVoice !== null && typeof value.ttsVoice !== 'string')
    || typeof value.speechLang !== 'string'
    || typeof value.offlineSpeech !== 'boolean'
    || typeof value.voskModel !== 'string'
    || typeof value.browserModel !== 'string') throw new Error('Invalid product preferences response')
  return value as unknown as ProductPreferences
}

export interface BrowserAuditLogEntry {
  timestamp: string
  [key: string]: unknown
}

export interface BrowserSystemInfo {
  productName: string
  productVersion: string
  runtime: 'agentd'
  platform: string
  engine: string
}

export interface BrowserDraft {
  id: number
  channel: 'whatsapp'
  providerEventId: string
  conversationId: string
  responseText: string
  status: 'draft' | 'approved' | 'rejected' | 'sent'
  createdAt: number
  updatedAt: number
  sendStatus?: 'pending' | 'sent' | 'failed'
  providerMessageId?: string
  sendError?: string
  sendCancellationRequested?: boolean
  sendAttempts?: number
}

export interface BrowserDraftSendResult {
  providerMessageId: string
  duplicate: boolean
  draft: BrowserDraft
}

export interface BrowserWhatsAppDraftResult {
  accepted: boolean
  duplicate: boolean
  paused: boolean
  draftId?: number
}

export interface BrowserWhatsAppPolicyDecision {
  action: 'send' | 'draft' | 'escalate'
  rationale: string
  grounding: 'grounded' | 'not_grounded' | 'unavailable'
  confidence?: number
  sensitiveTopic?: boolean
  evidence?: Array<{ fileName: string; rank?: number }>
}

export interface BrowserAutonomyMetrics {
  inbound: number
  sent: number
  escalated: number
  drafts: number
  failed: number
  averageDecisionLatencyMs: number
  llmCalls: number
  averageLlmLatencyMs: number
  groundedDecisionRate: number
  deliveryUnknown: number
  draftApprovalRate: number
  averageDraftEditingTimeMs: number
  estimatedCostPerResolvedConversation: number | null
  reviewedDecisions: number
  reviewAccuracy: number
  escalationPrecision: number
  unnecessaryEscalations: number
  missedEscalations: number
  recoveryDrills: number
  averageRecoveryTimeMs: number
}

export interface BrowserAutonomyUsageDay {
  day: string
  llmCalls: number
  outboundMessages: number
  estimatedCost: number
}

export interface BrowserAutonomyChannelUsage {
  channel: string
  amount: number
}

export type BrowserDecisionReviewLabel = 'correct' | 'incorrect' | 'unnecessary_escalation' | 'missed_escalation'

export interface BrowserDecisionEvidence {
  inboundId: string
  jid: string
  createdAt: number
  decision: {
    grounding: 'grounded' | 'not_grounded' | 'unavailable'
    reason: string
    confidence?: number
    escalated?: boolean
    sensitiveTopic?: boolean
    evidence?: Array<{ fileName: string; filePath?: string; rank?: number }>
  }
  label?: BrowserDecisionReviewLabel
  notes?: string
  reviewedAt?: number
}

export interface BrowserEmailDeliveryEvent {
  providerMessageId: string
  channel: 'email'
  status: 'sent' | 'failed'
  eventAt: number
  inboundId: string
}

export interface BrowserAutonomyNotification {
  id: number
  kind: 'failure' | 'budget' | 'recovery' | 'escalation_sla_overdue'
  details: string
  createdAt: number
}

export interface BrowserContinuityStatus {
  version: 1
  runtime: 'agentd'
  migration: {
    source: 'electron'
    target: 'agentd'
    state: 'native-owner-action-required'
    secretsExcluded: true
    note: string
  }
  stores: Array<{
    id: 'electron-settings' | 'electron-persona' | 'electron-chat-history' | 'agentd-state'
    source: 'electron' | 'agentd'
    target: string
    format: 'json' | 'sqlite'
    schemaVersion: string
    requiresReauthentication: boolean
    state: 'pending' | 'active'
  }>
  data: {
    sessions: number
    messages: number
    knowledgeDocuments: number
    inboundEvents: number
    drafts: number
  }
  credentials: Array<{ key: CredentialKey; present: boolean; available: boolean }>
}

export interface BrowserKnowledgeDocument {
  id: number
  file_path: string
  file_name: string
  created_at: string
  file_type?: string
  size?: number
}

export interface BrowserKnowledgeResult extends BrowserKnowledgeDocument {
  content: string
  rank?: number
}

export interface BrowserIntelligenceLog {
  id: number
  type: string
  event: string
  details?: string | null
  timestamp: string
}

export interface BrowserMemoryStats {
  entityCount: number
  relationCount: number
  storageSize: number
  avgSearchLatency: number
  backend: string
}

export interface BrowserMemoryExport {
  entities: unknown[]
  relations: unknown[]
  metadata: Record<string, unknown>
}

export interface BrowserWhatsAppSendResult {
  providerMessageId: string
}

export interface BrowserOllamaSettings {
  baseUrl: string
  model: string
}

export interface BrowserOllamaTestResult {
  success: boolean
  modelCount?: number
  models?: string[]
  error?: string
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
  getContinuityStatus(): Promise<BrowserContinuityStatus>
  getSystemInfo(): Promise<BrowserSystemInfo>
  cancelGeneration(sessionId: string, requestId: string): Promise<boolean>
  getLlmSettings(): Promise<LlmSettings>
  saveLlmSettings(settings: LlmSettings): Promise<LlmSettings>
  getWhatsAppSettings(): Promise<WhatsAppSettings>
  saveWhatsAppSettings(settings: WhatsAppSettings): Promise<WhatsAppSettings>
  getWhatsAppConnectionState(): Promise<BrowserWhatsAppConnectionState>
  getWhatsAppUiSettings(): Promise<BrowserWhatsAppUiSettings>
  saveWhatsAppUiSettings(settings: BrowserWhatsAppUiSettings): Promise<BrowserWhatsAppUiSettings>
  connectWhatsApp(targetPhoneNumber?: string): Promise<BrowserWhatsAppConnectionState>
  disconnectWhatsApp(clearAuth?: boolean): Promise<BrowserWhatsAppConnectionState>
  setWhatsAppTarget(phoneNumber: string): Promise<{ success: boolean; error?: string; handshakeCode?: string }>
  sendWhatsAppText(to: string, text: string): Promise<BrowserWhatsAppSendResult>
  sendWhatsAppMedia(to: string, media: { fileName: string; mimeType: string; size: number; dataBase64: string; type: 'image' | 'video' | 'audio' | 'document'; caption?: string }): Promise<BrowserWhatsAppSendResult>
  getOllamaSettings(): Promise<BrowserOllamaSettings>
  saveOllamaSettings(settings: BrowserOllamaSettings): Promise<BrowserOllamaSettings>
  testOllama(): Promise<BrowserOllamaTestResult>
  getEmailSettings(): Promise<EmailSettings>
  saveEmailSettings(settings: EmailSettings): Promise<EmailSettings>
  testEmail(): Promise<BrowserEmailTestResult>
  listEmailAttachments(limit?: number): Promise<BrowserEmailAttachment[]>
  listEmailDeliveryHistory(limit?: number): Promise<BrowserEmailDeliveryEvent[]>
  retrieveGmailAttachment(messageId: string, attachmentId: string, metadata?: { mimeType?: string; name?: string }): Promise<BrowserEmailAttachmentResult>
  getEmailInboundAttachment(providerEventId: string, attachmentId: string): Promise<BrowserEmailInboundAttachmentResult>
  getGmailOAuthStatus(): Promise<BrowserGmailOAuthStatus>
  startGmailOAuth(): Promise<{ authorizationUrl: string; expiresAt: number }>
  signOutGmailOAuth(): Promise<void>
  ingestEmailInbound(event: { providerEventId: string; conversationId: string; payload: BrowserEmailInboundEvent['payload'] }): Promise<{ accepted: true; duplicate: boolean; id: number }>
  claimEmailInbound(limit?: number): Promise<BrowserEmailInboundEvent[]>
  listEmailInbound(afterId?: number, limit?: number, status?: Extract<BrowserEmailInboundEvent['status'], 'queued' | 'processing' | 'completed'>): Promise<{ events: BrowserEmailInboundEvent[]; nextAfterId: number }>
  acknowledgeEmailInbound(eventIds: number[]): Promise<number[]>
  listEmailDrafts(limit?: number, status?: BrowserEmailDraftStatus): Promise<BrowserEmailDraft[]>
  saveEmailDraft(draft: BrowserEmailDraft): Promise<BrowserEmailDraft>
  updateEmailDraft(id: string, update: { responseText?: string; status?: BrowserEmailDraftStatus; attachments?: BrowserEmailDraftAttachment[] }): Promise<BrowserEmailDraft>
  sendEmailDraft(id: string): Promise<BrowserEmailDraft>
  deleteEmailDraft(id: string): Promise<void>
  listWhatsAppInbound(afterId?: number, limit?: number): Promise<{ events: BrowserWhatsAppInboundEvent[]; nextAfterId: number }>
  getWhatsAppInboundMedia(providerEventId: string): Promise<BrowserWhatsAppInboundMedia>
  createWhatsAppDraft(event: { providerEventId: string; conversationId: string; payload: Record<string, unknown>; draftText: string; policyDecision?: BrowserWhatsAppPolicyDecision }): Promise<BrowserWhatsAppDraftResult>
  getPersonaSettings(): Promise<PersonaSettings>
  savePersonaSettings(settings: PersonaSettings): Promise<PersonaSettings>
  getProductPreferences(): Promise<ProductPreferences>
  saveProductPreferences(settings: ProductPreferences): Promise<ProductPreferences>
  appendAuditLog(entry: Record<string, unknown>): Promise<void>
  listAuditLogs(limit?: number): Promise<BrowserAuditLogEntry[]>
  pauseAll(): Promise<{ paused: boolean }>
  resumeAll(): Promise<{ paused: boolean }>
  listDrafts(limit?: number, status?: BrowserDraft['status']): Promise<BrowserDraft[]>
  updateDraftStatus(id: number, status: BrowserDraft['status']): Promise<BrowserDraft>
  sendWhatsAppDraft(id: number): Promise<BrowserDraftSendResult>
  retryWhatsAppDraft(id: number): Promise<BrowserDraftSendResult>
  quarantineWhatsAppDraft(id: number): Promise<BrowserDraft>
  cancelWhatsAppDraft(id: number): Promise<BrowserDraft>
  getAutonomyMetrics(days?: number): Promise<BrowserAutonomyMetrics>
  enterRecoveryMode(reason?: string): Promise<{ recoveryMode: boolean; paused: boolean; reason: string | null }>
  clearRecoveryMode(): Promise<{ recoveryMode: boolean; paused: boolean; reason: string | null }>
  getAutonomyUsageHistory(days?: number): Promise<BrowserAutonomyUsageDay[]>
  getAutonomyChannelUsage(days?: number): Promise<BrowserAutonomyChannelUsage[]>
  listDecisionEvidence(limit?: number): Promise<BrowserDecisionEvidence[]>
  reviewDecision(inboundId: string, label: BrowserDecisionReviewLabel, notes?: string): Promise<{ reviewed: boolean; inboundId: string; label: BrowserDecisionReviewLabel }>
  listAutonomyNotifications(limit?: number): Promise<BrowserAutonomyNotification[]>
  ackAutonomyNotification(id: number): Promise<{ acknowledged: boolean }>
  listKnowledge(limit?: number): Promise<BrowserKnowledgeDocument[]>
  ingestKnowledge(input: { fileName: string; filePath: string; fileType: string; content: string; size: number }): Promise<BrowserKnowledgeDocument>
  convertKnowledge(input: { fileName: string; fileType: string; dataBase64: string; size: number }): Promise<BrowserKnowledgeDocument>
  deleteKnowledge(id: number): Promise<boolean>
  searchKnowledge(query: string, limit?: number): Promise<BrowserKnowledgeResult[]>
  getIntelligenceStats(): Promise<{ totalQueries: number; resolvedQueries: number; autonomyRate: number; trainingCount: number; learningCount: number }>
  listIntelligenceLogs(limit?: number): Promise<BrowserIntelligenceLog[]>
  logAccuracy(entry: { event: string; details?: string }): Promise<void>
  getMemoryStats(): Promise<BrowserMemoryStats>
  exportMemory(): Promise<BrowserMemoryExport>
  callMemoryTool(name: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: unknown; error?: string }>
  setCredential(key: CredentialKey, value: string): Promise<NativeResult>
  hasCredential(key: CredentialKey): Promise<NativeResult & { exists: boolean }>
  deleteCredential(key: CredentialKey): Promise<NativeResult>
  testProvider(provider: 'openai' | 'openrouter' | 'gemini'): Promise<ProviderTestResult>
  getMcpLifecycle(): Promise<BrowserMcpLifecycle>
  getMcpServers(): Promise<{ servers: BrowserMcpServer[]; execution: 'available' | 'unavailable'; reason: string }>
  saveMcpServers(servers: Array<Record<string, unknown>>): Promise<{ servers: BrowserMcpServer[]; execution: 'available' | 'unavailable'; reason: string }>
  connectMcpServer(serverId: string): Promise<BrowserMcpServer>
  disconnectMcpServer(serverId: string): Promise<BrowserMcpServer>
  listMcpTools(serverId: string): Promise<{ server: BrowserMcpServer; tools: BrowserMcpTool[] }>
  callMcpTool(serverId: string, toolName: string, args: Record<string, unknown>, requestId?: string): Promise<{ result: unknown; requestId: string }>
  cancelMcpTool(requestId: string): Promise<boolean>
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

  const requestResponse = async (path: string, init: RequestInit = {}, mutation = false): Promise<Response> => {
    const headers = new Headers(init.headers)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    // A second client instance can be created by a lazy browser chunk after
    // pairing. Refresh the memory-only shared slot before protecting a write.
    if (mutation && !csrfToken) csrfToken = readSharedCsrf()
    if (mutation && csrfToken) headers.set('x-csrf-token', csrfToken)
    return fetcher(new URL(path, `${baseOrigin}/`).toString(), {
      ...init,
      headers,
      credentials: 'include',
    })
  }

  const request = async <T = unknown>(path: string, init: RequestInit = {}, mutation = false): Promise<T> => {
    const response = await requestResponse(path, init, mutation)
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
  const getMcpLifecycle = async (): Promise<BrowserMcpLifecycle> => readMcpLifecycle(await request('/api/v1/mcp'))
  const getMcpServers = async () => readMcpServers(await request('/api/v1/mcp/servers'))
  const readMcpServer = (value: unknown): BrowserMcpServer => {
    const parsed = readMcpServers({ servers: [value], execution: 'available', reason: 'ok' })
    return parsed.servers[0]
  }
  const saveMcpServers = async (servers: Array<Record<string, unknown>>) => readMcpServers(await request('/api/v1/mcp/servers', { method: 'PUT', body: JSON.stringify({ servers }) }, true))
  const connectMcpServer = async (serverId: string): Promise<BrowserMcpServer> => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(serverId)) throw new Error('Invalid MCP server ID')
    const value = await request<unknown>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/connect`, { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || !value.server) throw new Error('Invalid MCP connect response')
    return readMcpServer(value.server)
  }
  const disconnectMcpServer = async (serverId: string): Promise<BrowserMcpServer> => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(serverId)) throw new Error('Invalid MCP server ID')
    const value = await request<unknown>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/disconnect`, { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || !value.server) throw new Error('Invalid MCP disconnect response')
    return readMcpServer(value.server)
  }
  const listMcpTools = async (serverId: string): Promise<{ server: BrowserMcpServer; tools: BrowserMcpTool[] }> => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(serverId)) throw new Error('Invalid MCP server ID')
    const value = await request<unknown>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/tools`)
    if (!isRecord(value) || !value.server || !Array.isArray(value.tools)) throw new Error('Invalid MCP tools response')
    const server = readMcpServer(value.server)
    const tools = readMcpServers({ servers: [{ ...server, tools: value.tools }], execution: 'available', reason: 'ok' }).servers[0].tools
    return { server, tools }
  }
  const callMcpTool = async (serverId: string, toolName: string, args: Record<string, unknown>, requestId?: string): Promise<{ result: unknown; requestId: string }> => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(serverId) || !/^[A-Za-z0-9._-]{1,128}$/.test(toolName)) throw new Error('Invalid MCP tool request')
    const value = await request<unknown>(`/api/v1/mcp/servers/${encodeURIComponent(serverId)}/call`, { method: 'POST', body: JSON.stringify({ toolName, args, ...(requestId ? { requestId } : {}) }) }, true)
    if (!isRecord(value) || typeof value.requestId !== 'string' || !Object.prototype.hasOwnProperty.call(value, 'result')) throw new Error('Invalid MCP tool response')
    return { result: value.result, requestId: value.requestId }
  }
  const cancelMcpTool = async (requestId: string): Promise<boolean> => {
    if (!/^[A-Za-z0-9._:-]{1,100}$/.test(requestId)) throw new Error('Invalid MCP request ID')
    const value = await request<unknown>('/api/v1/mcp/cancel', { method: 'POST', body: JSON.stringify({ requestId }) }, true)
    if (!isRecord(value) || typeof value.cancelled !== 'boolean') throw new Error('Invalid MCP cancellation response')
    return value.cancelled
  }
  const getContinuityStatus = async (): Promise<BrowserContinuityStatus> => readContinuityStatus(await request('/api/v1/continuity/status'))

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

  const createSession = async (sessionId: string, title: string, workspacePath?: string, metadata?: ChatSessionMetadata): Promise<void> => {
    await request('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({
        id: sessionId,
        title,
        ...(workspacePath ? { workspacePath } : {}),
        ...(metadata?.status ? { status: metadata.status } : {}),
        ...(metadata?.channel ? { channel: metadata.channel } : {}),
        ...(metadata?.contactId ? { contactId: metadata.contactId } : {}),
        ...(metadata?.threadId ? { threadId: metadata.threadId } : {}),
        ...(metadata?.topic ? { topic: metadata.topic } : {}),
      }),
    }, true)
  }

  const updateSessionWorkspace = async (sessionId: string, workspacePath: string | null, metadata?: ChatSessionMetadata): Promise<void> => {
    await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        workspacePath,
        ...(metadata?.status ? { status: metadata.status } : {}),
        ...(metadata?.channel ? { channel: metadata.channel } : {}),
        ...(metadata?.contactId ? { contactId: metadata.contactId } : {}),
        ...(metadata?.threadId ? { threadId: metadata.threadId } : {}),
        ...(metadata?.topic ? { topic: metadata.topic } : {}),
      }),
    }, true)
  }

  const deleteSession = async (sessionId: string): Promise<void> => {
    await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }, true)
  }

  const appendMessage = async (sessionId: string, message: ChatMessage): Promise<void> => {
    await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ id: message.id, role: message.role, content: message.content, ...(message.attachments ? { attachments: message.attachments } : {}) }),
    }, true)
  }

  const cancelGeneration = async (sessionId: string, requestId: string): Promise<boolean> => {
    const value = await request<unknown>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/generations/${encodeURIComponent(requestId)}/cancel`, { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || typeof value.cancelled !== 'boolean') throw new Error('Invalid agentd cancellation response')
    return value.cancelled
  }

  const generate = async (requestBody: ChatGenerationRequest, onEvent: Parameters<ChatClient['generate']>[1], signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) throw new DOMException('Chat generation canceled', 'AbortError')
    let cancelPromise: Promise<boolean> | null = null
    const onAbort = () => { cancelPromise = cancelGeneration(requestBody.sessionId, requestBody.requestId).catch(() => false) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
    let response: Response
    try {
      response = await requestResponse(`/api/v1/sessions/${encodeURIComponent(requestBody.sessionId)}/generations`, {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        signal,
        body: JSON.stringify({ requestId: requestBody.requestId, content: requestBody.content, ...(requestBody.model ? { model: requestBody.model } : {}), ...(requestBody.attachments ? { attachments: requestBody.attachments } : {}) }),
      }, true)
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Chat generation canceled', 'AbortError')
      throw error
    }
    if (!response.ok) {
      const body = await readJson(response)
      const message = isRecord(body) ? errorText(body.error, `Agentd request failed (${response.status})`) : `Agentd request failed (${response.status})`
      throw new BrowserAgentdError(message, response.status || 500)
    }
    if (!String(response.headers.get('content-type') || '').toLowerCase().includes('text/event-stream')) {
      if (signal?.aborted) throw new DOMException('Chat generation canceled', 'AbortError')
      const message = readGeneration(await readJson(response), requestBody)
      onEvent({ type: 'assistant.delta', sessionId: requestBody.sessionId, requestId: requestBody.requestId, sequence: 1, delta: message.content })
      onEvent({ type: 'assistant.done', sessionId: requestBody.sessionId, requestId: requestBody.requestId, sequence: 2 })
      return
    }
    if (!response.body) throw new Error('Agentd generation stream missing')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let eventData: string[] = []
    let completed = false
    const consume = (raw: string) => {
      const data = raw.trim()
      if (!data) return
      let value: unknown
      try { value = JSON.parse(data) } catch { throw new Error('Invalid agentd generation event') }
      if (!isRecord(value) || value.sessionId !== requestBody.sessionId || value.requestId !== requestBody.requestId || typeof value.type !== 'string' || !Number.isSafeInteger(value.sequence)) throw new Error('Invalid agentd generation event')
      if (value.type === 'assistant.delta') {
        if (typeof value.delta !== 'string') throw new Error('Invalid agentd generation event')
        onEvent({ type: 'assistant.delta', sessionId: requestBody.sessionId, requestId: requestBody.requestId, sequence: value.sequence as number, delta: value.delta })
      } else if (value.type === 'assistant.done') {
        completed = true
        onEvent({ type: 'assistant.done', sessionId: requestBody.sessionId, requestId: requestBody.requestId, sequence: value.sequence as number })
      } else if (value.type === 'error') {
        throw new Error(errorText(value.message, 'Agentd generation failed'))
      } else {
        throw new Error('Invalid agentd generation event')
      }
    }
    const flush = () => {
      if (!eventData.length) return
      const data = eventData.join('\n')
      eventData = []
      consume(data)
    }
    try {
      while (!completed) {
        if (signal?.aborted) throw new DOMException('Chat generation canceled', 'AbortError')
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (!line) flush()
          else if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart())
        }
      }
      buffer += decoder.decode()
      for (const line of buffer.split(/\r?\n/)) {
        if (!line) flush()
        else if (line.startsWith('data:')) eventData.push(line.slice(5).trimStart())
      }
      flush()
      if (!completed) throw new Error('Agentd generation stream ended before completion')
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Chat generation canceled', 'AbortError')
      throw error
    }
    } catch (error) {
      if (signal?.aborted) {
        await cancelPromise
        throw new DOMException('Chat generation canceled', 'AbortError')
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }
  }

  const getLlmSettings = async () => readLlmSettings(await request('/api/v1/settings/llm'))
  const saveLlmSettings = async (settings: LlmSettings) => readLlmSettings(await request('/api/v1/settings/llm', { method: 'PUT', body: JSON.stringify(settings) }, true))
  const getWhatsAppSettings = async () => readWhatsAppSettings(await request('/api/v1/settings/whatsapp'))
  const saveWhatsAppSettings = async (settings: WhatsAppSettings) => readWhatsAppSettings(await request('/api/v1/settings/whatsapp', { method: 'PUT', body: JSON.stringify(settings) }, true))
  const getWhatsAppConnectionState = async () => readWhatsAppConnectionState(await request('/api/v1/whatsapp/connection'))
  const getWhatsAppUiSettings = async () => readWhatsAppUiSettings(await request('/api/v1/settings/whatsapp-ui'))
  const saveWhatsAppUiSettings = async (settings: BrowserWhatsAppUiSettings) => readWhatsAppUiSettings(await request('/api/v1/settings/whatsapp-ui', { method: 'PUT', body: JSON.stringify(settings) }, true))
  const connectWhatsApp = async (targetPhoneNumber?: string) => readWhatsAppConnectionState(await request('/api/v1/whatsapp/connect', { method: 'POST', body: JSON.stringify(targetPhoneNumber ? { targetPhoneNumber } : {}) }, true))
  const disconnectWhatsApp = async (clearAuth = true) => readWhatsAppConnectionState(await request('/api/v1/whatsapp/disconnect', { method: 'POST', body: JSON.stringify({ clearAuth }) }, true))
  const setWhatsAppTarget = async (phoneNumber: string) => {
    const value = await request<unknown>('/api/v1/whatsapp/target', { method: 'POST', body: JSON.stringify({ phoneNumber }) }, true)
    if (!isRecord(value) || typeof value.success !== 'boolean' || (value.error !== undefined && typeof value.error !== 'string') || (value.handshakeCode !== undefined && typeof value.handshakeCode !== 'string')) throw new Error('Invalid WhatsApp target response')
    return {
      success: value.success,
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
      ...(typeof value.handshakeCode === 'string' ? { handshakeCode: value.handshakeCode } : {}),
    }
  }
  const sendWhatsAppText = async (to: string, text: string): Promise<BrowserWhatsAppSendResult> => {
    if (!to.trim() || !text.trim()) throw new Error('WhatsApp recipient and message are required')
    const value = await request<unknown>('/api/v1/whatsapp/messages', { method: 'POST', body: JSON.stringify({ to, text }) }, true)
    if (!isRecord(value) || value.success !== true || typeof value.providerMessageId !== 'string' || !value.providerMessageId) throw new Error('Invalid WhatsApp send response')
    return { providerMessageId: value.providerMessageId }
  }
  const sendWhatsAppMedia = async (to: string, media: { fileName: string; mimeType: string; size: number; dataBase64: string; type: 'image' | 'video' | 'audio' | 'document'; caption?: string }): Promise<BrowserWhatsAppSendResult> => {
    if (!to.trim() || !media.fileName.trim() || !media.mimeType.trim() || !media.dataBase64 || media.size < 1) throw new Error('WhatsApp recipient and media are required')
    const value = await request<unknown>('/api/v1/whatsapp/media', { method: 'POST', body: JSON.stringify({ to, ...media, caption: media.caption || '' }) }, true)
    if (!isRecord(value) || value.success !== true || typeof value.providerMessageId !== 'string' || !value.providerMessageId) throw new Error('Invalid WhatsApp media send response')
    return { providerMessageId: value.providerMessageId }
  }
  const createWhatsAppDraft = async (event: { providerEventId: string; conversationId: string; payload: Record<string, unknown>; draftText: string; policyDecision?: BrowserWhatsAppPolicyDecision }): Promise<BrowserWhatsAppDraftResult> => {
    const value = await request<unknown>('/api/v1/whatsapp/events', {
      method: 'POST',
      body: JSON.stringify({ channel: 'whatsapp', ...event }),
    }, true)
    if (!isRecord(value) || typeof value.accepted !== 'boolean' || typeof value.duplicate !== 'boolean' || typeof value.paused !== 'boolean'
      || (value.draftId !== undefined && !Number.isSafeInteger(value.draftId))) throw new Error('Invalid WhatsApp draft response')
    return {
      accepted: value.accepted,
      duplicate: value.duplicate,
      paused: value.paused,
      ...(Number.isSafeInteger(value.draftId) ? { draftId: value.draftId as number } : {}),
    }
  }
  const getOllamaSettings = async () => readOllamaSettings(await request('/api/v1/settings/ollama'))
  const saveOllamaSettings = async (settings: BrowserOllamaSettings) => readOllamaSettings(await request('/api/v1/settings/ollama', { method: 'PUT', body: JSON.stringify(settings) }, true))
  const testOllama = async (): Promise<BrowserOllamaTestResult> => {
    const value = await request<unknown>('/api/v1/providers/ollama/test', { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || typeof value.success !== 'boolean') throw new Error('Invalid Ollama provider test response')
    if (!value.success) return { success: false, error: errorText(value.error, 'Ollama provider test failed') }
    if (!Number.isSafeInteger(value.modelCount) || (value.modelCount as number) < 0 || (value.models !== undefined && (!Array.isArray(value.models) || value.models.some((item) => typeof item !== 'string')))) throw new Error('Invalid Ollama provider test response')
    return { success: true, modelCount: value.modelCount as number, ...(Array.isArray(value.models) ? { models: value.models as string[] } : {}) }
  }
  const getEmailSettings = async () => readEmailSettings(await request('/api/v1/settings/email'))
  const saveEmailSettings = async (settings: EmailSettings) => readEmailSettings(await request('/api/v1/settings/email', { method: 'PUT', body: JSON.stringify(settings) }, true))
  const readGmailOAuthStatus = (value: unknown): BrowserGmailOAuthStatus => {
    if (!isRecord(value) || typeof value.signedIn !== 'boolean' || (value.email !== null && typeof value.email !== 'string') || typeof value.requiresReauthentication !== 'boolean') throw new Error('Invalid Gmail OAuth status response')
    return { signedIn: value.signedIn, email: value.email as string | null, requiresReauthentication: value.requiresReauthentication }
  }
  const getGmailOAuthStatus = async () => readGmailOAuthStatus(await request('/api/v1/email/oauth/status'))
  const startGmailOAuth = async (): Promise<{ authorizationUrl: string; expiresAt: number }> => {
    const value = await request<unknown>('/api/v1/email/oauth/start', { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || typeof value.authorizationUrl !== 'string' || !Number.isSafeInteger(value.expiresAt)) throw new Error('Invalid Gmail OAuth start response')
    let url: URL
    try { url = new URL(value.authorizationUrl) } catch { throw new Error('Invalid Gmail OAuth authorization URL') }
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password) throw new Error('Invalid Gmail OAuth authorization URL')
    return { authorizationUrl: url.toString(), expiresAt: value.expiresAt as number }
  }
  const signOutGmailOAuth = async (): Promise<void> => {
    const value = await request<unknown>('/api/v1/email/oauth/signout', { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || value.success !== true) throw new Error('Invalid Gmail OAuth sign-out response')
  }
  const testEmail = async (): Promise<BrowserEmailTestResult> => {
    const value = await request<unknown>('/api/v1/email/test', { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || value.success !== true || value.credentialConfigured !== true || !isRecord(value.transport)) {
      throw new Error('Invalid email test response')
    }
    const transport = value.transport
    const validImapSmtp = isRecord(transport.imap) && transport.imap.reachable === true && typeof transport.imap.tls === 'boolean'
      && isRecord(transport.smtp) && transport.smtp.reachable === true && typeof transport.smtp.tls === 'boolean'
    const validGmail = isRecord(transport.gmailApi) && transport.gmailApi.reachable === true && transport.gmailApi.tls === true
    if (!validImapSmtp && !validGmail) throw new Error('Invalid email test response')
    if (value.oauth !== undefined && (!isRecord(value.oauth) || typeof value.oauth.signedIn !== 'boolean' || (value.oauth.email !== null && typeof value.oauth.email !== 'string'))) throw new Error('Invalid email test response')
    return value as unknown as BrowserEmailTestResult
  }
  const listEmailAttachments = async (limit = 20): Promise<BrowserEmailAttachment[]> => {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 20
    const value = await request<unknown>(`/api/v1/email/attachments?limit=${boundedLimit}`)
    if (!isRecord(value) || !Array.isArray(value.attachments)) throw new Error('Invalid agentd email attachment list response')
    return value.attachments.map(readEmailAttachmentMetadata)
  }
  const listEmailDeliveryHistory = async (limit = 50): Promise<BrowserEmailDeliveryEvent[]> => {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50
    const value = await request<unknown>(`/api/v1/email/delivery-history?limit=${boundedLimit}`)
    if (!isRecord(value) || !Array.isArray(value.events)) throw new Error('Invalid agentd email delivery history response')
    return value.events.map((item) => {
      if (!isRecord(item)
        || typeof item.providerMessageId !== 'string' || !item.providerMessageId.startsWith('email:')
        || item.channel !== 'email' || !['sent', 'failed'].includes(item.status as string)
        || !Number.isSafeInteger(item.eventAt) || (item.eventAt as number) < 0
        || typeof item.inboundId !== 'string') throw new Error('Invalid agentd email delivery event')
      return item as unknown as BrowserEmailDeliveryEvent
    })
  }
  const retrieveGmailAttachment = async (messageId: string, attachmentId: string, metadata: { mimeType?: string; name?: string } = {}): Promise<BrowserEmailAttachmentResult> => {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(messageId) || !/^[A-Za-z0-9_-]{1,256}$/.test(attachmentId)) throw new Error('Invalid Gmail attachment identity')
    if (metadata.mimeType !== undefined && (typeof metadata.mimeType !== 'string' || metadata.mimeType.length > 128)) throw new Error('Invalid Gmail attachment MIME type')
    if (metadata.name !== undefined && (typeof metadata.name !== 'string' || metadata.name.length > 256)) throw new Error('Invalid Gmail attachment name')
    const value = await request<unknown>(`/api/v1/email/attachments/${encodeURIComponent(messageId)}/${encodeURIComponent(attachmentId)}`, { method: 'POST', body: JSON.stringify(metadata) }, true)
    if (!isRecord(value)) throw new Error('Invalid agentd email attachment response')
    const scan = readEmailAttachmentScan(value.scan)
    if (value.bytes === undefined) return { scan }
    if (typeof value.bytes !== 'string' || value.bytes.length > Math.ceil(10 * 1024 * 1024 * 4 / 3) + 1024) throw new Error('Invalid agentd email attachment bytes')
    let binary: string
    try { binary = atob(value.bytes) } catch { throw new Error('Invalid agentd email attachment bytes') }
    if (binary.length > 10 * 1024 * 1024) throw new Error('Invalid agentd email attachment bytes')
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return { scan, bytes }
  }
  const getEmailInboundAttachment = async (providerEventId: string, attachmentId: string): Promise<BrowserEmailInboundAttachmentResult> => {
    if (typeof providerEventId !== 'string' || !/^[A-Za-z0-9_.:@-]{1,300}$/.test(providerEventId) || !/^[A-Za-z0-9_-]{1,256}$/.test(attachmentId)) throw new Error('Invalid email attachment identity')
    const response = await requestResponse(`/api/v1/email/inbound/media/${encodeURIComponent(providerEventId)}/${encodeURIComponent(attachmentId)}`)
    if (!response.ok) {
      const body = await readJson(response)
      throw new BrowserAgentdError(isRecord(body) ? errorText(body.error, 'Email attachment unavailable') : 'Email attachment unavailable', response.status || 500)
    }
    const mimeType = (response.headers.get('content-type') || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase()
    if (!/^(?:image|application|text)\/[A-Za-z0-9.+-]+$/.test(mimeType)) throw new Error('Invalid email attachment MIME type')
    const lengthHeader = response.headers.get('content-length')
    const size = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN
    if (!Number.isSafeInteger(size) || size < 1 || size > 512 * 1024) throw new Error('Invalid email attachment size')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length !== size) throw new Error('Email attachment size changed')
    const disposition = response.headers.get('content-disposition') || ''
    const filenameMatch = /filename="([^"]{1,256})"/i.exec(disposition)
    const fileName = (filenameMatch?.[1] || attachmentId).replace(/[\0\r\n\\/]/g, '_')
    const sha256 = response.headers.get('x-aica-sha256') || ''
    const detectedType = response.headers.get('x-aica-detected-type') || ''
    const reason = response.headers.get('x-aica-scan-reason') || ''
    if (response.headers.get('x-aica-scan-safe') !== 'true' || !/^[a-f0-9]{64}$/.test(sha256) || !['pdf', 'png', 'jpeg', 'text', 'unknown'].includes(detectedType) || !reason) throw new Error('Invalid email attachment scan headers')
    const scan: BrowserEmailAttachmentScan = { safe: true, reason, size, sha256, detectedType: detectedType as BrowserEmailAttachmentScan['detectedType'] }
    return { fileName, mimeType, size, bytes, scan }
  }
  const ingestEmailInbound = async (event: { providerEventId: string; conversationId: string; payload: BrowserEmailInboundEvent['payload'] }) => {
    const value = await request<unknown>('/api/v1/email/inbound', { method: 'POST', body: JSON.stringify(event) }, true)
    if (!isRecord(value) || value.accepted !== true || typeof value.duplicate !== 'boolean' || !Number.isSafeInteger(value.id)) throw new Error('Invalid email inbound response')
    return { accepted: true as const, duplicate: value.duplicate, id: value.id as number }
  }
  const claimEmailInbound = async (limit = 20): Promise<BrowserEmailInboundEvent[]> => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid email inbound claim limit')
    const value = await request<unknown>('/api/v1/email/inbound/claim', { method: 'POST', body: JSON.stringify({ limit }) }, true)
    if (!isRecord(value) || !Array.isArray(value.events)) throw new Error('Invalid email inbound claim response')
    const events = value.events.filter((event): event is BrowserEmailInboundEvent => isRecord(event)
      && Number.isSafeInteger(event.id) && typeof event.providerEventId === 'string' && typeof event.conversationId === 'string'
      && isRecord(event.payload) && typeof event.payload.from === 'string' && typeof event.payload.to === 'string'
      && typeof event.payload.subject === 'string' && typeof event.payload.body === 'string'
      && (event.payload.bodyType === 'text' || event.payload.bodyType === 'html') && typeof event.payload.timestamp === 'number'
      && (event.payload.sourceId === undefined || (typeof event.payload.sourceId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(event.payload.sourceId)))
      && validInboundEmailAttachments(event.payload.attachments)
      && event.status === 'processing' && Number.isSafeInteger(event.createdAt))
    if (events.length !== value.events.length) throw new Error('Invalid email inbound claim response')
    return events
  }
  const listEmailInbound = async (afterId = 0, limit = 20, status?: Extract<BrowserEmailInboundEvent['status'], 'queued' | 'processing' | 'completed'>) => {
    const query = new URLSearchParams({ after_id: String(afterId), limit: String(limit) })
    if (status) query.set('status', status)
    const value = await request<unknown>(`/api/v1/email/inbound?${query.toString()}`)
    if (!isRecord(value) || !Array.isArray(value.events) || !Number.isSafeInteger(value.nextAfterId)) throw new Error('Invalid email inbound list response')
    const events = value.events.filter((event): event is BrowserEmailInboundEvent => isRecord(event)
      && Number.isSafeInteger(event.id) && typeof event.providerEventId === 'string' && typeof event.conversationId === 'string'
      && isRecord(event.payload) && typeof event.payload.from === 'string' && typeof event.payload.to === 'string'
      && typeof event.payload.subject === 'string' && typeof event.payload.body === 'string'
      && (event.payload.bodyType === 'text' || event.payload.bodyType === 'html') && typeof event.payload.timestamp === 'number'
      && (event.payload.sourceId === undefined || (typeof event.payload.sourceId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(event.payload.sourceId)))
      && validInboundEmailAttachments(event.payload.attachments)
      && ['queued', 'draft', 'processing', 'completed'].includes(event.status as string) && Number.isSafeInteger(event.createdAt))
    if (events.length !== value.events.length) throw new Error('Invalid email inbound list response')
    return { events, nextAfterId: value.nextAfterId as number }
  }
  const acknowledgeEmailInbound = async (eventIds: number[]): Promise<number[]> => {
    if (!eventIds.length || eventIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid email inbound acknowledgement')
    const value = await request<unknown>('/api/v1/email/inbound/ack', { method: 'POST', body: JSON.stringify({ eventIds }) }, true)
    if (!isRecord(value) || !Array.isArray(value.acknowledgedIds) || value.acknowledgedIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid email inbound acknowledgement response')
    return value.acknowledgedIds as number[]
  }
  const listEmailDrafts = async (limit = 100, status?: BrowserEmailDraftStatus): Promise<BrowserEmailDraft[]> => {
    const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, Math.trunc(limit)))) })
    if (status) query.set('status', status)
    const value = await request<unknown>(`/api/v1/email/drafts?${query.toString()}`)
    if (!isRecord(value) || !Array.isArray(value.drafts)) throw new Error('Invalid agentd email draft list response')
    return value.drafts.map(readEmailDraft)
  }
  const saveEmailDraft = async (draft: BrowserEmailDraft): Promise<BrowserEmailDraft> => {
    const value = await request<unknown>('/api/v1/email/drafts', { method: 'POST', body: JSON.stringify(draft) }, true)
    return readEmailDraft(value)
  }
  const updateEmailDraft = async (id: string, update: { responseText?: string; status?: BrowserEmailDraftStatus; attachments?: BrowserEmailDraftAttachment[] }): Promise<BrowserEmailDraft> => {
    if (!/^draft_[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error('Invalid email draft id')
    const value = await request<unknown>(`/api/v1/email/drafts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(update) }, true)
    return readEmailDraft(value)
  }
  const sendEmailDraft = async (id: string): Promise<BrowserEmailDraft> => {
    if (!/^draft_[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error('Invalid email draft id')
    const value = await request<unknown>(`/api/v1/email/drafts/${encodeURIComponent(id)}/send`, { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || value.success !== true || !isRecord(value.draft)) throw new Error('Invalid agentd email send response')
    return readEmailDraft(value.draft)
  }
  const deleteEmailDraft = async (id: string): Promise<void> => {
    if (!/^draft_[A-Za-z0-9_-]{1,120}$/.test(id)) throw new Error('Invalid email draft id')
    const value = await request<unknown>(`/api/v1/email/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' }, true)
    if (!isRecord(value) || value.success !== true) throw new Error('Invalid agentd email draft delete response')
  }
  const listWhatsAppInbound = async (afterId = 0, limit = 20) => {
    const value = await request<unknown>(`/api/v1/whatsapp/inbound?after_id=${encodeURIComponent(String(afterId))}&limit=${encodeURIComponent(String(limit))}`)
    if (!isRecord(value) || !Array.isArray(value.events) || !Number.isSafeInteger(value.nextAfterId)) throw new Error('Invalid WhatsApp inbound list response')
    const events = value.events.filter((event): event is BrowserWhatsAppInboundEvent => isRecord(event)
      && Number.isSafeInteger(event.id) && typeof event.providerEventId === 'string' && typeof event.conversationId === 'string'
      && isRecord(event.payload) && ['queued', 'draft', 'processing', 'completed'].includes(event.status as string) && Number.isSafeInteger(event.createdAt))
    if (events.length !== value.events.length) throw new Error('Invalid WhatsApp inbound list response')
    return { events, nextAfterId: value.nextAfterId as number }
  }
  const getWhatsAppInboundMedia = async (providerEventId: string): Promise<BrowserWhatsAppInboundMedia> => {
    if (typeof providerEventId !== 'string' || !/^[\x21-\x7e]{1,300}$/.test(providerEventId)) throw new Error('Invalid WhatsApp media identity')
    const mediaUrl = `/api/v1/whatsapp/inbound/media/${encodeURIComponent(providerEventId)}`
    const response = await requestResponse(mediaUrl)
    if (!response.ok) {
      const body = await readJson(response)
      throw new BrowserAgentdError(isRecord(body) ? errorText(body.error, 'WhatsApp media unavailable') : 'WhatsApp media unavailable', response.status || 500)
    }
    const mimeType = (response.headers.get('content-type') || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase()
    if (!/^(?:image|video|audio|application|text)\/[A-Za-z0-9.+-]+$/.test(mimeType)) throw new Error('Invalid WhatsApp media MIME type')
    const lengthHeader = response.headers.get('content-length')
    const size = lengthHeader && /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : NaN
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BROWSER_WHATSAPP_MEDIA_BYTES) throw new Error('Invalid WhatsApp media size')
    const disposition = response.headers.get('content-disposition') || ''
    const filenameMatch = /filename="([^"]{1,256})"/i.exec(disposition)
    const fileName = (filenameMatch?.[1] || 'whatsapp-media').replace(/[\0\r\n\\/]/g, '_')
    const result: BrowserWhatsAppInboundMedia = { fileName, mimeType, size, mediaUrl }
    // Keep large media streamable in the browser UI. Only small images are copied
    // into the generation payload, matching the existing bounded image contract.
    if (size <= 256 * 1024 && mimeType.startsWith('image/')) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length !== size) throw new Error('WhatsApp media size changed')
      let binary = ''
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
      result.dataUrl = `data:${mimeType};base64,${btoa(binary)}`
    } else {
      await response.body?.cancel()
    }
    return result
  }
  const getPersonaSettings = async () => readPersonaSettings(await request('/api/v1/settings/persona'))
  const savePersonaSettings = async (settings: PersonaSettings) => readPersonaSettings(await request('/api/v1/settings/persona', { method: 'PUT', body: JSON.stringify(settings) }, true))
  const getProductPreferences = async () => readProductPreferences(await request('/api/v1/settings/preferences'))
  const saveProductPreferences = async (settings: ProductPreferences) => readProductPreferences(await request('/api/v1/settings/preferences', { method: 'PUT', body: JSON.stringify(settings) }, true))
  const getSystemInfo = async (): Promise<BrowserSystemInfo> => {
    const value = await request<unknown>('/api/v1/system-info')
    if (!isRecord(value)
      || typeof value.productName !== 'string'
      || typeof value.productVersion !== 'string'
      || value.runtime !== 'agentd'
      || typeof value.platform !== 'string'
      || typeof value.engine !== 'string') throw new Error('Invalid agentd system info response')
    return value as unknown as BrowserSystemInfo
  }
  const appendAuditLog = async (entry: Record<string, unknown>) => {
    await request('/api/v1/logs', { method: 'POST', body: JSON.stringify(entry) }, true)
  }
  const listAuditLogs = async (limit = 100): Promise<BrowserAuditLogEntry[]> => {
    const value = await request<unknown>(`/api/v1/logs?limit=${encodeURIComponent(String(limit))}`)
    if (!isRecord(value) || !Array.isArray(value.entries)) throw new Error('Invalid audit log response')
    return value.entries.filter((entry): entry is BrowserAuditLogEntry => isRecord(entry) && typeof entry.timestamp === 'string') as BrowserAuditLogEntry[]
  }
  const pauseAll = async (): Promise<{ paused: boolean }> => {
    const value = await request<unknown>('/api/v1/pause-all', { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || typeof value.paused !== 'boolean') throw new Error('Invalid agentd pause response')
    return { paused: value.paused }
  }
  const resumeAll = async (): Promise<{ paused: boolean }> => {
    const value = await request<unknown>('/api/v1/resume-all', { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || typeof value.paused !== 'boolean') throw new Error('Invalid agentd resume response')
    return { paused: value.paused }
  }
  const readRecoveryResponse = (value: unknown): { recoveryMode: boolean; paused: boolean; reason: string | null } => {
    if (!isRecord(value) || typeof value.recoveryMode !== 'boolean' || typeof value.paused !== 'boolean' || (value.reason !== null && typeof value.reason !== 'string')) throw new Error('Invalid agentd recovery response')
    return { recoveryMode: value.recoveryMode, paused: value.paused, reason: value.reason as string | null }
  }
  const enterRecoveryMode = async (reason = 'operator_requested') => {
    if (typeof reason !== 'string' || reason.length > 256) throw new Error('Invalid recovery reason')
    return readRecoveryResponse(await request('/api/v1/autonomy/recovery/enter', { method: 'POST', body: JSON.stringify({ reason }) }, true))
  }
  const clearRecoveryMode = async () => readRecoveryResponse(await request('/api/v1/autonomy/recovery/clear', { method: 'POST', body: '{}' }, true))
  const readDraft = (value: unknown): BrowserDraft => {
    if (!isRecord(value)
      || !Number.isSafeInteger(value.id)
      || value.channel !== 'whatsapp'
      || typeof value.providerEventId !== 'string'
      || typeof value.conversationId !== 'string'
      || typeof value.responseText !== 'string'
      || !['draft', 'approved', 'rejected', 'sent'].includes(value.status as string)
      || !Number.isSafeInteger(value.createdAt)
      || !Number.isSafeInteger(value.updatedAt)
      || (value.sendStatus !== undefined && !['pending', 'sent', 'failed'].includes(value.sendStatus as string))
      || (value.providerMessageId !== undefined && typeof value.providerMessageId !== 'string')
      || (value.sendError !== undefined && typeof value.sendError !== 'string')
      || (value.sendCancellationRequested !== undefined && typeof value.sendCancellationRequested !== 'boolean')
      || (value.sendAttempts !== undefined && (!Number.isSafeInteger(value.sendAttempts) || (value.sendAttempts as number) < 0))) throw new Error('Invalid agentd draft response')
    return value as unknown as BrowserDraft
  }
  const listDrafts = async (limit = 50, status?: BrowserDraft['status']): Promise<BrowserDraft[]> => {
    const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, Math.trunc(limit)))) })
    if (status) query.set('status', status)
    const value = await request<unknown>(`/api/v1/drafts?${query.toString()}`)
    if (!isRecord(value) || !Array.isArray(value.drafts)) throw new Error('Invalid agentd draft list response')
    return value.drafts.map(readDraft)
  }
  const updateDraftStatus = async (id: number, status: BrowserDraft['status']): Promise<BrowserDraft> => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid draft id')
    const value = await request<unknown>(`/api/v1/drafts/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }, true)
    return readDraft(value)
  }
  const sendWhatsAppDraft = async (id: number): Promise<BrowserDraftSendResult> => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid draft id')
    const value = await request<unknown>(`/api/v1/whatsapp/drafts/${id}/send`, { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || typeof value.providerMessageId !== 'string' || !value.providerMessageId || typeof value.duplicate !== 'boolean') throw new Error('Invalid WhatsApp draft send response')
    return { providerMessageId: value.providerMessageId, duplicate: value.duplicate, draft: readDraft(value.draft) }
  }
  const retryWhatsAppDraft = async (id: number): Promise<BrowserDraftSendResult> => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid draft id')
    const value = await request<unknown>(`/api/v1/whatsapp/drafts/${id}/retry`, { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || typeof value.providerMessageId !== 'string' || !value.providerMessageId || typeof value.duplicate !== 'boolean') throw new Error('Invalid WhatsApp draft retry response')
    return { providerMessageId: value.providerMessageId, duplicate: value.duplicate, draft: readDraft(value.draft) }
  }
  const disposeWhatsAppDraft = async (id: number, action: 'quarantine' | 'cancel'): Promise<BrowserDraft> => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid draft id')
    const value = await request<unknown>(`/api/v1/whatsapp/drafts/${id}/${action}`, { method: 'POST', body: '{}' }, true)
    return readDraft(value)
  }
  const quarantineWhatsAppDraft = async (id: number): Promise<BrowserDraft> => disposeWhatsAppDraft(id, 'quarantine')
  const cancelWhatsAppDraft = async (id: number): Promise<BrowserDraft> => disposeWhatsAppDraft(id, 'cancel')
  const getAutonomyMetrics = async (days = 14): Promise<BrowserAutonomyMetrics> => {
    const value = await request<unknown>(`/api/v1/autonomy/metrics?days=${encodeURIComponent(String(Math.max(1, Math.min(90, Math.trunc(days)))))}`)
    const fields = ['inbound', 'sent', 'escalated', 'drafts', 'failed', 'averageDecisionLatencyMs', 'llmCalls', 'averageLlmLatencyMs', 'groundedDecisionRate', 'deliveryUnknown', 'draftApprovalRate', 'averageDraftEditingTimeMs', 'reviewedDecisions', 'reviewAccuracy', 'escalationPrecision', 'unnecessaryEscalations', 'missedEscalations', 'recoveryDrills', 'averageRecoveryTimeMs']
    if (!isRecord(value) || fields.some((field) => typeof value[field] !== 'number' || !Number.isFinite(value[field] as number))
      || (value.estimatedCostPerResolvedConversation !== null && (typeof value.estimatedCostPerResolvedConversation !== 'number' || !Number.isFinite(value.estimatedCostPerResolvedConversation)))) throw new Error('Invalid agentd autonomy metrics response')
    return value as unknown as BrowserAutonomyMetrics
  }
  const getAutonomyUsageHistory = async (days = 30): Promise<BrowserAutonomyUsageDay[]> => {
    const boundedDays = Number.isSafeInteger(days) ? Math.min(Math.max(days, 1), 90) : 30
    const value = await request<unknown>(`/api/v1/autonomy/usage-history?days=${boundedDays}`)
    if (!isRecord(value) || !Array.isArray(value.days)) throw new Error('Invalid agentd autonomy usage response')
    return value.days.map((item) => {
      if (!isRecord(item) || typeof item.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.day)
        || typeof item.llmCalls !== 'number' || !Number.isSafeInteger(item.llmCalls) || item.llmCalls < 0
        || typeof item.outboundMessages !== 'number' || !Number.isSafeInteger(item.outboundMessages) || item.outboundMessages < 0
        || typeof item.estimatedCost !== 'number' || !Number.isFinite(item.estimatedCost) || item.estimatedCost < 0) throw new Error('Invalid agentd autonomy usage day')
      return item as unknown as BrowserAutonomyUsageDay
    })
  }
  const getAutonomyChannelUsage = async (days = 1): Promise<BrowserAutonomyChannelUsage[]> => {
    const boundedDays = Number.isSafeInteger(days) ? Math.min(Math.max(days, 1), 90) : 1
    const value = await request<unknown>(`/api/v1/autonomy/channel-usage?days=${boundedDays}`)
    if (!isRecord(value) || !Array.isArray(value.channels)) throw new Error('Invalid agentd autonomy channel usage response')
    return value.channels.map((item) => {
      if (!isRecord(item) || typeof item.channel !== 'string' || !item.channel || item.channel.length > 32
        || typeof item.amount !== 'number' || !Number.isSafeInteger(item.amount) || item.amount < 0) throw new Error('Invalid agentd autonomy channel usage item')
      return item as unknown as BrowserAutonomyChannelUsage
    })
  }
  const readDecisionEvidence = (value: unknown): BrowserDecisionEvidence => {
    if (!isRecord(value) || typeof value.inboundId !== 'string' || !/^(?:draft_[A-Za-z0-9_-]{1,120}|whatsapp_draft_[1-9]\d{0,18})$/.test(value.inboundId)
      || typeof value.jid !== 'string' || value.jid.length > 320 || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
      || !isRecord(value.decision) || !['grounded', 'not_grounded', 'unavailable'].includes(value.decision.grounding as string)
      || typeof value.decision.reason !== 'string' || value.decision.reason.length > 4096
      || (value.decision.confidence !== undefined && (typeof value.decision.confidence !== 'number' || !Number.isFinite(value.decision.confidence) || value.decision.confidence < 0 || value.decision.confidence > 1))
      || (value.decision.evidence !== undefined && (!Array.isArray(value.decision.evidence) || value.decision.evidence.some(item => !isRecord(item) || typeof item.fileName !== 'string' || (item.filePath !== undefined && typeof item.filePath !== 'string') || (item.rank !== undefined && typeof item.rank !== 'number'))))
      || (value.label !== undefined && !['correct', 'incorrect', 'unnecessary_escalation', 'missed_escalation'].includes(value.label as string))
      || (value.notes !== undefined && typeof value.notes !== 'string')
      || (value.reviewedAt !== undefined && (!Number.isSafeInteger(value.reviewedAt) || (value.reviewedAt as number) < 0))) throw new Error('Invalid agentd decision evidence response')
    return value as unknown as BrowserDecisionEvidence
  }
  const listDecisionEvidence = async (limit = 20): Promise<BrowserDecisionEvidence[]> => {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 20
    const value = await request<unknown>(`/api/v1/autonomy/decision-evidence?limit=${boundedLimit}`)
    if (!isRecord(value) || !Array.isArray(value.evidence)) throw new Error('Invalid agentd decision evidence list response')
    return value.evidence.map(readDecisionEvidence)
  }
  const reviewDecision = async (inboundId: string, label: BrowserDecisionReviewLabel, notes = ''): Promise<{ reviewed: boolean; inboundId: string; label: BrowserDecisionReviewLabel }> => {
    if (!/^(?:draft_[A-Za-z0-9_-]{1,120}|whatsapp_draft_[1-9]\d{0,18})$/.test(inboundId) || !['correct', 'incorrect', 'unnecessary_escalation', 'missed_escalation'].includes(label)) throw new Error('Invalid decision review')
    if (typeof notes !== 'string' || notes.length > 2000) throw new Error('Invalid decision review notes')
    const value = await request<unknown>(`/api/v1/autonomy/decision-evidence/${encodeURIComponent(inboundId)}/review`, { method: 'POST', body: JSON.stringify({ label, ...(notes ? { notes } : {}) }) }, true)
    if (!isRecord(value) || value.reviewed !== true || value.inboundId !== inboundId || value.label !== label) throw new Error('Invalid agentd decision review response')
    return { reviewed: true, inboundId, label }
  }
  const readAutonomyNotification = (value: unknown): BrowserAutonomyNotification => {
    if (!isRecord(value)
      || !Number.isSafeInteger(value.id) || (value.id as number) < 1
      || !['failure', 'budget', 'recovery', 'escalation_sla_overdue'].includes(value.kind as string)
      || typeof value.details !== 'string' || value.details.length > 4096
      || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) throw new Error('Invalid agentd autonomy notification response')
    return value as unknown as BrowserAutonomyNotification
  }
  const listAutonomyNotifications = async (limit = 50): Promise<BrowserAutonomyNotification[]> => {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 50) : 50
    const value = await request<unknown>(`/api/v1/autonomy/notifications?limit=${boundedLimit}`)
    if (!isRecord(value) || !Array.isArray(value.notifications)) throw new Error('Invalid agentd autonomy notification list response')
    return value.notifications.map(readAutonomyNotification)
  }
  const ackAutonomyNotification = async (id: number): Promise<{ acknowledged: boolean }> => {
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('Invalid notification ID')
    const value = await request<unknown>(`/api/v1/autonomy/notifications/${id}/ack`, { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || typeof value.acknowledged !== 'boolean') throw new Error('Invalid agentd autonomy notification acknowledgement response')
    return { acknowledged: value.acknowledged }
  }
  const readKnowledgeDocument = (value: unknown): BrowserKnowledgeDocument => {
    if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.file_path !== 'string' || typeof value.file_name !== 'string' || typeof value.created_at !== 'string') throw new Error('Invalid agentd knowledge document')
    return {
      id: value.id as number,
      file_path: value.file_path as string,
      file_name: value.file_name as string,
      created_at: value.created_at as string,
      ...(typeof value.file_type === 'string' ? { file_type: value.file_type } : {}),
      ...(Number.isSafeInteger(value.size) ? { size: value.size as number } : {}),
    }
  }
  const listKnowledge = async (limit = 100): Promise<BrowserKnowledgeDocument[]> => {
    const value = await request<unknown>(`/api/v1/knowledge?limit=${encodeURIComponent(String(limit))}`)
    if (!isRecord(value) || !Array.isArray(value.documents)) throw new Error('Invalid agentd knowledge response')
    return value.documents.map(readKnowledgeDocument)
  }
  const ingestKnowledge = async (input: { fileName: string; filePath: string; fileType: string; content: string; size: number }): Promise<BrowserKnowledgeDocument> => {
    const value = await request<unknown>('/api/v1/knowledge', { method: 'POST', body: JSON.stringify(input) }, true)
    if (!isRecord(value) || value.success !== true) throw new Error('Knowledge ingestion failed')
    return readKnowledgeDocument(value.document)
  }
  const convertKnowledge = async (input: { fileName: string; fileType: string; dataBase64: string; size: number }): Promise<BrowserKnowledgeDocument> => {
    const value = await request<unknown>('/api/v1/knowledge/convert', { method: 'POST', body: JSON.stringify(input) }, true)
    if (!isRecord(value) || value.success !== true) throw new Error('Knowledge conversion failed')
    return readKnowledgeDocument(value.document)
  }
  const deleteKnowledge = async (id: number): Promise<boolean> => {
    const value = await request<unknown>(`/api/v1/knowledge/${encodeURIComponent(String(id))}`, { method: 'DELETE' }, true)
    if (!isRecord(value) || typeof value.deleted !== 'boolean') throw new Error('Invalid knowledge delete response')
    return value.deleted
  }
  const searchKnowledge = async (query: string, limit = 5): Promise<BrowserKnowledgeResult[]> => {
    const value = await request<unknown>(`/api/v1/knowledge/search?query=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(limit))}`)
    if (!isRecord(value) || !Array.isArray(value.results)) throw new Error('Invalid knowledge search response')
    return value.results.map((item) => {
      const document = readKnowledgeDocument(item)
      if (!isRecord(item) || typeof item.content !== 'string') throw new Error('Invalid knowledge result')
      return { ...document, content: item.content, ...(typeof item.rank === 'number' ? { rank: item.rank } : {}) }
    })
  }
  const getIntelligenceStats = async () => {
    const value = await request<unknown>('/api/v1/intelligence/stats')
    if (!isRecord(value) || value.success !== true || !isRecord(value.stats)) throw new Error('Invalid intelligence stats response')
    const stats = value.stats
    if (![stats.totalQueries, stats.resolvedQueries, stats.autonomyRate, stats.trainingCount, stats.learningCount].every(item => typeof item === 'number')) throw new Error('Invalid intelligence stats response')
    return stats as { totalQueries: number; resolvedQueries: number; autonomyRate: number; trainingCount: number; learningCount: number }
  }
  const listIntelligenceLogs = async (limit = 20): Promise<BrowserIntelligenceLog[]> => {
    const value = await request<unknown>(`/api/v1/intelligence/logs?limit=${encodeURIComponent(String(limit))}`)
    if (!isRecord(value) || !Array.isArray(value.logs)) throw new Error('Invalid intelligence logs response')
    return value.logs.filter((item): item is BrowserIntelligenceLog => isRecord(item) && Number.isSafeInteger(item.id) && typeof item.type === 'string' && typeof item.event === 'string' && typeof item.timestamp === 'string')
  }
  const logAccuracy = async (entry: { event: string; details?: string }): Promise<void> => {
    await request('/api/v1/intelligence/accuracy', { method: 'POST', body: JSON.stringify(entry) }, true)
  }
  const getMemoryStats = async (): Promise<BrowserMemoryStats> => {
    const value = await request<unknown>('/api/v1/memory/stats')
    if (!isRecord(value) || value.success !== true || !isRecord(value.stats)
      || typeof value.stats.entityCount !== 'number' || typeof value.stats.relationCount !== 'number'
      || typeof value.stats.storageSize !== 'number' || typeof value.stats.avgSearchLatency !== 'number' || typeof value.stats.backend !== 'string') throw new Error('Invalid memory stats response')
    return value.stats as unknown as BrowserMemoryStats
  }
  const exportMemory = async (): Promise<BrowserMemoryExport> => {
    const value = await request<unknown>('/api/v1/memory/export')
    if (!isRecord(value) || value.success !== true || !isRecord(value.data) || !Array.isArray(value.data.entities) || !Array.isArray(value.data.relations) || !isRecord(value.data.metadata)) throw new Error('Invalid memory export response')
    return value.data as unknown as BrowserMemoryExport
  }
  const callMemoryTool = async (name: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: unknown; error?: string }> => {
    if (!/^memory_[a-z_]+$/.test(name)) throw new Error('Invalid memory tool name')
    const value = await request<unknown>('/api/v1/memory/tools', { method: 'POST', body: JSON.stringify({ name, args }) }, true)
    if (!isRecord(value) || typeof value.success !== 'boolean') throw new Error('Invalid memory tool response')
    return { success: value.success, ...(Object.prototype.hasOwnProperty.call(value, 'result') ? { result: value.result } : {}), ...(typeof value.error === 'string' ? { error: value.error } : {}) }
  }
  const setCredential = async (key: CredentialKey, value: string) => readResult(await request(`/api/v1/credentials/${encodeURIComponent(key)}`, { method: 'POST', body: JSON.stringify({ value }) }, true))
  const hasCredential = async (key: CredentialKey) => readCredentialPresence(await request(`/api/v1/credentials/${encodeURIComponent(key)}`))
  const deleteCredential = async (key: CredentialKey) => readResult(await request(`/api/v1/credentials/${encodeURIComponent(key)}`, { method: 'DELETE' }, true))
  const testProvider = async (provider: 'openai' | 'openrouter' | 'gemini') => {
    const value = await request<unknown>(`/api/v1/providers/${provider}/test`, { method: 'POST', body: '{}' }, true)
    if (!isRecord(value) || typeof value.success !== 'boolean') throw new Error('Invalid provider test response')
    if (!value.success) return { success: false, error: errorText(value.error, 'Provider test failed') }
    if (value.modelCount !== undefined && (!Number.isSafeInteger(value.modelCount) || (value.modelCount as number) < 0)) throw new Error('Invalid provider test response')
    if (value.models !== undefined && (!Array.isArray(value.models) || value.models.some(model => typeof model !== 'string'))) throw new Error('Invalid provider test response')
    return {
      success: true,
      ...(Number.isSafeInteger(value.modelCount) ? { modelCount: value.modelCount as number } : {}),
      ...(Array.isArray(value.models) ? { models: value.models as string[] } : {}),
    }
  }

  return {
    pair,
    readiness,
    status,
    getContinuityStatus,
    getSystemInfo,
    health,
    loadSessions,
    createSession,
    updateSessionWorkspace,
    deleteSession,
    appendMessage,
    cancelGeneration,
    generate,
    getLlmSettings,
    saveLlmSettings,
    getWhatsAppSettings,
    saveWhatsAppSettings,
    getWhatsAppConnectionState,
    getWhatsAppUiSettings,
    saveWhatsAppUiSettings,
    connectWhatsApp,
    disconnectWhatsApp,
    setWhatsAppTarget,
    sendWhatsAppText,
    sendWhatsAppMedia,
    createWhatsAppDraft,
    getOllamaSettings,
    saveOllamaSettings,
    testOllama,
    getEmailSettings,
    saveEmailSettings,
    testEmail,
    listEmailAttachments,
    listEmailDeliveryHistory,
    retrieveGmailAttachment,
    getEmailInboundAttachment,
    getGmailOAuthStatus,
    startGmailOAuth,
    signOutGmailOAuth,
    ingestEmailInbound,
    claimEmailInbound,
    listEmailInbound,
    acknowledgeEmailInbound,
    listEmailDrafts,
    saveEmailDraft,
    updateEmailDraft,
    sendEmailDraft,
    deleteEmailDraft,
    listWhatsAppInbound,
    getWhatsAppInboundMedia,
    getPersonaSettings,
    savePersonaSettings,
    getProductPreferences,
    saveProductPreferences,
    appendAuditLog,
    listAuditLogs,
    pauseAll,
    resumeAll,
    enterRecoveryMode,
    clearRecoveryMode,
    listDrafts,
    updateDraftStatus,
    sendWhatsAppDraft,
    retryWhatsAppDraft,
    quarantineWhatsAppDraft,
    cancelWhatsAppDraft,
    getAutonomyMetrics,
    getAutonomyUsageHistory,
    getAutonomyChannelUsage,
    listDecisionEvidence,
    reviewDecision,
    listAutonomyNotifications,
    ackAutonomyNotification,
    listKnowledge,
    ingestKnowledge,
    convertKnowledge,
    deleteKnowledge,
    searchKnowledge,
    getIntelligenceStats,
    listIntelligenceLogs,
    logAccuracy,
    getMemoryStats,
    exportMemory,
    callMemoryTool,
    setCredential,
    hasCredential,
    deleteCredential,
    testProvider,
    getMcpLifecycle,
    getMcpServers,
    saveMcpServers,
    connectMcpServer,
    disconnectMcpServer,
    listMcpTools,
    callMcpTool,
    cancelMcpTool,
  }
}

let browserAgentdClient: BrowserAgentdClient | null = null

export const getBrowserAgentdClient = (): BrowserAgentdClient => {
  browserAgentdClient ??= createBrowserAgentdClient()
  return browserAgentdClient
}
