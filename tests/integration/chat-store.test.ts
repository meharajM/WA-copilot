import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '../../src/renderer/src/stores/chatStore'

const loadSessionsMock = vi.fn()
const saveSessionsWithMirrorMock = vi.fn()
const deleteSessionMock = vi.fn()

function resetChatStore(): void {
  localStorage.removeItem('aica-chat-v3')
  useChatStore.setState({
    sessions: [],
    activeSessionId: null,
    activeSelectionRevision: 0,
    _processingSessions: new Map(),
    offlineSpeech: false,
    sidebarOpen: true,
  })
}

describe('chat store contracts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadSessionsMock.mockResolvedValue({ success: true, sessions: [] })
    saveSessionsWithMirrorMock.mockResolvedValue({ success: true })
    deleteSessionMock.mockResolvedValue({ success: true })
    window.electron = {
      chat: {
        loadSessions: loadSessionsMock,
        saveSessionsWithMirror: saveSessionsWithMirrorMock,
        deleteSession: deleteSessionMock,
      },
    } as unknown as ElectronAPI
    resetChatStore()
  })

  it('loads, saves, and deletes sessions through typed preload methods', async () => {
    const session = {
      id: 'chat-1',
      title: 'Existing chat',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }
    loadSessionsMock.mockResolvedValueOnce({ success: true, sessions: [session] })

    await useChatStore.persist.rehydrate()
    expect(loadSessionsMock).toHaveBeenCalledOnce()
    expect(useChatStore.getState().sessions).toEqual([session])

    useChatStore.getState().updateSessionTitle('chat-1', 'Renamed chat')
    await vi.waitFor(() => expect(saveSessionsWithMirrorMock).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'chat-1', title: 'Renamed chat' }),
    ]))

    useChatStore.getState().deleteSession('chat-1')
    await vi.waitFor(() => expect(deleteSessionMock).toHaveBeenCalledWith('chat-1'))
  })

  it('restores a session when backend deletion fails', async () => {
    const session = {
      id: 'chat-delete-failure',
      title: 'Keep this chat',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }
    deleteSessionMock.mockResolvedValueOnce({ success: false, error: 'Storage unavailable' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    useChatStore.setState({ sessions: [session], activeSessionId: session.id })

    useChatStore.getState().deleteSession(session.id)

    await vi.waitFor(() => expect(useChatStore.getState().sessions).toEqual([session]))
    expect(useChatStore.getState().activeSessionId).toBe(session.id)
    errorSpy.mockRestore()
  })

  it('does not override a repeated fallback selection when backend deletion rejects', async () => {
    const deletedSession = {
      id: 'chat-delete-rejected',
      title: 'Deleted chat',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const fallbackSession = {
      id: 'chat-fallback',
      title: 'Fallback chat',
      messages: [],
      createdAt: 2,
      updatedAt: 2,
    }
    let rejectDelete: (error: Error) => void = () => undefined
    deleteSessionMock.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectDelete = reject
    }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    useChatStore.setState({ sessions: [deletedSession, fallbackSession], activeSessionId: deletedSession.id })

    useChatStore.getState().deleteSession(deletedSession.id)
    useChatStore.getState().setActiveSession(fallbackSession.id)
    rejectDelete(new Error('Storage unavailable'))

    await vi.waitFor(() => expect(useChatStore.getState().sessions).toContainEqual(deletedSession))
    expect(useChatStore.getState().activeSessionId).toBe(fallbackSession.id)
    errorSpy.mockRestore()
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
