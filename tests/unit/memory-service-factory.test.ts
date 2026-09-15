import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => ({
  value: undefined as unknown,
  set: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/wa-copilot-memory-factory-tests' },
}))

vi.mock('electron-store', () => ({
  default: class MockStore {
    get(_key: string, defaultValue: unknown): unknown {
      return storeState.value ?? defaultValue
    }

    set(key: string, value: unknown): void {
      storeState.value = value
      storeState.set(key, value)
    }
  },
}))

import { MemoryServiceFactory, type MemoryConfig } from '../../src/main/services/memory/MemoryServiceFactory'

describe('MemoryServiceFactory config fallback', () => {
  beforeEach(() => {
    storeState.value = undefined
    storeState.set.mockClear()
  })

  it('migrates a persisted memento-mcp selection to the default SQLite backend', () => {
    storeState.value = {
      backend: 'memento-mcp',
      memento: {
        neo4jUri: 'bolt://localhost:7687',
        username: 'neo4j',
        password: 'unused',
      },
    } satisfies MemoryConfig

    const config = MemoryServiceFactory.loadConfig()

    expect(config.backend).toBe('sqlite')
    expect(config.sqlite).toEqual({
      storagePath: '/tmp/wa-copilot-memory-factory-tests/memory_v2.db',
    })
    expect(storeState.set).toHaveBeenCalledWith('memory', config)
  })

  it('leaves implemented backend selections unchanged', () => {
    const sqliteConfig: MemoryConfig = {
      backend: 'sqlite',
      sqlite: { storagePath: '/tmp/custom-memory.db' },
    }
    storeState.value = sqliteConfig

    expect(MemoryServiceFactory.loadConfig()).toBe(sqliteConfig)
    expect(storeState.set).not.toHaveBeenCalled()
  })
})
