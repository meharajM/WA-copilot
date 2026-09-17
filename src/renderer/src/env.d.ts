/// <reference types="vite/client" />

// Vite environment variables
interface ImportMetaEnv {
    readonly VITE_FIREBASE_API_KEY?: string
    readonly VITE_FIREBASE_AUTH_DOMAIN?: string
    readonly VITE_FIREBASE_PROJECT_ID?: string
    readonly VITE_FIREBASE_STORAGE_BUCKET?: string
    readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string
    readonly VITE_FIREBASE_APP_ID?: string
    readonly VITE_RECAPTCHA_SITE_KEY?: string
}

interface ImportMeta {
    readonly env: ImportMetaEnv
}

// Electron API exposed via preload
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
        selectFile: (options: { title?: string, buttonLabel?: string, filters?: Array<{ name: string, extensions: string[] }> }) => Promise<string | null>
        selectFiles: (options: { title?: string, buttonLabel?: string, filters?: Array<{ name: string, extensions: string[] }> }) => Promise<string[] | null>
    }

    logs?: {
        add: (entry: unknown) => Promise<void>
        getPath: () => Promise<string>
        openFolder: () => Promise<void>
    }

    secure?: {
        isAvailable: () => Promise<boolean>
        set: (key: string, value: string, userId?: string) => Promise<{ success: boolean; encrypted?: boolean; error?: string }>
        get: (key: string, userId?: string) => Promise<{ success: boolean; value?: string | null; encrypted?: boolean; error?: string }>
        delete: (key: string, userId?: string) => Promise<{ success: boolean; error?: string }>
        listKeys: (userId?: string) => Promise<{ success: boolean; keys?: string[]; error?: string }>
    }

    fs: {
        getPendingChanges: () => Promise<Array<{
            id: string
            originalPath: string
            shadowPath: string
            type: 'create' | 'modify' | 'delete'
            content?: string
            timestamp: number
        }>>
        approveChange: (changeId: string) => Promise<{ success: boolean; error?: string }>
        rejectChange: (changeId: string) => Promise<{ success: boolean; error?: string }>
        writeInternalFile: (workspacePath: string | undefined, filename: string, content: string) =>
            Promise<{ success: boolean; path?: string; error?: string }>
        readInternalFile: (workspacePath: string | undefined, filename: string) =>
            Promise<{ success: boolean; content?: string; error?: string }>
        readFileBase64: (filePath: string) =>
            Promise<{ success: boolean; content?: string; error?: string }>
    }

    memory: {
        runTests: () => Promise<{ success: boolean; result?: { results: string[]; passed: boolean }; error?: string }>
        getStats: () => Promise<{
            success: boolean
            stats?: {
                entityCount: number
                relationCount: number
                storageSize: number
                avgSearchLatency: number
                backend: string
            }
            error?: string
        }>
        exportAll: () => Promise<{ success: boolean; data?: { entities: any[]; relations: any[] }; error?: string }>
        callTool: (name: string, args: any) => Promise<{ success: boolean; result?: any; error?: string }>
        migrate: () => Promise<{ success: boolean; result?: any; error?: string }>
        checkMigration: () => Promise<{ success: boolean; shouldMigrate?: boolean; error?: string }>
        openFileLocation: () => Promise<{ success: boolean; error?: string }>
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

    antigravity?: {
        initialize: () => Promise<{ signedIn: boolean; email: string | null; projectId: string | null }>
        signIn: () => Promise<{ signedIn: boolean; email: string | null; projectId: string | null }>
        getToken: () => Promise<{ token: string | null; headers: Record<string, string> | null }>
        signOut: () => Promise<{ success: boolean }>
        getStatus: () => Promise<{ signedIn: boolean; email: string | null; projectId: string | null }>
        callGateway: (url: string, headers: Record<string, string>, body: string) => Promise<any>
    }

    clipboard: {
        readFilePaths: () => string[]
    }

    whatsapp?: {
        getState: () => Promise<{
            status: 'disconnected' | 'connecting' | 'qr_required' | 'connected' | 'logged_out' | 'blocked' | 'error'
            qrCode: string | null
            error: string | null
            phoneNumber: string | null
            workerNumber: string | null
        }>
        connect: (phoneNumber?: string) => Promise<{ success: boolean; error?: string }>
        setTargetNumber: (phoneNumber: string) => Promise<{ success: boolean; error?: string }>
        disconnect: (clearAuth?: boolean) => Promise<{ success: boolean; error?: string }>
        sendMessage: (to: string, content: string) => Promise<{ success: boolean; error?: string }>
        sendPresence: (to: string, state: string) => Promise<{ success: boolean; error?: string }>
        sendMediaMessage: (to: string, filePath: string, caption?: string, type?: string) => Promise<{ success: boolean; error?: string }>
        onConnectionChange: (callback: (state: unknown) => void) => () => void
        onMessage: (callback: (message: unknown) => void) => () => void
        onEscalation: (callback: (data: unknown) => void) => () => void
        notifyAdmin: (customerJid: string, summary: string, mainQuestion: string) => Promise<{ success: boolean; error?: string }>
        web: {
            getState: () => Promise<any>
            start: () => Promise<any>
            stop: () => Promise<any>
            humanTakeover: () => Promise<any>
            captureFailure: (name?: string) => Promise<string | null>
            startMonitoring: (chatId: string) => Promise<any>
            stopMonitoring: () => Promise<void>
        }
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
        retryJob: (inboundId: string) => Promise<any>
        quarantineDelivery: (inboundId: string) => Promise<any>
        cancelOutbound: (inboundId: string) => Promise<any>
        listApprovedTemplates: () => Promise<any>
        listTakeovers: () => Promise<any>
        listDrafts: () => Promise<any>
        listUnresolvedOutbound: () => Promise<any>
        listDeliveryHistory: (limit?: number) => Promise<any>
        listEmailAttachments: (limit?: number) => Promise<any>
        retrieveGmailAttachment: (messageId: string, attachmentId: string, metadata?: { mimeType?: string; name?: string }) => Promise<any>
        listDecisionEvidence: (limit?: number) => Promise<any>
        reviewDecision: (inboundId: string, label: string, notes?: string) => Promise<any>
        recordConversationOutcome: (jid: string, revision: number, outcome: string, evidence: string) => Promise<any>
        usageHistory: (days?: number) => Promise<any>
        channelUsage: (days?: number) => Promise<any>
        approveDraft: (inboundId: string) => Promise<any>
        listNotifications: () => Promise<any>
        ackNotification: (id: number) => Promise<any>
        onNotification: (callback: (data: any) => void) => () => void
        sendApprovedTemplate: (inboundId: string, name: string, languageCode: string, parameters?: string[]) => Promise<any>
        registerApprovedTemplate: (name: string, languageCode: string, category: string) => Promise<any>
        revokeApprovedTemplate: (name: string, languageCode: string) => Promise<any>
        setMode: (mode: string, responsePermission: boolean) => Promise<any>
        onState: (callback: (state: any) => void) => () => void
        onDecision: (callback: (data: any) => void) => () => void
        onFailure: (callback: (data: any) => void) => () => void
    }
    email?: {
        getState: () => Promise<{
            status: 'disconnected' | 'connecting' | 'connected' | 'error'
            error: string | null
            lastSyncAt: number | null
            unreadCount: number
        }>
        configure: (config: unknown) => Promise<{ success: boolean; error?: string }>
        start: () => Promise<{ success: boolean; error?: string }>
        stop: () => Promise<{ success: boolean; error?: string }>
        send: (payload: unknown) => Promise<{ success: boolean; error?: string }>
        onConnectionChange: (callback: (state: unknown) => void) => () => void
        onMessage: (callback: (message: unknown) => void) => () => void
        onDeliveryStatus: (callback: (status: unknown) => void) => () => void
    }
    emailOAuth?: {
        initialize: () => Promise<{ signedIn: boolean; email: string | null }>
        signInGoogle: () => Promise<{ signedIn: boolean; email: string | null }>
        signOut: () => Promise<{ success: boolean }>
        getStatus: () => Promise<{ signedIn: boolean; email: string | null }>
        getAccessToken: () => Promise<{ token: string | null }>
    }
}

// Web Speech API types - placed inside declare global to be available everywhere
declare global {
    interface SpeechRecognition extends EventTarget {
        continuous: boolean
        interimResults: boolean
        lang: string
        start(): void
        stop(): void
        abort(): void
        onresult: ((event: SpeechRecognitionEvent) => void) | null
        onerror: ((event: SpeechRecognitionErrorEvent) => void) | null
        onend: (() => void) | null
    }

    interface SpeechRecognitionEvent extends Event {
        resultIndex: number
        results: SpeechRecognitionResultList
    }

    interface SpeechRecognitionResultList {
        length: number
        [index: number]: SpeechRecognitionResult
    }

    interface SpeechRecognitionResult {
        isFinal: boolean
        length: number
        [index: number]: SpeechRecognitionAlternative
    }

    interface SpeechRecognitionAlternative {
        transcript: string
        confidence: number
    }

    interface SpeechRecognitionErrorEvent extends Event {
        error: string
        message: string
    }

    const SpeechRecognition: {
        new(): SpeechRecognition
    }

    interface Window {
        electron?: ElectronAPI
        SpeechRecognition?: typeof SpeechRecognition
        webkitSpeechRecognition?: typeof SpeechRecognition
    }
}

export { }
