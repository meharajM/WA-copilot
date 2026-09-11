import { describe, expect, it } from 'vitest'
import {
  buildEmailRuntimeConfig,
  parseMcpArgs,
  resolveEmailRuntimeProvider,
} from '../../src/renderer/src/lib/email-runtime'

describe('parseMcpArgs', () => {
  it('splits whitespace-delimited arguments', () => {
    expect(parseMcpArgs('mcp-email-server==0.6.2 stdio')).toEqual([
      'mcp-email-server==0.6.2',
      'stdio',
    ])
  })

  it('drops extra whitespace', () => {
    expect(parseMcpArgs('  foo   bar   baz  ')).toEqual(['foo', 'bar', 'baz'])
  })
})

describe('buildEmailRuntimeConfig', () => {
  const baseInput = {
    emailAddress: 'user@example.com',
    userName: 'User',
    accountName: 'Support',
    imapHost: 'imap.example.com',
    imapPort: 993,
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    imapTls: true,
    smtpTls: true,
    pollingIntervalSeconds: 15,
    password: 'secret',
  } as const

  it('uses the default MCP command and args for imap-smtp', () => {
    const config = buildEmailRuntimeConfig({
      ...baseInput,
      provider: 'imap-smtp',
    })

    expect(config.command).toBe('uvx')
    expect(config.args).toEqual(['mcp-email-server==0.6.2', 'stdio'])
    expect(config.pollingIntervalSeconds).toBe(30)
    expect(config.accountName).toBe('Support')
    expect(config.env.MCP_EMAIL_SERVER_EMAIL_ADDRESS).toBe('user@example.com')
  })

  it('uses custom MCP command and args when provider is custom-mcp', () => {
    const config = buildEmailRuntimeConfig({
      ...baseInput,
      provider: 'custom-mcp',
      mcpCommand: 'node',
      mcpArgsText: '--inspect ./server.js --flag value',
      unreadOnly: true,
      maxEmailsPerPoll: 99,
    })

    expect(config.command).toBe('node')
    expect(config.args).toEqual(['--inspect', './server.js', '--flag', 'value'])
    expect(config.unreadOnly).toBe(true)
    expect(config.maxEmailsPerPoll).toBe(50)
  })

  it('falls back to the default MCP command when custom command is blank', () => {
    const config = buildEmailRuntimeConfig({
      ...baseInput,
      provider: 'custom-mcp',
      mcpCommand: '   ',
      mcpArgsText: '   ',
    })

    expect(config.command).toBe('uvx')
    expect(config.args).toEqual(['mcp-email-server==0.6.2', 'stdio'])
  })

  it('uses IMAP/SMTP for Gmail when app-password mode is selected', () => {
    const config = buildEmailRuntimeConfig({
      ...baseInput,
      provider: 'gmail-api',
      gmailAuthMode: 'app-password',
      oauthSignedIn: false,
    })

    expect(config.provider).toBe('imap-smtp')
  })

  it('uses Gmail API only when Gmail OAuth mode is selected and signed in', () => {
    const config = buildEmailRuntimeConfig({
      ...baseInput,
      provider: 'gmail-api',
      gmailAuthMode: 'google-oauth',
      oauthSignedIn: true,
    })

    expect(config.provider).toBe('gmail-api')
  })
})

describe('resolveEmailRuntimeProvider', () => {
  it('falls back to imap-smtp for gmail when oauth mode is not active', () => {
    expect(resolveEmailRuntimeProvider('gmail-api', 'app-password', false)).toBe('imap-smtp')
    expect(resolveEmailRuntimeProvider('gmail-api', 'google-oauth', false)).toBe('imap-smtp')
  })

  it('preserves gmail-api only for active oauth sessions', () => {
    expect(resolveEmailRuntimeProvider('gmail-api', 'google-oauth', true)).toBe('gmail-api')
  })
})
