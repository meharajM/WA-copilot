import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint'
import type { WhatsAppMessage } from '../whatsapp/WhatsAppService'
import type { ChannelMessage } from '../packages/omnichannel'
import type { ResponseDecision } from './AutonomousSupervisor'

export type WorkflowMessage = WhatsAppMessage & Partial<Pick<ChannelMessage, 'channel' | 'businessId' | 'channelAccountId' | 'conversationId'>>

export function workflowThreadId(message: WorkflowMessage): string {
  return `${message.businessId || 'local-business'}:${message.channel || 'whatsapp'}:${message.channelAccountId || message.to}:${message.conversationId || message.from}`
}

const SAFE_TIMEOUT_DECISION: ResponseDecision = {
  text: null, confidence: 0, grounding: 'unavailable', escalated: true,
  sensitiveTopic: false, reason: 'workflow_execution_failed'
}

const WorkflowState = Annotation.Root({
  message: Annotation<WorkflowMessage>(),
  decision: Annotation<ResponseDecision | null>(),
  guardPassed: Annotation<boolean>()
})

export interface AutonomyWorkflowCallbacks {
  guard: (message: WorkflowMessage) => Promise<ResponseDecision | null>
  decide: (message: WorkflowMessage) => Promise<ResponseDecision>
}

export function createAutonomyWorkflow(
  callbacks: AutonomyWorkflowCallbacks | ((message: WorkflowMessage) => Promise<ResponseDecision>),
  checkpointer?: BaseCheckpointSaver,
  timeoutMs = 30_000
) {
  const handlers: AutonomyWorkflowCallbacks = typeof callbacks === 'function' ? { guard: async () => null, decide: callbacks } : callbacks
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([work(), new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('workflow timeout')), timeoutMs) })])
    } finally { if (timer) clearTimeout(timer) }
  }
  return new StateGraph(WorkflowState)
    .addNode('guard', async (state) => {
      try {
        const decision = await bounded(() => handlers.guard(state.message))
        return { decision, guardPassed: decision === null }
      } catch { return { decision: SAFE_TIMEOUT_DECISION, guardPassed: false } }
    })
    .addNode('decide', async (state) => {
      if (!state.guardPassed) return {}
      try {
        return { decision: await bounded(() => handlers.decide(state.message)) }
      } catch { return { decision: SAFE_TIMEOUT_DECISION } }
    })
    .addEdge(START, 'guard')
    .addConditionalEdges('guard', state => state.guardPassed ? 'decide' : END)
    .addEdge('decide', END)
    .compile({ checkpointer })
}

export async function runAutonomyWorkflow(
  workflow: ReturnType<typeof createAutonomyWorkflow>,
  message: WorkflowMessage
): Promise<ResponseDecision> {
  const result = await workflow.invoke(
    { message },
    { configurable: { thread_id: workflowThreadId(message) } }
  )
  if (!result.decision) throw new Error('Autonomy workflow returned no decision')
  return result.decision
}
