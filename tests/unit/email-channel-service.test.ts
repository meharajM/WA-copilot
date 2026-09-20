import { beforeEach, describe, expect, it, vi } from 'vitest'

const { dataDir } = vi.hoisted(() => ({
  dataDir: `/tmp/aica-email-channel-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
}))

vi.mock('electron', () => {
  const fs = process.getBuiltinModule('node:fs')
  fs.mkdirSync(dataDir, { recursive: true })
  return { app: { getPath: () => dataDir } }
})

vi.mock('electron-store', () => ({
  default: class MockStore {
    private values = new Map<string, unknown>()

    constructor(options?: { defaults?: Record<string, unknown> }) {
      for (const [key, value] of Object.entries(options?.defaults || {})) {
        this.values.set(key, value)
      }
    }

    get(key: string): unknown {
      return this.values.get(key)
    }

    set(key: string, value: unknown): void {
      this.values.set(key, value)
    }
  },
}))

vi.mock('../../src/main/services/GmailOAuthService', () => ({
  gmailOAuthService: {
    initialize: vi.fn(),
    getAccessToken: vi.fn(),
  },
}))

import { EmailChannelService } from '../../src/main/services/EmailChannelService'

describe('EmailChannelService outbound delivery', () => {
  let service: EmailChannelService
  const callTool = vi.fn()

  beforeEach(() => {
    service = new EmailChannelService()
    service.configure({
      command: 'unused',
      args: [],
      pollingIntervalSeconds: 60,
      accountName: 'support',
      provider: 'imap-smtp',
    })
    callTool.mockReset()
    ;(service as unknown as { client: { callTool: typeof callTool } }).client = { callTool }
  })

  it('delegates one send to the connected MCP client with reply headers', async () => {
    callTool.mockResolvedValue({ content: [{ type: 'text', text: 'sent' }] })

    const result = await service.send({
      to: 'customer@example.com',
      subject: 'Re: Order status',
      body: 'Your order shipped.',
      inReplyTo: '<inbound@example.com>',
      references: '<root@example.com> <inbound@example.com>',
    })

    expect(result).toEqual({ success: true })
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(callTool).toHaveBeenCalledWith({
      name: 'send_email',
      arguments: {
        account_name: 'support',
        recipients: ['customer@example.com'],
        subject: 'Re: Order status',
        body: 'Your order shipped.',
        in_reply_to: '<inbound@example.com>',
        references: '<root@example.com> <inbound@example.com>',
      },
    })
  })

  it('reports MCP tool-level send failures instead of emitting false success', async () => {
    callTool.mockResolvedValue({
      isError: true,
      content: [{ type: 'text', text: 'SMTP rejected the recipient' }],
    })

    const result = await service.send({
      to: 'invalid@example.com',
      subject: 'Reply',
      body: 'Hello',
    })

    expect(result).toEqual({ success: false, error: 'SMTP rejected the recipient' })
    expect(callTool).toHaveBeenCalledTimes(1)
  })
})
