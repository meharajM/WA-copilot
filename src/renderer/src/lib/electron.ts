import '../env.d.ts'
import { getBrowserAgentdClient } from './browser-agentd-client'
import { isTauriRuntime } from './tauri-native-bridge'
// Provides fallbacks for browser environment

export const isElectron = (): boolean => {
    return !!(window.electron && typeof window.electron === 'object')
}

export const getPlatform = (): 'mac' | 'windows' | 'linux' | 'browser' => {
    if (!isElectron()) return 'browser'

    const platform = window.electron?.platform
    switch (platform) {
        case 'darwin': return 'mac'
        case 'win32': return 'windows'
        case 'linux': return 'linux'
        default: return 'browser'
    }
}

const isBrowserProduct = (): boolean => typeof window !== 'undefined' && !isElectron() && !isTauriRuntime()

const browserAutonomyState = async () => {
    let status
    try {
        status = await getBrowserAgentdClient().status()
    } catch (error) {
        return {
            mode: 'draft' as const,
            responsePermission: false,
            paused: true,
            emergencyPaused: false,
            recoveryMode: false,
            status: 'unavailable',
            queueDepth: 0,
            activeJob: null,
            lastProcessedMessage: null,
            lastError: error instanceof Error ? error.message : 'agentd unavailable',
            escalations: 0,
            lastDeliveryStatus: null,
            lastProviderMessageId: null,
            lastDeliveryInboundId: null,
            usageToday: { llmCalls: 0, outboundMessages: 0, estimatedCost: 0 },
        }
    }
    return {
        mode: 'draft' as const,
        responsePermission: false,
        paused: status.paused !== false,
        emergencyPaused: false,
        recoveryMode: false,
        status: status.paused === false ? 'running' : 'paused',
        queueDepth: status.queueDepth || 0,
        activeJob: null,
        lastProcessedMessage: null,
        lastError: null,
        escalations: 0,
        lastDeliveryStatus: null,
        lastProviderMessageId: null,
        lastDeliveryInboundId: null,
        usageToday: { llmCalls: 0, outboundMessages: 0, estimatedCost: 0 },
    }
}

const browserAutonomyHealth = async () => {
    let status
    try {
        status = await getBrowserAgentdClient().status()
    } catch (error) {
        return { executionLocation: 'agentd', transport: 'unavailable', channel: { status: 'unavailable', error: error instanceof Error ? error.message : 'agentd unavailable' }, leaseHeld: false }
    }
    return {
        executionLocation: 'agentd',
        transport: 'authenticated loopback HTTP',
        channel: { status: 'draft-only', error: null },
        queues: { whatsapp: status.queueDepth || 0, email: 0, meta: 0 },
        leaseHeld: true,
        memory: { status: 'not migrated', backend: null },
        rag: { status: 'not migrated', documents: 0 },
    }
}

// Safe wrapper for Electron APIs with browser fallbacks
export const electron = {
    // Open external URL
    openExternal: async (url: string): Promise<void> => {
        if (isElectron() && window.electron?.shell) {
            await window.electron.shell.openExternal(url)
        } else {
            window.open(url, '_blank', 'noopener,noreferrer')
        }
    },

    // App operations
    app: {
        getVersion: async (): Promise<string> => {
            if (isElectron() && window.electron?.app) {
                return await window.electron.app.getVersion()
            }
            return '0.1.0' // Fallback to package.json version
        },

        selectFolder: async (): Promise<string | null> => {
            if (isElectron() && window.electron?.app?.selectFolder) {
                return await window.electron.app.selectFolder()
            }
            // Browser fallback - not supported
            console.warn('[Browser] Folder selection not supported in browser mode')
            return null
        },

        selectFile: async (options?: { title?: string, buttonLabel?: string, filters?: { name: string, extensions: string[] }[] }): Promise<string | null> => {
            if (isElectron() && window.electron?.app?.selectFile) {
                return await window.electron.app.selectFile(options || {})
            }
            console.warn('[Browser] File selection not supported in browser mode')
            return null
        },

        selectFiles: async (options?: { title?: string, buttonLabel?: string, filters?: { name: string, extensions: string[] }[] }): Promise<string[] | null> => {
            if (isElectron() && window.electron?.app?.selectFiles) {
                return await window.electron.app.selectFiles(options || {})
            }
            console.warn('[Browser] Multiple file selection not supported in browser mode')
            return null
        },
    },

    // MCP operations
    mcp: {
        connect: async (serverConfig: unknown) => {
            if (isElectron() && window.electron?.mcp) {
                return await window.electron.mcp.connect(serverConfig)
            }
            // Browser fallback - mock implementation
            console.log('[Browser] MCP connect mock:', serverConfig)
            return { success: true, serverId: `mock_${Date.now()}` }
        },

        disconnect: async (serverId: string) => {
            if (isElectron() && window.electron?.mcp) {
                return await window.electron.mcp.disconnect(serverId)
            }
            console.log('[Browser] MCP disconnect mock:', serverId)
            return { success: true }
        },

        listTools: async (serverId: string) => {
            if (isElectron() && window.electron?.mcp) {
                return await window.electron.mcp.listTools(serverId)
            }
            console.log('[Browser] MCP list tools mock:', serverId)
            return { tools: [] }
        },

        callTool: async (serverId: string, toolName: string, args: unknown, requestId?: string) => {
            if (isElectron() && window.electron?.mcp) {
                return await window.electron.mcp.callTool(serverId, toolName, args, requestId)
            }
            console.log('[Browser] MCP call tool mock:', { serverId, toolName, args })
            return { result: null }
        },
        cancelTool: async (requestId: string) => {
            if (isElectron() && window.electron?.mcp) return await window.electron.mcp.cancelTool(requestId)
            return { success: false, error: 'Not supported in browser mode' }
        },
    },

    // Storage with localStorage fallback
    store: {
        get: async <T>(key: string, defaultValue?: T): Promise<T | undefined> => {
            if (isElectron() && window.electron?.store) {
                const value = await window.electron.store.get(key)
                return (value as T) ?? defaultValue
            }
            // Browser fallback to localStorage
            const stored = localStorage.getItem(key)
            if (stored) {
                try {
                    return JSON.parse(stored) as T
                } catch {
                    return stored as unknown as T
                }
            }
            return defaultValue
        },

        set: async (key: string, value: unknown): Promise<boolean> => {
            if (isElectron() && window.electron?.store) {
                return await window.electron.store.set(key, value)
            }
            // Browser fallback
            localStorage.setItem(key, JSON.stringify(value))
            return true
        },

        delete: async (key: string): Promise<boolean> => {
            if (isElectron() && window.electron?.store) {
                return await window.electron.store.delete(key)
            }
            localStorage.removeItem(key)
            return true
        },
    },

    // Secure storage for sensitive data (encrypted with OS keychain)
    secure: {
        isAvailable: async (): Promise<boolean> => {
            if (isElectron() && window.electron?.secure) {
                return await window.electron.secure.isAvailable()
            }
            return false // Browser cannot use safeStorage
        },

        set: async (key: string, value: string, userId?: string): Promise<{ success: boolean; encrypted?: boolean; error?: string }> => {
            if (isElectron() && window.electron?.secure) {
                return await window.electron.secure.set(key, value, userId)
            }
            return { success: false, error: 'Not supported in browser mode' }
        },

        get: async (key: string, userId?: string): Promise<{ success: boolean; value?: string | null; encrypted?: boolean; error?: string }> => {
            if (isElectron() && window.electron?.secure) {
                return await window.electron.secure.get(key, userId)
            }
            return { success: false, error: 'Not supported in browser mode' }
        },

        delete: async (key: string, userId?: string): Promise<{ success: boolean; error?: string }> => {
            if (isElectron() && window.electron?.secure) {
                return await window.electron.secure.delete(key, userId)
            }
            return { success: false, error: 'Not supported in browser mode' }
        },

        listKeys: async (userId?: string): Promise<{ success: boolean; keys?: string[]; error?: string }> => {
            if (isElectron() && window.electron?.secure?.listKeys) {
                return await window.electron.secure.listKeys(userId)
            }
            return { success: false, error: 'Not supported in browser mode' }
        },

    },

    // FS operations
    fs: {
        getPendingChanges: async () => {
            if (isElectron() && window.electron?.fs) {
                return await window.electron.fs.getPendingChanges()
            }
            return []
        },
        approveChange: async (changeId: string) => {
            if (isElectron() && window.electron?.fs) {
                return await window.electron.fs.approveChange(changeId)
            }
            return { success: false }
        },
        rejectChange: async (changeId: string) => {
            if (isElectron() && window.electron?.fs) {
                return await window.electron.fs.rejectChange(changeId)
            }
            return { success: false }
        },
        writeInternalFile: async (workspacePath: string | undefined, filename: string, content: string) => {
            if (isElectron() && window.electron?.fs && window.electron.fs.writeInternalFile) {
                return await window.electron.fs.writeInternalFile(workspacePath, filename, content)
            }
            return { success: false, error: 'Not supported in browser' }
        },
        readInternalFile: async (workspacePath: string | undefined, filename: string) => {
            if (isElectron() && window.electron?.fs && window.electron.fs.readInternalFile) {
                return await window.electron.fs.readInternalFile(workspacePath, filename)
            }
            return { success: false, error: 'Not supported in browser' }
        },
        readFileBase64: async (filePath: string) => {
            if (isElectron() && window.electron?.fs && window.electron.fs.readFileBase64) {
                return await window.electron.fs.readFileBase64(filePath)
            }
            return { success: false, error: 'Not supported in browser' }
        }
    },

    // Memory operations
    memory: {
        callTool: async (name: string, args: Record<string, unknown>) => {
            if (isElectron() && window.electron?.memory) {
                return await window.electron.memory.callTool(name, args)
            }
            console.log('[Browser] Memory call tool mock:', { name, args })
            return { result: null }
        },
        getStats: async () => {
            if (isElectron() && window.electron?.memory) {
                return await window.electron.memory.getStats()
            }
            return {
                success: true,
                stats: { entityCount: 0, relationCount: 0, storageSize: 0, avgSearchLatency: 0, backend: 'mock' },
            }
        },
        openFileLocation: async () => {
            if (isElectron() && window.electron?.memory) {
                return await window.electron.memory.openFileLocation()
            }
        }
    },
    intelligence: {
        getKnowledge: async () => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.getKnowledge()
            }
            return []
        },
        deleteKnowledge: async (id: number) => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.deleteKnowledge(id)
            }
            return false
        },
        getPersona: async () => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.getPersona()
            }
            return null
        },
        updatePersona: async (updates: Record<string, unknown>) => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.updatePersona(updates)
            }
            return null
        },
        getLogs: async (limit = 20) => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.getLogs(limit)
            }
            return { success: true, logs: [] }
        },
        getStats: async () => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.getStats()
            }
            return {
                success: true,
                stats: { totalQueries: 0, resolvedQueries: 0, autonomyRate: 100, trainingCount: 0, learningCount: 0 },
            }
        },
        logAccuracy: async (payload: { event: string; details?: string }) => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.logAccuracy(payload)
            }
            return { success: true }
        },
    },

    // Antigravity OAuth operations (Google sign-in for Gemini access)
    antigravity: {
        initialize: async (): Promise<{ signedIn: boolean; email: string | null; projectId: string | null }> => {
            if (isElectron() && window.electron?.antigravity) {
                return await window.electron.antigravity.initialize()
            }
            return { signedIn: false, email: null, projectId: null }
        },
        signIn: async (): Promise<{ signedIn: boolean; email: string | null; projectId: string | null }> => {
            if (isElectron() && window.electron?.antigravity) {
                return await window.electron.antigravity.signIn()
            }
            console.warn('[Browser] Antigravity sign-in not available in browser mode')
            throw new Error('Antigravity sign-in requires the desktop app')
        },
        getToken: async (): Promise<{ token: string | null; headers: Record<string, string> | null }> => {
            if (isElectron() && window.electron?.antigravity) {
                return await window.electron.antigravity.getToken()
            }
            return { token: null, headers: null }
        },
        signOut: async (): Promise<{ success: boolean }> => {
            if (isElectron() && window.electron?.antigravity) {
                return await window.electron.antigravity.signOut()
            }
            return { success: true }
        },
        getStatus: async (): Promise<{ signedIn: boolean; email: string | null; projectId: string | null }> => {
            if (isElectron() && window.electron?.antigravity) {
                return await window.electron.antigravity.getStatus()
            }
            return { signedIn: false, email: null, projectId: null }
        },
        callGateway: async (url: string, headers: Record<string, string>, body: string): Promise<unknown> => {
            if (isElectron() && window.electron?.antigravity) {
                return await window.electron.antigravity.callGateway(url, headers, body)
            }
            throw new Error('Antigravity gateway calls require the desktop app')
        },
    },

    // Log operations
    logs: {
        add: async (entry: unknown) => {
            if (isElectron() && window.electron?.logs) {
                return await window.electron.logs.add(entry)
            }
        },
        getPath: async () => {
            if (isElectron() && window.electron?.logs) {
                return await window.electron.logs.getPath()
            }
            return 'logs/'
        },
        openFolder: async () => {
            if (isElectron() && window.electron?.logs) {
                return await window.electron.logs.openFolder()
            }
        }
    },
    // Clipboard operations
    clipboard: {
        readFilePaths: (): string[] => {
            if (isElectron() && window.electron?.clipboard) {
                return window.electron.clipboard.readFilePaths()
            }
            return []
        }
    },

    // WhatsApp operations
    whatsapp: {
        getState: async () => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.getState()
            }
            return { status: 'disconnected' as const, qrCode: null, error: null, phoneNumber: null, workerNumber: null }
        },
        connect: async (phoneNumber?: string) => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.connect(phoneNumber)
            }
            console.warn('[Browser] WhatsApp not supported in browser mode')
            return { success: false, error: 'Not supported in browser mode' }
        },
        setTargetNumber: async (phoneNumber: string): Promise<{ success: boolean; error?: string; handshakeCode?: string }> => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.setTargetNumber(phoneNumber)
            }
            return { success: false, error: 'Electron not available' }
        },
        disconnect: async (clearAuth?: boolean) => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.disconnect(clearAuth)
            }
            return { success: true }
        },
        sendMessage: async (to: string, content: string) => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.sendMessage(to, content)
            }
            console.warn('[Browser] WhatsApp sendMessage not supported')
            return { success: false, error: 'Not supported in browser mode' }
        },
        sendPresence: async (to: string, state: string) => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.sendPresence(to, state)
            }
            console.warn('[Browser] WhatsApp sendPresence not supported')
            return { success: false, error: 'Not supported in browser mode' }
        },
        sendMediaMessage: async (to: string, filePath: string, caption?: string, type?: string) => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.sendMediaMessage(to, filePath, caption, type)
            }
            console.warn('[Browser] WhatsApp sendMediaMessage not supported')
            return { success: false, error: 'Not supported in browser mode' }
        },
        onConnectionChange: (callback: (state: import('../stores/whatsappStore').WhatsAppConnectionState) => void): (() => void) => {
            if (isElectron() && window.electron?.whatsapp) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return window.electron.whatsapp.onConnectionChange(callback as any)
            }
            return () => {}
        },
        onMessage: (callback: (message: import('../stores/whatsappStore').WhatsAppConnectionState) => void): (() => void) => {
            if (isElectron() && window.electron?.whatsapp) {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return window.electron.whatsapp.onMessage(callback as any)
            }
            return () => {}
        },
        onEscalation: (callback: (data: unknown) => void): (() => void) => {
            if (isElectron() && window.electron?.whatsapp?.onEscalation) {
                return window.electron.whatsapp.onEscalation(callback)
            }
            return () => {}
        },
        notifyAdmin: async (customerJid: string, summary: string, mainQuestion: string) => {
            if (isElectron() && window.electron?.whatsapp?.notifyAdmin) {
                return await window.electron.whatsapp.notifyAdmin(customerJid, summary, mainQuestion)
            }
            console.warn('[Browser] WhatsApp notifyAdmin not supported')
            return { success: false, error: 'Not supported in browser mode' }
        },
        web: {
            getState: async () => isElectron() && window.electron?.whatsapp?.web ? window.electron.whatsapp.web.getState() : { status: 'disconnected' },
            start: async () => isElectron() && window.electron?.whatsapp?.web ? window.electron.whatsapp.web.start() : { status: 'disconnected' },
            stop: async () => isElectron() && window.electron?.whatsapp?.web ? window.electron.whatsapp.web.stop() : { status: 'disconnected' },
            humanTakeover: async () => isElectron() && window.electron?.whatsapp?.web ? window.electron.whatsapp.web.humanTakeover() : { status: 'disconnected' },
            captureFailure: async (name?: string) => isElectron() && window.electron?.whatsapp?.web ? window.electron.whatsapp.web.captureFailure(name) : null,
            startMonitoring: async (chatId: string) => isElectron() && window.electron?.whatsapp?.web ? window.electron.whatsapp.web.startMonitoring(chatId) : { status: 'disconnected' },
            stopMonitoring: async () => { if (isElectron() && window.electron?.whatsapp?.web) await window.electron.whatsapp.web.stopMonitoring() }
        },
    },
    autonomy: {
        getState: async () => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.getState()
            if (isBrowserProduct()) return browserAutonomyState()
            return { mode: 'observe', responsePermission: false, paused: true, status: 'stopped', queueDepth: 0 }
        },
        getHealth: async () => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.getHealth()
            if (isBrowserProduct()) return browserAutonomyHealth()
            return null
        },
        getMetrics: async (days = 14) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.getMetrics(days) : (isBrowserProduct() ? { inbound: 0, sent: 0, escalated: 0, drafts: (await getBrowserAgentdClient().listDrafts()).length, failed: 0, averageDecisionLatencyMs: 0, llmCalls: 0, averageLlmLatencyMs: 0, groundedDecisionRate: 0, deliveryUnknown: 0, draftApprovalRate: 0, averageDraftEditingTimeMs: 0, estimatedCostPerResolvedConversation: 0, reviewedDecisions: 0, reviewAccuracy: 0, escalationPrecision: 0, unnecessaryEscalations: 0, missedEscalations: 0, recoveryDrills: 0, averageRecoveryTimeMs: 0 } : null),
        reconnectChannel: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.reconnectChannel() : (isBrowserProduct() ? browserAutonomyState() : null),
        start: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.start() : (isBrowserProduct() ? getBrowserAgentdClient().resumeAll().then(browserAutonomyState) : null),
        stop: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.stop() : (isBrowserProduct() ? getBrowserAgentdClient().pauseAll().then(browserAutonomyState) : null),
        pause: async (emergency = false) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.pause(emergency) : (isBrowserProduct() ? getBrowserAgentdClient().pauseAll().then(browserAutonomyState) : null),
        resume: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.resume() : (isBrowserProduct() ? getBrowserAgentdClient().resumeAll().then(browserAutonomyState) : null),
        enterRecoveryMode: async (reason?: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.enterRecoveryMode(reason) : null,
        clearRecoveryMode: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.clearRecoveryMode() : null,
        stageBackup: async (backupPath: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.stageBackup(backupPath) : null,
        pruneRetention: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.pruneRetention() : null,
        pauseConversation: async (jid: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.pauseConversation(jid) : null,
        resumeConversation: async (jid: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.resumeConversation(jid) : null,
        retryDelivery: async (inboundId: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.retryDelivery(inboundId) : null,
        retryJob: async (inboundId: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.retryJob(inboundId) : null,
        quarantineDelivery: async (inboundId: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.quarantineDelivery(inboundId) : null,
        cancelOutbound: async (inboundId: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.cancelOutbound(inboundId) : null,
        listApprovedTemplates: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.listApprovedTemplates() : [],
        listTakeovers: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.listTakeovers() : [],
        listUnresolvedOutbound: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.listUnresolvedOutbound() : [],
        listDeliveryHistory: async (limit = 50) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.listDeliveryHistory(limit) : [],
        listEmailAttachments: async (limit = 20) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.listEmailAttachments(limit) : [],
        retrieveGmailAttachment: async (messageId: string, attachmentId: string, metadata?: { mimeType?: string; name?: string }) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.retrieveGmailAttachment(messageId, attachmentId, metadata) : null,
        listDecisionEvidence: async (limit = 50) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.listDecisionEvidence(limit) : [],
        reviewDecision: async (inboundId: string, label: string, notes = '') => isElectron() && window.electron?.autonomy ? window.electron.autonomy.reviewDecision(inboundId, label, notes) : null,
        recordConversationOutcome: async (jid: string, revision: number, outcome: string, evidence: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.recordConversationOutcome(jid, revision, outcome, evidence) : null,
        listDrafts: async () => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.listDrafts()
            if (!isBrowserProduct()) return []
            const drafts = await getBrowserAgentdClient().listDrafts(50, 'draft')
            return drafts.map(draft => ({ inboundId: draft.providerEventId, jid: draft.conversationId, content: draft.responseText, contentHash: '', expiresAt: draft.updatedAt + 7 * 24 * 60 * 60 * 1000, status: draft.status }))
        },
        usageHistory: async (days = 30) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.usageHistory(days) : [],
        channelUsage: async (days = 1) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.channelUsage(days) : [],
        approveDraft: async (inboundId: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.approveDraft(inboundId)
            if (!isBrowserProduct()) return null
            const draft = (await getBrowserAgentdClient().listDrafts(100)).find(item => item.providerEventId === inboundId)
            return draft ? getBrowserAgentdClient().updateDraftStatus(draft.id, 'approved').then(() => browserAutonomyState()) : null
        },
        sendApprovedTemplate: async (inboundId: string, name: string, languageCode: string, parameters: string[] = []) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.sendApprovedTemplate(inboundId, name, languageCode, parameters) : null,
        listNotifications: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.listNotifications() : [],
        ackNotification: async (id: number) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.ackNotification(id) : null,
        onNotification: (callback: (data: unknown) => void) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.onNotification(callback) : () => {},
        registerApprovedTemplate: async (name: string, languageCode: string, category: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.registerApprovedTemplate(name, languageCode, category) : null,
        revokeApprovedTemplate: async (name: string, languageCode: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.revokeApprovedTemplate(name, languageCode) : null,
        setMode: async (mode: string, permission: boolean) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.setMode(mode, permission)
            if (!isBrowserProduct()) return null
            // Browser slice is draft-only: permission never enables direct sends.
            if (mode === 'draft') return getBrowserAgentdClient().resumeAll().then(browserAutonomyState)
            // Browser slice supports observe (paused) and draft-only (running).
            // Auto mode stays paused until a provider-backed outbox exists.
            return getBrowserAgentdClient().pauseAll().then(browserAutonomyState)
        },
        onState: (callback: (state: unknown) => void) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.onState(callback) : () => {},
        onDecision: (callback: (data: unknown) => void) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.onDecision(callback) : () => {},
        onFailure: (callback: (data: unknown) => void) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.onFailure(callback) : () => {},
    },
    email: {
        getState: async () => {
            if (isElectron() && window.electron?.email) {
                return window.electron.email.getState()
            }
            return { status: 'disconnected' as const, error: null, lastSyncAt: null, unreadCount: 0 }
        },
        configure: async (config: unknown) => {
            if (isElectron() && window.electron?.email) {
                return window.electron.email.configure(config)
            }
            return { success: false, error: 'Not supported in browser mode' }
        },
        start: async () => {
            if (isElectron() && window.electron?.email) {
                return window.electron.email.start()
            }
            return { success: false, error: 'Not supported in browser mode' }
        },
        stop: async () => {
            if (isElectron() && window.electron?.email) {
                return window.electron.email.stop()
            }
            return { success: false, error: 'Not supported in browser mode' }
        },
        send: async (payload: unknown) => {
            if (isElectron() && window.electron?.email) {
                return window.electron.email.send(payload)
            }
            return { success: false, error: 'Not supported in browser mode' }
        },
        onConnectionChange: (callback: (state: unknown) => void): (() => void) => {
            if (isElectron() && window.electron?.email) {
                return window.electron.email.onConnectionChange(callback)
            }
            return () => {}
        },
        onMessage: (callback: (message: unknown) => void): (() => void) => {
            if (isElectron() && window.electron?.email) {
                return window.electron.email.onMessage(callback)
            }
            return () => {}
        },
        onDeliveryStatus: (callback: (status: unknown) => void): (() => void) => {
            if (isElectron() && window.electron?.email) {
                return window.electron.email.onDeliveryStatus(callback)
            }
            return () => {}
        }
    },
    emailOAuth: {
        initialize: async () => {
            if (isElectron() && window.electron?.emailOAuth) {
                return window.electron.emailOAuth.initialize()
            }
            return { signedIn: false, email: null }
        },
        signInGoogle: async () => {
            if (isElectron() && window.electron?.emailOAuth) {
                return window.electron.emailOAuth.signInGoogle()
            }
            return { signedIn: false, email: null }
        },
        signOut: async () => {
            if (isElectron() && window.electron?.emailOAuth) {
                return window.electron.emailOAuth.signOut()
            }
            return { success: true }
        },
        getStatus: async () => {
            if (isElectron() && window.electron?.emailOAuth) {
                return window.electron.emailOAuth.getStatus()
            }
            return { signedIn: false, email: null }
        },
        getAccessToken: async () => {
            if (isElectron() && window.electron?.emailOAuth) {
                return window.electron.emailOAuth.getAccessToken()
            }
            return { token: null }
        }
    },
}

export default electron
