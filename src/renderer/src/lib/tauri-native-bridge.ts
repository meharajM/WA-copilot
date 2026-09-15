import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen as tauriListen, type Event, type UnlistenFn } from '@tauri-apps/api/event'
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
  selectFile: 'select_file',
  selectFolder: 'select_folder',
  credentialSet: 'credential_set',
  credentialExists: 'credential_exists',
  credentialDelete: 'credential_delete',
} as const

export const TAURI_EVENTS = {
  agentdHealth: 'agentd-health',
} as const

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>
type Listen = <T>(event: string, handler: (event: Event<T>) => void) => Promise<UnlistenFn>

export interface TauriBridgeDependencies {
  invoke: Invoke
  listen: Listen
}

export type HealthListener = (health: NativeHealth) => void
export type Unsubscribe = () => void

const defaultDependencies: TauriBridgeDependencies = {
  invoke: tauriInvoke,
  listen: tauriListen,
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
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
  (credentialKeys as readonly string[]).includes(key)
)

const readHealth = (value: unknown): NativeHealth => {
  if (!isRecord(value) || (value.status !== 'ready' && value.status !== 'unavailable')) {
    return { status: 'unavailable', error: 'Invalid agentd health response' }
  }

  return {
    status: value.status,
    ...(typeof value.version === 'string' ? { version: value.version } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
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
  const result = readResult(value)
  return {
    ...result,
    exists: value.exists,
  }
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
  onAgentdHealth: (listener: HealthListener, onError?: (error: string) => void) => Unsubscribe
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
      return { status: 'unavailable', error: errorText(error instanceof Error ? error.message : error, 'Agentd health unavailable') }
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

  const onAgentdHealth = (listener: HealthListener, onError?: (error: string) => void): Unsubscribe => {
    let active = true
    let unlisten: UnlistenFn | undefined

    void dependencies.listen<unknown>(TAURI_EVENTS.agentdHealth, (event) => {
      if (active) listener(readHealth(event.payload))
    }).then((cleanup) => {
      if (active) unlisten = cleanup
      else cleanup()
    }).catch(() => {
      if (active) onError?.('Agentd health event subscription unavailable')
    })

    return () => {
      active = false
      unlisten?.()
      unlisten = undefined
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
    onAgentdHealth,
  }
}

export const tauriNativeBridge = createTauriNativeBridge()
