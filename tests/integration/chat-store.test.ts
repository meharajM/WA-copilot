import { beforeEach, describe, expect, it } from 'vitest'
import { useChatStore } from '../../src/renderer/src/stores/chatStore'

function resetChatStore(): void {
  localStorage.removeItem('aica-chat-v3')
  useChatStore.setState({
    sessions: [],
    activeSessionId: null,
    _processingSessions: new Map(),
    offlineSpeech: false,
    sidebarOpen: true,
  })
}

describe('chat store contracts', () => {
  beforeEach(() => {
    resetChatStore()
  })

  it('creates an active session with default status', () => {
    const id = useChatStore.getState().createSession('/tmp/workspace')
    const state = useChatStore.getState()

    expect(state.activeSessionId).toBe(id)
    const session = state.sessions.find((s) => s.id === id)
    expect(session).toBeTruthy()
    expect(session?.status).toBe('active')
    expect(session?.workspacePath).toBe('/tmp/workspace')
  })

  it('tracks per-session processing lifecycle independently', () => {
    const id = useChatStore.getState().createSession()
    const signal = useChatStore.getState().startProcessing(id)
    expect(signal.aborted).toBe(false)
    expect(useChatStore.getState().isSessionProcessing(id)).toBe(true)

    useChatStore.getState().stopProcessing(id)
    expect(useChatStore.getState().isSessionProcessing(id)).toBe(false)
  })

  it('clearMessages aborts only active session processing', () => {
    const id1 = useChatStore.getState().createSession()
    const id2 = useChatStore.getState().createSession()

    useChatStore.getState().startProcessing(id1)
    useChatStore.getState().startProcessing(id2)
    useChatStore.getState().setActiveSession(id2)

    useChatStore.getState().addSessionMessage(id2, {
      role: 'user',
      content: 'hello',
    })

    useChatStore.getState().clearMessages()

    expect(useChatStore.getState().isSessionProcessing(id2)).toBe(false)
    expect(useChatStore.getState().isSessionProcessing(id1)).toBe(true)

    const session2 = useChatStore.getState().sessions.find((s) => s.id === id2)
    expect(session2?.messages).toHaveLength(0)
  })
})
