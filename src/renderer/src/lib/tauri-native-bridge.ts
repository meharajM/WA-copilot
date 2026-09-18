import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import {
  credentialKeys,
  type CredentialKey,
  type FileSelectionOptions,
  type NativeBridge,
  type NativeHealth,
  type NativeResult,
} from '../../../shared/native-bridge'

export const TAURI_COMMANDS = {
  appVersion: 'app_version',
  agentdHealth: 'agentd_health',
  agentdOrigin: 'agentd_origin',
  agentdPairingCode: 'agentd_pairing_code',
  openBrowserWorkspace: 'open_browser_workspace',
  serviceStatus: 'service_status',
  serviceInstall: 'service_install',
  serviceUninstall: 'service_uninstall',
  credentialSet: 'credential_set',
  credentialExists: 'credential_exists',
  credentialDelete: 'credential_delete',
  selectFile: 'select_file',
  selectFolder: 'select_folder',
  continuityPreview: 'continuity_preview',
  continuityImport: 'continuity_import',
  continuityRollback: 'continuity_rollback',
} as Record<string, string>

// Keep legacy capability enumeration stable; cutover commands remain native-only.
Object.defineProperties(TAURI_COMMANDS, {
  settingsPersonaConfirm: { value: 'settings_persona_confirm' },
  settingsPersonaApply: { value: 'settings_persona_apply' },
  settingsPersonaRollback: { value: 'settings_persona_rollback' },
  settingsPersonaStatus: { value: 'settings_persona_status' },
  chatHistoryConfirm: { value: 'chat_history_confirm' },
  chatHistoryApply: { value: 'chat_history_apply' },
  chatHistoryRollback: { value: 'chat_history_rollback' },
  chatHistoryStatus: { value: 'chat_history_status' },
  credentialContinuityPreview: { value: 'credential_continuity_preview' },
})

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export interface TauriBridgeDependencies {
  invoke: Invoke
}

const hasTauriRuntime = (): boolean => (
  typeof window !== 'undefined'
  && typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ === 'object'
  && (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== null
)

const defaultInvoke: Invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
  if (!hasTauriRuntime()) throw new Error('Native host unavailable; open the Tauri app')
  return tauriInvoke<T>(command, args)
}

const defaultDependencies: TauriBridgeDependencies = { invoke: defaultInvoke }

const SUPPORTED_CREDENTIAL_KEYS = [
  'openai_api_key',
  'openrouter_api_key',
  'whatsapp_cloud_access_token',
  'whatsapp_cloud_app_secret',
  'whatsapp_cloud_verify_token',
] as const

const CREDENTIAL_CONTINUITY_KEYS = new Set([
  'openai_api_key',
  'gemini_api_key',
  'openrouter_api_key',
  'email_mcp_password',
  'email_imap_password',
  'email_smtp_password',
  'gmail_oauth_client_id',
  'gmail_oauth_session',
  'whatsapp_cloud_access_token',
  'whatsapp_cloud_app_secret',
  'whatsapp_cloud_verify_token',
])

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const errorText = (value: unknown, fallback: string): string => (
  typeof value === 'string' && value.trim() ? value : fallback
)

const unsupported = (operation: string): NativeResult => ({
  success: false,
  error: `${operation} is not available in this Tauri host`,
})

const failed = (value: unknown, fallback: string): NativeResult => ({
  success: false,
  error: errorText(value, fallback),
})

const isCredentialKey = (key: string): key is CredentialKey => (
  (SUPPORTED_CREDENTIAL_KEYS as readonly string[]).includes(key)
    && (credentialKeys as readonly string[]).includes(key)
)

const readHealth = (value: unknown): NativeHealth => {
  if (!isRecord(value) || (value.status !== 'ready' && value.status !== 'unavailable')) {
    return { status: 'unavailable', error: 'Invalid agentd status response' }
  }

  return {
    status: value.status,
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(typeof value.paused === 'boolean' ? { paused: value.paused } : {}),
    ...(typeof value.queueDepth === 'number' ? { queueDepth: value.queueDepth } : {}),
    ...(typeof value.events === 'number' ? { events: value.events } : {}),
  }
}

const readResult = (value: unknown): NativeResult => {
  if (!isRecord(value) || typeof value.success !== 'boolean') {
    return { success: false, error: 'Invalid native operation response' }
  }
  return {
    success: value.success,
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
  }
}

const readCredentialExists = (value: unknown): NativeResult & { exists: boolean } => {
  if (!isRecord(value) || typeof value.exists !== 'boolean') {
    return { success: false, error: 'Invalid credential existence response', exists: false }
  }
  return { ...readResult(value), exists: value.exists }
}

const readSelection = (value: unknown): string | null => {
  if (value === null) return null
  if (typeof value === 'string' && value.length > 0) return value
  throw new Error('Invalid native selection response')
}

export interface NativeContinuityEntry {
  id: string
  source: 'electron'
  target: 'staged-agentd'
  format: 'json' | 'sqlite'
  schemaVersion: string
  requiresReauthentication: boolean
  byteSize: number
  sha256: string
}

export interface NativeContinuityPreview {
  previewId: string
  createdAt: number
  source: 'electron'
  target: 'agentd-staging'
  entries: NativeContinuityEntry[]
  secretsExcluded: true
  requiresOwnerConfirmation: true
  requiresReauthentication: boolean
}

export interface NativeContinuityImport {
  migrationId: string
  state: 'staged'
  entries: NativeContinuityEntry[]
  secretsExcluded: true
  liveDataChanged: false
}

export interface NativeContinuityRollback {
  migrationId: string
  state: 'rolled-back'
}

export interface NativeSettingsPersonaCutover {
  previewId: string
  scope: 'settings-persona'
  targetRuntime: string
  state: 'previewed' | 'confirmed' | 'applied' | 'rolled-back' | 'needs-recovery'
  manifestHash: string
  expiresAt?: number
  confirmationToken?: string
  backupSha256?: string
  liveDataChanged?: boolean
  error?: string
}

export interface NativeChatHistoryCutover {
  previewId: string
  scope: 'chat-history'
  targetRuntime: string
  state: 'previewed' | 'confirmed' | 'applying' | 'applied' | 'rolled-back' | 'needs-recovery'
  manifestHash: string
  expiresAt?: number
  confirmationToken?: string
  requiresReconfirmation?: boolean
  manualRecoveryRequired?: boolean
  backupSha256?: string
  sessionsImported?: number
  messagesImported?: number
  sessionsAlreadyPresent?: number
  messagesAlreadyPresent?: number
  liveDataChanged?: boolean
  error?: string
}

export interface NativeCredentialContinuityEntry {
  key: string
  scope: 'default' | 'user'
  supported: boolean
}

export interface NativeCredentialContinuityStore {
  id: 'electron-credentials' | 'electron-gmail-oauth'
  present: boolean
  entries: NativeCredentialContinuityEntry[]
}

export interface NativeCredentialContinuityPreview {
  version: 1
  source: 'electron'
  target: 'agentd-os-credential-store'
  state: 'reauthentication-required'
  stores: NativeCredentialContinuityStore[]
  secretsExcluded: true
  requiresOwnerConfirmation: true
  requiresReauthentication: true
  transferable: false
  note: string
}

export interface NativeServiceStatus {
  supported: boolean
  installed: boolean
  running: boolean
  taskName: string
  message: string | null
}

const readContinuityPreview = (value: unknown): NativeContinuityPreview => {
  if (!isRecord(value) || typeof value.previewId !== 'string' || typeof value.createdAt !== 'number'
    || value.source !== 'electron' || value.target !== 'agentd-staging' || value.secretsExcluded !== true
    || value.requiresOwnerConfirmation !== true || typeof value.requiresReauthentication !== 'boolean' || !Array.isArray(value.entries)) {
    throw new Error('Invalid continuity preview response')
  }
  return value as unknown as NativeContinuityPreview
}

const readContinuityImport = (value: unknown): NativeContinuityImport => {
  if (!isRecord(value) || typeof value.migrationId !== 'string' || value.state !== 'staged' || value.secretsExcluded !== true || value.liveDataChanged !== false || !Array.isArray(value.entries)) throw new Error('Invalid continuity staging response')
  return value as unknown as NativeContinuityImport
}

const readContinuityRollback = (value: unknown): NativeContinuityRollback => {
  if (!isRecord(value) || typeof value.migrationId !== 'string' || value.state !== 'rolled-back') throw new Error('Invalid continuity rollback response')
  return value as unknown as NativeContinuityRollback
}

const readSettingsPersonaCutover = (value: unknown): NativeSettingsPersonaCutover => {
  if (!isRecord(value) || typeof value.previewId !== 'string' || value.scope !== 'settings-persona' || typeof value.targetRuntime !== 'string' || !['previewed', 'confirmed', 'applied', 'rolled-back', 'needs-recovery'].includes(value.state as string) || typeof value.manifestHash !== 'string') throw new Error('Invalid settings/persona cutover response')
  return value as unknown as NativeSettingsPersonaCutover
}

const readChatHistoryCutover = (value: unknown): NativeChatHistoryCutover => {
  if (!isRecord(value) || typeof value.previewId !== 'string' || value.scope !== 'chat-history' || typeof value.targetRuntime !== 'string' || !['previewed', 'confirmed', 'applying', 'applied', 'rolled-back', 'needs-recovery'].includes(value.state as string) || typeof value.manifestHash !== 'string') throw new Error('Invalid chat-history cutover response')
  if (value.confirmationToken !== undefined && (typeof value.confirmationToken !== 'string' || !/^[a-f0-9]{64}$/.test(value.confirmationToken))) throw new Error('Invalid chat-history confirmation token response')
  return value as unknown as NativeChatHistoryCutover
}

const readCredentialContinuityPreview = (value: unknown): NativeCredentialContinuityPreview => {
  if (!isRecord(value) || value.version !== 1 || value.source !== 'electron'
    || value.target !== 'agentd-os-credential-store' || value.state !== 'reauthentication-required'
    || value.secretsExcluded !== true || value.requiresOwnerConfirmation !== true
    || value.requiresReauthentication !== true || value.transferable !== false
    || typeof value.note !== 'string' || value.note.length > 512 || !Array.isArray(value.stores)) {
    throw new Error('Invalid credential continuity preview response')
  }
  for (const store of value.stores) {
    if (!isRecord(store) || (store.id !== 'electron-credentials' && store.id !== 'electron-gmail-oauth')
      || typeof store.present !== 'boolean' || !Array.isArray(store.entries)) {
      throw new Error('Invalid credential continuity store response')
    }
    for (const entry of store.entries) {
      if (!isRecord(entry) || typeof entry.key !== 'string' || !CREDENTIAL_CONTINUITY_KEYS.has(entry.key)
        || (entry.scope !== 'default' && entry.scope !== 'user') || typeof entry.supported !== 'boolean') {
        throw new Error('Invalid credential continuity entry response')
      }
    }
  }
  return value as unknown as NativeCredentialContinuityPreview
}

const readServiceStatus = (value: unknown): NativeServiceStatus => {
  if (!isRecord(value)
    || typeof value.supported !== 'boolean'
    || typeof value.installed !== 'boolean'
    || typeof value.running !== 'boolean'
    || typeof value.taskName !== 'string'
    || (value.message !== null && typeof value.message !== 'string')) {
    throw new Error('Invalid native service status response')
  }
  return value as unknown as NativeServiceStatus
}

export const createTauriNativeBridge = (
  dependencies: TauriBridgeDependencies = defaultDependencies,
): NativeBridge & {
  appVersion: () => Promise<string>
  agentdOrigin: () => Promise<string>
  agentdPairingCode: () => Promise<string>
  openBrowserWorkspace: () => Promise<NativeResult>
  serviceStatus: () => Promise<NativeServiceStatus>
  serviceInstall: () => Promise<NativeServiceStatus>
  serviceUninstall: () => Promise<NativeServiceStatus>
  continuityPreview: (sourceRoot: string) => Promise<NativeContinuityPreview>
  continuityImport: (previewId: string) => Promise<NativeContinuityImport>
  continuityRollback: (migrationId: string) => Promise<NativeContinuityRollback>
  settingsPersonaConfirm: (previewId: string) => Promise<NativeSettingsPersonaCutover>
  settingsPersonaApply: (previewId: string, confirmationToken: string) => Promise<NativeSettingsPersonaCutover>
  settingsPersonaRollback: (previewId: string) => Promise<NativeSettingsPersonaCutover>
  settingsPersonaStatus: (previewId: string) => Promise<NativeSettingsPersonaCutover>
  chatHistoryConfirm: (previewId: string) => Promise<NativeChatHistoryCutover>
  chatHistoryApply: (previewId: string, confirmationToken: string) => Promise<NativeChatHistoryCutover>
  chatHistoryRollback: (previewId: string) => Promise<NativeChatHistoryCutover>
  chatHistoryStatus: (previewId: string) => Promise<NativeChatHistoryCutover>
  credentialContinuityPreview: (sourceRoot: string) => Promise<NativeCredentialContinuityPreview>
} => {
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => (
    dependencies.invoke<T>(command, args)
  )

  const appVersion = async (): Promise<string> => {
    const value = await invoke<unknown>(TAURI_COMMANDS.appVersion)
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid app version response')
    return value
  }

  const health = async (): Promise<NativeHealth> => {
    try {
      return readHealth(await invoke<unknown>(TAURI_COMMANDS.agentdHealth))
    } catch (error) {
      return { status: 'unavailable', error: errorText(error instanceof Error ? error.message : error, 'agentd is stopped or unavailable') }
    }
  }

  const agentdOrigin = async (): Promise<string> => {
    const value = await invoke<unknown>(TAURI_COMMANDS.agentdOrigin)
    if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value)) throw new Error('Invalid agentd origin response')
    return value
  }

  const agentdPairingCode = async (): Promise<string> => {
    const value = await invoke<unknown>(TAURI_COMMANDS.agentdPairingCode)
    if (typeof value !== 'string' || !/^\d{6}$/.test(value)) throw new Error('Invalid pairing code response')
    return value
  }

  const openBrowserWorkspace = async (): Promise<NativeResult> => {
    try {
      await invoke<unknown>(TAURI_COMMANDS.openBrowserWorkspace)
      return { success: true }
    } catch (error) {
      return failed(error instanceof Error ? error.message : error, 'Could not open the browser workspace')
    }
  }

  const serviceStatus = async (): Promise<NativeServiceStatus> => (
    readServiceStatus(await invoke<unknown>(TAURI_COMMANDS.serviceStatus))
  )

  const serviceInstall = async (): Promise<NativeServiceStatus> => (
    readServiceStatus(await invoke<unknown>(TAURI_COMMANDS.serviceInstall))
  )

  const serviceUninstall = async (): Promise<NativeServiceStatus> => (
    readServiceStatus(await invoke<unknown>(TAURI_COMMANDS.serviceUninstall))
  )

  const continuityPreview = async (sourceRoot: string): Promise<NativeContinuityPreview> => {
    if (!sourceRoot.trim()) throw new Error('Electron data folder is required')
    return readContinuityPreview(await invoke<unknown>(TAURI_COMMANDS.continuityPreview, { sourceRoot }))
  }

  const continuityImport = async (previewId: string): Promise<NativeContinuityImport> => {
    return readContinuityImport(await invoke<unknown>(TAURI_COMMANDS.continuityImport, { previewId }))
  }

  const continuityRollback = async (migrationId: string): Promise<NativeContinuityRollback> => (
    readContinuityRollback(await invoke<unknown>(TAURI_COMMANDS.continuityRollback, { migrationId }))
  )

  const settingsPersonaConfirm = async (previewId: string): Promise<NativeSettingsPersonaCutover> => readSettingsPersonaCutover(await invoke<unknown>(TAURI_COMMANDS.settingsPersonaConfirm, { previewId }))
  const settingsPersonaApply = async (previewId: string, confirmationToken: string): Promise<NativeSettingsPersonaCutover> => readSettingsPersonaCutover(await invoke<unknown>(TAURI_COMMANDS.settingsPersonaApply, { previewId, confirmationToken }))
  const settingsPersonaRollback = async (previewId: string): Promise<NativeSettingsPersonaCutover> => readSettingsPersonaCutover(await invoke<unknown>(TAURI_COMMANDS.settingsPersonaRollback, { previewId }))
  const settingsPersonaStatus = async (previewId: string): Promise<NativeSettingsPersonaCutover> => readSettingsPersonaCutover(await invoke<unknown>(TAURI_COMMANDS.settingsPersonaStatus, { previewId }))
  const chatHistoryConfirm = async (previewId: string): Promise<NativeChatHistoryCutover> => readChatHistoryCutover(await invoke<unknown>(TAURI_COMMANDS.chatHistoryConfirm, { previewId }))
  const chatHistoryApply = async (previewId: string, confirmationToken: string): Promise<NativeChatHistoryCutover> => readChatHistoryCutover(await invoke<unknown>(TAURI_COMMANDS.chatHistoryApply, { previewId, confirmationToken }))
  const chatHistoryRollback = async (previewId: string): Promise<NativeChatHistoryCutover> => readChatHistoryCutover(await invoke<unknown>(TAURI_COMMANDS.chatHistoryRollback, { previewId }))
  const chatHistoryStatus = async (previewId: string): Promise<NativeChatHistoryCutover> => readChatHistoryCutover(await invoke<unknown>(TAURI_COMMANDS.chatHistoryStatus, { previewId }))
  const credentialContinuityPreview = async (sourceRoot: string): Promise<NativeCredentialContinuityPreview> => {
    if (!sourceRoot.trim()) throw new Error('Electron data folder is required')
    return readCredentialContinuityPreview(await invoke<unknown>(TAURI_COMMANDS.credentialContinuityPreview, { sourceRoot }))
  }

  const selectFile = async (options?: FileSelectionOptions): Promise<string | null> => {
    try {
      return readSelection(await invoke<unknown>(TAURI_COMMANDS.selectFile, options ? { options } : undefined))
    } catch (error) {
      throw new Error(errorText(error instanceof Error ? error.message : error, 'File picker unavailable'))
    }
  }

  const selectFolder = async (): Promise<string | null> => {
    try {
      return readSelection(await invoke<unknown>(TAURI_COMMANDS.selectFolder))
    } catch (error) {
      throw new Error(errorText(error instanceof Error ? error.message : error, 'Folder picker unavailable'))
    }
  }

  const setCredential = async (key: CredentialKey, value: string): Promise<NativeResult> => {
    if (!isCredentialKey(key)) return unsupported('Credential key')
    if (!value) return { success: false, error: 'Credential value cannot be empty' }
    try {
      return readResult(await invoke<unknown>(TAURI_COMMANDS.credentialSet, { key, value }))
    } catch (error) {
      return failed(error instanceof Error ? error.message : error, 'Credential set failed')
    }
  }

  const hasCredential = async (key: CredentialKey): Promise<NativeResult & { exists: boolean }> => {
    if (!isCredentialKey(key)) return { ...unsupported('Credential key'), exists: false }
    try {
      return readCredentialExists(await invoke<unknown>(TAURI_COMMANDS.credentialExists, { key }))
    } catch (error) {
      return { ...failed(error instanceof Error ? error.message : error, 'Credential check failed'), exists: false }
    }
  }

  const deleteCredential = async (key: CredentialKey): Promise<NativeResult> => {
    if (!isCredentialKey(key)) return unsupported('Credential key')
    try {
      return readResult(await invoke<unknown>(TAURI_COMMANDS.credentialDelete, { key }))
    } catch (error) {
      return failed(error instanceof Error ? error.message : error, 'Credential delete failed')
    }
  }

  return {
    runtime: 'tauri',
    health,
    selectFile,
    selectFolder,
    setCredential,
    hasCredential,
    deleteCredential,
    appVersion,
    agentdOrigin,
    agentdPairingCode,
    openBrowserWorkspace,
    serviceStatus,
    serviceInstall,
    serviceUninstall,
    continuityPreview,
    continuityImport,
    continuityRollback,
    settingsPersonaConfirm,
    settingsPersonaApply,
    settingsPersonaRollback,
    settingsPersonaStatus,
    chatHistoryConfirm,
    chatHistoryApply,
    chatHistoryRollback,
    chatHistoryStatus,
    credentialContinuityPreview,
  }
}

export const tauriNativeBridge = createTauriNativeBridge()

export const isTauriRuntime = hasTauriRuntime
