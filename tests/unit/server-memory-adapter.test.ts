import { describe, expect, it, vi } from 'vitest'
import type { Entity } from '../../src/main/services/memory/UnifiedMemoryBackend'
import { ServerMemoryAdapter } from '../../src/main/services/memory/adapters/ServerMemoryAdapter'

const existingEntity: Entity = {
  id: 'AgentState_agent-1',
  name: 'AgentState_agent-1',
  type: 'agent_execution_state',
  description: 'active state',
  observations: ['existing observation'],
  metadata: { status: 'active' },
  createdAt: '2026-01-01T00:00:00.000Z',
}

function createInitializedAdapter() {
  const callTool = vi.fn().mockResolvedValue({ content: [] })
  const adapter = new ServerMemoryAdapter({ storagePath: '/tmp/server-memory-test' })
  const internals = adapter as unknown as {
    client: { callTool: typeof callTool }
    entityCache: Map<string, Entity>
  }
  internals.client = { callTool }
  internals.entityCache.set(existingEntity.id, existingEntity)
  return { adapter, callTool }
}

describe('ServerMemoryAdapter observation updates', () => {
  it('returns the exact entity instead of the first fuzzy search hit', async () => {
    const { adapter, callTool } = createInitializedAdapter()
    const internals = adapter as unknown as { entityCache: Map<string, Entity> }
    internals.entityCache.clear()
    callTool.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            {
              name: `${existingEntity.name}-old`,
              entityType: existingEntity.type,
              observations: ['old'],
            },
            {
              name: existingEntity.name,
              entityType: existingEntity.type,
              observations: existingEntity.observations,
            },
          ]),
        },
      ],
    })

    await expect(adapter.getEntity(existingEntity.id)).resolves.toMatchObject({
      id: existingEntity.id,
      name: existingEntity.name,
    })
  })

  it('sends only new observations using the server-memory add_observations schema', async () => {
    const { adapter, callTool } = createInitializedAdapter()

    const updated = await adapter.updateEntity(existingEntity.id, {
      observations: ['existing observation', 'new observation', 'new observation'],
    })

    expect(callTool).toHaveBeenCalledWith({
      name: 'add_observations',
      arguments: {
        observations: [
          { entityName: existingEntity.name, contents: ['new observation'] },
        ],
      },
    })
    expect(updated.observations).toEqual(['existing observation', 'new observation'])
  })

  it('does not call add_observations when the update contains no additions', async () => {
    const { adapter, callTool } = createInitializedAdapter()

    const updated = await adapter.updateEntity(existingEntity.id, {
      observations: ['existing observation'],
      metadata: { status: 'complete' },
    })

    expect(callTool).not.toHaveBeenCalled()
    expect(updated.observations).toEqual(['existing observation'])
    expect(updated.metadata).toEqual({ status: 'complete' })
  })
})
