import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/aica-memory-fallback-test' } }))
vi.mock('electron-store', () => ({
  default: class TestStore {
    private values = new Map<string, unknown>()
    get(key: string, defaultValue?: unknown) { return this.values.has(key) ? this.values.get(key) : defaultValue }
    set(key: string, value: unknown) { this.values.set(key, value) }
  },
}))

import { recoverUnavailableMemoryBackend } from '../../src/main/services/memory/MemoryServiceFactory'

describe('memory backend fallback', () => {
  it('falls back unavailable Memento configuration to SQLite while preserving its path', () => {
    const fallback = { backend: 'sqlite' as const, sqlite: { storagePath: '/tmp/default-memory.db' } }
    const config = { backend: 'memento-mcp' as const, memento: { neo4jUri: 'bolt://localhost', username: 'neo4j', password: 'secret' } }

    expect(recoverUnavailableMemoryBackend(config, fallback)).toMatchObject({
      backend: 'sqlite',
      sqlite: fallback.sqlite,
      memento: config.memento,
    })
  })

  it('leaves supported configuration unchanged', () => {
    const config = { backend: 'sqlite' as const, sqlite: { storagePath: '/tmp/memory.db' } }
    expect(recoverUnavailableMemoryBackend(config, { backend: 'sqlite' })).toBe(config)
  })
})
