import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stores: [] as Array<{ data: Record<string, string> }>,
  isEncryptionAvailable: vi.fn(),
  encryptString: vi.fn(),
  decryptString: vi.fn(),
  openExternal: vi.fn(),
}))

vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
  safeStorage: {
    isEncryptionAvailable: mocks.isEncryptionAvailable,
    encryptString: mocks.encryptString,
    decryptString: mocks.decryptString,
  },
}))

vi.mock('electron-store', () => ({
  default: class MockStore {
    data: Record<string, string> = {}

    constructor() {
      mocks.stores.push(this)
    }

    get(key: string): string | undefined {
      return this.data[key]
    }

    set(key: string, value: string): void {
      this.data[key] = value
    }

    delete(key: string): void {
      delete this.data[key]
    }
  },
}))

describe('Gmail OAuth credential recovery', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
    mocks.stores.length = 0
    vi.clearAllMocks()
    delete process.env.GMAIL_OAUTH_CLIENT_ID
    delete process.env.GMAIL_OAUTH_CLIENT_SECRET
  })

  it('never writes OAuth values when safeStorage is unavailable', async () => {
    mocks.isEncryptionAvailable.mockReturnValue(false)
    process.env.GMAIL_OAUTH_CLIENT_ID = 'client-id'

    const { gmailOAuthService } = await import('../../src/main/services/GmailOAuthService')
    mocks.stores[0].data = { gmail_refresh_token: 'ciphertext-preserved' }
    await gmailOAuthService.initialize()
    expect(gmailOAuthService.getStatus()).toMatchObject({ signedIn: false, requiresReauthentication: true })

    await expect(gmailOAuthService.signIn()).rejects.toThrow('Secure storage encryption is unavailable')
    expect(mocks.stores[0]?.data.gmail_refresh_token).toBe('ciphertext-preserved')
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  it('marks revoked refresh tokens as requiring explicit reauthentication', async () => {
    mocks.isEncryptionAvailable.mockReturnValue(true)
    mocks.encryptString.mockImplementation((value: string) => Buffer.from(value))
    const encrypted = {
      'refresh-cipher': 'refresh-token-never-returned',
      'email-cipher': 'owner@example.test',
      'client-cipher': 'client-id',
    }
    mocks.decryptString.mockImplementation((value: Buffer) => encrypted[value.toString()] || '')

    const { gmailOAuthService } = await import('../../src/main/services/GmailOAuthService')
    const store = mocks.stores[0]
    store.data = {
      gmail_refresh_token: Buffer.from('refresh-cipher').toString('base64'),
      gmail_email: Buffer.from('email-cipher').toString('base64'),
      gmail_client_id: Buffer.from('client-cipher').toString('base64'),
    }
    await gmailOAuthService.initialize()
    expect(gmailOAuthService.getStatus()).toMatchObject({ signedIn: true, requiresReauthentication: false })

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })))
    await expect(gmailOAuthService.getAccessToken()).rejects.toThrow('Gmail OAuth token refresh failed: invalid_grant')
    expect(gmailOAuthService.getStatus()).toMatchObject({ signedIn: false, requiresReauthentication: true })
  })

  it('preserves undecryptable OAuth ciphertext and requires reauthentication', async () => {
    mocks.isEncryptionAvailable.mockReturnValue(true)
    mocks.decryptString.mockImplementation(() => { throw new Error('invalid ciphertext') })

    const { gmailOAuthService } = await import('../../src/main/services/GmailOAuthService')
    const store = mocks.stores[0]
    store.data = { gmail_refresh_token: 'ciphertext-preserved' }
    await gmailOAuthService.initialize()

    expect(gmailOAuthService.getStatus()).toMatchObject({ signedIn: false, requiresReauthentication: true })
    expect(store.data.gmail_refresh_token).toBe('ciphertext-preserved')
  })
})
