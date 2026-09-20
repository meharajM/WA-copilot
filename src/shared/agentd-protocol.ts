export const AGENTD_PROTOCOL_VERSION = 1 as const
export const AGENTD_MAX_FRAME_BYTES = 1024 * 1024

export interface AgentdHealth {
  status: 'ready'
  protocolVersion: typeof AGENTD_PROTOCOL_VERSION
  pid: number
  startedAt: string
}

export interface AgentdHealthRequest {
  version: typeof AGENTD_PROTOCOL_VERSION
  kind: 'request'
  id: string
  method: 'health.get'
}

export interface AgentdShutdownRequest {
  version: typeof AGENTD_PROTOCOL_VERSION
  kind: 'request'
  id: string
  method: 'shutdown'
}

export type AgentdRequest = AgentdHealthRequest | AgentdShutdownRequest

export interface AgentdHealthResponse {
  version: typeof AGENTD_PROTOCOL_VERSION
  kind: 'response'
  id: string
  ok: true
  result: AgentdHealth
}

export interface AgentdShutdownResponse {
  version: typeof AGENTD_PROTOCOL_VERSION
  kind: 'response'
  id: string
  ok: true
  result: { status: 'stopping' }
}

export type AgentdErrorCode =
  | 'malformed_json'
  | 'invalid_envelope'
  | 'invalid_request_id'
  | 'unsupported_version'
  | 'unknown_method'
  | 'frame_too_large'

export interface AgentdErrorResponse {
  version: typeof AGENTD_PROTOCOL_VERSION
  kind: 'response'
  id: string | null
  ok: false
  error: {
    code: AgentdErrorCode
    message: string
  }
}

export type AgentdResponse =
  | AgentdHealthResponse
  | AgentdShutdownResponse
  | AgentdErrorResponse

export interface AgentdReadyEvent {
  version: typeof AGENTD_PROTOCOL_VERSION
  kind: 'event'
  event: 'ready'
  data: AgentdHealth
}

export type AgentdEvent = AgentdReadyEvent
export type AgentdOutboundMessage = AgentdResponse | AgentdEvent
