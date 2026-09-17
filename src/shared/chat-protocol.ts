export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  timestamp: number
  attachments?: ChatAttachment[]
}

export interface ChatAttachment {
  name: string
  type: string
  size: number
  text?: string
  dataUrl?: string
}

export interface ChatSessionSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  status: 'active' | 'resolved'
  channel?: string
  contactId?: string
  threadId?: string
  workspacePath?: string
}

export interface ChatSessionMetadata {
  status?: 'active' | 'resolved'
  channel?: string
  contactId?: string
  threadId?: string
}

export interface ChatSession extends ChatSessionSummary {
  messages: ChatMessage[]
}

export interface ChatGenerationRequest {
  sessionId: string
  requestId: string
  content: string
  model?: string
  attachments?: ChatAttachment[]
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
  createSession(sessionId: string, title: string, workspacePath?: string, metadata?: ChatSessionMetadata): Promise<void>
  updateSessionWorkspace(sessionId: string, workspacePath: string | null, metadata?: ChatSessionMetadata): Promise<void>
  deleteSession(sessionId: string): Promise<void>
  appendMessage(sessionId: string, message: ChatMessage): Promise<void>
  generate(request: ChatGenerationRequest, onEvent: (event: ChatGenerationEvent) => void, signal?: AbortSignal): Promise<void>
}
