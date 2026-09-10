import { autonomousSupervisor } from './AutonomousSupervisor'
import { PlaywrightService } from './PlaywrightService'

const tools = [
  { name: 'get_machine_health', description: 'Read bounded host and supervisor health.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_agent_status', description: 'Read autonomous supervisor state.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_queue_status', description: 'Read queue depth and active job state.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_channel_status', description: 'Read autonomous channel and dependency health.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_recent_failures', description: 'Read bounded recent unresolved failures.', inputSchema: { type: 'object', properties: {} } },
  { name: 'capture_diagnostics', description: 'Capture bounded supervisor diagnostics without shell or filesystem access.', inputSchema: { type: 'object', properties: {} } },
  { name: 'surface_browser', description: 'Surface the controlled browser for human intervention.', inputSchema: { type: 'object', properties: {} } },
  { name: 'pause_agent', description: 'Pause autonomous processing; optionally emergency-pause it.', inputSchema: { type: 'object', properties: { emergency: { type: 'boolean' } } } },
  { name: 'resume_agent', description: 'Resume autonomous processing after owner review.', inputSchema: { type: 'object', properties: {} } },
  { name: 'retry_job', description: 'Retry one failed job using its durable original payload.', inputSchema: { type: 'object', required: ['inboundId'], properties: { inboundId: { type: 'string', minLength: 1, maxLength: 200 } } } },
  { name: 'reconnect_channel', description: 'Request an owner-authorized channel reconnect.', inputSchema: { type: 'object', properties: {} } }
]

function stringArg(args: unknown, key: string): string {
  const value = args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined
  if (typeof value !== 'string' || !value || value.length > 200) throw new Error(`Invalid ${key}`)
  return value
}

export class AutonomyMcpService {
  listTools(): { tools: typeof tools } { return { tools } }

  async callTool(name: string, args: unknown): Promise<{ result: unknown; error?: string }> {
    try {
      switch (name) {
        case 'get_machine_health': return { result: { platform: process.platform, arch: process.arch, uptime: process.uptime(), memoryRss: process.memoryUsage().rss, supervisor: autonomousSupervisor.getHealth() } }
        case 'get_agent_status': return { result: autonomousSupervisor.getState() }
        case 'get_queue_status': { const state = autonomousSupervisor.getState(); return { result: { queueDepth: state.queueDepth, activeJob: state.activeJob, status: state.status, paused: state.paused } } }
        case 'get_channel_status': return { result: autonomousSupervisor.getHealth() }
        case 'get_recent_failures': return { result: { lastError: autonomousSupervisor.getState().lastError, unresolvedOutbound: autonomousSupervisor.listUnresolvedOutbound() } }
        case 'capture_diagnostics': return { result: { health: autonomousSupervisor.getHealth(), state: autonomousSupervisor.getState(), unresolvedOutbound: autonomousSupervisor.listUnresolvedOutbound(), deliveryHistory: autonomousSupervisor.listDeliveryHistory(50) } }
        case 'surface_browser': return await PlaywrightService.getInstance().callTool('request_human_intervention', { reason: 'Autonomy MCP operator requested browser surface' })
        case 'pause_agent': return { result: autonomousSupervisor.pause(Boolean(args && typeof args === 'object' && (args as Record<string, unknown>).emergency)) }
        case 'resume_agent': return { result: autonomousSupervisor.resume() }
        case 'retry_job': return { result: autonomousSupervisor.retryJob(stringArg(args, 'inboundId')) }
        case 'reconnect_channel': return { result: await autonomousSupervisor.reconnectChannel() }
        default: return { result: null, error: `Tool ${name} not found` }
      }
    } catch (error) { return { result: null, error: error instanceof Error ? error.message : String(error) } }
  }
}

export const autonomyMcpService = new AutonomyMcpService()
