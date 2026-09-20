import { describe, expect, it, vi } from 'vitest'
import type { LLMMessage, LLMSettings } from '../../src/renderer/src/lib/types'

type ProviderAvailability = {
  browser?: { available: boolean; isLoaded?: boolean }
  ollama?: boolean
  openai?: boolean
  gemini?: boolean
  openrouter?: boolean
}

async function loadChatWithMocks(availability: ProviderAvailability) {
  vi.resetModules()

  const callBrowserLLM = vi.fn(async () => ({
    content: 'browser',
    provider: 'browser',
    model: 'browser-model',
  }))
  const callOllama = vi.fn(async () => ({
    content: 'ollama',
    provider: 'ollama',
    model: 'qwen2.5:3b',
  }))
  const callOpenAI = vi.fn(async (_messages, _tools, settings, _useJson, _servers, isOpenRouter) => ({
    content: isOpenRouter ? 'openrouter' : 'openai',
    provider: isOpenRouter ? 'openrouter' : 'openai',
    model: isOpenRouter ? settings?.openrouterModel || 'openrouter-model' : settings?.openaiModel || 'openai-model',
  }))
  const callGemini = vi.fn(async () => ({
    content: 'gemini',
    provider: 'gemini',
    model: 'gemini-model',
  }))

  vi.doMock('../../src/renderer/src/lib/webllm', () => ({
    getWebLLMStatus: () => ({
      isSupported: availability.browser?.available ?? false,
      isLoaded: availability.browser?.isLoaded ?? false,
      downloadedModels: [],
      currentModel: null,
      progress: 0,
      error: null,
    }),
    subscribeToWebLLMStatus: vi.fn(),
    WEBLLM_MODELS: [],
    checkDownloadedWebLLMModels: vi.fn(),
    deleteWebLLMModel: vi.fn(),
    downloadWebLLMModelOnly: vi.fn(),
    getWebLLMDownloadStatus: vi.fn(),
    checkWebLLMModelCompatibility: vi.fn(),
  }))

  vi.doMock('../../src/renderer/src/lib/llm/ollama', () => ({
    checkOllama: async () => ({ available: availability.ollama ?? false, model: 'qwen2.5:3b' }),
    testOllamaConnection: vi.fn(),
    callOllama,
  }))

  vi.doMock('../../src/renderer/src/lib/llm/browser-llm', () => ({
    checkBrowserLLM: async () => ({ available: availability.browser?.available ?? false }),
    testWebLLMConnection: vi.fn(),
    callBrowserLLM,
    downloadBrowserModel: vi.fn(),
  }))

  vi.doMock('../../src/renderer/src/lib/llm/openai', () => ({
    checkOpenAI: async () => ({ available: availability.openai ?? false, model: 'gpt-4o-mini' }),
    checkOpenRouter: async () => ({
      available: availability.openrouter ?? false,
      model: 'nvidia/nemotron-3-super-120b-a12b:free',
    }),
    testOpenAIConnection: vi.fn(),
    callOpenAI,
  }))

  vi.doMock('../../src/renderer/src/lib/llm/gemini', () => ({
    checkGemini: async () => ({ available: availability.gemini ?? false, model: 'gemini-2.5-flash' }),
    testGeminiConnection: vi.fn(),
    callGemini,
  }))

  vi.doMock('../../src/renderer/src/lib/llm/prompts', () => ({
    buildSystemPrompt: async () => 'TEST_SYSTEM_PROMPT',
  }))

  vi.doMock('../../src/renderer/src/lib/dcp', () => ({
    pruneContext: (messages: LLMMessage[]) => messages,
  }))

  vi.doMock('../../src/renderer/src/lib/plan_manager', () => ({
    CREATE_PLAN_TOOL: {
      name: 'create_execution_plan',
      description: 'Create execution plan',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  }))

  const llm = await import('../../src/renderer/src/lib/llm')
  return { ...llm, callBrowserLLM, callOllama, callOpenAI, callGemini }
}

describe('LLM routing contracts', () => {
  it('auto mode prefers Ollama when browser is not loaded', async () => {
    const { chat, callOllama, callBrowserLLM } = await loadChatWithMocks({
      browser: { available: true, isLoaded: false },
      ollama: true,
      openai: true,
      gemini: true,
      openrouter: true,
    })

    const response = await chat([{ role: 'user', content: 'hello' }], [], {
      preferredProvider: 'auto',
    })

    expect(callOllama).toHaveBeenCalledTimes(1)
    expect(callBrowserLLM).not.toHaveBeenCalled()
    expect(response.provider).toBe('ollama')
  })

  it('preferred openrouter routes through callOpenAI with openrouter flag', async () => {
    const { chat, callOpenAI } = await loadChatWithMocks({
      openrouter: true,
    })

    const settings: LLMSettings = {
      preferredProvider: 'openrouter',
      openrouterApiKey: 'test-key',
      openrouterModel: 'nvidia/nemotron-3-super-120b-a12b:free',
    }

    const response = await chat([{ role: 'user', content: 'hello' }], [], settings)

    expect(callOpenAI).toHaveBeenCalledTimes(1)
    expect(callOpenAI.mock.calls[0][5]).toBe(true)
    expect(response.provider).toBe('openrouter')
  })

  it('preferred browser routes through the local WebGPU provider', async () => {
    const { chat, callBrowserLLM, callOllama } = await loadChatWithMocks({
      browser: { available: true, isLoaded: true },
      ollama: true,
    })

    const response = await chat([{ role: 'user', content: 'hello' }], [], {
      preferredProvider: 'browser',
      browserModel: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
    })

    expect(callBrowserLLM).toHaveBeenCalledTimes(1)
    expect(callOllama).not.toHaveBeenCalled()
    expect(response.provider).toBe('browser')
  })

  it('throws a clear error when no providers are available', async () => {
    const { chat } = await loadChatWithMocks({
      browser: { available: false, isLoaded: false },
      ollama: false,
      openai: false,
      gemini: false,
      openrouter: false,
    })

    await expect(
      chat([{ role: 'user', content: 'hello' }], [], { preferredProvider: 'auto' })
    ).rejects.toThrow('No LLM provider available')
  })
})
