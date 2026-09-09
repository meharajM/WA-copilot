// Global type declarations for AIConsumerAgent
// This file ensures TypeScript recognizes window.electron

// Electron API type (matches preload/index.ts)
interface ElectronAPI {
    platform: string

    mcp: {
        authorize: () => Promise<{ success: boolean; token?: string; error?: string }>
        connect: (serverConfig: unknown) => Promise<{ success: boolean; serverId?: string; error?: string }>
        disconnect: (serverId: string) => Promise<{ success: boolean }>
        listTools: (serverId: string) => Promise<{ tools: Array<{ name: string; description: string }> }>
        callTool: (serverId: string, toolName: string, args: unknown, requestId?: string) => Promise<{ result: unknown }>
        cancelTool: (requestId: string) => Promise<{ success: boolean; error?: string }>
    }

    llm: {
        chat: (messages: unknown[], tools?: unknown[]) => Promise<unknown>
        getProviders: () => Promise<Record<string, { available: boolean }>>
        fetchOpenAIModels: (baseUrl: string, apiKey: string) => Promise<{ success: boolean; models?: string[]; error?: string }>
        fetchOllamaModels: (baseUrl: string) => Promise<{ success: boolean; models?: string[]; error?: string }>
    }

    store: {
        get: (key: string) => Promise<unknown>
        set: (key: string, value: unknown) => Promise<boolean>
        delete: (key: string) => Promise<boolean>
    }

    shell: {
        openExternal: (url: string) => Promise<void>
    }

    app: {
        getVersion: () => Promise<string>
        getName: () => Promise<string>
        selectFolder: () => Promise<string | null>
        getMissingDependencies: () => Promise<any[]>
        getAllDependencies: () => Promise<any[]>
        runSetupScript: () => Promise<void>
    }

    speech: {
        checkSupport: (modelId?: string) => Promise<{
            supported: boolean
            modelDownloaded: boolean
            modelsPath: string
            error: string | null
        }>
        initialize: (options?: { modelName?: string }) => Promise<{ success: boolean; error?: string }>
        startListening: () => Promise<{ success: boolean; error?: string; message?: string }>
        stopListening: () => Promise<{ success: boolean; error?: string; message?: string }>
        processAudio: (audioData: ArrayBuffer) => Promise<{
            success: boolean
            isFinal?: boolean
            transcript?: string
            error?: string
        }>
        getFinalResult: () => Promise<{ success: boolean; transcript?: string; error?: string }>
        downloadModel: (options: { modelId: string; url: string; modelName: string }) => Promise<{
            success: boolean
            error?: string
        }>
        getPreferredModel: () => Promise<{ id: string; name: string; url: string; lang: string }>
        getModelPath: (modelName: string) => Promise<string | null>
        getStatus: (modelId?: string) => Promise<{
            isInitialized: boolean
            isListening: boolean
            error: string | null
            modelsPath: string
            modelDownloaded: boolean
        }>
        cleanup: () => Promise<{ success: boolean; error?: string }>
        onResult: (callback: (result: { text: string; final: boolean }) => void) => () => void
        onDownloadProgress: (callback: (data: { modelId: string; progress: number }) => void) => () => void
    }

    clipboard: {
        readFilePaths: () => string[]
    }

    utils: {
        getPathForFile: (file: File) => string
    }

    intelligence?: {
        getKnowledge: () => Promise<Array<{ id: number; file_path: string; file_name: string; created_at: string }>>
        deleteKnowledge: (id: number) => Promise<boolean>
        getPersona: () => Promise<unknown>
        updatePersona: (updates: Record<string, unknown>) => Promise<unknown>
        getLogs: (limit?: number) => Promise<{ success: boolean; logs?: Array<{ id: number; type: string; event: string; details?: string; timestamp?: string }>; error?: string }>
        getStats: () => Promise<{ success: boolean; stats?: { totalQueries: number; resolvedQueries: number; autonomyRate: number; trainingCount: number; learningCount: number }; error?: string }>
        logAccuracy: (payload: { event: string; details?: string }) => Promise<{ success: boolean; error?: string }>
    }
    autonomy: {
        getState: () => Promise<any>
        getHealth: () => Promise<any>
        getMetrics: (days?: number) => Promise<any>
        reconnectChannel: () => Promise<any>
        start: () => Promise<any>
        stop: () => Promise<any>
        pause: (emergency?: boolean) => Promise<any>
        resume: () => Promise<any>
        enterRecoveryMode: (reason?: string) => Promise<any>
        clearRecoveryMode: () => Promise<any>
        stageBackup: (backupPath: string) => Promise<any>
        pruneRetention: () => Promise<any>
        pauseConversation: (jid: string) => Promise<any>
        resumeConversation: (jid: string) => Promise<any>
        retryDelivery: (inboundId: string) => Promise<any>
        quarantineDelivery: (inboundId: string) => Promise<any>
        cancelOutbound: (inboundId: string) => Promise<any>
        listApprovedTemplates: () => Promise<any>
        listTakeovers: () => Promise<any>
        listDrafts: () => Promise<any>
        listUnresolvedOutbound: () => Promise<any>
        listDeliveryHistory: (limit?: number) => Promise<any>
        listDecisionEvidence: (limit?: number) => Promise<any>
        usageHistory: (days?: number) => Promise<any>
        approveDraft: (inboundId: string) => Promise<any>
        sendApprovedTemplate: (inboundId: string, name: string, languageCode: string, parameters?: string[]) => Promise<any>
        listNotifications: () => Promise<any>
        ackNotification: (id: number) => Promise<any>
        onNotification: (callback: (data: any) => void) => () => void
        registerApprovedTemplate: (name: string, languageCode: string, category: string) => Promise<any>
        revokeApprovedTemplate: (name: string, languageCode: string) => Promise<any>
        setMode: (mode: string, responsePermission: boolean) => Promise<any>
        onState: (callback: (state: any) => void) => () => void
        onDecision: (callback: (data: any) => void) => () => void
        onFailure: (callback: (data: any) => void) => () => void
    }
}

// Extend the Window interface globally
declare global {
    interface Window {
        electron?: ElectronAPI
        SpeechRecognition?: typeof SpeechRecognition
        webkitSpeechRecognition?: typeof SpeechRecognition
    }
}

export { }
