import { LLM_CONFIG } from './constants'

export interface OpenRouterEnvDefaults {
    VITE_API_KEY?: string
    VITE_DEFAULT_MODEL?: string
}

function normalize(value?: string): string | undefined {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
}

export function getOpenRouterDefaultSettings(
    env: OpenRouterEnvDefaults = import.meta.env
): {
    preferredProvider: 'openrouter'
    openrouterApiKey: string
    openrouterModel: string
} {
    return {
        preferredProvider: 'openrouter',
        openrouterApiKey: normalize(env.VITE_API_KEY) ?? '',
        openrouterModel: normalize(env.VITE_DEFAULT_MODEL) ?? LLM_CONFIG.OPENROUTER.DEFAULT_MODEL,
    }
}

