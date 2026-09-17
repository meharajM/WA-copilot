import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChatClient, ChatHealth } from '../../../shared/chat-protocol'
import { createFakeChatClient, isChatAbortError } from '../lib/fake-chat-client'
import { createTauriChatClient } from '../lib/tauri-chat-client'
import { useChatStore } from '../stores/chatStore'

const fakePreviewEnabled = import.meta.env.VITE_TAURI_CHAT_FAKE === 'true'

function requestId(): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  return uuid ? `tauri-${uuid}` : `tauri-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/**
 * Session-scoped Tauri chat seam. Production uses the local daemon generation
 * route; setting VITE_TAURI_CHAT_FAKE=true enables the deterministic preview.
 */
export function useTauriChat(client?: ChatClient) {
  const chatClient = useMemo(() => client ?? (fakePreviewEnabled ? createFakeChatClient(true) : createTauriChatClient()), [client])
  const [health, setHealth] = useState<ChatHealth>({ status: 'unavailable', mode: fakePreviewEnabled ? 'fake' : 'daemon', error: 'Checking Tauri chat…' })

  useEffect(() => {
    let disposed = false
    void chatClient.health().then((next) => {
      if (!disposed) setHealth(next)
    }).catch(() => {
      if (!disposed) setHealth({ status: 'unavailable', mode: fakePreviewEnabled ? 'fake' : 'daemon', error: 'Tauri chat is unavailable' })
    })
    return () => { disposed = true }
  }, [chatClient])

  const submit = useCallback(async (sessionId: string, content: string): Promise<void> => {
    const trimmed = content.trim()
    if (!sessionId || !trimmed) throw new Error('Choose a session and enter a message')
    const id = requestId()
    const store = useChatStore.getState()
    const signal = store.startProcessing(sessionId)
    // Keep the optimistic renderer message ID equal to the durable agentd request ID.
    // Otherwise the persistence adapter can replay the same user prompt under a second
    // generated ID while append+generate is already in flight.
    const user = store.addSessionMessage(sessionId, { id, role: 'user', content: trimmed })
    let assistantId: string | null = null
    let lastSequence = 0
    try {
      await chatClient.appendMessage(sessionId, {
        // The daemon's generation endpoint uses requestId as the durable user
        // message id. Reuse it here so append+generate is idempotent and does
        // not persist the same user prompt twice.
        id,
        role: user.role,
        content: user.content,
        timestamp: user.timestamp,
      })
      await chatClient.generate({ sessionId, requestId: id, content: trimmed }, (event) => {
        if (event.sessionId !== sessionId || event.requestId !== id || event.sequence <= lastSequence) return
        lastSequence = event.sequence
        if (event.type === 'assistant.delta') {
          if (!assistantId) {
            assistantId = store.addSessionMessage(sessionId, { role: 'assistant', content: event.delta }).id
          } else {
            const current = useChatStore.getState().getActiveSession()
            const existing = useChatStore.getState().sessions.find((session) => session.id === sessionId)?.messages.find((message) => message.id === assistantId)
            if (existing) useChatStore.getState().updateSessionMessage(sessionId, assistantId, { content: `${existing.content}${event.delta}` })
            else if (current?.id === sessionId) useChatStore.getState().updateSessionMessage(sessionId, assistantId, { content: event.delta })
          }
        }
      }, signal)
    } catch (reason) {
      if (!isChatAbortError(reason)) throw reason
    } finally {
      store.stopProcessing(sessionId)
    }
  }, [chatClient])

  const cancel = useCallback((sessionId: string) => {
    useChatStore.getState().abortSession(sessionId)
  }, [])

  const loadSessions = useCallback(() => chatClient.loadSessions(), [chatClient])

  return { health, submit, cancel, loadSessions, fakePreviewEnabled }
}
