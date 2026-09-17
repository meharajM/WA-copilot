import { describe, expect, it, vi } from 'vitest'
import type { ChatClient, ChatSession } from '../../src/shared/chat-protocol'
import { createTauriChatStorage } from '../../src/renderer/src/stores/chatStore'

const session = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: 'chat_1',
  title: 'Saved chat',
  createdAt: 100,
  updatedAt: 200,
  status: 'active',
  messages: [],
  ...overrides,
})

function client(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    health: vi.fn(async () => ({ status: 'ready', mode: 'daemon' as const })),
    loadSessions: vi.fn(async () => []),
    createSession: vi.fn(async () => {}),
    updateSessionWorkspace: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => {}),
    generate: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('Tauri chat-store persistence', () => {
  it('hydrates from agentd and writes new sessions/messages through typed client', async () => {
    const loaded = session({
      messages: [{ id: 'm1', role: 'user', content: 'old', timestamp: 150 }],
    })
    const chat = client({ loadSessions: vi.fn(async () => [loaded]) })
    const storage = createTauriChatStorage(chat)

    const envelope = await storage.getItem('aica-chat-v3')
    expect(JSON.parse(envelope!)).toMatchObject({ state: { sessions: [loaded] } })

    const next = session({
      id: 'chat_2',
      title: 'New chat',
      messages: [{ id: 'm2', role: 'user', content: 'new', timestamp: 250 }],
    })
    await storage.setItem('aica-chat-v3', JSON.stringify({ state: { sessions: [loaded, next], activeSessionId: next.id } }))

    expect(chat.createSession).toHaveBeenCalledWith('chat_2', 'New chat')
    expect(chat.appendMessage).toHaveBeenCalledWith('chat_2', next.messages[0])
    expect(chat.appendMessage).not.toHaveBeenCalledWith('chat_1', loaded.messages[0])
  })

  it('retries failed daemon writes instead of marking messages persisted', async () => {
    const appendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined)
    const chat = client({ appendMessage })
    const storage = createTauriChatStorage(chat)
    const value = JSON.stringify({ state: { sessions: [session({ messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 1 }] })] } })

    await storage.setItem('aica-chat-v3', value)
    await storage.setItem('aica-chat-v3', value)

    expect(appendMessage).toHaveBeenCalledTimes(2)
  })

  it('routes removed sessions to the daemon delete command', async () => {
    const chat = client({ loadSessions: vi.fn(async () => [session()]) })
    const storage = createTauriChatStorage(chat)
    await storage.getItem('aica-chat-v3')
    await storage.setItem('aica-chat-v3', JSON.stringify({ state: { sessions: [], activeSessionId: null } }))
    expect(chat.deleteSession).toHaveBeenCalledWith('chat_1')
  })
})
