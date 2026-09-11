import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entity, UnifiedMemoryBackend } from '../../src/main/services/memory/UnifiedMemoryBackend'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/wa-copilot-memory-tests' },
  BrowserWindow: { getFocusedWindow: () => null },
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../../src/main/services/memory/MemoryServiceFactory', () => ({
  MemoryServiceFactory: {
    create: vi.fn(),
    getCurrentBackend: () => 'sqlite',
  },
}))

vi.mock('../../src/main/services/IntelligenceService', () => ({
  IntelligenceService: {
    getInstance: () => ({ logEvent: vi.fn() }),
  },
}))

import { MemoryService } from '../../src/main/services/MemoryService'

const targetEntity: Entity = {
  id: 'AgentState_target',
  name: 'AgentState_target',
  type: 'agent_execution_state',
  description: 'target',
  observations: ['target'],
  metadata: { isInternal: true },
  createdAt: '2026-01-01T00:00:00.000Z',
}

function setBackend(backend: Partial<UnifiedMemoryBackend>): void {
  const service = MemoryService.getInstance() as unknown as {
    backend: UnifiedMemoryBackend
  }
  service.backend = backend as UnifiedMemoryBackend
}

describe('MemoryService tool safety and exact lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not advertise deletion but keeps the internal delete operation callable', async () => {
    const deleteEntity = vi.fn().mockResolvedValue(undefined)
    setBackend({
      getEntity: vi.fn().mockResolvedValue(targetEntity),
      deleteEntity,
    })

    const service = MemoryService.getInstance()
    expect(service.listTools().tools.map((tool) => tool.name)).not.toContain('memory_delete_entity')

    await expect(
      service.callTool('memory_delete_entity', { name: targetEntity.name })
    ).resolves.toEqual({
      result: { deleted: true, id: targetEntity.id, name: targetEntity.name },
    })
    expect(deleteEntity).toHaveBeenCalledWith(targetEntity.id)
  })

  it('selects only an exact name match from fuzzy backend search results', async () => {
    const partial = { ...targetEntity, id: 'AgentState_target-old', name: 'AgentState_target-old' }
    const search = vi.fn().mockResolvedValue([partial, targetEntity])
    setBackend({
      getEntity: vi.fn().mockResolvedValue(null),
      search,
    })

    const result = await MemoryService.getInstance().callTool('memory_read_entity', {
      name: targetEntity.name,
    })

    expect(result.result).toMatchObject({ id: targetEntity.id, name: targetEntity.name })
    expect(search).toHaveBeenCalledWith(targetEntity.name, { limit: 100 })
  })

  it('does not return a fuzzy result when no exact entity exists', async () => {
    setBackend({
      getEntity: vi.fn().mockResolvedValue(null),
      search: vi.fn().mockResolvedValue([
        { ...targetEntity, id: 'AgentState_target-old', name: 'AgentState_target-old' },
      ]),
    })

    await expect(
      MemoryService.getInstance().callTool('memory_read_entity', { name: targetEntity.name })
    ).resolves.toEqual({ result: null })
  })
})
