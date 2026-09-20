/**
 * whatsappStore.ts — Zustand store for WhatsApp connection state.
 *
 * Owns: connection state, message mode toggle, and target phone number.
 * Subscribes to IPC push events (whatsapp:connection-change, whatsapp:message)
 * via the useWhatsAppBridge hook — NOT here directly.
 *
 * Per zustand-stores.md: stores do not import each other, no class instances
 * are persisted, and all async callbacks read state via getState().
 */

import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import { getBrowserAgentdClient, type BrowserWhatsAppUiSettings } from '../lib/browser-agentd-client'
import { isTauriRuntime } from '../lib/tauri-native-bridge'

const isBrowserProduct = (): boolean => typeof window !== 'undefined' && !window.electron && !isTauriRuntime()

const hasBrowserSession = (): boolean => {
    if (typeof window === 'undefined') return false
    const token = (window as Window & { __AICA_AGENTD_CSRF_TOKEN__?: unknown }).__AICA_AGENTD_CSRF_TOKEN__
    return typeof token === 'string' && token.length > 0
}

const validPhone = (value: unknown): value is string => typeof value === 'string'
    && value.length <= 32
    && /^\+?[0-9\s().-]+$/.test(value)
    && /^\d{8,15}$/.test(value.replace(/\D/g, ''))

const toBrowserSettings = (value: unknown): BrowserWhatsAppUiSettings => {
    const state = (value && typeof value === 'object' && !Array.isArray(value))
        ? value as { whatsappEnabled?: unknown; businessBotMode?: unknown; targetPhoneNumber?: unknown }
        : {}
    return {
        whatsappEnabled: state.whatsappEnabled === true,
        businessBotMode: state.businessBotMode === true,
        targetPhoneNumber: validPhone(state.targetPhoneNumber) ? state.targetPhoneNumber : null,
    }
}

const encodeBrowserState = (settings: BrowserWhatsAppUiSettings): string => JSON.stringify({
    state: {
        ...settings,
    },
    version: 0,
})

const createBrowserWhatsAppStorage = (): StateStorage => ({
    getItem: async (name: string) => {
        if (!hasBrowserSession()) return null
        const client = getBrowserAgentdClient()
        let settings = await client.getWhatsAppUiSettings()
        const legacy = window.localStorage.getItem(name)
        if (legacy) {
            let legacyState: unknown
            try {
                const parsed = JSON.parse(legacy) as unknown
                legacyState = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                    ? (parsed as { state?: unknown }).state
                    : undefined
            } catch {
                window.localStorage.removeItem(name)
            }
            const migrated = toBrowserSettings(legacyState)
            if ((migrated.whatsappEnabled || migrated.businessBotMode || migrated.targetPhoneNumber)
                && !settings.whatsappEnabled && !settings.businessBotMode && !settings.targetPhoneNumber) {
                try {
                    settings = await client.saveWhatsAppUiSettings(migrated)
                } catch {
                    // Keep the legacy value for a later paired retry if the
                    // daemon is temporarily unavailable during hydration.
                    return encodeBrowserState(settings)
                }
            }
            // The old browser-only copy is never authoritative after the
            // paired agentd store has been consulted.
            window.localStorage.removeItem(name)
        }
        return encodeBrowserState(settings)
    },
    setItem: async (_name: string, value: string) => {
        if (!hasBrowserSession()) return
        const parsed = JSON.parse(value) as { state?: unknown }
        await getBrowserAgentdClient().saveWhatsAppUiSettings(toBrowserSettings(parsed.state))
    },
    removeItem: async () => {
        if (!hasBrowserSession()) return
        await getBrowserAgentdClient().saveWhatsAppUiSettings({ whatsappEnabled: false, businessBotMode: false, targetPhoneNumber: null })
    },
})

export interface WhatsAppConnectionState {
    status: 'disconnected' | 'connecting' | 'qr_required' | 'connected' | 'logged_out' | 'blocked' | 'error'
    qrCode: string | null
    error: string | null
    phoneNumber: string | null
    workerNumber: string | null
    handshakeStatus: 'idle' | 'pending' | 'expired' | 'verified' | null
}

interface WhatsAppState {
    /** Remote connection state mirrored from main process */
    connectionState: WhatsAppConnectionState

    /** Whether "WhatsApp mode" is active for the current chat session */
    whatsappEnabled: boolean

    /** Whether "Business Bot Mode" is active (responds to all incoming messages) */
    businessBotMode: boolean

    /** Phone number the user wants to send messages to */
    targetPhoneNumber: string | null

    /** Whether the connection dialog is open */
    isDialogOpen: boolean

    // ── Persisted actions ──────────────────────────────────────────────────
    setWhatsAppEnabled: (enabled: boolean) => void
    setBusinessBotMode: (enabled: boolean) => void
    setTargetPhoneNumber: (number: string | null) => void
    openDialog: () => void
    closeDialog: () => void

    // ── Runtime-only actions (not persisted) ───────────────────────────────
    /** Called by useWhatsAppBridge when main pushes a new connection state */
    setConnectionState: (state: WhatsAppConnectionState) => void
}

export const useWhatsAppStore = create<WhatsAppState>()(
    persist(
        (set) => ({
            connectionState: {
                status: 'disconnected',
                qrCode: null,
                error: null,
                phoneNumber: null,
                workerNumber: null,
                handshakeStatus: 'idle',
            },
            whatsappEnabled: false,
            businessBotMode: false,
            targetPhoneNumber: null,
            isDialogOpen: false,

            setWhatsAppEnabled: (enabled) => set({ whatsappEnabled: enabled }),
            setBusinessBotMode: (enabled) => set({ businessBotMode: enabled }),
            setTargetPhoneNumber: (number) => set({ targetPhoneNumber: number }),
            openDialog: () => set({ isDialogOpen: true }),
            closeDialog: () => set({ isDialogOpen: false }),
            setConnectionState: (state) => set({ connectionState: state }),
        }),
        {
            name: 'aica-whatsapp-v1',
            storage: createJSONStorage(() => isBrowserProduct() ? createBrowserWhatsAppStorage() : localStorage),
            partialize: (state) => ({
                whatsappEnabled: state.whatsappEnabled,
                businessBotMode: state.businessBotMode,
                targetPhoneNumber: state.targetPhoneNumber,
                // connectionState is NOT persisted — always fresh from main on startup
                // isDialogOpen is NOT persisted — always start closed
            }),
        }
    )
)
