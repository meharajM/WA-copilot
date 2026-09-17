export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
}

export interface ChatSessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  status: 'active' | 'resolved'
  channel?: string
  contactId?: string
}

export interface ChatSession extends ChatSessionSummary {
  messages: ChatMessage[]
}

export interface ChatGenerationRequest {
  sessionId: string
  requestId: string
  content: string
  model?: string
}

export type ChatGenerationEvent =
  | { type: 'assistant.delta'; sessionId: string; requestId: string; sequence: number; delta: string }
  | { type: 'assistant.done'; sessionId: string; requestId: string; sequence: number }
  | { type: 'error'; sessionId: string; requestId: string; sequence: number; message: string }

export interface ChatHealth {
  status: 'ready' | 'unavailable'
  error?: string
  mode: 'daemon' | 'fake'
}

export interface ChatClient {
  health(): Promise<ChatHealth>
  loadSessions(): Promise<ChatSession[]>
  createSession(sessionId: string, title: string): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  appendMessage(sessionId: string, message: ChatMessage): Promise<void>
  generate(request: ChatGenerationRequest, onEvent: (event: ChatGenerationEvent) => void, signal?: AbortSignal): Promise<void>
}
