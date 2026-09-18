import { describe, expect, it, vi } from 'vitest'
import {
  createTauriNativeBridge,
  TAURI_COMMANDS,
  tauriNativeBridge,
} from '../../src/renderer/src/lib/tauri-native-bridge'

const defaultSettings = {
  preferredProvider: 'auto',
  openaiModel: 'gpt-4o-mini',
  openrouterModel: 'anthropic/claude-3-haiku',
} as const

const defaultWhatsAppSettings = {
  whatsapp_transport: 'baileys',
  whatsapp_cloud_phone_number_id: '',
  whatsapp_cloud_api_version: 'v23.0',
} as const

describe('tauri native bridge', () => {
  it('reports a safe host-unavailable state when opened as plain web UI', async () => {
    await expect(tauriNativeBridge.health()).resolves.toMatchObject({
      status: 'unavailable',
      error: 'Native host unavailable; open the Tauri app',
    })
  })

  it('uses fixed typed commands and never exposes credential reads', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === TAURI_COMMANDS.appVersion) return '1.2.3'
      if (command === TAURI_COMMANDS.agentdOrigin) return 'http://127.0.0.1:4141'
      if (command === TAURI_COMMANDS.openBrowserWorkspace) return null
      if (command === TAURI_COMMANDS.agentdHealth) return { status: 'ready', version: 'agentd protocol v1', paused: false, queueDepth: 2, events: 4 }
      if (command === TAURI_COMMANDS.getLlmSettings) return defaultSettings
      if (command === TAURI_COMMANDS.saveLlmSettings) return defaultSettings
      if (command === TAURI_COMMANDS.getWhatsAppSettings) return defaultWhatsAppSettings
      if (command === TAURI_COMMANDS.saveWhatsAppSettings) return defaultWhatsAppSettings
      if (command === TAURI_COMMANDS.credentialSet) return { success: true }
      if (command === TAURI_COMMANDS.credentialExists) return { success: true, exists: true }
      if (command === TAURI_COMMANDS.credentialDelete) return { success: true }
      if (command === TAURI_COMMANDS.providerTest) return { success: true, modelCount: 7 }
      return null
    })
    const bridge = createTauriNativeBridge({ invoke })

    await expect(bridge.appVersion()).resolves.toBe('1.2.3')
    await expect(bridge.agentdOrigin()).resolves.toBe('http://127.0.0.1:4141')
    await expect(bridge.openBrowserWorkspace()).resolves.toEqual({ success: true })
    await expect(bridge.health()).resolves.toMatchObject({ status: 'ready', paused: false, queueDepth: 2, events: 4 })
    await expect(bridge.getLlmSettings()).resolves.toEqual(defaultSettings)
    await expect(bridge.saveLlmSettings(defaultSettings)).resolves.toEqual(defaultSettings)
    await expect(bridge.getWhatsAppSettings()).resolves.toEqual(defaultWhatsAppSettings)
    await expect(bridge.saveWhatsAppSettings(defaultWhatsAppSettings)).resolves.toEqual(defaultWhatsAppSettings)
    await expect(bridge.setCredential('openai_api_key', 'secret')).resolves.toEqual({ success: true })
    await expect(bridge.setCredential('whatsapp_cloud_access_token', 'cloud-secret')).resolves.toEqual({ success: true })
    await expect(bridge.hasCredential('whatsapp_cloud_access_token')).resolves.toEqual({ success: true, exists: true })
    await expect(bridge.hasCredential('openai_api_key')).resolves.toEqual({ success: true, exists: true })
    await expect(bridge.deleteCredential('openai_api_key')).resolves.toEqual({ success: true })
    await expect(bridge.testProvider('openrouter')).resolves.toEqual({ success: true, modelCount: 7 })

    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.credentialSet, { key: 'openai_api_key', value: 'secret' })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.providerTest, { provider: 'openrouter' })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.openBrowserWorkspace, undefined)
    expect(invoke).not.toHaveBeenCalledWith(expect.stringMatching(/get.*credential|credential.*read/i), expect.anything())
  })

  it('fails closed on malformed host responses and unavailable agentd', async () => {
    const bridge = createTauriNativeBridge({
      invoke: vi.fn(async (command: string) => {
        if (command === TAURI_COMMANDS.agentdHealth) throw new Error('agentd is stopped or unavailable')
        if (command === TAURI_COMMANDS.getLlmSettings) return { ...defaultSettings, customBaseUrl: 'https://example.test' }
        if (command === TAURI_COMMANDS.providerTest) return { success: true, modelCount: 'many' }
        return { unexpected: true }
      }),
    })

    await expect(bridge.health()).resolves.toMatchObject({ status: 'unavailable', error: 'agentd is stopped or unavailable' })
    await expect(bridge.getLlmSettings()).rejects.toThrow('Invalid LLM settings response')
    await expect(bridge.testProvider('openai')).resolves.toEqual({ success: false, error: 'Invalid provider test response' })
    await expect(bridge.setCredential('openai_api_key', '')).resolves.toMatchObject({ success: false })
    await expect(bridge.hasCredential('openai_api_key')).resolves.toMatchObject({ success: false, exists: false })
  })

  it('rejects non-loopback browser workspace origins', async () => {
    const bridge = createTauriNativeBridge({ invoke: vi.fn(async () => 'https://example.test') })
    await expect(bridge.agentdOrigin()).rejects.toThrow('Invalid agentd origin response')
  })

  it('allows only supported credentials and providers', async () => {
    const invoke = vi.fn()
    const bridge = createTauriNativeBridge({ invoke })

    await expect(bridge.setCredential('gemini_api_key', 'secret')).resolves.toMatchObject({
      success: false,
      error: 'Credential key is not available in this Tauri host',
    })
    await expect(bridge.hasCredential('whatsapp_cloud_access_token')).resolves.toMatchObject({ success: false, exists: false })
    await expect(bridge.deleteCredential('email_imap_password')).resolves.toMatchObject({ success: false })
    await expect(bridge.setCredential('gmail_oauth_client_id', 'secret')).resolves.toMatchObject({ success: false })
    await expect(bridge.hasCredential('email_smtp_password')).resolves.toMatchObject({ success: false, exists: false })
    await expect(bridge.testProvider('gemini' as never)).resolves.toMatchObject({ success: false })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.credentialExists, { key: 'whatsapp_cloud_access_token' })
  })

  it('rejects settings that do not match the exact schema', async () => {
    const bridge = createTauriNativeBridge({
      invoke: vi.fn(async () => ({ ...defaultSettings, surprise: true })),
    })
    await expect(bridge.getLlmSettings()).rejects.toThrow('Invalid LLM settings response')
  })

  it('treats only null as picker cancellation', async () => {
    const invoke = vi.fn(async () => null as unknown)
    const bridge = createTauriNativeBridge({ invoke })

    await expect(bridge.selectFile()).resolves.toBeNull()
    invoke.mockResolvedValueOnce(undefined)
    await expect(bridge.selectFile()).rejects.toThrow('Invalid native selection response')
    invoke.mockResolvedValueOnce({ path: '/tmp/file.txt' })
    await expect(bridge.selectFile()).rejects.toThrow('Invalid native selection response')
  })
})
