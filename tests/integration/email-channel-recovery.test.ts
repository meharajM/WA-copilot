import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ stores: [] as Array<{ data: Record<string, string>; get: (key: string) => string | undefined }> }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  shell: { openExternal: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('electron-store', () => ({
  default: class TestStore {
    data: Record<string, string> = {}
    constructor() { mocks.stores.push(this) }
    get(key: string) { return this.data[key] }
    set(key: string, value: string) { this.data[key] = value }
    delete(key: string) { delete this.data[key] }
  }
}))

describe('email channel recovery', () => {
  beforeEach(() => { mocks.stores.length = 0 })

  it('surfaces Gmail token refresh failures as an error state', async () => {
    const { EmailChannelService } = await import('../../src/main/services/EmailChannelService')
    const { gmailOAuthService } = await import('../../src/main/services/GmailOAuthService')
    const service = new EmailChannelService()
    service.configure({ command: 'unused', args: [], provider: 'gmail-api', pollingIntervalSeconds: 60 })
    vi.spyOn(gmailOAuthService, 'getAccessToken').mockRejectedValue(new Error('Gmail OAuth token refresh failed: invalid_grant'))

    await (service as unknown as { pollOnce: () => Promise<void> }).pollOnce()

    expect(service.getConnectionState()).toMatchObject({ status: 'error', error: 'Gmail OAuth token refresh failed: invalid_grant' })
  })

  it('retrieves and scans a bounded Gmail attachment without exposing rejected bytes', async () => {
    const { EmailChannelService } = await import('../../src/main/services/EmailChannelService')
    const { gmailOAuthService } = await import('../../src/main/services/GmailOAuthService')
    const service = new EmailChannelService()
    service.configure({ command: 'unused', args: [], provider: 'gmail-api', pollingIntervalSeconds: 60 })
    vi.spyOn(gmailOAuthService, 'getAccessToken').mockResolvedValue('access-token')
    const data = Buffer.from('%PDF-1.7\n').toString('base64url')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ data, size: 9 }), { status: 200 }))

    const result = await service.retrieveGmailAttachment('message_1', 'attachment_1', { mimeType: 'application/pdf', name: 'invoice.pdf' })

    expect(result.scan).toMatchObject({ safe: true, detectedType: 'pdf', size: 9 })
    expect(result.bytes).toBeInstanceOf(Uint8Array)
    expect(fetchMock).toHaveBeenCalledWith('https://gmail.googleapis.com/gmail/v1/users/me/messages/message_1/attachments/attachment_1', expect.objectContaining({ headers: { Authorization: 'Bearer access-token' } }))

    const rejected = await service.retrieveGmailAttachment('message_1', 'attachment_1', { mimeType: 'image/png', name: 'invoice.png' })
    expect(rejected.scan).toMatchObject({ safe: false, reason: 'mime_magic_mismatch_or_unsupported_type' })
    expect(rejected.bytes).toBeUndefined()

    await expect(service.retrieveGmailAttachment('message_1', 'attachment_1', { mimeType: 42 as unknown as string, name: { toString: () => 'bad' } as unknown as string })).resolves.toMatchObject({ scan: { safe: true, detectedType: 'pdf' } })

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 200, headers: { 'content-length': '20000000' } }))
    await expect(service.retrieveGmailAttachment('message_1', 'attachment_1', { mimeType: 'application/pdf' })).resolves.toMatchObject({ scan: { safe: false, reason: 'attachment_response_exceeds_scan_limit' } })

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ data: 'A'.repeat(15 * 1024 * 1024) }), { status: 200 }))
    await expect(service.retrieveGmailAttachment('message_1', 'attachment_1', { mimeType: 'application/pdf' })).resolves.toMatchObject({ scan: { safe: false, reason: 'attachment_payload_missing_or_exceeds_scan_limit' } })
  })

  it('does not advance the Gmail cursor when a detail fetch fails', async () => {
    const { EmailChannelService } = await import('../../src/main/services/EmailChannelService')
    const { gmailOAuthService } = await import('../../src/main/services/GmailOAuthService')
    const service = new EmailChannelService()
    service.configure({ command: 'unused', args: [], provider: 'gmail-api', pollingIntervalSeconds: 60 })
    vi.spyOn(gmailOAuthService, 'getAccessToken').mockResolvedValue('access-token')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'gmail-message-1' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('temporary failure', { status: 503 }))

    await (service as unknown as { pollOnce: () => Promise<void> }).pollOnce()

    expect(mocks.stores.some(store => store.get('gmailLastSyncTimestamp') !== undefined)).toBe(false)
  })

  it('uses Gmail internalDate so stale messages cannot enter the agent queue', async () => {
    const { EmailChannelService } = await import('../../src/main/services/EmailChannelService')
    const { gmailOAuthService } = await import('../../src/main/services/GmailOAuthService')
    const service = new EmailChannelService()
    service.configure({ command: 'unused', args: [], provider: 'gmail-api', pollingIntervalSeconds: 60 })
    vi.spyOn(gmailOAuthService, 'getAccessToken').mockResolvedValue('access-token')
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: 'gmail-old-message' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'gmail-old-message',
        internalDate: String(Date.now() - 2 * 60 * 60 * 1000),
        payload: { headers: [
          { name: 'From', value: 'customer@example.com' },
          { name: 'To', value: 'support@example.com' },
          { name: 'Subject', value: 'Old question' },
          { name: 'Message-ID', value: '<gmail-old-message@example.com>' }
        ], body: {} }
      }), { status: 200 }))

    const message = vi.fn()
    service.on('message', message)
    await (service as unknown as { pollOnce: () => Promise<void> }).pollOnce()

    expect(message).not.toHaveBeenCalled()
  })

  it('renews a validated Gmail Pub/Sub watch', async () => {
    const { gmailOAuthService } = await import('../../src/main/services/GmailOAuthService')
    vi.spyOn(gmailOAuthService, 'getAccessToken').mockResolvedValue('access-token')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ historyId: 'history-1', expiration: '2000000000000' }), { status: 200 }))

    await expect(gmailOAuthService.renewWatch('projects/example/topics/gmail')).resolves.toEqual({ historyId: 'history-1', expiration: 2000000000000 })
    expect(fetchMock).toHaveBeenCalledWith('https://gmail.googleapis.com/gmail/v1/users/me/watch', expect.objectContaining({ method: 'POST', body: JSON.stringify({ labelIds: ['INBOX'], topicName: 'projects/example/topics/gmail' }) }))
    await expect(gmailOAuthService.renewWatch('not-a-topic')).rejects.toThrow('Invalid Gmail Pub/Sub topic')
  })

  it('includes the MCP provider ID in delivery acknowledgments', async () => {
    const { EmailChannelService } = await import('../../src/main/services/EmailChannelService')
    const service = new EmailChannelService()
    service.configure({ command: 'unused', args: [], provider: 'mcp', pollingIntervalSeconds: 60 })
    ;(service as unknown as { client: { callTool: ReturnType<typeof vi.fn> } }).client = { callTool: vi.fn().mockResolvedValue({ structuredContent: { id: 'mcp-email-1' } }) }
    const delivery = vi.fn()
    service.on('deliveryStatus', delivery)
    const result = await service.send({ to: 'customer@example.com', subject: 'Re: Hours', body: `We are open (${Date.now()}).` })
    expect(result).toMatchObject({ success: true, providerMessageId: 'mcp-email-1' })
    expect(delivery).toHaveBeenCalledWith(expect.objectContaining({ providerMessageId: 'mcp-email-1', status: 'sent' }))
  })
})
