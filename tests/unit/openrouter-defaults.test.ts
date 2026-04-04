import { describe, expect, it } from 'vitest'
import { LLM_CONFIG } from '../../src/renderer/src/lib/constants'
import { getOpenRouterDefaultSettings } from '../../src/renderer/src/lib/openrouter-defaults'

describe('OpenRouter env defaults', () => {
    it('uses VITE_DEFAULT_MODEL and VITE_API_KEY when provided', () => {
        const defaults = getOpenRouterDefaultSettings({
            VITE_DEFAULT_MODEL: 'anthropic/claude-3.5-sonnet',
            VITE_API_KEY: 'or-key-123',
        })

        expect(defaults.preferredProvider).toBe('openrouter')
        expect(defaults.openrouterModel).toBe('anthropic/claude-3.5-sonnet')
        expect(defaults.openrouterApiKey).toBe('or-key-123')
    })

    it('trims env values and falls back when missing', () => {
        const defaults = getOpenRouterDefaultSettings({
            VITE_DEFAULT_MODEL: '  ',
            VITE_API_KEY: '  my-key  ',
        })

        expect(defaults.preferredProvider).toBe('openrouter')
        expect(defaults.openrouterModel).toBe(LLM_CONFIG.OPENROUTER.DEFAULT_MODEL)
        expect(defaults.openrouterApiKey).toBe('my-key')
    })
})

