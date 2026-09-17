import { contextBridge, ipcRenderer } from 'electron'

type BusinessPersonaProfile = {
    name: string
    industry: string
    tone: 'professional' | 'casual' | 'enthusiastic' | 'concise'
    coreKnowledge: string[]
    customRules?: string
}

let mcpSessionToken: Promise<string> | null = null
function getMcpSessionToken(): Promise<string> {
    return mcpSessionToken ??= ipcRenderer.invoke('mcp:authorize').then((result: { success: boolean; token?: string; error?: string }) => {
        if (!result.success || !result.token) throw new Error(result.error || 'MCP session authorization failed')
        return result.token
    })
}

// IPC channels for main process communication
const electronAPI = {
    // Platform info
    platform: process.platform,

    // MCP Server operations
    mcp: {
        authorize: () => ipcRenderer.invoke('mcp:authorize'),
        connect: async (serverConfig: unknown) => ipcRenderer.invoke('mcp:connect', serverConfig, await getMcpSessionToken()),
        disconnect: async (serverId: string) => ipcRenderer.invoke('mcp:disconnect', serverId, await getMcpSessionToken()),
        listTools: async (serverId: string) => ipcRenderer.invoke('mcp:list-tools', serverId, await getMcpSessionToken()),
        callTool: async (serverId: string, toolName: string, args: unknown, requestId?: string) =>
            ipcRenderer.invoke('mcp:call-tool', serverId, toolName, args, requestId, await getMcpSessionToken()),
        cancelTool: async (requestId: string) => ipcRenderer.invoke('mcp:cancel-tool', requestId, await getMcpSessionToken()),
    },

    // LLM operations (for future main process LLM handling)
    llm: {
        chat: (messages: unknown[], tools?: unknown[]) =>
            ipcRenderer.invoke('llm:chat', messages, tools),
        getProviders: () => ipcRenderer.invoke('llm:get-providers'),
        fetchOpenAIModels: (baseUrl: string, apiKey: string) =>
            ipcRenderer.invoke('llm:fetch-openai-models', baseUrl, apiKey),
        fetchOllamaModels: (baseUrl: string) =>
            ipcRenderer.invoke('llm:fetch-ollama-models', baseUrl),
    },

    // Storage operations (using electron-store in main process)
    store: {
        get: (key: string) => ipcRenderer.invoke('store:get', key),
        set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
        delete: (key: string) => ipcRenderer.invoke('store:delete', key),
    },

    // Chat persistence operations (never expose generic ipcRenderer)
    chat: {
        loadSessions: () => ipcRenderer.invoke('chat:load-sessions') as Promise<{
            success: boolean
            sessions?: unknown[]
            error?: string
        }>,
        saveSessionsWithMirror: (sessions: unknown[]) =>
            ipcRenderer.invoke('chat:save-sessions-with-mirror', sessions) as Promise<{
                success: boolean
                error?: string
            }>,
        deleteSession: (id: string) =>
            ipcRenderer.invoke('chat:delete-session', id) as Promise<{
                success: boolean
                error?: string
            }>,
    },

    // Shell operations
    shell: {
        openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
    },

    // App info
    app: {
        getVersion: () => ipcRenderer.invoke('app:get-version'),
        getName: () => ipcRenderer.invoke('app:get-name'),
        selectFolder: () => ipcRenderer.invoke('app:select-folder'),
        selectFile: (options: unknown) => ipcRenderer.invoke('app:select-file', options),
        selectFiles: (options?: unknown) => ipcRenderer.invoke('app:select-files', options || {}),
        getMissingDependencies: () => ipcRenderer.invoke('app:get-missing-dependencies'),
        getAllDependencies: () => ipcRenderer.invoke('app:get-all-dependencies'),
        runSetupScript: () => ipcRenderer.invoke('app:run-setup-script'),
    },

    // Logging operations
    logs: {
        add: (entry: any) => ipcRenderer.invoke('logs:add', entry),
        getPath: () => ipcRenderer.invoke('logs:get-path'),
        openFolder: () => ipcRenderer.invoke('logs:open-folder'),
    },

    // Speech recognition operations (native Vosk-based)
    speech: {
        checkSupport: (modelId?: string) => ipcRenderer.invoke('speech:check-support', modelId),
        initialize: () => ipcRenderer.invoke('speech:initialize'),
        startListening: () => ipcRenderer.invoke('speech:start-listening'),
        stopListening: () => ipcRenderer.invoke('speech:stop-listening'),
        processAudio: (audioData: ArrayBuffer) =>
            ipcRenderer.send('speech:process-audio', audioData),
        downloadModel: (options: { modelId: string }) =>
            ipcRenderer.invoke('speech:download-model', options),
        getPreferredModel: () => ipcRenderer.invoke('speech:get-preferred-model'), // NEW
        getModelPath: (modelId: string) => ipcRenderer.invoke('speech:get-model-path', modelId),
        getStatus: (modelId?: string) => ipcRenderer.invoke('speech:get-status', modelId),
        cleanup: () => ipcRenderer.invoke('speech:cleanup'),
        onResult: (callback: (result: { text: string, final: boolean }) => void) => {
            const listener = (_event: any, result: { text: string, final: boolean }) => callback(result)
            ipcRenderer.on('speech:result', listener)
            return () => ipcRenderer.removeListener('speech:result', listener)
        },
        onDownloadProgress: (callback: (data: { modelId: string, progress: number }) => void) => {
            const listener = (_event: any, data: { modelId: string, progress: number }) => callback(data)
            ipcRenderer.on('speech:download-progress', listener)
            return () => ipcRenderer.removeListener('speech:download-progress', listener)
        },
    },
    // Secure storage operations (encrypted with OS keychain)
    secure: {
        isAvailable: () => ipcRenderer.invoke('secure:is-available'),
        set: (key: string, value: string, userId?: string) =>
            ipcRenderer.invoke('secure:set', key, value, userId),
        get: (key: string, userId?: string) =>
            ipcRenderer.invoke('secure:get', key, userId),
        delete: (key: string, userId?: string) =>
            ipcRenderer.invoke('secure:delete', key, userId),
        listKeys: (userId?: string) =>
            ipcRenderer.invoke('secure:list-keys', userId),
    },
    // Filesystem Safe Mode operations
    fs: {
        getPendingChanges: () => ipcRenderer.invoke('fs:get-pending-changes'),
        approveChange: (changeId: string) => ipcRenderer.invoke('fs:approve-change', changeId),
        rejectChange: (changeId: string) => ipcRenderer.invoke('fs:reject-change', changeId),
        writeInternalFile: (workspacePath: string | undefined, filename: string, content: string) =>
            ipcRenderer.invoke('fs:write-internal-file', workspacePath, filename, content),
        readInternalFile: (workspacePath: string | undefined, filename: string) =>
            ipcRenderer.invoke('fs:read-internal-file', workspacePath, filename),
        readFileBase64: (filePath: string) =>
            ipcRenderer.invoke('fs:read-file-base64', filePath)
    },
    // Memory operations
    memory: {
        runTests: () => ipcRenderer.invoke('memory:run-tests'),
        getStats: () => ipcRenderer.invoke('memory:get-stats'),
        exportAll: () => ipcRenderer.invoke('memory:export-all'),
        callTool: (name: string, args: any) => ipcRenderer.invoke('memory:call-tool', { name, args }),
        migrate: () => ipcRenderer.invoke('memory:migrate'),
        checkMigration: () => ipcRenderer.invoke('memory:check-migration'),
        openFileLocation: () => ipcRenderer.invoke('memory:open-file-location'),
    },
    intelligence: {
        getKnowledge: () => ipcRenderer.invoke('intelligence:get-knowledge'),
        deleteKnowledge: (id: number) => ipcRenderer.invoke('intelligence:delete-knowledge', id),
        getPersona: () => ipcRenderer.invoke('intelligence:get-persona') as Promise<BusinessPersonaProfile>,
        updatePersona: (updates: Partial<BusinessPersonaProfile>) =>
            ipcRenderer.invoke('intelligence:update-persona', updates) as Promise<void>,
        getLogs: (limit = 20) => ipcRenderer.invoke('intelligence:get-logs', limit),
        getStats: () => ipcRenderer.invoke('intelligence:get-stats'),
        logAccuracy: (payload: { event: string; details?: string }) => ipcRenderer.invoke('intelligence:log-accuracy', payload),
    },
    // Antigravity OAuth operations (Google sign-in for Gemini access)
    antigravity: {
        initialize: () => ipcRenderer.invoke('antigravity:initialize'),
        signIn: () => ipcRenderer.invoke('antigravity:sign-in'),
        getToken: () => ipcRenderer.invoke('antigravity:get-token'),
        signOut: () => ipcRenderer.invoke('antigravity:sign-out'),
        getStatus: () => ipcRenderer.invoke('antigravity:get-status'),
        callGateway: (url: string, headers: Record<string, string>, body: string) =>
            ipcRenderer.invoke('antigravity:call-gateway', url, headers, body),
    },
    // Clipboard operations
    clipboard: {
        readFilePaths: () => {
            const { clipboard } = require('electron')
            const paths: string[] = []

            if (process.platform === 'darwin') {
                const fileUrl = clipboard.read('public.file-url')
                if (fileUrl) {
                    try {
                        // Decode URI and remove file:// prefix
                        const p = decodeURIComponent(fileUrl).replace(/^file:\/\//, '')
                        paths.push(p)
                    } catch (e) {
                        console.error('Error parsing file url from clipboard:', e)
                    }
                }
            } else {
                // Windows/Linux fallback or implementation
                // For now, on Windows, dragging generic files usually works via web API better than mac paste
                // We can add more robust logic later if needed
            }
            return paths
        }
    },
    // WhatsApp operations
    whatsapp: {
        getState: () => ipcRenderer.invoke('whatsapp:get-state'),
        connect: (phoneNumber?: string) => ipcRenderer.invoke('whatsapp:connect', phoneNumber),
        setTargetNumber: (phoneNumber: string) => ipcRenderer.invoke('whatsapp:set-target-number', phoneNumber),
        disconnect: (clearAuth?: boolean) => ipcRenderer.invoke('whatsapp:disconnect', clearAuth),
        sendMessage: (to: string, content: string) =>
            ipcRenderer.invoke('whatsapp:send-message', to, content),
        sendPresence: (to: string, state: string) =>
            ipcRenderer.invoke('whatsapp:send-presence', to, state),
        sendMediaMessage: (to: string, filePath: string, caption?: string, type?: string) =>
            ipcRenderer.invoke('whatsapp:send-media-message', to, filePath, caption, type),
        onConnectionChange: (callback: (state: unknown) => void) => {
            const listener = (_event: any, state: unknown) => callback(state)
            ipcRenderer.on('whatsapp:connection-change', listener)
            return () => ipcRenderer.removeListener('whatsapp:connection-change', listener)
        },
        onMessage: (callback: (message: unknown) => void) => {
            const listener = (_event: any, message: unknown) => callback(message)
            ipcRenderer.on('whatsapp:message', listener)
            return () => ipcRenderer.removeListener('whatsapp:message', listener)
        },
        onEscalation: (callback: (data: unknown) => void) => {
            const listener = (_event: any, data: unknown) => callback(data)
            ipcRenderer.on('whatsapp:escalation', listener)
            return () => ipcRenderer.removeListener('whatsapp:escalation', listener)
        },
        notifyAdmin: (customerJid: string, summary: string, mainQuestion: string) =>
            ipcRenderer.invoke('whatsapp:notify-admin', { customerJid, summary, mainQuestion }),
        web: {
            getState: () => ipcRenderer.invoke('whatsapp-web:get-state'),
            start: () => ipcRenderer.invoke('whatsapp-web:start'),
            stop: () => ipcRenderer.invoke('whatsapp-web:stop'),
            humanTakeover: () => ipcRenderer.invoke('whatsapp-web:human-takeover'),
            captureFailure: (name?: string) => ipcRenderer.invoke('whatsapp-web:capture-failure', name),
            startMonitoring: (chatId: string) => ipcRenderer.invoke('whatsapp-web:start-monitoring', chatId),
            stopMonitoring: () => ipcRenderer.invoke('whatsapp-web:stop-monitoring')
        },
    },
    autonomy: {
        getState: () => ipcRenderer.invoke('autonomy:get-state'),
        getHealth: () => ipcRenderer.invoke('autonomy:get-health'),
        getMetrics: (days?: number) => ipcRenderer.invoke('autonomy:get-metrics', days ?? 14),
        reconnectChannel: () => ipcRenderer.invoke('autonomy:reconnect-channel'),
        start: () => ipcRenderer.invoke('autonomy:start'),
        stop: () => ipcRenderer.invoke('autonomy:stop'),
        pause: (emergency?: boolean) => ipcRenderer.invoke('autonomy:pause', emergency),
        resume: () => ipcRenderer.invoke('autonomy:resume'),
        enterRecoveryMode: (reason?: string) => ipcRenderer.invoke('autonomy:enter-recovery-mode', reason),
        clearRecoveryMode: () => ipcRenderer.invoke('autonomy:clear-recovery-mode'),
        stageBackup: (backupPath: string) => ipcRenderer.invoke('autonomy:stage-backup', backupPath),
        pruneRetention: () => ipcRenderer.invoke('autonomy:prune-retention'),
        pauseConversation: (jid: string) => ipcRenderer.invoke('autonomy:pause-conversation', jid),
        resumeConversation: (jid: string) => ipcRenderer.invoke('autonomy:resume-conversation', jid),
        retryDelivery: (inboundId: string) => ipcRenderer.invoke('autonomy:retry-delivery', inboundId),
        retryJob: (inboundId: string) => ipcRenderer.invoke('autonomy:retry-job', inboundId),
        quarantineDelivery: (inboundId: string) => ipcRenderer.invoke('autonomy:quarantine-delivery', inboundId),
        cancelOutbound: (inboundId: string) => ipcRenderer.invoke('autonomy:cancel-outbound', inboundId),
        listApprovedTemplates: () => ipcRenderer.invoke('autonomy:list-approved-templates'),
        listTakeovers: () => ipcRenderer.invoke('autonomy:list-takeovers'),
        listDrafts: () => ipcRenderer.invoke('autonomy:list-drafts'),
        listUnresolvedOutbound: () => ipcRenderer.invoke('autonomy:list-unresolved-outbound'),
        listDeliveryHistory: (limit?: number) => ipcRenderer.invoke('autonomy:list-delivery-history', limit ?? 50),
        listEmailAttachments: (limit?: number) => ipcRenderer.invoke('autonomy:list-email-attachments', limit ?? 20),
        retrieveGmailAttachment: (messageId: string, attachmentId: string, metadata?: { mimeType?: string; name?: string }) => ipcRenderer.invoke('autonomy:retrieve-gmail-attachment', messageId, attachmentId, metadata ?? {}),
        listDecisionEvidence: (limit?: number) => ipcRenderer.invoke('autonomy:list-decision-evidence', limit ?? 50),
        reviewDecision: (inboundId: string, label: string, notes?: string) => ipcRenderer.invoke('autonomy:review-decision', inboundId, label, notes ?? ''),
        recordConversationOutcome: (jid: string, revision: number, outcome: string, evidence: string) => ipcRenderer.invoke('autonomy:record-conversation-outcome', jid, revision, outcome, evidence),
        usageHistory: (days?: number) => ipcRenderer.invoke('autonomy:usage-history', days ?? 30),
        channelUsage: (days?: number) => ipcRenderer.invoke('autonomy:channel-usage', days ?? 1),
        approveDraft: (inboundId: string) => ipcRenderer.invoke('autonomy:approve-draft', inboundId),
        sendApprovedTemplate: (inboundId: string, name: string, languageCode: string, parameters?: string[]) => ipcRenderer.invoke('autonomy:send-approved-template', inboundId, name, languageCode, parameters ?? []),
        listNotifications: () => ipcRenderer.invoke('autonomy:list-notifications'),
        ackNotification: (id: number) => ipcRenderer.invoke('autonomy:ack-notification', id),
        onNotification: (callback: (data: unknown) => void) => { const l = (_e: unknown, d: unknown) => callback(d); ipcRenderer.on('autonomy:notification', l); return () => ipcRenderer.removeListener('autonomy:notification', l) },
        registerApprovedTemplate: (name: string, languageCode: string, category: string) => ipcRenderer.invoke('autonomy:register-approved-template', name, languageCode, category),
        revokeApprovedTemplate: (name: string, languageCode: string) => ipcRenderer.invoke('autonomy:revoke-approved-template', name, languageCode),
        setMode: (mode: string, responsePermission: boolean) => ipcRenderer.invoke('autonomy:set-mode', mode, responsePermission),
        onState: (callback: (state: unknown) => void) => { const l = (_e: unknown, s: unknown) => callback(s); ipcRenderer.on('autonomy:state', l); return () => ipcRenderer.removeListener('autonomy:state', l) },
        onDecision: (callback: (data: unknown) => void) => { const l = (_e: unknown, d: unknown) => callback(d); ipcRenderer.on('autonomy:decision', l); return () => ipcRenderer.removeListener('autonomy:decision', l) },
        onFailure: (callback: (data: unknown) => void) => { const l = (_e: unknown, d: unknown) => callback(d); ipcRenderer.on('autonomy:failure', l); return () => ipcRenderer.removeListener('autonomy:failure', l) },
    },
    // Email channel operations
    email: {
        getState: () => ipcRenderer.invoke('email:get-state'),
        configure: (config: unknown) => ipcRenderer.invoke('email:configure', config),
        start: () => ipcRenderer.invoke('email:start'),
        stop: () => ipcRenderer.invoke('email:stop'),
        send: (payload: unknown) => ipcRenderer.invoke('email:send', payload),
        onConnectionChange: (callback: (state: unknown) => void) => {
            const listener = (_event: any, state: unknown) => callback(state)
            ipcRenderer.on('email:connection-change', listener)
            return () => ipcRenderer.removeListener('email:connection-change', listener)
        },
        onMessage: (callback: (message: unknown) => void) => {
            const listener = (_event: any, message: unknown) => callback(message)
            ipcRenderer.on('email:message', listener)
            return () => ipcRenderer.removeListener('email:message', listener)
        },
        onDeliveryStatus: (callback: (status: unknown) => void) => {
            const listener = (_event: any, status: unknown) => callback(status)
            ipcRenderer.on('email:delivery-status', listener)
            return () => ipcRenderer.removeListener('email:delivery-status', listener)
        },
    },
    emailOAuth: {
        initialize: () => ipcRenderer.invoke('email-oauth:initialize'),
        signInGoogle: () => ipcRenderer.invoke('email-oauth:sign-in-google'),
        signOut: () => ipcRenderer.invoke('email-oauth:sign-out'),
        getStatus: () => ipcRenderer.invoke('email-oauth:get-status'),
        getAccessToken: () => ipcRenderer.invoke('email-oauth:get-access-token'),
    },
    // General utils
    utils: {
        getPathForFile: (file: File): string => {
            const { webUtils } = require('electron')
            if (webUtils && webUtils.getPathForFile) {
                try {
                    const result = webUtils.getPathForFile(file)
                    // webUtils may return an empty string if it fails
                    if (result) return result
                } catch (e) {
                    console.error('webUtils.getPathForFile failed:', e)
                }
            }
            // Fallback to internal path property if webUtils isn't available
            return (file as any).path || ''
        }
    }
}

// Expose APIs to renderer
if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', electronAPI)
    } catch (error) {
        console.error('Failed to expose electron API:', error)
    }
} else {
    // @ts-ignore (define in d.ts)
    window.electron = electronAPI
}

// Type declarations
export type ElectronAPI = typeof electronAPI
