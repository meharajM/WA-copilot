import { describe, expect, it } from 'vitest'
import { createFakeChatClient } from '../../src/renderer/src/lib/fake-chat-client'

describe('Tauri fake chat client', () => {
  it('is explicitly unavailable unless preview mode is enabled', async () => {
    const client = createFakeChatClient(false)
    await expect(client.health()).resolves.toMatchObject({ status: 'unavailable', mode: 'fake' })
    await expect(client.generate({ sessionId: 's1', requestId: 'r1', content: 'hello' }, () => {})).rejects.toThrow('disabled')
  })

  it('emits deterministic ordered deltas and persists the fake response by session', async () => {
    const client = createFakeChatClient(true)
    const events: Array<{ type: string; sequence: number; sessionId: string; requestId: string; delta?: string }> = []
    await client.generate({ sessionId: 's1', requestId: 'r1', content: 'hello' }, (event) => events.push(event))
    expect(events.map((event) => event.type)).toEqual(['assistant.delta', 'assistant.delta', 'assistant.delta', 'assistant.done'])
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4])
    expect(events.every((event) => event.sessionId === 's1' && event.requestId === 'r1')).toBe(true)
    expect((await client.loadSessions())[0].messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Fake response: hello' })
  })

  it('stops emitting after a session-scoped abort', async () => {
    const client = createFakeChatClient(true)
    const controller = new AbortController()
    const events: string[] = []
    await expect(client.generate({ sessionId: 's1', requestId: 'r1', content: 'hello' }, (event) => {
      events.push(event.type)
      if (event.type === 'assistant.delta') controller.abort()
    }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(events).toEqual(['assistant.delta'])
  })
})
