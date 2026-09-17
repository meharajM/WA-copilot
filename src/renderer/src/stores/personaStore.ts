import { create } from 'zustand'
import { getBrowserAgentdClient } from '../lib/browser-agentd-client'
import { isTauriRuntime } from '../lib/tauri-native-bridge'

export interface BusinessProfile {
    name: string
    industry: string
    tone: 'professional' | 'casual' | 'enthusiastic' | 'concise'
    coreKnowledge: string[]
    customRules?: string
}

interface PersonaState {
    profile: BusinessProfile | null
    isLoading: boolean
    error: string | null
    
    // Actions
    fetchProfile: () => Promise<void>
    updateProfile: (updates: Partial<BusinessProfile>) => Promise<void>
}

export const usePersonaStore = create<PersonaState>((set, get) => ({
    profile: null,
    isLoading: true,
    error: null,

    fetchProfile: async () => {
        try {
            set({ isLoading: true, error: null })
            const browserRuntime = typeof window !== 'undefined' && !window.electron && !isTauriRuntime()
            if (browserRuntime) {
                const profile = await getBrowserAgentdClient().getPersonaSettings()
                set({ profile, isLoading: false })
                return
            }
            const intelligence = window.electron?.intelligence
            if (intelligence) {
                const profile = await intelligence.getPersona()
                set({ profile, isLoading: false })
            } else {
                throw new Error("Electron IPC not available")
            }
        } catch (error) {
            const err = error as Error;
            if (typeof window !== 'undefined' && window.electron) console.error('[PersonaStore] Failed to fetch profile:', err)
            set({ error: err.message, isLoading: false })
            
            // Fallback default if running outside electron/dev mode
            set({
                profile: {
                    name: 'AIConsumerAgent',
                    industry: 'Tech Support',
                    tone: 'professional',
                    coreKnowledge: []
                },
                isLoading: false
            })
        }
    },

    updateProfile: async (updates: Partial<BusinessProfile>) => {
        try {
            // Optimistic update
            const currentProfile = get().profile;
            const newProfile = currentProfile ? { ...currentProfile, ...updates } : updates as BusinessProfile;
            set({ profile: newProfile })

            // Sync to backend
            const browserRuntime = typeof window !== 'undefined' && !window.electron && !isTauriRuntime()
            if (browserRuntime) {
                const saved = await getBrowserAgentdClient().savePersonaSettings(newProfile)
                set({ profile: saved, error: null })
                return
            }
            const intelligence = window.electron?.intelligence
            if (intelligence) {
                await intelligence.updatePersona(updates)
            }
        } catch (error) {
            const err = error as Error;
            if (typeof window !== 'undefined' && window.electron) console.error('[PersonaStore] Failed to update profile:', err)
            set({ error: err.message })
            // Revert on failure (simple implementation)
            get().fetchProfile();
        }
    }
}))

// Auto-initialize when store is required
usePersonaStore.getState().fetchProfile()
