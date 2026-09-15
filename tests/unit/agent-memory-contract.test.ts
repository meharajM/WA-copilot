import { beforeEach, describe, expect, it, vi } from 'vitest'

const executeToolCallMock = vi.hoisted(() => vi.fn())

vi.mock('../../src/renderer/src/lib/mcp', () => ({
  executeToolCall: executeToolCallMock,
  parseTabIdFromResult: vi.fn(),
}))

import {
  cleanupState,
  detectHandoff,
  initializeSessionState,
  loadParentContext,
} from '../../src/renderer/src/lib/agent/AgentStateService'
import { SpecialToolHandlers } from '../../src/renderer/src/lib/agent/SpecialToolHandlers'

describe('agent memory contract', () => {
  beforeEach(() => {
    executeToolCallMock.mockReset()
    process.env.NODE_ENV = 'test'
  })

  it('restores checkpoints from lowercase metadata', async () => {
    executeToolCallMock.mockResolvedValueOnce({
      result: {
        id: 'AgentState_agent-1',
        name: 'AgentState_agent-1',
        metadata: {
          lastCheckpoint: { step: 3, summary: 'Browsed docs', timestamp: 123 },
        },
      },
    })

    const result = await initializeSessionState('agent-1', 'session-1', undefined)

    expect(result.restoredCheckpoint).toEqual({
      step: 3,
      summary: 'Browsed docs',
      timestamp: 123,
    })
    expect(executeToolCallMock).toHaveBeenCalledWith('memory_read_entity', {
      name: 'AgentState_agent-1',
    })
    expect(executeToolCallMock).not.toHaveBeenCalledWith(
      'memory_create_entity',
      expect.anything()
    )
  })

  it('keeps compatibility with legacy uppercase Metadata', async () => {
    executeToolCallMock.mockResolvedValueOnce({
      result: {
        name: 'AgentState_agent-legacy',
        Metadata: {
          lastCheckpoint: { step: 5, summary: 'Legacy checkpoint', timestamp: 456 },
        },
      },
    })

    const result = await initializeSessionState('agent-legacy', 'session-1', undefined)

    expect(result.restoredCheckpoint?.summary).toBe('Legacy checkpoint')
  })

  it('loads parent context from normalized metadata and observations', async () => {
    executeToolCallMock.mockResolvedValueOnce({
      result: {
        name: 'AgentState_parent-1',
        metadata: {
          lastCheckpoint: { step: 7, summary: 'Parent summary', timestamp: 789 },
        },
        observations: ['first', 'second', 'third', 'fourth'],
      },
    })

    const result = await loadParentContext('parent-1')

    expect(result?.role).toBe('system')
    expect(result?.content).toContain('[Parent Context - Step 7]')
    expect(result?.content).toContain('Parent summary')
    expect(result?.content).toContain('1. second')
    expect(result?.content).toContain('3. fourth')
  })

  it('detects and consumes handoffs from the memory_search array contract', async () => {
    executeToolCallMock
      .mockResolvedValueOnce({
        result: [
          {
            id: 'Handoff_session-1_1',
            name: 'Handoff_session-1_1',
            type: 'agent_handoff',
            metadata: {
              sessionId: 'session-1',
              originalGoal: 'finish task',
              lastCheckpoint: { step: 10, summary: 'Half done', timestamp: 999 },
            },
          },
        ],
      })
      .mockResolvedValueOnce({ result: { deleted: true } })

    const result = await detectHandoff('session-1')

    expect(result).toEqual({
      found: true,
      originalGoal: 'finish task',
      checkpoint: { step: 10, summary: 'Half done', timestamp: 999 },
    })
    expect(executeToolCallMock).toHaveBeenNthCalledWith(1, 'memory_search', {
      query: 'session-1',
    })
    expect(executeToolCallMock).toHaveBeenNthCalledWith(2, 'memory_delete_entity', {
      id: 'Handoff_session-1_1',
      name: 'Handoff_session-1_1',
    })
  })

  it('ignores non-handoff entities returned by the SQLite-compatible session search', async () => {
    executeToolCallMock.mockResolvedValueOnce({
      result: [
        {
          id: 'AgentState_session-1',
          name: 'AgentState_session-1',
          type: 'agent_execution_state',
          metadata: { sessionId: 'session-1' },
        },
      ],
    })

    await expect(detectHandoff('session-1')).resolves.toEqual({
      found: false,
      checkpoint: null,
      originalGoal: null,
    })
    expect(executeToolCallMock).toHaveBeenCalledTimes(1)
  })

  it('saves progress checkpoints by reading state before update-by-id', async () => {
    executeToolCallMock
      .mockResolvedValueOnce({
        result: { id: 'AgentState_agent-1', name: 'AgentState_agent-1' },
      })
      .mockResolvedValueOnce({ result: { id: 'AgentState_agent-1' } })

    const handlers = new SpecialToolHandlers(
      'agent-1',
      { activeSessionId: 'session-1' } as never,
      undefined,
      vi.fn(),
      vi.fn()
    )

    const result = await handlers.handleUpdateProgressSummary(
      { summary: 'Checkpoint text' },
      15
    )

    expect(result.checkpoint.step).toBe(15)
    expect(executeToolCallMock).toHaveBeenNthCalledWith(1, 'memory_read_entity', {
      name: 'AgentState_agent-1',
    })
    expect(executeToolCallMock).toHaveBeenNthCalledWith(2, 'memory_update_entity', {
      id: 'AgentState_agent-1',
      name: 'AgentState_agent-1',
      metadata: {
        lastCheckpoint: result.checkpoint,
        status: 'active',
        iterationCount: 15,
      },
    })
  })

  it('cleans up production state via delete-by-name', async () => {
    process.env.NODE_ENV = 'production'
    executeToolCallMock.mockResolvedValueOnce({ result: { deleted: true } })

    await cleanupState('agent-prod')

    expect(executeToolCallMock).toHaveBeenCalledWith('memory_delete_entity', {
      name: 'AgentState_agent-prod',
    })
  })
})
