import { describe, expect, it, vi } from 'vitest'
import { createTauriChatClient } from '../../src/renderer/src/lib/tauri-chat-client'

describe('Tauri daemon chat client', () => {
  it('validates persisted sessions and forwards bounded messages through typed commands', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'chat_load_sessions') return [{
        id: 's1',
        title: 'Saved chat',
        createdAt: 100,
        updatedAt: 200,
        messages: [{ id: 'm1', role: 'user', content: 'hello', createdAt: 150 }],
      }]
      if (command === 'chat_generate') return {
        generation: { sessionId: 's1', requestId: 'r1', provider: 'openai', model: 'gpt-4o-mini', streaming: false, duplicate: false },
        message: { id: 'assistant_r1', role: 'assistant', content: 'answer', createdAt: 400 },
      }
      return { message: { id: 'm2', role: 'user', content: 'next', createdAt: 300 }, duplicate: false }
    })
    const client = createTauriChatClient({ invoke, health: async () => ({ status: 'ready' }) })
    await expect(client.health()).resolves.toMatchObject({ status: 'ready', mode: 'daemon' })
    await expect(client.loadSessions()).resolves.toMatchObject([{ id: 's1', messages: [{ id: 'm1' }] }])
    await client.createSession('s2', 'New chat')
    expect(invoke).toHaveBeenLastCalledWith('chat_create_session', { id: 's2', title: 'New chat' })
    await client.deleteSession('s2')
    expect(invoke).toHaveBeenLastCalledWith('chat_delete_session', { sessionId: 's2' })
    await client.appendMessage('s1', { id: 'm2', role: 'user', content: 'next', timestamp: 300 })
    expect(invoke).toHaveBeenLastCalledWith('chat_append_message', { sessionId: 's1', messageId: 'm2', role: 'user', content: 'next' })
    const events: string[] = []
    await client.generate({ sessionId: 's1', requestId: 'r1', content: 'hello' }, (event) => events.push(event.type))
    expect(events).toEqual(['assistant.delta', 'assistant.done'])
    expect(invoke).toHaveBeenLastCalledWith('chat_generate', { sessionId: 's1', requestId: 'r1', content: 'hello' })
  })

  it('preserves explicit unavailable state when daemon is offline', async () => {
    const client = createTauriChatClient({ invoke: vi.fn(), health: async () => ({ status: 'unavailable', error: 'offline' }) })
    await expect(client.health()).resolves.toMatchObject({ status: 'unavailable', mode: 'daemon', error: 'offline' })
  })
})
