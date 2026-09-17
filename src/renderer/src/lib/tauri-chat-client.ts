import { invoke } from '@tauri-apps/api/core'
import type {
  ChatClient,
  ChatGenerationEvent,
  ChatGenerationRequest,
  ChatHealth,
  ChatMessage,
  ChatSession,
} from '../../../shared/chat-protocol'
import { tauriNativeBridge } from './tauri-native-bridge'

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export interface TauriChatClientDependencies {
  invoke: Invoke
  health: () => Promise<{ status: 'ready' | 'unavailable'; error?: string }>
}

const defaultDependencies: TauriChatClientDependencies = {
  invoke,
  health: tauriNativeBridge.health,
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

export const readMessage = (value: unknown): ChatMessage => {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || !['user', 'assistant', 'system'].includes(value.role as string)
    || typeof value.content !== 'string'
    || !Number.isSafeInteger(value.createdAt)) {
    throw new Error('Invalid agentd chat message response')
  }
  return {
    id: value.id,
    role: value.role as ChatMessage['role'],
    content: value.content,
    timestamp: value.createdAt as number,
  }
}

export const readSession = (value: unknown): ChatSession => {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.title !== 'string'
    || !Number.isSafeInteger(value.createdAt)
    || !Number.isSafeInteger(value.updatedAt)
    || !Array.isArray(value.messages)) {
    throw new Error('Invalid agentd chat session response')
  }
  return {
    id: value.id,
    title: value.title,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
    status: 'active',
    messages: value.messages.map(readMessage),
  }
}

export const readGeneration = (value: unknown, request: ChatGenerationRequest): ChatMessage => {
  if (!isRecord(value) || !isRecord(value.message)
    || !isRecord(value.generation)
    || value.generation.sessionId !== request.sessionId
    || value.generation.requestId !== request.requestId
    || value.generation.streaming !== false) {
    throw new Error('Invalid agentd chat generation response')
  }
  return readMessage(value.message)
}

const abortError = (): DOMException => new DOMException('Chat generation canceled', 'AbortError')

export function createTauriChatClient(
  dependencies: TauriChatClientDependencies = defaultDependencies,
): ChatClient {
  const health = async (): Promise<ChatHealth> => {
    try {
      const result = await dependencies.health()
      return result.status === 'ready'
        ? { status: 'ready', mode: 'daemon' }
        : { status: 'unavailable', mode: 'daemon', error: result.error || 'agentd is unavailable' }
    } catch (error) {
      return { status: 'unavailable', mode: 'daemon', error: error instanceof Error ? error.message : 'agentd is unavailable' }
    }
  }

  const loadSessions = async (): Promise<ChatSession[]> => {
    const value = await dependencies.invoke<unknown>('chat_load_sessions')
    if (!Array.isArray(value)) throw new Error('Invalid agentd chat session response')
    return value.map(readSession)
  }

  const createSession = async (sessionId: string, title: string): Promise<void> => {
    await dependencies.invoke('chat_create_session', { id: sessionId, title })
  }

  const deleteSession = async (sessionId: string): Promise<void> => {
    await dependencies.invoke('chat_delete_session', { sessionId })
  }

  const appendMessage = async (sessionId: string, message: ChatMessage): Promise<void> => {
    await dependencies.invoke('chat_append_message', {
      sessionId,
      messageId: message.id,
      role: message.role,
      content: message.content,
    })
  }

  const generate = async (
    request: ChatGenerationRequest,
    onEvent: (event: ChatGenerationEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> => {
    if (signal?.aborted) throw abortError()
    const value = await dependencies.invoke<unknown>('chat_generate', {
      sessionId: request.sessionId,
      requestId: request.requestId,
      content: request.content,
      ...(request.model ? { model: request.model } : {}),
    })
    if (signal?.aborted) throw abortError()
    const message = readGeneration(value, request)
    onEvent({
      type: 'assistant.delta',
      sessionId: request.sessionId,
      requestId: request.requestId,
      sequence: 1,
      delta: message.content,
    })
    onEvent({
      type: 'assistant.done',
      sessionId: request.sessionId,
      requestId: request.requestId,
      sequence: 2,
    })
  }

  return { health, loadSessions, createSession, deleteSession, appendMessage, generate }
}
