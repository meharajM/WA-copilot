import type { EmailProvider, GmailAuthMode } from '../stores/emailStore'

export interface EmailRuntimeConfig {
  provider: EmailProvider
  command: string
  args: string[]
  pollingIntervalSeconds: number
  accountName: string
  unreadOnly: boolean
  maxEmailsPerPoll: number
  env: Record<string, string>
}

export interface EmailRuntimeInput {
  provider: EmailProvider
  gmailAuthMode?: GmailAuthMode
  oauthSignedIn?: boolean
  emailAddress: string
  userName: string
  accountName: string
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
  imapTls: boolean
  smtpTls: boolean
  pollingIntervalSeconds: number
  password: string
  mcpCommand?: string
  mcpArgsText?: string
  unreadOnly?: boolean
  maxEmailsPerPoll?: number
}

const DEFAULT_MCP_COMMAND = 'uvx'
const DEFAULT_MCP_ARGS = ['mcp-email-server==0.6.2', 'stdio']

export function resolveEmailRuntimeProvider(
  provider: EmailProvider,
  gmailAuthMode: GmailAuthMode = 'app-password',
  oauthSignedIn = false
): EmailProvider {
  if (provider !== 'gmail-api') return provider
  if (gmailAuthMode === 'google-oauth' && oauthSignedIn) return 'gmail-api'
  return 'imap-smtp'
}

export function parseMcpArgs(argsText: string): string[] {
  return argsText
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0)
}

export function buildEmailRuntimeConfig(input: EmailRuntimeInput): EmailRuntimeConfig {
  const provider = resolveEmailRuntimeProvider(
    input.provider,
    input.gmailAuthMode,
    input.oauthSignedIn === true
  )
  const command = provider === 'custom-mcp'
    ? input.mcpCommand?.trim() || DEFAULT_MCP_COMMAND
    : DEFAULT_MCP_COMMAND
  const parsedArgs = provider === 'custom-mcp'
    ? parseMcpArgs(input.mcpArgsText || '')
    : DEFAULT_MCP_ARGS
  const args = parsedArgs.length > 0 ? parsedArgs : DEFAULT_MCP_ARGS
  const accountName = input.accountName || 'default'

  return {
    provider,
    command,
    args,
    pollingIntervalSeconds: Math.max(30, input.pollingIntervalSeconds || 60),
    accountName,
    unreadOnly: input.unreadOnly ?? false,
    maxEmailsPerPoll: Math.max(1, Math.min(input.maxEmailsPerPoll || 10, 50)),
    env: {
      MCP_EMAIL_SERVER_ACCOUNT_NAME: accountName,
      MCP_EMAIL_SERVER_FULL_NAME: input.emailAddress.split('@')[0] || 'support',
      MCP_EMAIL_SERVER_EMAIL_ADDRESS: input.emailAddress,
      MCP_EMAIL_SERVER_USER_NAME: input.userName || input.emailAddress,
      MCP_EMAIL_SERVER_PASSWORD: input.password,
      MCP_EMAIL_SERVER_IMAP_HOST: input.imapHost,
      MCP_EMAIL_SERVER_IMAP_PORT: String(input.imapPort),
      MCP_EMAIL_SERVER_IMAP_SSL: String(input.imapTls),
      MCP_EMAIL_SERVER_SMTP_HOST: input.smtpHost,
      MCP_EMAIL_SERVER_SMTP_PORT: String(input.smtpPort),
      MCP_EMAIL_SERVER_SMTP_START_SSL: input.smtpTls ? 'true' : 'false',
      MCP_EMAIL_SERVER_SMTP_SSL: input.smtpPort === 465 ? 'true' : 'false',
      MCP_EMAIL_SERVER_ENABLE_ATTACHMENT_DOWNLOAD: 'false',
      MCP_EMAIL_SERVER_SAVE_TO_SENT: 'true',
    },
  }
}
