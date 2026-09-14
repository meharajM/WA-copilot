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
