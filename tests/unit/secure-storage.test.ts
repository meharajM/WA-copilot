import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>()
  const values = new Map<string, string>()

  return {
    handlers,
    values,
    handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
      handlers.set(channel, handler)
    }),
    isEncryptionAvailable: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
    set: vi.fn((key: string, value: string) => values.set(key, value)),
    delete: vi.fn((key: string) => values.delete(key)),
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  safeStorage: {
    isEncryptionAvailable: mocks.isEncryptionAvailable,
    encryptString: mocks.encryptString,
    decryptString: mocks.decryptString,
  },
}))

vi.mock('electron-store', () => ({
  default: class MockStore {
    get store(): Record<string, string> {
      return Object.fromEntries(mocks.values)
    }

    get(key: string): string | undefined {
      return mocks.values.get(key)
    }

    set(key: string, value: string): void {
      mocks.set(key, value)
    }

    delete(key: string): void {
      mocks.delete(key)
    }
  },
}))

import { registerSecureHandlers } from '../../src/main/ipc/secure'

function handler(channel: string): (...args: any[]) => any {
  const registered = mocks.handlers.get(channel)
  if (!registered) throw new Error(`Missing IPC handler: ${channel}`)
  return registered
}

describe('secure storage IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.values.clear()
    vi.clearAllMocks()
    registerSecureHandlers()
  })

  it('refuses to store a secret when encryption is unavailable', async () => {
    mocks.isEncryptionAvailable.mockReturnValue(false)

    const result = await handler('secure:set')({}, 'openai_api_key', 'plaintext')

    expect(result).toEqual({
      success: false,
      encrypted: false,
      error: 'Secure storage encryption is unavailable',
    })
    expect(mocks.set).not.toHaveBeenCalled()
    expect(mocks.values.size).toBe(0)
  })

  it('does not expose a stored value when encryption is unavailable', async () => {
    mocks.values.set('openai_api_key', 'legacy-plaintext')
    mocks.isEncryptionAvailable.mockReturnValue(false)

    const result = await handler('secure:get')({}, 'openai_api_key')

    expect(result).toEqual({
      success: false,
      value: null,
      encrypted: false,
      error: 'Secure storage encryption is unavailable',
    })
    expect(mocks.decryptString).not.toHaveBeenCalled()
  })

  it('removes legacy plaintext instead of returning it', async () => {
    mocks.values.set('user_alice_openai_api_key', 'legacy-plaintext')
    mocks.isEncryptionAvailable.mockReturnValue(true)
    mocks.decryptString.mockImplementation(() => {
      throw new Error('not encrypted')
    })

    const result = await handler('secure:get')({}, 'openai_api_key', 'alice')

    expect(result).toEqual({
      success: false,
      value: null,
      encrypted: false,
      error: 'Stored secret was not securely encrypted and has been removed',
    })
    expect(mocks.delete).toHaveBeenCalledWith('user_alice_openai_api_key')
    expect(mocks.values.has('user_alice_openai_api_key')).toBe(false)
  })

  it('stores and retrieves encrypted secrets normally', async () => {
    mocks.isEncryptionAvailable.mockReturnValue(true)
    mocks.encryptString.mockReturnValue(Buffer.from('ciphertext'))
    mocks.decryptString.mockReturnValue('secret-value')

    const setResult = await handler('secure:set')(
      {},
      'gemini_api_key',
      'secret-value',
      'alice',
    )
    const getResult = await handler('secure:get')({}, 'gemini_api_key', 'alice')

    expect(setResult).toEqual({ success: true, encrypted: true })
    expect(mocks.values.get('user_alice_gemini_api_key')).toBe(
      Buffer.from('ciphertext').toString('base64'),
    )
    expect(mocks.decryptString).toHaveBeenCalledWith(Buffer.from('ciphertext'))
    expect(getResult).toEqual({
      success: true,
      value: 'secret-value',
      encrypted: true,
    })
  })
})
