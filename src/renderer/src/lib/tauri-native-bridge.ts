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
  openBrowserWorkspace: 'open_browser_workspace',
  credentialSet: 'credential_set',
  credentialExists: 'credential_exists',
  credentialDelete: 'credential_delete',
  selectFile: 'select_file',
  selectFolder: 'select_folder',
} as const

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

export const createTauriNativeBridge = (
  dependencies: TauriBridgeDependencies = defaultDependencies,
): NativeBridge & {
  appVersion: () => Promise<string>
  agentdOrigin: () => Promise<string>
  openBrowserWorkspace: () => Promise<NativeResult>
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

  const openBrowserWorkspace = async (): Promise<NativeResult> => {
    try {
      await invoke<unknown>(TAURI_COMMANDS.openBrowserWorkspace)
      return { success: true }
    } catch (error) {
      return failed(error instanceof Error ? error.message : error, 'Could not open the browser workspace')
    }
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
    openBrowserWorkspace,
  }
}

export const tauriNativeBridge = createTauriNativeBridge()

export const isTauriRuntime = hasTauriRuntime
