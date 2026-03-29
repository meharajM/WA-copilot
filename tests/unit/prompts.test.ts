import { describe, expect, it, vi, beforeEach } from 'vitest'

// Mock dependencies for prompt builder
vi.mock('../../src/renderer/src/lib/user-environment', () => ({
    getUserEnvironmentContext: vi.fn().mockResolvedValue('MOCK_ENV_CONTEXT')
}))

vi.mock('../../src/renderer/src/stores/whatsappStore', () => ({
    useWhatsAppStore: {
        getState: vi.fn().mockReturnValue({
            connectionState: { status: 'disconnected' },
            whatsappEnabled: false
        })
    }
}))

vi.mock('../../src/renderer/src/stores/personaStore', () => ({
    usePersonaStore: {
        getState: vi.fn().mockReturnValue({
            profile: null
        })
    }
}))

import { buildSystemPrompt } from '../../src/renderer/src/lib/llm/prompts'
import { usePersonaStore } from '../../src/renderer/src/stores/personaStore'

describe('System Prompt Generation', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('injects WA-Copilot defaults when persona profile is null', async () => {
        vi.mocked(usePersonaStore.getState).mockReturnValue({
            profile: null
        } as any)

        const prompt = await buildSystemPrompt([{ name: 'mock', description: 'desc' } as any])
        
        expect(prompt).toContain('You are WA-Copilot, the professional WhatsApp Support Agent for a Business')
        expect(prompt).toContain('MOCK_ENV_CONTEXT')
        expect(prompt).not.toContain('BUSINESS RULES')
    })

    it('injects dynamic name, industry, and tone from the store', async () => {
        vi.mocked(usePersonaStore.getState).mockReturnValue({
            profile: {
                name: 'BurgerBot',
                industry: 'Fast Food',
                tone: 'enthusiastic',
                coreKnowledge: []
            }
        } as any)

        const prompt = await buildSystemPrompt([{ name: 'mock', description: 'desc' } as any])
        
        expect(prompt).toContain('You are BurgerBot, the enthusiastic WhatsApp Support Agent for a Fast Food')
        expect(prompt).not.toContain('BUSINESS RULES')
    })

    it('appends custom business rules securely when provided', async () => {
        vi.mocked(usePersonaStore.getState).mockReturnValue({
            profile: {
                name: 'RuleBot',
                industry: 'Legal',
                tone: 'concise',
                coreKnowledge: [],
                customRules: 'Never give free fries. Always ask for case ID.'
            }
        } as any)

        const prompt = await buildSystemPrompt([{ name: 'mock', description: 'desc' } as any])
        
        expect(prompt).toContain('BUSINESS RULES:\nNever give free fries. Always ask for case ID.')
        expect(prompt).toContain('You are RuleBot, the concise WhatsApp Support Agent')
    })

    it('formats sub-agent prompts differently without injecting identity', async () => {
        const prompt = await buildSystemPrompt([{ name: 'mock', description: 'desc' } as any], undefined, false, undefined, true)
        
        expect(prompt).toContain('You are a focused sub-agent executing a delegated task')
        expect(prompt).not.toContain('WA-Copilot')
        expect(prompt).not.toContain('WhatsApp Support Agent')
    })
})
