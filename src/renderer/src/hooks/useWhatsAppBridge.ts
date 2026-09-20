/**
 * useWhatsAppBridge.ts — Subscribes to IPC push events from the main process
 * and syncs them into whatsappStore.
 *
 * Mount once at the top of the app (App.tsx). Components read from
 * useWhatsAppStore directly — they do NOT call IPC themselves.
 *
 * Per react-hooks.md: this hook encapsulates all IPC calls and side effects
 * so components remain testable without mocking Electron.
 */

import { useEffect, useCallback } from 'react'
import { useWhatsAppStore, WhatsAppConnectionState } from '../stores/whatsappStore'
import electron, { isElectron } from '../lib/electron'
import { useChatStore, type ChatSession } from '../stores/chatStore'
import { BrowserAgentdError, getBrowserAgentdClient, type BrowserWhatsAppInboundEvent, type BrowserWhatsAppInboundMedia } from '../lib/browser-agentd-client'
import { isTauriRuntime } from '../lib/tauri-native-bridge'
import type { ChatSession as AgentdChatSession } from '../../../shared/chat-protocol'

const isBrowserProduct = (): boolean => typeof window !== 'undefined' && !window.electron && !isTauriRuntime()

const stableWhatsAppSessionId = (conversationId: string): string => {
    // FNV-1a keeps a deterministic, bounded session id without exposing raw JIDs in ids.
    let hash = 2166136261
    for (let index = 0; index < conversationId.length; index += 1) hash = Math.imul(hash ^ conversationId.charCodeAt(index), 16777619)
    return `whatsapp_${(hash >>> 0).toString(16)}`
}

export interface BrowserWhatsAppMessage {
    id: string
    from: string
    content: string
    type: string
    timestamp: number
    isFromMe: boolean
    conversationId: string
    mediaUrl?: string
    mediaDataUrl?: string
    mediaName?: string
    mediaMimeType?: string
    mediaSize?: number
}

const readPayloadString = (payload: Record<string, unknown>, keys: string[]): string => {
    for (const key of keys) {
        const value = payload[key]
        if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
}

export const normalizeBrowserWhatsAppEvent = (event: BrowserWhatsAppInboundEvent): BrowserWhatsAppMessage | null => {
    const payload = event.payload
    const nested = payload.message && typeof payload.message === 'object' && !Array.isArray(payload.message)
        ? payload.message as Record<string, unknown>
        : null
    const read = (keys: string[]) => readPayloadString(payload, keys) || (nested ? readPayloadString(nested, keys) : '')
    const media = payload.media && typeof payload.media === 'object' && !Array.isArray(payload.media)
        ? payload.media as Record<string, unknown>
        : null
    const mediaType = media && typeof media.type === 'string' ? media.type : ''
    const content = read(['content', 'body', 'text', 'caption']) || (mediaType ? `[WhatsApp ${mediaType} attachment]` : '')
    if (!content) return null
    const timestampValue = payload.timestamp ?? payload.timestampMs ?? payload.createdAt
    const timestamp = typeof timestampValue === 'number' && Number.isFinite(timestampValue)
        ? (timestampValue < 2_000_000_000 ? timestampValue * 1000 : timestampValue)
        : typeof timestampValue === 'string' && Number.isFinite(Date.parse(timestampValue))
            ? Date.parse(timestampValue)
            : event.createdAt
    const conversationId = event.conversationId.trim()
    const from = read(['from', 'sender', 'fromNumber', 'fromJid', 'author']) || conversationId
    const isFromMeValue = payload.isFromMe ?? payload.fromMe ?? payload.outgoing ?? nested?.isFromMe
    return {
        id: read(['messageId', 'id']) || event.providerEventId,
        from,
        content,
        type: read(['type', 'messageType']) || 'text',
        timestamp,
        isFromMe: isFromMeValue === true,
        conversationId,
        ...(media && typeof media.fileName === 'string' ? { mediaName: media.fileName } : {}),
        ...(media && typeof media.mimeType === 'string' ? { mediaMimeType: media.mimeType } : {}),
        ...(media && Number.isSafeInteger(media.size) ? { mediaSize: media.size as number } : {}),
    }
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
            path: attachment.dataUrl || attachment.mediaUrl || '',
            type: attachment.type,
            size: attachment.size,
            ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
            ...(attachment.mediaUrl ? { mediaUrl: attachment.mediaUrl } : {}),
        })) } : {}),
    })),
})

const ingestBrowserWhatsAppEvent = async (event: BrowserWhatsAppInboundEvent): Promise<{ message: BrowserWhatsAppMessage | null; sessionId: string | null; alreadyHandled: boolean }> => {
    const message = normalizeBrowserWhatsAppEvent(event)
    if (!message || message.isFromMe) return { message: null, sessionId: null, alreadyHandled: true }
    const client = getBrowserAgentdClient()
    let media: BrowserWhatsAppInboundMedia | null = null
    if (message.mediaName && message.mediaMimeType && Number.isSafeInteger(message.mediaSize)) {
        try { media = await client.getWhatsAppInboundMedia(event.providerEventId) } catch { media = null }
    }
    const hydratedMessage = media ? {
        ...message,
        mediaUrl: media.mediaUrl,
        ...(media.dataUrl ? { mediaDataUrl: media.dataUrl } : {}),
        mediaName: media.fileName,
        mediaMimeType: media.mimeType,
        mediaSize: media.size,
    } : message
    const sessionId = stableWhatsAppSessionId(message.conversationId)
    const sessions = await client.loadSessions()
    const existing = sessions.find((session) => session.id === sessionId)
        || sessions.find((session) => session.channel === 'whatsapp' && session.contactId === message.conversationId)
    const resolvedSessionId = existing?.id || sessionId
    if (!existing) {
        await client.createSession(sessionId, `WhatsApp · ${message.from}`, undefined, {
            channel: 'whatsapp',
            contactId: message.conversationId,
            threadId: message.conversationId,
        })
    }
    try {
        await client.appendMessage(resolvedSessionId, {
            id: `whatsapp_${event.providerEventId}`,
            role: 'user',
            content: `📱 **WhatsApp** (${hydratedMessage.from}): ${hydratedMessage.content}`,
            timestamp: hydratedMessage.timestamp,
            ...(media ? { attachments: [{
                name: media.fileName,
                type: media.mimeType,
                size: media.size,
                mediaUrl: media.mediaUrl,
                ...(media.dataUrl ? { dataUrl: media.dataUrl } : {}),
            }] } : {}),
        })
    } catch (error) {
        if (!(error instanceof BrowserAgentdError) || error.status !== 409) throw error
    }
    const refreshed = await client.loadSessions()
    const activeSessionId = useChatStore.getState().activeSessionId
    useChatStore.setState({
        sessions: refreshed.map(toRendererSession),
        activeSessionId: activeSessionId && refreshed.some((session) => session.id === activeSessionId) ? activeSessionId : resolvedSessionId,
    })
    // A completed generation alone is not enough to advance the cursor: the
    // durable draft admission can still fail or be paused. The draft record is
    // the completion marker that makes a reload safe without losing review work.
    const durableDrafts = await client.listDrafts(100)
    return {
        message: hydratedMessage,
        sessionId: resolvedSessionId,
        alreadyHandled: durableDrafts.some((draft) => draft.providerEventId === event.providerEventId),
    }
}

export function useWhatsAppBridge(): void {
    const setConnectionState = useWhatsAppStore((s) => s.setConnectionState)
    const setWhatsAppEnabled = useWhatsAppStore((s) => s.setWhatsAppEnabled)
    const whatsappEnabled = useWhatsAppStore((s) => s.whatsappEnabled)
    const businessBotMode = useWhatsAppStore((s) => s.businessBotMode)

    // On mount: fetch initial state from main process
    useEffect(() => {
        if (!isElectron()) return
        let cancelled = false
        electron.whatsapp.getState().then((state) => {
            if (!cancelled) setConnectionState(state as WhatsAppConnectionState)
        }).catch(console.error)
        return () => { cancelled = true }
    }, [setConnectionState])

    // Browser mode owns the WhatsApp session in agentd. Poll the bounded
    // connection projection so the QR and handshake screens update without
    // exposing sockets, auth files, or provider credentials to the page.
    useEffect(() => {
        if (!isBrowserProduct()) return
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | null = null
        const poll = async () => {
            if (cancelled) return
            let delay = 10_000
            try {
                const state = await getBrowserAgentdClient().getWhatsAppConnectionState()
                if (!cancelled) {
                    setConnectionState(state as WhatsAppConnectionState)
                    if (state.status !== 'connected') setWhatsAppEnabled(false)
                    delay = ['connecting', 'qr_required', 'connected'].includes(state.status) ? 2_000 : 10_000
                }
            } catch (error) {
                if (!cancelled) console.warn('[WhatsAppBridge] Browser connection state unavailable', error)
            }
            if (!cancelled) timer = setTimeout(() => void poll(), delay)
        }
        void poll()
        return () => {
            cancelled = true
            if (timer) clearTimeout(timer)
        }
    }, [setConnectionState, setWhatsAppEnabled])

    // Browser mode consumes durable agentd events only when an explicit WhatsApp
    // mode is enabled. The Baileys worker owns the provider socket; this hook
    // only hydrates Lead Directory sessions through idempotent chat routes.
    useEffect(() => {
        // Browser ingress is gated by either explicit Response Permission or
        // the separately persisted Autonomous Bot Mode. Both paths use the
        // same durable event cursor; useAgent decides whether the resulting
        // response remains a draft or enters the approved outbox.
        if (!isBrowserProduct() || (!whatsappEnabled && !businessBotMode)) return
        let cancelled = false
        let timer: ReturnType<typeof setTimeout> | null = null
        let afterId = 0
        const poll = async () => {
            if (cancelled) return
            try {
                const result = await getBrowserAgentdClient().listWhatsAppInbound(afterId, 50)
                for (const event of result.events) {
                    if (cancelled) return
                    const hydrated = await ingestBrowserWhatsAppEvent(event)
                    if (hydrated.message && !hydrated.alreadyHandled) {
                        await new Promise<void>((resolve, reject) => {
                            let handedOff = false
                            const completion = (promise: Promise<void>) => {
                                handedOff = true
                                promise.then(resolve, reject)
                            }
                            window.dispatchEvent(new CustomEvent('app:submit-message', {
                                detail: {
                                    content: `📱 **WhatsApp** (${hydrated.message.from}): ${hydrated.message.content}`,
                                    whatsappMessage: hydrated.message,
                                    whatsappSessionId: hydrated.sessionId,
                                    whatsappAlreadyHydrated: true,
                                    whatsappGenerationRequestId: `whatsapp_${event.id}`,
                                    whatsappEvent: {
                                        providerEventId: event.providerEventId,
                                        conversationId: event.conversationId,
                                        payload: event.payload,
                                    },
                                    onComplete: completion,
                                },
                            }))
                            if (!handedOff) reject(new Error('Browser WhatsApp agent is unavailable'))
                        })
                    }
                }
                afterId = result.nextAfterId
            } catch (error) {
                if (!cancelled) console.warn('[WhatsAppBridge] Browser inbound event poll failed', error)
            }
            if (!cancelled) timer = setTimeout(() => void poll(), 30_000)
        }
        void poll()
        return () => {
            cancelled = true
            if (timer) clearTimeout(timer)
        }
    }, [businessBotMode, whatsappEnabled])

    // Subscribe to connection state push events from main
    useEffect(() => {
        if (!isElectron()) return
        const unsub = electron.whatsapp.onConnectionChange((state: WhatsAppConnectionState) => {
            setConnectionState(state)

            // Auto-disable WhatsApp mode when disconnected/error
            if (state.status !== 'connected') {
                useWhatsAppStore.getState().setWhatsAppEnabled(false)
            }
        })
        return unsub
    }, [setConnectionState])

    // Subscribe to incoming WhatsApp messages — add them to active chat session
    const handleMessage = useCallback(async (message: {
        id: string
        from: string
        content: string
        type: string
        mediaUrl?: string
        caption?: string
        timestamp: number
        isFromMe: boolean
    }) => {
        // Skip messages from self to avoid loops
        if (message.isFromMe) return

        // The main-process supervisor owns autonomous conversations. Do not
        // also submit the same event to the legacy renderer agent.
        try {
            const autonomy = await electron.autonomy.getState()
            if (autonomy?.status === 'running' || autonomy?.status === 'degraded') return
        } catch (error) {
            console.warn('[WhatsAppBridge] Could not read autonomy state; keeping manual path available', error)
        }

        const { whatsappEnabled, businessBotMode } = useWhatsAppStore.getState()

        // Process if either manual chat mode or global business bot mode is on
        if (!whatsappEnabled && !businessBotMode) return

        // Trigger the AI agent execution pipeline via generic window event
        window.dispatchEvent(new CustomEvent('app:submit-message', {
            detail: { 
                content: `📱 **WhatsApp** (${message.from}): ${message.content}`,
                whatsappMessage: message 
            }
        }))
    }, [])

    useEffect(() => {
        if (!isElectron()) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unsub = electron.whatsapp.onMessage(handleMessage as any)
        return unsub
    }, [handleMessage])

    // Subscribe to frustration/loop escalation events
    useEffect(() => {
        if (!isElectron()) return
        const unsub = electron.whatsapp.onEscalation?.((data: any) => {
            console.warn(`[WhatsAppBridge] ESCALATION: ${data.reason} for ${data.jid}`);
            window.dispatchEvent(new CustomEvent('app:escalation', { detail: data }));
            
            // Also add a system message to the chat if possible
            window.dispatchEvent(new CustomEvent('app:submit-message', {
                detail: { 
                    content: `⚠️ **Escalation Triggered**: ${data.reason === 'frustration_detected' ? 'Customer frustration detected' : 'Loop detected'}. Manual intervention recommended.`,
                    system: true
                }
            }));
        });
        return unsub;
    }, [])
}
