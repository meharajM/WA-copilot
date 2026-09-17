import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { VOICE_CONFIG, LLM_CONFIG, STORAGE_KEYS } from '../lib/constants'
import electron from '../lib/electron'
import { getUserProfile } from '../lib/firebase'
import { getBrowserAgentdClient } from '../lib/browser-agentd-client'
import { isTauriRuntime } from '../lib/tauri-native-bridge'
import type { ProductPreferences } from '../../../shared/native-bridge'

export type Theme = 'dark' | 'light' | 'system'
export type LLMProviderType = 'auto' | 'ollama' | 'openai' | 'gemini' | 'openrouter' | 'browser' | 'anthropic' | 'groq'
export type PlaywrightBrowserType = 'auto' | 'chrome' | 'msedge' | 'firefox' | 'webkit' | 'chromium'

interface SettingsState {
    // Voice settings
    ttsEnabled: boolean
    ttsRate: number
    ttsPitch: number
    ttsVoice: string | null
    speechLang: string
    offlineSpeech: boolean
    voskModel: string

    // LLM settings
    preferredProvider: LLMProviderType
    ollamaModel: string
    ollamaBaseUrl: string
    openaiApiKey: string
    openaiBaseUrl: string
    openaiModel: string
    geminiApiKey: string
    geminiModel: string
    openrouterApiKey: string
    openrouterModel: string
    browserModel: string

    // Appearance
    theme: Theme

    // MCP Playwright Browser settings
    playwrightBrowser: PlaywrightBrowserType
    playwrightHeadless: boolean

    // MCP FileSystem settings
    fileSystemSafeMode: boolean

    // Sync State
    activeUserId: string | null
    isSyncing: boolean
    lastSyncTime: number

    // Actions
    setTtsEnabled: (enabled: boolean) => void
    setTtsRate: (rate: number) => void
    setTtsPitch: (pitch: number) => void
    setTtsVoice: (voice: string | null) => void
    setSpeechLang: (lang: string) => void
    setOfflineSpeech: (enabled: boolean) => void
    setVoskModel: (model: string) => void
    setPreferredProvider: (provider: LLMProviderType) => void
    setOllamaModel: (model: string) => void
    setOllamaBaseUrl: (url: string) => void
    setOpenaiApiKey: (key: string) => void
    setOpenaiBaseUrl: (url: string) => void
    setOpenaiModel: (model: string) => void
    setGeminiApiKey: (key: string) => void
    setGeminiModel: (model: string) => void
    setOpenrouterApiKey: (key: string) => void
    setOpenrouterModel: (model: string) => void
    setBrowserModel: (model: string) => void
    setTheme: (theme: Theme) => void
    setPlaywrightBrowser: (browser: PlaywrightBrowserType) => void
    setPlaywrightHeadless: (headless: boolean) => void
    setFileSystemSafeMode: (enabled: boolean) => void

    // Memory Settings
    memoryBackend: 'sqlite' | 'server-memory'
    setMemoryBackend: (backend: 'sqlite' | 'server-memory') => void

    resetToDefaults: () => void

    // Sync Actions
    setActiveUserId: (uid: string | null) => void
    loadRemoteSettings: (uid: string) => Promise<void>
    loadAgentdSettings: () => Promise<void>
    hydrateSettings: (settings: Partial<SettingsState>) => void
    loadUserSecrets: (uid: string) => Promise<void>
    clearUserSecrets: () => void
    forceSync: () => Promise<void>
    setIsSyncing: (isSyncing: boolean) => void
}

const defaultSettings = {
    ttsEnabled: true,
    ttsRate: 1,
    ttsPitch: 1,
    ttsVoice: null,
    speechLang: VOICE_CONFIG.SPEECH_LANG,
    // Force offline speech in Electron, enforce online in browser
    offlineSpeech: !!(window.electron),
    voskModel: 'en-us',
    preferredProvider: 'auto' as LLMProviderType,
    ollamaModel: LLM_CONFIG.OLLAMA.DEFAULT_MODEL,
    ollamaBaseUrl: LLM_CONFIG.OLLAMA.BASE_URL,
    openaiApiKey: '',
    openaiBaseUrl: 'https://api.openai.com/v1',
    openaiModel: LLM_CONFIG.OPENAI_COMPATIBLE.DEFAULT_MODEL,
    geminiApiKey: '',
    geminiModel: LLM_CONFIG.GEMINI.DEFAULT_MODEL,
    openrouterApiKey: '',
    openrouterModel: LLM_CONFIG.OPENROUTER.DEFAULT_MODEL,
    browserModel: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', // Default small model
    theme: 'dark' as Theme,
    playwrightBrowser: 'auto' as PlaywrightBrowserType, // Auto-detect based on OS
    playwrightHeadless: false, // Default to headed for user visibility
    fileSystemSafeMode: true, // Default to safe mode (shadow writes)
    memoryBackend: 'sqlite' as 'sqlite' | 'server-memory',
    activeUserId: null,
    isSyncing: false,
    lastSyncTime: 0,
}

const isBrowserProduct = (): boolean => (
    typeof window !== 'undefined' && !window.electron && !isTauriRuntime()
)

const isAgentdProvider = (provider: LLMProviderType): provider is 'auto' | 'openai' | 'openrouter' => (
    provider === 'auto' || provider === 'openai' || provider === 'openrouter'
)

const syncBrowserLlmSettings = (state: Pick<SettingsState, 'preferredProvider' | 'openaiModel' | 'openrouterModel'>): void => {
    if (!isBrowserProduct() || !isAgentdProvider(state.preferredProvider)) return
    void getBrowserAgentdClient().saveLlmSettings({
        preferredProvider: state.preferredProvider,
        openaiModel: state.openaiModel,
        openrouterModel: state.openrouterModel,
    }).catch((error) => console.warn('[Settings] Failed to persist browser LLM settings:', error))
}

const browserPreferencesFrom = (state: Pick<SettingsState, keyof ProductPreferences>): ProductPreferences => ({
    theme: state.theme,
    playwrightBrowser: state.playwrightBrowser,
    playwrightHeadless: state.playwrightHeadless,
    fileSystemSafeMode: state.fileSystemSafeMode,
    memoryBackend: state.memoryBackend,
    ttsEnabled: state.ttsEnabled,
    ttsRate: state.ttsRate,
    ttsPitch: state.ttsPitch,
    ttsVoice: state.ttsVoice,
    speechLang: state.speechLang,
    offlineSpeech: state.offlineSpeech,
    voskModel: state.voskModel,
    browserModel: state.browserModel,
})

const syncBrowserPreferences = (state: SettingsState): void => {
    if (!isBrowserProduct()) return
    void getBrowserAgentdClient().saveProductPreferences(browserPreferencesFrom(state)).catch((error) => {
        console.warn('[Settings] Failed to persist browser preferences:', error)
    })
}

const createSettingsStorage = () => ({
    getItem: async (name: string): Promise<string | null> => {
        if (isBrowserProduct()) {
            try {
                const preferences = await getBrowserAgentdClient().getProductPreferences()
                return JSON.stringify({ state: preferences, version: 0 })
            } catch (error) {
                console.warn('[Settings] Browser preferences unavailable:', error)
                return null
            }
        }
        const value = await electron.store.get(name)
        return value ? JSON.stringify(value) : null
    },
    setItem: async (name: string, value: string): Promise<void> => {
        if (isBrowserProduct()) {
            const parsed = JSON.parse(value) as { state?: SettingsState }
            if (parsed.state) await getBrowserAgentdClient().saveProductPreferences(browserPreferencesFrom(parsed.state))
            return
        }
        await electron.store.set(name, JSON.parse(value))
    },
    removeItem: async (name: string): Promise<void> => {
        if (isBrowserProduct()) return
        await electron.store.delete(name)
    },
})

// ... existing migration code ...

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set, get) => ({
            ...defaultSettings,


            setTtsEnabled: (enabled) => { set({ ttsEnabled: enabled }); syncBrowserPreferences({ ...get(), ttsEnabled: enabled }) },
            setTtsRate: (rate) => { set({ ttsRate: rate }); syncBrowserPreferences({ ...get(), ttsRate: rate }) },
            setTtsPitch: (pitch) => { set({ ttsPitch: pitch }); syncBrowserPreferences({ ...get(), ttsPitch: pitch }) },
            setTtsVoice: (voice) => { set({ ttsVoice: voice }); syncBrowserPreferences({ ...get(), ttsVoice: voice }) },
            setSpeechLang: (lang) => { set({ speechLang: lang }); syncBrowserPreferences({ ...get(), speechLang: lang }) },
            setOfflineSpeech: (enabled) => { set({ offlineSpeech: enabled }); syncBrowserPreferences({ ...get(), offlineSpeech: enabled }) },
            setVoskModel: (model: string) => { set({ voskModel: model }); syncBrowserPreferences({ ...get(), voskModel: model }) },
            setPreferredProvider: (provider) => {
                set({ preferredProvider: provider })
                syncBrowserLlmSettings({ ...get(), preferredProvider: provider })
            },
            setOllamaModel: (model) => set({ ollamaModel: model }),
            setOllamaBaseUrl: (url) => set({ ollamaBaseUrl: url }),
            setOpenaiApiKey: async (key) => {
                set({ openaiApiKey: key })
                if (isBrowserProduct()) return
                const uid = get().activeUserId || undefined
                // Store API key in encrypted secure storage
                await electron.secure.set('openai_api_key', key || '', uid)
            },
            setOpenaiBaseUrl: async (url) => {
                set({ openaiBaseUrl: url })
                if (isBrowserProduct()) return
                const uid = get().activeUserId
                // Base URL is not sensitive, use regular store
                const storeKey = uid ? `user_${uid}_openai_base_url` : 'openai_base_url'
                await electron.store.set(storeKey, url)
            },
            setOpenaiModel: (model) => {
                set({ openaiModel: model })
                syncBrowserLlmSettings({ ...get(), openaiModel: model })
            },
            setGeminiApiKey: async (key) => {
                set({ geminiApiKey: key })
                if (isBrowserProduct()) return
                const uid = get().activeUserId || undefined
                // Store API key in encrypted secure storage
                await electron.secure.set('gemini_api_key', key || '', uid)
            },
            setGeminiModel: (model) => set({ geminiModel: model }),
            setOpenrouterApiKey: async (key) => {
                set({ openrouterApiKey: key })
                if (isBrowserProduct()) return
                const uid = get().activeUserId || undefined
                // Store API key in encrypted secure storage
                await electron.secure.set('openrouter_api_key', key || '', uid)
            },
            setOpenrouterModel: (model) => {
                set({ openrouterModel: model })
                syncBrowserLlmSettings({ ...get(), openrouterModel: model })
            },
            setBrowserModel: (model) => { set({ browserModel: model }); syncBrowserPreferences({ ...get(), browserModel: model }) },
            setTheme: (theme) => { set({ theme }); syncBrowserPreferences({ ...get(), theme }) },
            setPlaywrightBrowser: async (browser) => {
                set({ playwrightBrowser: browser })
                if (isBrowserProduct()) { syncBrowserPreferences({ ...get(), playwrightBrowser: browser }); return }
                // Also save to main process store for PlaywrightService to read
                const browserValue = browser === 'auto' ? undefined : browser
                await electron.store.set('mcpPlaywright', { browser: browserValue })
            },
            setPlaywrightHeadless: async (headless) => {
                set({ playwrightHeadless: headless })
                if (isBrowserProduct()) { syncBrowserPreferences({ ...get(), playwrightHeadless: headless }); return }
                // Also save to main process store for PlaywrightService to read
                const current = await electron.store.get<Record<string, unknown>>('mcpPlaywright') || {}
                await electron.store.set('mcpPlaywright', { ...current, headless })
            },
            setFileSystemSafeMode: async (enabled) => {
                set({ fileSystemSafeMode: enabled })
                if (isBrowserProduct()) { syncBrowserPreferences({ ...get(), fileSystemSafeMode: enabled }); return }
                // Save to main process store for FileSystemService to read
                const current = await electron.store.get<Record<string, unknown>>('mcpFileSystem') || {}
                await electron.store.set('mcpFileSystem', { ...current, safeMode: enabled })
            },
            setMemoryBackend: async (backend) => {
                set({ memoryBackend: backend })
                if (isBrowserProduct()) { syncBrowserPreferences({ ...get(), memoryBackend: backend }); return }
                // Update main process store (triggers migration check if changed via UI, though usually handled by IPC)
                // We store complete config structure
                const current = await electron.store.get<Record<string, unknown>>('memory') || {}
                await electron.store.set('memory', { ...current, backend })
            },
            resetToDefaults: () => { set(defaultSettings); syncBrowserPreferences({ ...get(), ...defaultSettings }) },

            setActiveUserId: (uid) => set({ activeUserId: uid }),

            hydrateSettings: (remoteSettings: Partial<SettingsState>) => {
                set((state) => ({
                    ...state,
                    ...remoteSettings,
                    isSyncing: false,
                    lastSyncTime: Date.now()
                }))
            },

            loadAgentdSettings: async () => {
                if (!isBrowserProduct()) return
                const client = getBrowserAgentdClient()
                const [saved, preferences] = await Promise.all([client.getLlmSettings(), client.getProductPreferences()])
                set({
                    preferredProvider: saved.preferredProvider,
                    openaiModel: saved.openaiModel,
                    openrouterModel: saved.openrouterModel,
                    // Credential values are intentionally never read back from agentd.
                    openaiApiKey: '',
                    openrouterApiKey: '',
                    ...preferences,
                })
            },

            loadUserSecrets: async (uid: string) => {
                set({ activeUserId: uid })
                // Load scoped secrets from encrypted secure storage
                const openaiResult = await electron.secure.get('openai_api_key', uid)
                const geminiResult = await electron.secure.get('gemini_api_key', uid)
                const openrouterResult = await electron.secure.get('openrouter_api_key', uid)
                // Base URL is not sensitive, use regular store
                const openaiUrl = await electron.store.get<string>(`user_${uid}_openai_base_url`)

                set({
                    openaiApiKey: openaiResult.value || '',
                    openaiBaseUrl: openaiUrl || 'https://api.openai.com/v1',
                    geminiApiKey: geminiResult.value || '',
                    openrouterApiKey: openrouterResult.value || ''
                })
                console.log(`[Settings] Loaded secrets for user ${uid} (encrypted: ${openaiResult.encrypted})`)
            },

            clearUserSecrets: () => {
                set({
                    activeUserId: null,
                    openaiApiKey: '',
                    geminiApiKey: '',
                    openrouterApiKey: ''
                    // We might typically clear Base URL too, or leave it as default?
                    // Let's clear it to be safe/reset to default
                })
                console.log('[Settings] Cleared user secrets from memory')
            },

            loadRemoteSettings: async (uid) => {
                if (!uid) return
                set({ isSyncing: true })
                try {
                    const remoteData = await getUserProfile(uid)
                    if (remoteData && remoteData.settings) {
                        console.log('[Settings] Loaded remote settings:', remoteData.settings)
                        // Merge remote settings with local defaults/current
                        // We filter out API keys from remote sync if we decided not to store them
                        // But for now, we just merge what we get, excluding potentially sensitive defaults if needed.
                        // Assuming remote settings structure matches store partially.

                        // Extract only syncable fields
                        const {
                            theme,
                            preferredProvider,
                            ollamaModel,
                            ollamaBaseUrl,
                            // api keys might not be there if we don't save them
                            openaiModel,
                            geminiModel,
                            openrouterModel,
                            browserModel,
                            ttsEnabled,
                            ttsRate,
                            ttsPitch,
                            ttsVoice,
                            speechLang
                        } = remoteData.settings

                        set((state) => ({
                            ...state,
                            theme: theme ?? state.theme,
                            preferredProvider: preferredProvider ?? state.preferredProvider,
                            ollamaModel: ollamaModel ?? state.ollamaModel,
                            ollamaBaseUrl: ollamaBaseUrl ?? state.ollamaBaseUrl,
                            openaiModel: openaiModel ?? state.openaiModel,
                            geminiModel: geminiModel ?? state.geminiModel,
                            openrouterModel: openrouterModel ?? state.openrouterModel,
                            browserModel: browserModel ?? state.browserModel,
                            ttsEnabled: ttsEnabled ?? state.ttsEnabled,
                            ttsRate: ttsRate ?? state.ttsRate,
                            ttsPitch: ttsPitch ?? state.ttsPitch,
                            ttsVoice: ttsVoice ?? state.ttsVoice,
                            speechLang: speechLang ?? state.speechLang,
                            isSyncing: false,
                            lastSyncTime: Date.now()
                        }))
                    } else {
                        set({ isSyncing: false })
                    }
                } catch (error) {
                    console.error('[Settings] Failed to load remote settings:', error)
                    set({ isSyncing: false })
                }
            },

            forceSync: async () => {
                const state = get()
                if (!state.activeUserId) return
                // Trigger the debounced sync immediately or calling save directly
                // implementation handled by subscription
            },

            setIsSyncing: (isSyncing) => set({ isSyncing })
        }),
        {
            name: STORAGE_KEYS.SETTINGS,
            // Provider credentials stay in OS/agentd storage. Never persist them
            // in renderer state (including browser localStorage).
            partialize: (state) => {
                const { openaiApiKey: _openaiApiKey, geminiApiKey: _geminiApiKey, openrouterApiKey: _openrouterApiKey, ...safeState } = state
                return safeState
            },
            storage: createJSONStorage(() => createSettingsStorage()),
            // Force offlineSpeech to true in Electron after rehydration
            onRehydrateStorage: () => (state) => {
                if (state && window.electron) {
                    if ((state.memoryBackend as string) === 'memento-mcp') {
                        console.warn('[Settings] Memento MCP is unavailable; reverting memory backend to SQLite')
                        void state.setMemoryBackend('sqlite')
                    }
                    // In Electron, always use offline speech (native Vosk)
                    if (!state.offlineSpeech) {
                        console.log('[Settings] Forcing offlineSpeech=true in Electron environment')
                        state.setOfflineSpeech(true)
                    }
                }
            },
        }
    )
)
