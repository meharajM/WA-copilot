import { useEffect } from 'react'
import electron, { isElectron } from '../lib/electron'
import { flushEmailSettingsPersistence, useEmailStore } from '../stores/emailStore'
import { useChatStore, type ChatSession } from '../stores/chatStore'
import { buildEmailRuntimeConfig } from '../lib/email-runtime'
import { generateEmailSessionKey, generateEmailSessionTitle, convertEmailToLLMMessage, normalizeEmailAddress, type EmailMessage } from '../lib/email-integration'
import { BrowserAgentdError, getBrowserAgentdClient, type BrowserEmailInboundEvent } from '../lib/browser-agentd-client'
import { isTauriRuntime } from '../lib/tauri-native-bridge'
import type { ChatSession as AgentdChatSession } from '../../../shared/chat-protocol'

interface EmailConnectionState {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  error: string | null
  lastSyncAt: number | null
  unreadCount: number
}

export function dispatchInboundEmailToAgent(email: EmailMessage): boolean {
  const { config } = useEmailStore.getState()

  if (!config.autoReplyMode) {
    console.log('[useEmailBridge] Ignoring inbound message (autoReplyMode is off)')
    return false
  }

  window.dispatchEvent(new CustomEvent('app:submit-message', {
    detail: {
      content: `📧 **Email** (${email.from}): ${email.subject}\n\n${email.body || ''}`,
      emailMessage: email
    }
  }))
  return true
}

const isBrowserProduct = (): boolean => typeof window !== 'undefined' && !window.electron && !isTauriRuntime()

const stableEmailSessionId = (key: string): string => {
  // FNV-1a keeps deterministic thread IDs within agentd's bounded ID grammar.
  let hash = 2166136261
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16777619)
  return `email_${(hash >>> 0).toString(16)}`
}

const bytesToDataUrl = (bytes: Uint8Array, mimeType: string): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
  }
  return `data:${mimeType};base64,${btoa(binary)}`
}

const toRendererSession = (session: AgentdChatSession): ChatSession => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  status: session.status,
  ...(session.channel ? { channel: session.channel as ChatSession['channel'] } : {}),
  ...(session.contactId ? { contact_id: session.contactId } : {}),
  ...(session.threadId ? { thread_id: session.threadId } : {}),
  ...(session.workspacePath ? { workspacePath: session.workspacePath } : {}),
  ...(session.topic ? { topic: session.topic } : {}),
  messages: session.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    ...(message.attachments?.length ? { attachments: message.attachments.map((attachment) => ({
      name: attachment.name,
      path: attachment.dataUrl || '',
      type: attachment.type,
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
    })) } : {}),
  })),
})

const ingestBrowserInboundEmail = async (event: BrowserEmailInboundEvent): Promise<{ email: EmailMessage; content: string; alreadyHandled: boolean }> => {
  const payload = event.payload
  const client = getBrowserAgentdClient()
  const attachments = await Promise.all((payload.attachments || []).map(async (attachment) => {
    const metadata = {
      filename: attachment.name || attachment.id,
      contentType: attachment.mimeType || 'application/octet-stream',
      size: attachment.size || 0,
    }
    // Small scanned images can enter generation for both transports. Gmail
    // uses its provider attachment API; IMAP uses the daemon's private media
    // route keyed by the durable provider event. Larger/unsupported files
    // remain metadata-only and are still available to operators.
    if (metadata.contentType.startsWith('image/') && metadata.size > 0 && metadata.size <= 256 * 1024) {
      try {
        if (payload.sourceId) {
          const result = await client.retrieveGmailAttachment(payload.sourceId, attachment.id, { mimeType: metadata.contentType, name: metadata.filename })
          if (result.scan.safe && result.bytes && result.bytes.length === metadata.size) {
            return { ...metadata, dataUrl: bytesToDataUrl(result.bytes, metadata.contentType) }
          }
        } else {
          const result = await client.getEmailInboundAttachment(event.providerEventId, attachment.id)
          if (result.mimeType === metadata.contentType && result.bytes.length === metadata.size) {
            return { ...metadata, dataUrl: bytesToDataUrl(result.bytes, metadata.contentType) }
          }
        }
      } catch { /* metadata-only fallback */ }
    }
    return metadata
  }))
  const email: EmailMessage = {
    id: event.providerEventId,
    from: payload.from,
    to: payload.to,
    subject: payload.subject,
    body: payload.body,
    bodyType: payload.bodyType,
    timestamp: payload.timestamp,
    isFromMe: payload.isFromMe === true,
    ...(payload.messageId ? { messageId: payload.messageId } : {}),
    ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
    ...(payload.references ? { references: payload.references } : {}),
    ...(attachments.length ? { attachments } : {}),
  }
  const sessionKey = generateEmailSessionKey(email)
  let sessionId = stableEmailSessionId(sessionKey.key)
  const sessions = await client.loadSessions()
  const session = sessions.find((candidate) => candidate.id === sessionId)
    || sessions.find((candidate) => candidate.channel === 'email' && candidate.contactId === sessionKey.sender && candidate.threadId === sessionKey.threadId)
  if (!session) {
    await client.createSession(sessionId, generateEmailSessionTitle(email), undefined, { channel: 'email', contactId: sessionKey.sender, threadId: sessionKey.threadId })
  } else {
    sessionId = session.id
  }
  const llmMessage = convertEmailToLLMMessage(email)
  const content = typeof llmMessage.content === 'string'
    ? llmMessage.content
    : llmMessage.content.map((part) => 'text' in part ? part.text : '[Attachment]').join('\n')
  try {
    await client.appendMessage(sessionId, {
      id: `email_${event.id}`,
      role: 'user',
      content,
      timestamp: email.timestamp,
      ...(email.attachments?.length ? {
        attachments: email.attachments.map((attachment) => ({
          name: attachment.filename,
          type: attachment.contentType,
          size: attachment.size,
          ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
        })),
      } : {}),
    })
  } catch (error) {
    if (!(error instanceof BrowserAgentdError) || error.status !== 409) throw error
  }
  const refreshed = await client.loadSessions()
  const activeSessionId = useChatStore.getState().activeSessionId
  useChatStore.setState({
    sessions: refreshed.map(toRendererSession),
    activeSessionId: activeSessionId && refreshed.some((candidate) => candidate.id === activeSessionId) ? activeSessionId : sessionId,
  })
  // A completed generation alone is not enough to acknowledge the event: the
  // confidence policy may still need to persist a draft or send it. The
  // deterministic browser draft id is the durable completion marker for both
  // review and delivery paths.
  const durableDrafts = await client.listEmailDrafts()
  return { email, content, alreadyHandled: durableDrafts.some((draft) => draft.id === `draft_email_${event.id}`) }
}

export function useEmailBridge(): void {
  const config = useEmailStore((s) => s.config)
  const setConnectionState = useEmailStore((s) => s.setConnectionState)

  useEffect(() => {
    if (!isElectron()) return
    let cancelled = false
    electron.email.getState().then((state) => {
      if (!cancelled) {
        setConnectionState(state as EmailConnectionState)
      }
    }).catch(console.error)
    return () => { cancelled = true }
  }, [setConnectionState])

  useEffect(() => {
    if (!isBrowserProduct()) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = async () => {
      if (cancelled) return
      // Enable/Auto-Reply toggles persist through an async agentd queue. Do
      // not report connected or claim events until that mutation is durable.
      await flushEmailSettingsPersistence()
      if (cancelled) return
      if (!config.enabled) {
        setConnectionState({ status: 'disconnected', error: null, lastSyncAt: null, unreadCount: 0 })
      } else {
        try {
          const client = getBrowserAgentdClient()
          let processed = 0
          if (config.autoReplyMode) {
            const events = await client.claimEmailInbound(50)
            for (const event of events) {
              const hydrated = await ingestBrowserInboundEmail(event)
              if (!hydrated.alreadyHandled) {
                // The product hook owns generation/policy execution. It reports
                // completion back through the event detail so the daemon event is
                // acknowledged only after the response is durably handled.
                await new Promise<void>((resolve, reject) => {
                  let handedOff = false
                  const completion = (promise: Promise<void>) => {
                    handedOff = true
                    promise.then(resolve, reject)
                  }
                  window.dispatchEvent(new CustomEvent('app:submit-message', {
                    detail: {
                      content: hydrated.content,
                      emailMessage: hydrated.email,
                      emailAlreadyHydrated: true,
                      emailGenerationRequestId: `email_${event.id}`,
                      emailDraftId: `draft_email_${event.id}`,
                      onComplete: completion,
                    },
                  }))
                  if (!handedOff) reject(new Error('Browser email agent is unavailable'))
                })
              }
              // Acknowledge only after durable session/message hydration. If the
              // generation or draft/send policy fails, daemon keeps event queued
              // for retry after reload.
              await client.acknowledgeEmailInbound([event.id])
              processed += 1
            }
          }
          if (!cancelled) setConnectionState({ status: 'connected', error: config.autoReplyMode ? null : 'Inbound events are stored; enable Auto-Reply to create email sessions.', lastSyncAt: Date.now(), unreadCount: processed })
        } catch (error) {
          if (!cancelled) setConnectionState({ status: 'error', error: error instanceof Error ? error.message : 'Browser email inbox unavailable', lastSyncAt: null, unreadCount: 0 })
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), Math.max(30_000, config.pollingIntervalSeconds * 1000))
    }
    void poll()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [config.enabled, config.autoReplyMode, config.pollingIntervalSeconds, setConnectionState])

  useEffect(() => {
    if (!isElectron()) return
    const unsubConnection = electron.email.onConnectionChange((state) => {
      setConnectionState(state as EmailConnectionState)
    })

    const unsubMessage = electron.email.onMessage((payload) => {
      const email = payload as EmailMessage
      electron.autonomy.getState().then((autonomy) => {
        if (autonomy?.status === 'running' || autonomy?.status === 'degraded') return
        dispatchInboundEmailToAgent(email)
      }).catch((error) => console.warn('[useEmailBridge] Could not read autonomy state; legacy email path skipped', error))
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
      if (!isElectron()) return
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
      const wantsGmailOAuth = config.provider === 'gmail-api' && config.gmailAuthMode === 'google-oauth'
      const usingGmailOAuth = wantsGmailOAuth && oauthStatus.signedIn
      const configuredAddress = normalizeEmailAddress(config.emailAddress || '')
      const oauthAddress = normalizeEmailAddress(oauthStatus.email || '')
      const effectiveAddress = usingGmailOAuth ? (oauthAddress || configuredAddress) : configuredAddress

      if (wantsGmailOAuth && !oauthStatus.signedIn) {
        setConnectionState({
          status: 'error',
          error: oauthStatus.requiresReauthentication
            ? 'Gmail authorization expired or was revoked. Sign in with Google again.'
            : 'Gmail is set to Google sign-in, but the Google account is not connected.',
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
      const runtimeConfig = buildEmailRuntimeConfig({
        provider: config.provider,
        gmailAuthMode: config.gmailAuthMode,
        oauthSignedIn: oauthStatus.signedIn,
        emailAddress: address,
        userName: config.userName || address,
        accountName: config.accountName || 'default',
        imapHost: config.imapHost,
        imapPort: config.imapPort,
        smtpHost: config.smtpHost,
        smtpPort: config.smtpPort,
        imapTls: config.imapTls,
        smtpTls: config.smtpTls,
        pollingIntervalSeconds: config.pollingIntervalSeconds,
        password,
        unreadOnly: false,
        maxEmailsPerPoll: 10,
      })

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
    config.gmailAuthMode,
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
