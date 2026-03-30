import { describe, expect, it, beforeEach, vi } from 'vitest'

// Mock Electron IPC before importing the store
const invokeMock = vi.fn()
global.window = {
    // @ts-expect-error - mock
    electron: {
        ipcRenderer: {
            invoke: invokeMock
        }
    }
}

import { usePersonaStore } from '../../src/renderer/src/stores/personaStore'

describe('Persona Zustand Store', () => {

    beforeEach(() => {
        vi.clearAllMocks()
        // Reset Zustand store state
        usePersonaStore.setState({
            profile: null,
            isLoading: false,
            error: null
        })
    })

    it('fetches profile successfully via IPC', async () => {
        invokeMock.mockResolvedValueOnce({
            name: 'StoreBot',
            industry: 'Retail',
            tone: 'professional',
            coreKnowledge: [],
            customRules: 'Rule 1'
        })

        const store = usePersonaStore.getState()
        await store.fetchProfile()

        const state = usePersonaStore.getState()
        expect(invokeMock).toHaveBeenCalledWith('intelligence:get-persona')
        expect(state.isLoading).toBe(false)
        expect(state.error).toBeNull()
        expect(state.profile?.name).toBe('StoreBot')
        expect(state.profile?.customRules).toBe('Rule 1')
    })

    it('falls back to default profile if IPC fails', async () => {
        invokeMock.mockRejectedValueOnce(new Error('IPC Error'))

        const store = usePersonaStore.getState()
        await store.fetchProfile()

        const state = usePersonaStore.getState()
        expect(state.isLoading).toBe(false)
        expect(state.error).toBe('IPC Error')
        // Important fallback logic
        expect(state.profile?.name).toBe('AIConsumerAgent')
        expect(state.profile?.tone).toBe('professional')
    })

    it('performs optimistic updates and flushes to IPC', async () => {
        // Seed initial state
        usePersonaStore.setState({
            profile: {
                name: 'Initial',
                industry: 'Test',
                tone: 'casual',
                coreKnowledge: []
            }
        })

        const store = usePersonaStore.getState()
        await store.updateProfile({ name: 'Optimistic Bot', tone: 'enthusiastic' })

        // Check if state updated immediately
        const state = usePersonaStore.getState()
        expect(state.profile?.name).toBe('Optimistic Bot')
        expect(state.profile?.tone).toBe('enthusiastic')

        // Check if it triggered IPC update
        expect(invokeMock).toHaveBeenCalledWith('intelligence:update-persona', {
            name: 'Optimistic Bot',
            tone: 'enthusiastic'
        })
    })
})
