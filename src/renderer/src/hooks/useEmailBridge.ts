import { useEffect } from 'react'
import electron from '../lib/electron'
import { useEmailStore } from '../stores/emailStore'
import { normalizeEmailAddress, type EmailMessage } from '../lib/email-integration'

interface EmailConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error: string | null
  lastSyncAt: number | null
  unreadCount: number
}

export function useEmailBridge(): void {
  const config = useEmailStore((s) => s.config)
  const setConnectionState = useEmailStore((s) => s.setConnectionState)

  useEffect(() => {
    let cancelled = false
    electron.email.getState().then((state) => {
      if (!cancelled) {
        setConnectionState(state as EmailConnectionState)
      }
    }).catch(console.error)
    return () => { cancelled = true }
  }, [setConnectionState])

  useEffect(() => {
    const unsubConnection = electron.email.onConnectionChange((state) => {
      setConnectionState(state as EmailConnectionState)
    })

    const unsubMessage = electron.email.onMessage((payload) => {
      const email = payload as EmailMessage
      const { config } = useEmailStore.getState()

      if (!config.autoReplyMode) {
        console.log('[useEmailBridge] Ignoring inbound message (autoReplyMode is off)')
        return;
      }

      window.dispatchEvent(new CustomEvent('app:submit-message', {
        detail: {
          content: `📧 **Email** (${email.from}): ${email.subject}\n\n${email.body || ''}`,
          emailMessage: email
        }
      }))
    })

    const unsubDelivery = electron.email.onDeliveryStatus((status) => {
      const s = status as { status?: string; subject?: string; error?: string }
      const text = s.status === 'sent'
        ? `Email delivered: ${s.subject || '(No subject)'}`
        : `Email delivery failed: ${s.subject || '(No subject)'}${s.error ? ` — ${s.error}` : ''}`
      window.dispatchEvent(new CustomEvent('app:submit-message', {
        detail: {
          content: `📨 ${text}`,
          system: true
        }
      }))
    })

    return () => {
      unsubConnection()
      unsubMessage()
      unsubDelivery()
    }
  }, [setConnectionState])

  useEffect(() => {
    const run = async () => {
      console.log('[EmailBridge] run', {
        enabled: config.enabled,
        provider: config.provider,
        emailAddress: config.emailAddress,
        accountName: config.accountName
      })
      if (!config.enabled) {
        await electron.email.stop()
        return
      }

      const oauthStatus = await electron.emailOAuth.getStatus()
      const usingGmailOAuth = config.provider === 'gmail-api' && oauthStatus.signedIn
      const configuredAddress = normalizeEmailAddress(config.emailAddress || '')
      const oauthAddress = normalizeEmailAddress(oauthStatus.email || '')
      const effectiveAddress = usingGmailOAuth ? (oauthAddress || configuredAddress) : configuredAddress

      if (config.provider === 'gmail-api' && !oauthStatus.signedIn) {
        setConnectionState({
          status: 'error',
          error: 'Gmail provider requires Google OAuth sign-in',
          lastSyncAt: null,
          unreadCount: 0
        })
        return
      }

      if (!effectiveAddress) {
        setConnectionState({
          status: 'error',
          error: 'Email channel enabled but required settings are missing',
          lastSyncAt: null,
          unreadCount: 0
        })
        return
      }

      if (!usingGmailOAuth && (!config.imapHost || !config.smtpHost)) {
        setConnectionState({
          status: 'error',
          error: 'Email channel enabled but required settings are missing',
          lastSyncAt: null,
          unreadCount: 0
        })
        return
      }

      const passwordResult = await electron.secure.get('email_mcp_password')
      const password = passwordResult.value || ''
      if (!password && !usingGmailOAuth) {
        setConnectionState({
          status: 'error',
          error: 'Email password/app token missing in secure storage',
          lastSyncAt: null,
          unreadCount: 0
        })
        return
      }

      const address = effectiveAddress
      const runtimeConfig = {
        provider: config.provider,
        command: 'uvx',
        args: ['mcp-email-server==0.6.2', 'stdio'],
        pollingIntervalSeconds: config.pollingIntervalSeconds,
        accountName: config.accountName || 'default',
        unreadOnly: false,
        maxEmailsPerPoll: 10,
        env: {
          MCP_EMAIL_SERVER_ACCOUNT_NAME: config.accountName || 'default',
          MCP_EMAIL_SERVER_FULL_NAME: address.split('@')[0] || 'support',
          MCP_EMAIL_SERVER_EMAIL_ADDRESS: address,
          MCP_EMAIL_SERVER_USER_NAME: config.userName || address,
          MCP_EMAIL_SERVER_PASSWORD: password,
          MCP_EMAIL_SERVER_IMAP_HOST: config.imapHost,
          MCP_EMAIL_SERVER_IMAP_PORT: String(config.imapPort),
          MCP_EMAIL_SERVER_IMAP_SSL: String(config.imapTls),
          MCP_EMAIL_SERVER_SMTP_HOST: config.smtpHost,
          MCP_EMAIL_SERVER_SMTP_PORT: String(config.smtpPort),
          MCP_EMAIL_SERVER_SMTP_START_SSL: config.smtpTls ? 'true' : 'false',
          MCP_EMAIL_SERVER_SMTP_SSL: config.smtpPort === 465 ? 'true' : 'false',
          MCP_EMAIL_SERVER_ENABLE_ATTACHMENT_DOWNLOAD: 'false',
          MCP_EMAIL_SERVER_SAVE_TO_SENT: 'true',
        }
      }

      const configured = await electron.email.configure(runtimeConfig) as { success?: boolean; error?: string }
      if (configured && configured.success === false) {
        throw new Error(configured.error || 'Failed to configure email channel')
      }

      const started = await electron.email.start() as { success?: boolean; error?: string }
      if (started && started.success === false) {
        throw new Error(started.error || 'Failed to start email channel')
      }

      const state = await electron.email.getState()
      console.log('[EmailBridge] start state', state)
      if (state.status !== 'connected') {
        throw new Error(state.error || `Email channel state is ${state.status}`)
      }
    }

    run().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      setConnectionState({
        status: 'error',
        error: message,
        lastSyncAt: null,
        unreadCount: 0
      })
    })
  }, [
    config.enabled,
    config.provider,
    config.emailAddress,
    config.userName,
    config.accountName,
    config.imapHost,
    config.imapPort,
    config.smtpHost,
    config.smtpPort,
    config.imapTls,
    config.smtpTls,
    config.pollingIntervalSeconds,
    setConnectionState
  ])

}
