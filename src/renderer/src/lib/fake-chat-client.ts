import type {
  ChatClient,
  ChatGenerationEvent,
  ChatGenerationRequest,
  ChatHealth,
  ChatMessage,
  ChatSessionMetadata,
  ChatSession,
} from '../../../shared/chat-protocol'

const MAX_CONTENT_LENGTH = 32_000

const abortError = (): DOMException => new DOMException('Chat generation canceled', 'AbortError')

/**
 * Deterministic, explicitly opt-in chat client used to prove Tauri session
 * isolation before the daemon-backed generation route is shipped. It never
 * calls a provider and keeps state in memory only.
 */
export function createFakeChatClient(enabled = false): ChatClient {
  const sessions = new Map<string, ChatSession>()

  const health = async (): Promise<ChatHealth> => enabled
    ? { status: 'ready', mode: 'fake' }
    : { status: 'unavailable', mode: 'fake', error: 'Tauri chat preview is disabled' }

  const loadSessions = async (): Promise<ChatSession[]> => [...sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => ({ ...session, messages: session.messages.map((message) => ({ ...message })) }))

  const createSession = async (sessionId: string, title: string, workspacePath?: string, _metadata?: ChatSessionMetadata): Promise<void> => {
    if (!enabled) throw new Error('Tauri chat preview is disabled')
    if (!sessionId || !title) throw new Error('Chat session is invalid')
    if (sessions.has(sessionId)) return
    const now = Date.now()
    sessions.set(sessionId, { id: sessionId, title, createdAt: now, updatedAt: now, status: 'active', messages: [], ...(workspacePath ? { workspacePath } : {}) })
  }

  const updateSessionWorkspace = async (sessionId: string, workspacePath: string | null): Promise<void> => {
    if (!enabled) throw new Error('Tauri chat preview is disabled')
    const session = sessions.get(sessionId)
    if (!session) throw new Error('Chat session not found')
    if (workspacePath) session.workspacePath = workspacePath
    else delete session.workspacePath
    session.updatedAt = Date.now()
  }

  const deleteSession = async (sessionId: string): Promise<void> => {
    if (!enabled) throw new Error('Tauri chat preview is disabled')
    sessions.delete(sessionId)
  }

  const appendMessage = async (sessionId: string, message: ChatMessage): Promise<void> => {
    if (!enabled) throw new Error('Tauri chat preview is disabled')
    if (!sessionId || message.content.length > MAX_CONTENT_LENGTH) throw new Error('Chat message is invalid')
    const existing = sessions.get(sessionId)
    if (!existing) {
      const now = Date.now()
      sessions.set(sessionId, {
        id: sessionId,
        title: message.role === 'user' ? message.content.slice(0, 64) || 'New Chat' : 'New Chat',
        createdAt: now,
        updatedAt: now,
        status: 'active',
        messages: [{ ...message }],
      })
      return
    }
    if (existing.messages.some((item) => item.id === message.id)) return
    existing.messages.push({ ...message })
    existing.updatedAt = Math.max(existing.updatedAt, message.timestamp)
  }

  const generate = async (
    request: ChatGenerationRequest,
    onEvent: (event: ChatGenerationEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (!enabled) throw new Error('Tauri chat preview is disabled')
    if (!request.sessionId || !request.requestId || !request.content || request.content.length > MAX_CONTENT_LENGTH) {
      throw new Error('Chat generation request is invalid')
    }
    const response = `Fake response: ${request.content}`
    const parts = [response.slice(0, Math.ceil(response.length / 3)), response.slice(Math.ceil(response.length / 3), Math.ceil(response.length * 2 / 3)), response.slice(Math.ceil(response.length * 2 / 3))].filter(Boolean)
    let emitted = ''
    for (const [index, delta] of parts.entries()) {
      if (signal?.aborted) throw abortError()
      await Promise.resolve()
      if (signal?.aborted) throw abortError()
      emitted += delta
      onEvent({ type: 'assistant.delta', sessionId: request.sessionId, requestId: request.requestId, sequence: index + 1, delta })
    }
    if (signal?.aborted) throw abortError()
    await appendMessage(request.sessionId, {
      id: `assistant_${request.requestId}`,
      role: 'assistant',
      content: emitted,
      timestamp: Date.now(),
    })
    onEvent({ type: 'assistant.done', sessionId: request.sessionId, requestId: request.requestId, sequence: parts.length + 1 })
  }

  return { health, loadSessions, createSession, updateSessionWorkspace, deleteSession, appendMessage, generate }
}

export const isChatAbortError = (reason: unknown): boolean => reason instanceof DOMException && reason.name === 'AbortError'
