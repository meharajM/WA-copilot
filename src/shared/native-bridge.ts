export type NativeRuntime = 'electron' | 'tauri' | 'browser'

export const credentialKeys = [
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
] as const

export type CredentialKey = (typeof credentialKeys)[number]

export interface NativeResult {
  success: boolean
  error?: string
}

export interface NativeHealth {
  status: 'ready' | 'unavailable'
  version?: string
  error?: string
  paused?: boolean
  recoveryMode?: boolean
  recoveryReason?: string | null
  queueDepth?: number
  events?: number
}

export type LlmProvider = 'auto' | 'openai' | 'openrouter' | 'ollama' | 'gemini' | 'browser'
export type SupportedLlmProvider = Exclude<LlmProvider, 'auto'>

export interface LlmSettings {
  preferredProvider: LlmProvider
  openaiModel: string
  geminiModel: string
  openrouterModel: string
}

export interface ProductPreferences {
  theme: 'dark' | 'light' | 'system'
  playwrightBrowser: 'auto' | 'chrome' | 'msedge' | 'firefox' | 'webkit' | 'chromium'
  playwrightHeadless: boolean
  fileSystemSafeMode: boolean
  memoryBackend: 'sqlite' | 'server-memory'
  ttsEnabled: boolean
  ttsRate: number
  ttsPitch: number
  ttsVoice: string | null
  speechLang: string
  offlineSpeech: boolean
  voskModel: string
  browserModel: string
}

export interface PersonaSettings {
  name: string
  industry: string
  tone: 'professional' | 'casual' | 'enthusiastic' | 'concise'
  coreKnowledge: string[]
  customRules?: string
}

export type WhatsAppTransport = 'baileys' | 'cloud' | 'web'

export interface WhatsAppSettings {
  whatsapp_transport: WhatsAppTransport
  whatsapp_cloud_phone_number_id: string
  whatsapp_cloud_api_version: string
}

export type EmailProvider = 'imap-smtp' | 'gmail-api' | 'outlook-api' | 'custom-mcp'
export type GmailAuthMode = 'app-password' | 'google-oauth'

/** Non-secret email channel configuration owned by agentd. Passwords/tokens stay in credentials. */
export interface EmailSettings {
  accountName: string
  provider: EmailProvider
  gmailAuthMode: GmailAuthMode
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  emailAddress: string
  userName: string
  imapTls: boolean
  smtpTls: boolean
  pollingIntervalSeconds: number
  enabled: boolean
  autoReplyMode: boolean
  draftMode: boolean
}

export interface ProviderTestResult extends NativeResult {
  modelCount?: number
  models?: string[]
}

export interface FileSelectionOptions {
  title?: string
  buttonLabel?: string
  filters?: Array<{ name: string; extensions: string[] }>
}

export interface NativeBridge {
  runtime: NativeRuntime
  health(): Promise<NativeHealth>
  selectFile(options?: FileSelectionOptions): Promise<string | null>
  selectFolder(): Promise<string | null>
  setCredential(key: CredentialKey, value: string): Promise<NativeResult>
  hasCredential(key: CredentialKey): Promise<NativeResult & { exists: boolean }>
  deleteCredential(key: CredentialKey): Promise<NativeResult>
}
