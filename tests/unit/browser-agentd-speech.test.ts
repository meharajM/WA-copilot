import { describe, expect, it } from 'vitest'
import { createBrowserAgentdSpeechClient } from '../../src/renderer/src/lib/browser-agentd-speech'

describe('browser agentd speech client', () => {
  it('fetches authenticated model archive with bounded progress', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const seen: RequestInit[] = []
    const client = createBrowserAgentdSpeechClient({
      origin: 'http://127.0.0.1:4321',
      fetch: async (_input, init) => {
        seen.push(init || {})
        return new Response(bytes, { status: 200, headers: { 'content-type': 'application/zip', 'content-length': '4', 'x-content-digest': `sha-256=${'a'.repeat(64)}` } })
      },
    })
    const progress: number[] = []
    const blob = await client.fetchModel('en-us', value => progress.push(value))
    expect(blob.size).toBe(4)
    expect(progress.at(-1)).toBe(100)
    expect(seen[0]?.credentials).toBe('include')
  })

  it('rejects missing integrity metadata', async () => {
    const client = createBrowserAgentdSpeechClient({
      origin: 'http://127.0.0.1:4321',
      fetch: async () => new Response(new Uint8Array([1]), { status: 200 }),
    })
    await expect(client.fetchModel('en-us')).rejects.toThrow('integrity metadata')
  })
})
