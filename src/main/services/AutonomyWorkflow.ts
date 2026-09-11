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
  decision: Annotation<ResponseDecision | null>()
})

export function createAutonomyWorkflow(
  decide: (message: WorkflowMessage) => Promise<ResponseDecision>,
  checkpointer?: BaseCheckpointSaver,
  timeoutMs = 30_000
) {
  return new StateGraph(WorkflowState)
    .addNode('decide', async (state) => {
      let timer: NodeJS.Timeout | undefined
      try {
        const decision = await Promise.race([
          decide(state.message),
          new Promise<ResponseDecision>((_, reject) => { timer = setTimeout(() => reject(new Error('workflow timeout')), timeoutMs) })
        ])
        return { decision }
      } catch {
        return { decision: SAFE_TIMEOUT_DECISION }
      } finally {
        if (timer) clearTimeout(timer)
      }
    })
    .addEdge(START, 'decide')
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
