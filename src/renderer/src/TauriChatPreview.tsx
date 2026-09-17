import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useTauriChat } from './hooks/useTauriChat'
import { useChatStore } from './stores/chatStore'
import type { ChatSession } from '../../shared/chat-protocol'

/** Small native-shell chat surface. The full Electron app remains on its own mount. */
export default function TauriChatPreview() {
  const { health, submit, cancel, loadSessions, fakePreviewEnabled } = useTauriChat()
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const sessions = useChatStore((state) => state.sessions)
  const createSession = useChatStore((state) => state.createSession)
  const setActiveSession = useChatStore((state) => state.setActiveSession)
  const processing = useChatStore((state) => activeSessionId ? state.isSessionProcessing(activeSessionId) : false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [daemonSessions, setDaemonSessions] = useState<ChatSession[]>([])

  useEffect(() => {
    if (fakePreviewEnabled && !activeSessionId) createSession()
  }, [activeSessionId, createSession, fakePreviewEnabled])

  const syncDaemonSessions = useCallback(async (preferredSessionId?: string) => {
    const next = await loadSessions()
    setDaemonSessions(next)
    // The shared store powers the existing composer/processing actions. Hydrate
    // it only with daemon sessions so this shell can use the real generation
    // route without mounting Electron-bound App.tsx.
    useChatStore.setState((state) => {
      const active = preferredSessionId && next.some((item) => item.id === preferredSessionId)
        ? preferredSessionId
        : state.activeSessionId && next.some((item) => item.id === state.activeSessionId)
        ? state.activeSessionId
        : next[0]?.id ?? null
      return {
        sessions: next.map((item) => ({
          id: item.id,
          title: item.title,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          messages: item.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            timestamp: message.timestamp,
          })),
          status: item.status === 'resolved' ? 'resolved' : 'active',
        })),
        activeSessionId: active,
      }
    })
  }, [loadSessions])

  useEffect(() => {
    if (fakePreviewEnabled || health.status !== 'ready') return
    let disposed = false
    void syncDaemonSessions().catch((reason) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : 'Could not load daemon chat sessions')
    })
    return () => { disposed = true }
  }, [fakePreviewEnabled, health.status, syncDaemonSessions])

  const session = useMemo(() => sessions.find((item) => item.id === activeSessionId), [sessions, activeSessionId])
  const enabled = health.status === 'ready'

  const createDaemonSession = async () => {
    setError(null)
    try {
      const created = await invoke<{ id?: unknown }>('chat_create_session', { title: 'New Chat' })
      await syncDaemonSessions(typeof created?.id === 'string' ? created.id : undefined)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create chat session')
    }
  }

  const send = async () => {
    if (!activeSessionId || !draft.trim()) return
    const content = draft
    setError(null)
    try {
      setDraft('')
      await submit(activeSessionId, content)
    } catch (reason) {
      setDraft(content)
      setError(reason instanceof Error ? reason.message : 'Chat preview failed')
    }
  }

  return (
    <article className="pilot-panel pilot-chat-preview" aria-label="Tauri chat preview">
      <div className="pilot-panel-heading">
        <div>
          <p className="pilot-label">06 / product seam</p>
          <h2>{enabled ? (fakePreviewEnabled ? 'Tauri chat preview' : 'Tauri chat') : 'Tauri chat availability'}</h2>
        </div>
        <span className="pilot-index">{enabled ? (fakePreviewEnabled ? 'FAKE · DEV ONLY' : 'AGENTD') : 'DAEMON REQUIRED'}</span>
      </div>
      <p className="pilot-copy">
        {fakePreviewEnabled ? 'This deterministic preview proves session isolation and cancellation. It never calls a provider.' : enabled ? 'Chat runs through the local agentd service while the native shell stays lightweight.' : health.error || 'Start agentd to use local chat generation.'}
      </p>
      {enabled && (
        <>
          {!fakePreviewEnabled && <div className="pilot-chat-sessions" role="list" aria-label="Chat sessions">
            {daemonSessions.map((item) => <button type="button" role="listitem" className={`pilot-button ${item.id === activeSessionId ? 'pilot-button-primary' : ''}`} key={item.id} onClick={() => setActiveSession(item.id)}>{item.title}</button>)}
            <button type="button" className="pilot-button" onClick={() => void createDaemonSession()}>New chat</button>
          </div>}
          <div className="pilot-chat-transcript" role="log" aria-live="polite">
            {(session?.messages || []).slice(-6).map((message) => <p key={message.id}><strong>{message.role}:</strong> {message.content}</p>)}
          </div>
          <div className="pilot-form-row">
            <label htmlFor="tauri-chat-preview-input">Message</label>
            <input id="tauri-chat-preview-input" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} disabled={processing || !activeSessionId} placeholder={fakePreviewEnabled ? 'Try the isolated fake chat' : 'Ask your local model'} />
          </div>
          <div className="pilot-actions pilot-actions-tight">
            <button type="button" className="pilot-button pilot-button-primary" onClick={() => void send()} disabled={processing || !activeSessionId || !draft.trim()}>{fakePreviewEnabled ? 'Send preview' : 'Send message'}</button>
            <button type="button" className="pilot-button" onClick={() => activeSessionId && cancel(activeSessionId)} disabled={!processing}>Cancel</button>
          </div>
        </>
      )}
      {error && <p className="pilot-copy" role="alert">{error}</p>}
    </article>
  )
}
