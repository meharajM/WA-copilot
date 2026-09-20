import { describe, expect, it, vi } from 'vitest'
import {
  createTauriNativeBridge,
  TAURI_COMMANDS,
  tauriNativeBridge,
} from '../../src/renderer/src/lib/tauri-native-bridge'

describe('tauri native bridge', () => {
  it('exposes only native capability command names', () => {
    expect(Object.values(TAURI_COMMANDS)).toEqual([
      'app_version',
      'agentd_health',
      'agentd_origin',
      'agentd_pairing_code',
      'open_browser_workspace',
      'open_agentd_data_folder',
      'service_status',
      'service_install',
      'service_uninstall',
      'credential_set',
      'credential_exists',
      'credential_delete',
      'select_file',
      'select_folder',
      'continuity_preview',
      'continuity_import',
      'continuity_rollback',
    ])
  })

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
      if (command === TAURI_COMMANDS.agentdPairingCode) return '123456'
      if (command === TAURI_COMMANDS.openBrowserWorkspace) return null
      if (command === TAURI_COMMANDS.openAgentdDataFolder) return null
      if (command === TAURI_COMMANDS.agentdHealth) return { status: 'ready', version: 'agentd protocol v1', paused: false, queueDepth: 2, events: 4 }
      if (command === TAURI_COMMANDS.credentialSet) return { success: true }
      if (command === TAURI_COMMANDS.credentialExists) return { success: true, exists: true }
      if (command === TAURI_COMMANDS.credentialDelete) return { success: true }
      return null
    })
    const bridge = createTauriNativeBridge({ invoke })

    await expect(bridge.appVersion()).resolves.toBe('1.2.3')
    await expect(bridge.agentdOrigin()).resolves.toBe('http://127.0.0.1:4141')
    await expect(bridge.agentdPairingCode()).resolves.toBe('123456')
    await expect(bridge.openBrowserWorkspace()).resolves.toEqual({ success: true })
    await expect(bridge.openAgentdDataFolder()).resolves.toEqual({ success: true })
    await expect(bridge.health()).resolves.toMatchObject({ status: 'ready', paused: false, queueDepth: 2, events: 4 })
    await expect(bridge.setCredential('openai_api_key', 'secret')).resolves.toEqual({ success: true })
    await expect(bridge.setCredential('whatsapp_cloud_access_token', 'cloud-secret')).resolves.toEqual({ success: true })
    await expect(bridge.hasCredential('whatsapp_cloud_access_token')).resolves.toEqual({ success: true, exists: true })
    await expect(bridge.hasCredential('openai_api_key')).resolves.toEqual({ success: true, exists: true })
    await expect(bridge.deleteCredential('openai_api_key')).resolves.toEqual({ success: true })

    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.credentialSet, { key: 'openai_api_key', value: 'secret' })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.openBrowserWorkspace, undefined)
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.openAgentdDataFolder, undefined)
    expect(invoke).not.toHaveBeenCalledWith(expect.stringMatching(/get.*credential|credential.*read/i), expect.anything())
  })

  it('keeps Windows service registration typed and owner-controlled', async () => {
    const invoke = vi.fn(async (command: string) => {
      if ([TAURI_COMMANDS.serviceStatus, TAURI_COMMANDS.serviceInstall, TAURI_COMMANDS.serviceUninstall].includes(command)) {
        return { supported: true, installed: command !== TAURI_COMMANDS.serviceUninstall, running: false, taskName: 'AICA Native Companion', message: 'Registered for this Windows user' }
      }
      return null
    })
    const bridge = createTauriNativeBridge({ invoke })

    await expect(bridge.serviceStatus()).resolves.toMatchObject({ supported: true, taskName: 'AICA Native Companion' })
    await expect(bridge.serviceInstall()).resolves.toMatchObject({ installed: true })
    await expect(bridge.serviceUninstall()).resolves.toMatchObject({ installed: false })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.serviceInstall, undefined)
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.serviceUninstall, undefined)
  })

  it('fails closed on malformed host responses and unavailable agentd', async () => {
    const bridge = createTauriNativeBridge({
      invoke: vi.fn(async (command: string) => {
        if (command === TAURI_COMMANDS.agentdHealth) throw new Error('agentd is stopped or unavailable')
        return { unexpected: true }
      }),
    })

    await expect(bridge.health()).resolves.toMatchObject({ status: 'unavailable', error: 'agentd is stopped or unavailable' })
    await expect(bridge.setCredential('openai_api_key', '')).resolves.toMatchObject({ success: false })
    await expect(bridge.hasCredential('openai_api_key')).resolves.toMatchObject({ success: false, exists: false })
  })

  it('rejects non-loopback browser workspace origins', async () => {
    const bridge = createTauriNativeBridge({ invoke: vi.fn(async () => 'https://example.test') })
    await expect(bridge.agentdOrigin()).rejects.toThrow('Invalid agentd origin response')
  })

  it('covers every public agentd credential without exposing internal OAuth refresh material', async () => {
    const invoke = vi.fn(async () => ({ success: true, exists: true }))
    const bridge = createTauriNativeBridge({ invoke })

    await expect(bridge.setCredential('gemini_api_key', 'secret')).resolves.toMatchObject({ success: true })
    await expect(bridge.setCredential('email_imap_password', 'secret')).resolves.toMatchObject({ success: true })
    await expect(bridge.setCredential('gmail_oauth_client_id', 'secret')).resolves.toMatchObject({ success: true })
    await expect(bridge.hasCredential('whatsapp_cloud_access_token')).resolves.toMatchObject({ success: true, exists: true })
    await expect(bridge.deleteCredential('email_imap_password')).resolves.toMatchObject({ success: true })
    await expect(bridge.hasCredential('email_smtp_password')).resolves.toMatchObject({ success: true, exists: true })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.credentialExists, { key: 'whatsapp_cloud_access_token' })
  })

  it('keeps continuity actions typed and native-only', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === TAURI_COMMANDS.continuityPreview) return {
        previewId: 'preview-id', createdAt: 1, source: 'electron', target: 'agentd-staging',
        entries: [], secretsExcluded: true, requiresOwnerConfirmation: true, requiresReauthentication: false,
      }
      if (command === TAURI_COMMANDS.continuityImport) return { migrationId: 'migration-id', state: 'staged', entries: [], secretsExcluded: true, liveDataChanged: false }
      return { migrationId: 'migration-id', state: 'rolled-back' }
    })
    const bridge = createTauriNativeBridge({ invoke })
    await expect(bridge.continuityPreview('C:\\Users\\owner\\AppData\\Roaming\\AIConsumerAgent')).resolves.toMatchObject({ target: 'agentd-staging' })
    await expect(bridge.continuityImport('preview-id')).resolves.toMatchObject({ liveDataChanged: false })
    await expect(bridge.continuityRollback('migration-id')).resolves.toMatchObject({ state: 'rolled-back' })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.continuityPreview, { sourceRoot: 'C:\\Users\\owner\\AppData\\Roaming\\AIConsumerAgent' })
  })

  it('keeps chat-history cutover typed, native-only, and token-free in rendered state', async () => {
    expect(TAURI_COMMANDS.chatHistoryConfirm).toBe('chat_history_confirm')
    expect(TAURI_COMMANDS.chatHistoryApply).toBe('chat_history_apply')
    expect(TAURI_COMMANDS.chatHistoryStatus).toBe('chat_history_status')
    expect(TAURI_COMMANDS.chatHistoryRollback).toBe('chat_history_rollback')
    const invoke = vi.fn(async (command: string) => {
      if (command === TAURI_COMMANDS.chatHistoryConfirm) return {
        previewId: '12345678-1234-1234-1234-123456789012', scope: 'chat-history', targetRuntime: 'runtime', state: 'confirmed', manifestHash: 'manifest', confirmationToken: 'a'.repeat(64),
      }
      if (command === TAURI_COMMANDS.chatHistoryApply) return {
        previewId: '12345678-1234-1234-1234-123456789012', scope: 'chat-history', targetRuntime: 'runtime', state: 'applied', manifestHash: 'manifest', backupSha256: 'backup', liveDataChanged: true, sessionsImported: 1, messagesImported: 2,
      }
      if (command === TAURI_COMMANDS.chatHistoryStatus) return {
        previewId: '12345678-1234-1234-1234-123456789012', scope: 'chat-history', targetRuntime: 'runtime', state: 'applied', manifestHash: 'manifest', backupSha256: 'backup', liveDataChanged: true,
      }
      return {
        previewId: '12345678-1234-1234-1234-123456789012', scope: 'chat-history', targetRuntime: 'runtime', state: 'rolled-back', manifestHash: 'manifest', liveDataChanged: true,
      }
    })
    const bridge = createTauriNativeBridge({ invoke })
    const previewId = '12345678-1234-1234-1234-123456789012'
    const confirmed = await bridge.chatHistoryConfirm(previewId)
    await expect(bridge.chatHistoryApply(previewId, confirmed.confirmationToken!)).resolves.toMatchObject({ state: 'applied', sessionsImported: 1 })
    await expect(bridge.chatHistoryStatus(previewId)).resolves.toMatchObject({ state: 'applied' })
    await expect(bridge.chatHistoryRollback(previewId)).resolves.toMatchObject({ state: 'rolled-back' })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.chatHistoryConfirm, { previewId })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.chatHistoryApply, { previewId, confirmationToken: 'a'.repeat(64) })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.chatHistoryStatus, { previewId })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.chatHistoryRollback, { previewId })
  })

  it('keeps credential continuity metadata-only and native-owner-only', async () => {
    expect(TAURI_COMMANDS.credentialContinuityPreview).toBe('credential_continuity_preview')
    const invoke = vi.fn(async () => ({
      version: 1,
      source: 'electron',
      target: 'agentd-os-credential-store',
      state: 'reauthentication-required',
      stores: [{
        id: 'electron-credentials',
        present: true,
        entries: [{ key: 'openai_api_key', scope: 'default', supported: true }],
      }],
      secretsExcluded: true,
      requiresOwnerConfirmation: true,
      requiresReauthentication: true,
      transferable: false,
      note: 'Electron safe-storage values are not copied; re-enter each supported credential through the native owner flow.',
    }))
    const bridge = createTauriNativeBridge({ invoke })
    const sourceRoot = 'C:\\Users\\owner\\AppData\\Roaming\\AIConsumerAgent'
    await expect(bridge.credentialContinuityPreview(sourceRoot)).resolves.toMatchObject({
      state: 'reauthentication-required',
      secretsExcluded: true,
      transferable: false,
    })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.credentialContinuityPreview, { sourceRoot })
  })

  it('rejects malformed credential continuity metadata', async () => {
    const bridge = createTauriNativeBridge({ invoke: vi.fn(async () => ({
      version: 1,
      source: 'electron',
      target: 'agentd-os-credential-store',
      state: 'reauthentication-required',
      stores: [{ id: 'electron-credentials', present: true, entries: [{ key: 'raw_secret_value', scope: 'default', supported: true }] }],
      secretsExcluded: true,
      requiresOwnerConfirmation: true,
      requiresReauthentication: true,
      transferable: false,
      note: 'safe',
    })) })
    await expect(bridge.credentialContinuityPreview('/tmp/electron')).rejects.toThrow('Invalid credential continuity entry response')
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
