import { describe, expect, it } from 'vitest'
import { createAutonomyWorkflow, runAutonomyWorkflow } from '../../src/main/services/AutonomyWorkflow'
import type { WhatsAppMessage } from '../../src/main/whatsapp/WhatsAppService'
import { MemorySaver } from '@langchain/langgraph'
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite'
import Database from 'better-sqlite3'

const message: WhatsAppMessage = {
  id: 'm1', from: '123@s.whatsapp.net', to: '456@s.whatsapp.net', content: 'Hours?',
  timestamp: Date.now(), type: 'text', isFromMe: false
}

describe('autonomy workflow', () => {
  it('executes the bounded decision graph', async () => {
    const workflow = createAutonomyWorkflow(async input => ({
      text: `Answer: ${input.content}`, confidence: 0.9, grounding: 'grounded',
      escalated: false, sensitiveTopic: false, reason: 'test'
    }), new MemorySaver())
    await expect(runAutonomyWorkflow(workflow, message)).resolves.toMatchObject({
      text: 'Answer: Hours?', confidence: 0.9, grounding: 'grounded'
    })
  })

  it('writes a checkpoint for the stable message thread', async () => {
    const saver = new SqliteSaver(new Database(':memory:'))
    const workflow = createAutonomyWorkflow(async () => ({
      text: 'Persisted draft', confidence: 0.9, grounding: 'grounded',
      escalated: false, sensitiveTopic: false, reason: 'test'
    }), saver)
    await runAutonomyWorkflow(workflow, message)
    const checkpoints = []
    for await (const checkpoint of saver.list({ configurable: { thread_id: `local-business:whatsapp:${message.to}:${message.from}` } })) {
      checkpoints.push(checkpoint)
    }
    expect(checkpoints.length).toBeGreaterThan(0)
  })

  it('runs the deterministic guard before model decisioning', async () => {
    const guard = async () => ({ text: null, confidence: 0, grounding: 'unavailable' as const, escalated: true, sensitiveTopic: true, reason: 'guarded' })
    const decide = async () => { throw new Error('decision node must not run') }
    const workflow = createAutonomyWorkflow({ guard, decide }, new MemorySaver())
    await expect(runAutonomyWorkflow(workflow, message)).resolves.toMatchObject({ reason: 'guarded', escalated: true })
  })

  it('fails closed when the decision worker exceeds its timeout', async () => {
    const workflow = createAutonomyWorkflow(() => new Promise(() => {}), new MemorySaver(), 5)
    await expect(runAutonomyWorkflow(workflow, message)).resolves.toMatchObject({
      text: null, escalated: true, reason: 'workflow_execution_failed'
    })
  })
})
