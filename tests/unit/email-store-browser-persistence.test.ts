import { beforeEach, describe, expect, it, vi } from 'vitest'

const browserClient = vi.hoisted(() => ({
  getEmailSettings: vi.fn(),
  saveEmailSettings: vi.fn(),
}))

vi.mock('../../src/renderer/src/lib/browser-agentd-client', () => ({
  getBrowserAgentdClient: () => browserClient,
}))

const REMOTE_SETTINGS = {
  accountName: 'remote',
  provider: 'imap-smtp' as const,
  gmailAuthMode: 'app-password' as const,
  imapHost: 'imap.example.test',
  imapPort: 993,
  smtpHost: 'smtp.example.test',
  smtpPort: 587,
  emailAddress: 'remote@example.test',
  userName: 'remote@example.test',
  imapTls: true,
  smtpTls: true,
  pollingIntervalSeconds: 60,
  enabled: false,
  autoReplyMode: false,
  draftMode: true,
}

describe('browser email settings persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    browserClient.getEmailSettings.mockReset()
    browserClient.saveEmailSettings.mockReset()
    browserClient.saveEmailSettings.mockImplementation(async (settings) => settings)
  })

  it('preserves edits made during hydration and serializes rapid writes', async () => {
    let releaseHydration: ((settings: typeof REMOTE_SETTINGS) => void) | undefined
    browserClient.getEmailSettings.mockImplementation(() => new Promise(resolve => { releaseHydration = resolve }))

    const { flushEmailSettingsPersistence, useEmailStore } = await import('../../src/renderer/src/stores/emailStore')
    useEmailStore.getState().setConnectionSettings({ emailAddress: 'local@example.test' })
    releaseHydration?.(REMOTE_SETTINGS)
    await flushEmailSettingsPersistence()

    expect(useEmailStore.getState().config.emailAddress).toBe('local@example.test')
    expect(browserClient.saveEmailSettings).toHaveBeenCalledTimes(1)

    useEmailStore.getState().setProvider('gmail-api')
    useEmailStore.getState().setGmailAuthMode('google-oauth')
    await flushEmailSettingsPersistence()

    const writes = browserClient.saveEmailSettings.mock.calls.map(([settings]) => settings)
    expect(writes.map((settings) => settings.provider)).toEqual(['imap-smtp', 'gmail-api', 'gmail-api'])
    expect(writes.at(-1)).toMatchObject({
      emailAddress: 'local@example.test',
      provider: 'gmail-api',
      gmailAuthMode: 'google-oauth',
    })
  })
})
