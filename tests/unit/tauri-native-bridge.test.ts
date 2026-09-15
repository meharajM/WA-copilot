import { describe, expect, it, vi } from 'vitest'
import {
  createTauriNativeBridge,
  TAURI_COMMANDS,
  TAURI_EVENTS,
} from '../../src/renderer/src/lib/tauri-native-bridge'

describe('tauri native bridge', () => {
  it('uses fixed commands and never exposes credential reads', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === TAURI_COMMANDS.appVersion) return '1.2.3'
      if (command === TAURI_COMMANDS.agentdHealth) return { status: 'ready', version: 'protocol-v1' }
      if (command === TAURI_COMMANDS.credentialSet) return { success: true }
      if (command === TAURI_COMMANDS.credentialExists) return { success: true, exists: true }
      if (command === TAURI_COMMANDS.credentialDelete) return { success: true }
      return null
    })
    const listen = vi.fn(async () => () => undefined)
    const bridge = createTauriNativeBridge({ invoke, listen })

    await expect(bridge.appVersion()).resolves.toBe('1.2.3')
    await expect(bridge.health()).resolves.toMatchObject({ status: 'ready', version: 'protocol-v1' })
    await expect(bridge.setCredential('openai_api_key', 'secret')).resolves.toEqual({ success: true })
    await expect(bridge.hasCredential('openai_api_key')).resolves.toEqual({ success: true, exists: true })
    await expect(bridge.deleteCredential('openai_api_key')).resolves.toEqual({ success: true })

    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.credentialSet, { key: 'openai_api_key', value: 'secret' })
    expect(invoke).not.toHaveBeenCalledWith(expect.stringMatching(/get|read/i), expect.anything())
  })

  it('fails closed on malformed health/results and empty credentials', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === TAURI_COMMANDS.agentdHealth) return { status: 'online' }
      return { unexpected: true }
    })
    const bridge = createTauriNativeBridge({ invoke, listen: vi.fn(async () => () => undefined) })

    await expect(bridge.health()).resolves.toEqual({ status: 'unavailable', error: 'Invalid agentd health response' })
    await expect(bridge.setCredential('openai_api_key', '')).resolves.toMatchObject({ success: false })
    await expect(bridge.hasCredential('openai_api_key')).resolves.toMatchObject({ success: false, exists: false })
  })

  it('rejects credential keys outside the runtime allowlist', async () => {
    const invoke = vi.fn()
    const bridge = createTauriNativeBridge({ invoke, listen: vi.fn(async () => () => undefined) })

    await expect(bridge.setCredential('not_allowlisted' as never, 'secret')).resolves.toMatchObject({
      success: false,
      error: 'Credential key is not available in this Tauri host',
    })
    await expect(bridge.hasCredential('not_allowlisted' as never)).resolves.toMatchObject({
      success: false,
      exists: false,
    })
    await expect(bridge.deleteCredential('not_allowlisted' as never)).resolves.toMatchObject({
      success: false,
      error: 'Credential key is not available in this Tauri host',
    })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects credential existence responses without a boolean exists field', async () => {
    const bridge = createTauriNativeBridge({
      invoke: vi.fn(async () => ({ success: true })),
      listen: vi.fn(async () => () => undefined),
    })

    await expect(bridge.hasCredential('openai_api_key')).resolves.toEqual({
      success: false,
      error: 'Invalid credential existence response',
      exists: false,
    })
  })

  it('treats only null as picker cancellation', async () => {
    const invoke = vi.fn(async () => null as unknown)
    const bridge = createTauriNativeBridge({ invoke, listen: vi.fn(async () => () => undefined) })

    await expect(bridge.selectFile()).resolves.toBeNull()
    invoke.mockResolvedValueOnce(undefined)
    await expect(bridge.selectFile()).rejects.toThrow('Invalid native selection response')
    invoke.mockResolvedValueOnce({ path: '/tmp/file.txt' })
    await expect(bridge.selectFile()).rejects.toThrow('Invalid native selection response')
  })

  it('reports health event subscription failures to the caller', async () => {
    const listen = vi.fn(async () => { throw new Error('native registration details') })
    const onError = vi.fn()
    const bridge = createTauriNativeBridge({ invoke: vi.fn(), listen })

    const subscription = bridge.onAgentdHealth(vi.fn(), onError)
    await subscription.ready
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith('Agentd health event subscription unavailable'))
  })

  it('does not report a listener registration failure after unsubscribe', async () => {
    let rejectListen: ((error: Error) => void) | undefined
    const listen = vi.fn(() => new Promise<() => void>((_resolve, reject) => { rejectListen = reject }))
    const onError = vi.fn()
    const bridge = createTauriNativeBridge({ invoke: vi.fn(), listen })

    const subscription = bridge.onAgentdHealth(vi.fn(), onError)
    subscription.unsubscribe()
    rejectListen?.(new Error('registration failed'))
    await subscription.ready

    expect(onError).not.toHaveBeenCalled()
  })

  it('cleans up an async listener that resolves after unsubscribe', async () => {
    let resolveListen: ((cleanup: () => void) => void) | undefined
    const cleanup = vi.fn()
    const listen = vi.fn(() => new Promise<() => void>((resolve) => { resolveListen = resolve }))
    const bridge = createTauriNativeBridge({ invoke: vi.fn(), listen })
    const listener = vi.fn()

    const subscription = bridge.onAgentdHealth(listener)
    subscription.unsubscribe()
    resolveListen?.(cleanup)
    await subscription.ready

    expect(cleanup).toHaveBeenCalledOnce()
    expect(listener).not.toHaveBeenCalled()
    expect(listen).toHaveBeenCalledWith(TAURI_EVENTS.agentdHealth, expect.any(Function))
  })

  it('exposes readiness only after native event registration settles', async () => {
    let resolveListen: ((cleanup: () => void) => void) | undefined
    const listen = vi.fn(() => new Promise<() => void>((resolve) => { resolveListen = resolve }))
    const invoke = vi.fn(async () => ({ status: 'ready' }))
    const bridge = createTauriNativeBridge({ invoke, listen })
    const subscription = bridge.onAgentdHealth(vi.fn())
    let ready = false
    const snapshot = subscription.ready.then(() => {
      ready = true
      return bridge.health()
    })

    await Promise.resolve()
    expect(ready).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
    resolveListen?.(vi.fn())
    await subscription.ready

    expect(ready).toBe(true)
    await expect(snapshot).resolves.toMatchObject({ status: 'ready' })
    expect(invoke).toHaveBeenCalledWith(TAURI_COMMANDS.agentdHealth, undefined)
    subscription.unsubscribe()
  })
})
