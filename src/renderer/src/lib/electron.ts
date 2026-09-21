import '../env.d.ts'
import { getBrowserAgentdClient } from './browser-agentd-client'
import { isTauriRuntime } from './tauri-native-bridge'
import { useWhatsAppStore } from '../stores/whatsappStore'
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
    const whatsappState = useWhatsAppStore.getState()
    let status
    try {
        status = await getBrowserAgentdClient().status()
    } catch (error) {
        return {
            mode: whatsappState.businessBotMode ? 'auto' as const : whatsappState.whatsappEnabled ? 'draft' as const : 'observe' as const,
            responsePermission: whatsappState.whatsappEnabled,
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
        mode: whatsappState.businessBotMode ? 'auto' as const : whatsappState.whatsappEnabled ? 'draft' as const : 'observe' as const,
        responsePermission: whatsappState.whatsappEnabled,
        paused: status.paused !== false,
        emergencyPaused: false,
        recoveryMode: status.recoveryMode === true,
        status: status.recoveryMode === true ? 'degraded' : status.paused === false ? 'running' : 'paused',
        queueDepth: status.queueDepth || 0,
        activeJob: null,
        lastProcessedMessage: null,
        lastError: status.recoveryMode === true ? status.recoveryReason || 'Recovery hold active' : null,
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
    let knowledgeDocuments = 0
    try { knowledgeDocuments = (await getBrowserAgentdClient().listKnowledge()).length } catch { /* status remains useful if the optional slice is unavailable */ }
    let memoryBackend: string | null = null
    try { memoryBackend = (await getBrowserAgentdClient().getMemoryStats()).backend } catch { /* the rest of the health surface remains actionable */ }
    return {
        executionLocation: 'agentd',
        transport: 'authenticated loopback HTTP',
        channel: { status: 'agentd-outbox', error: null },
        extension: status.extension,
        queues: { whatsapp: status.queueDepth || 0, email: 0, meta: 0 },
        leaseHeld: true,
        memory: { status: memoryBackend ? 'bounded' : 'unavailable', backend: memoryBackend },
        rag: { status: 'bounded-text', documents: knowledgeDocuments },
    }
}

/**
 * Browser Web transport is owned by the user's existing browser plus the
 * authenticated agentd loopback bridge. Keep the legacy Electron connector
 * state shape, but source browser status from the daemon so the UI never
 * reports a misleading disconnected placeholder.
 */
const browserWhatsAppWebState = async () => {
    try {
        const extension = (await getBrowserAgentdClient().status()).extension
        if (!extension) return { status: 'disconnected', error: 'agentd did not report the browser bridge' }
        return {
            status: extension.status,
            error: extension.error,
            lastStatus: extension.lastStatus,
            port: extension.port,
            profile: 'Manifest V3 extension on the user browser',
        }
    } catch (error) {
        return { status: 'disconnected', error: error instanceof Error ? error.message : 'agentd unavailable' }
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
            if (isBrowserProduct()) {
                try {
                    // The browser shell has no package metadata API. Read the
                    // version from the authenticated daemon so About/system
                    // surfaces do not silently advertise a stale hardcoded
                    // renderer fallback.
                    return (await getBrowserAgentdClient().getSystemInfo()).productVersion
                } catch {
                    // Pairing/startup may not be ready yet; preserve the
                    // existing neutral fallback until agentd is reachable.
                }
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
            return { success: false, error: 'MCP server management is not available in browser mode' }
        },

        disconnect: async (serverId: string) => {
            if (isElectron() && window.electron?.mcp) {
                return await window.electron.mcp.disconnect(serverId)
            }
            return { success: false, error: 'MCP server management is not available in browser mode' }
        },

        listTools: async (serverId: string) => {
            if (isElectron() && window.electron?.mcp) {
                return await window.electron.mcp.listTools(serverId)
            }
            return { success: false, error: 'MCP server management is not available in browser mode', tools: [] }
        },

        callTool: async (serverId: string, toolName: string, args: unknown, requestId?: string) => {
            if (isElectron() && window.electron?.mcp) {
                return await window.electron.mcp.callTool(serverId, toolName, args, requestId)
            }
            return { success: false, error: 'MCP tool execution is not available in browser mode', result: null }
        },
        cancelTool: async (requestId: string) => {
            if (isElectron() && window.electron?.mcp) return await window.electron.mcp.cancelTool(requestId)
            return { success: false, error: 'Not supported in browser mode' }
        },
    },

    // Electron-only storage. Browser product preferences belong to the
    // authenticated agentd settings routes; never silently create a second
    // renderer-local authority when a legacy caller misses its browser branch.
    store: {
        get: async <T>(key: string, defaultValue?: T): Promise<T | undefined> => {
            if (isElectron() && window.electron?.store) {
                const value = await window.electron.store.get(key)
                return (value as T) ?? defaultValue
            }
            if (isBrowserProduct()) return defaultValue
            return defaultValue
        },

        set: async (key: string, value: unknown): Promise<boolean> => {
            if (isElectron() && window.electron?.store) {
                return await window.electron.store.set(key, value)
            }
            if (isBrowserProduct()) throw new Error('Browser product storage is owned by authenticated agentd')
            return false
        },

        delete: async (key: string): Promise<boolean> => {
            if (isElectron() && window.electron?.store) {
                return await window.electron.store.delete(key)
            }
            if (isBrowserProduct()) throw new Error('Browser product storage is owned by authenticated agentd')
            return false
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
        callTool: async (name: string, args: Record<string, unknown>): Promise<{ success: boolean; result?: unknown; error?: string }> => {
            if (isElectron() && window.electron?.memory) {
                return await window.electron.memory.callTool(name, args)
            }
            if (isBrowserProduct()) return await getBrowserAgentdClient().callMemoryTool(name, args)
            console.log('[Browser] Memory call tool mock:', { name, args })
            return { success: false, result: null, error: 'Memory is not supported in this runtime' }
        },
        getStats: async () => {
            if (isElectron() && window.electron?.memory) {
                return await window.electron.memory.getStats()
            }
            if (isBrowserProduct()) {
                const stats = await getBrowserAgentdClient().getMemoryStats()
                return {
                    success: true,
                    stats,
                }
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
            if (isBrowserProduct()) return { success: false, error: 'Memory files are owned by agentd and are not exposed as native paths in the browser.' }
            return { success: false, error: 'Not supported in browser mode' }
        },
        exportAll: async () => {
            if (isElectron() && window.electron?.memory) return await window.electron.memory.exportAll()
            if (isBrowserProduct()) return { success: true, data: await getBrowserAgentdClient().exportMemory() }
            return { success: false, error: 'Not supported in browser mode' }
        }
    },
    intelligence: {
        getKnowledge: async () => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.getKnowledge()
            }
            if (isBrowserProduct()) return await getBrowserAgentdClient().listKnowledge()
            return []
        },
        deleteKnowledge: async (id: number) => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.deleteKnowledge(id)
            }
            if (isBrowserProduct()) return await getBrowserAgentdClient().deleteKnowledge(id)
            return false
        },
        getPersona: async () => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.getPersona()
            }
            if (isBrowserProduct()) return await getBrowserAgentdClient().getPersonaSettings()
            return null
        },
        updatePersona: async (updates: Record<string, unknown>) => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.updatePersona(updates)
            }
            if (isBrowserProduct()) {
                const current = await getBrowserAgentdClient().getPersonaSettings()
                return await getBrowserAgentdClient().savePersonaSettings({ ...current, ...updates } as Parameters<ReturnType<typeof getBrowserAgentdClient>['savePersonaSettings']>[0])
            }
            return null
        },
        getLogs: async (limit = 20) => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.getLogs(limit)
            }
            if (isBrowserProduct()) return { success: true, logs: await getBrowserAgentdClient().listIntelligenceLogs(limit) }
            return { success: true, logs: [] }
        },
        getStats: async () => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.getStats()
            }
            if (isBrowserProduct()) return { success: true, stats: await getBrowserAgentdClient().getIntelligenceStats() }
            return {
                success: true,
                stats: { totalQueries: 0, resolvedQueries: 0, autonomyRate: 100, trainingCount: 0, learningCount: 0 },
            }
        },
        logAccuracy: async (payload: { event: string; details?: string }) => {
            if (isElectron() && window.electron?.intelligence) {
                return await window.electron.intelligence.logAccuracy(payload)
            }
            if (isBrowserProduct()) {
                await getBrowserAgentdClient().logAccuracy(payload)
                return { success: true }
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
            if (isBrowserProduct()) return getBrowserAgentdClient().getWhatsAppConnectionState()
            return { status: 'disconnected' as const, qrCode: null, error: null, phoneNumber: null, workerNumber: null }
        },
        connect: async (phoneNumber?: string) => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.connect(phoneNumber)
            }
            if (isBrowserProduct()) return { success: true, ...(await getBrowserAgentdClient().connectWhatsApp(phoneNumber)) }
            console.warn('[Browser] WhatsApp not supported in browser mode')
            return { success: false, error: 'Not supported in browser mode' }
        },
        setTargetNumber: async (phoneNumber: string): Promise<{ success: boolean; error?: string; handshakeCode?: string }> => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.setTargetNumber(phoneNumber)
            }
            if (isBrowserProduct()) return getBrowserAgentdClient().setWhatsAppTarget(phoneNumber)
            return { success: false, error: 'Electron not available' }
        },
        disconnect: async (clearAuth?: boolean) => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.disconnect(clearAuth)
            }
            if (isBrowserProduct()) return { success: true, ...(await getBrowserAgentdClient().disconnectWhatsApp(clearAuth)) }
            return { success: true }
        },
        sendMessage: async (to: string, content: string) => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.sendMessage(to, content)
            }
            if (isBrowserProduct()) return { success: true, ...(await getBrowserAgentdClient().sendWhatsAppText(to, content)) }
            console.warn('[Browser] WhatsApp sendMessage not supported')
            return { success: false, error: 'Not supported in browser mode' }
        },
        sendPresence: async (to: string, state: string) => {
            if (isElectron() && window.electron?.whatsapp) {
                return window.electron.whatsapp.sendPresence(to, state)
            }
            if (isBrowserProduct() && ['unavailable', 'available', 'composing', 'recording', 'paused'].includes(state)) {
                return getBrowserAgentdClient().sendWhatsAppPresence(to, state as 'unavailable' | 'available' | 'composing' | 'recording' | 'paused')
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
            getState: async () => {
                if (isElectron() && window.electron?.whatsapp?.web) return window.electron.whatsapp.web.getState()
                if (isBrowserProduct()) return browserWhatsAppWebState()
                return { status: 'disconnected' }
            },
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
        getMetrics: async (days = 14) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.getMetrics(days) : (isBrowserProduct() ? getBrowserAgentdClient().getAutonomyMetrics(days) : null),
        reconnectChannel: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.reconnectChannel() : (isBrowserProduct() ? browserAutonomyState() : null),
        start: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.start() : (isBrowserProduct() ? getBrowserAgentdClient().resumeAll().then(browserAutonomyState) : null),
        stop: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.stop() : (isBrowserProduct() ? getBrowserAgentdClient().pauseAll().then(browserAutonomyState) : null),
        pause: async (emergency = false) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.pause(emergency) : (isBrowserProduct() ? getBrowserAgentdClient().pauseAll().then(browserAutonomyState) : null),
        resume: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.resume() : (isBrowserProduct() ? getBrowserAgentdClient().resumeAll().then(browserAutonomyState) : null),
        enterRecoveryMode: async (reason?: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.enterRecoveryMode(reason)
            if (isBrowserProduct()) return getBrowserAgentdClient().enterRecoveryMode(reason).then(browserAutonomyState)
            return null
        },
        clearRecoveryMode: async () => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.clearRecoveryMode()
            if (isBrowserProduct()) return getBrowserAgentdClient().clearRecoveryMode().then(browserAutonomyState)
            return null
        },
        stageBackup: async (backupPath: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.stageBackup(backupPath) : null,
        pruneRetention: async () => isElectron() && window.electron?.autonomy ? window.electron.autonomy.pruneRetention() : null,
        pauseConversation: async (jid: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.pauseConversation(jid)
            if (isBrowserProduct()) return getBrowserAgentdClient().pauseConversation(jid)
            return null
        },
        resumeConversation: async (jid: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.resumeConversation(jid)
            if (isBrowserProduct()) return getBrowserAgentdClient().resumeConversation(jid)
            return null
        },
        retryDelivery: async (inboundId: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.retryDelivery(inboundId)
            if (!isBrowserProduct()) return null
            const draft = (await getBrowserAgentdClient().listDrafts(100)).find(item => item.providerEventId === inboundId)
            return draft ? getBrowserAgentdClient().retryWhatsAppDraft(draft.id).then(() => browserAutonomyState()) : null
        },
        retryJob: async (inboundId: string) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.retryJob(inboundId) : null,
        quarantineDelivery: async (inboundId: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.quarantineDelivery(inboundId)
            if (!isBrowserProduct()) return null
            const draft = (await getBrowserAgentdClient().listDrafts(100)).find(item => item.providerEventId === inboundId)
            return draft ? getBrowserAgentdClient().quarantineWhatsAppDraft(draft.id).then(() => browserAutonomyState()) : null
        },
        cancelOutbound: async (inboundId: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.cancelOutbound(inboundId)
            if (!isBrowserProduct()) return null
            const draft = (await getBrowserAgentdClient().listDrafts(100)).find(item => item.providerEventId === inboundId)
            return draft ? getBrowserAgentdClient().cancelWhatsAppDraft(draft.id).then(() => browserAutonomyState()) : null
        },
        listApprovedTemplates: async () => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.listApprovedTemplates()
            if (isBrowserProduct()) return getBrowserAgentdClient().listApprovedTemplates()
            return []
        },
        listTakeovers: async () => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.listTakeovers()
            if (isBrowserProduct()) return getBrowserAgentdClient().listAutonomyTakeovers()
            return []
        },
        listUnresolvedOutbound: async () => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.listUnresolvedOutbound()
            if (!isBrowserProduct()) return []
            const drafts = await getBrowserAgentdClient().listDrafts(100)
            return drafts.filter(draft => draft.sendStatus === 'pending' || draft.sendStatus === 'failed').map(draft => ({
                inboundId: draft.providerEventId,
                jid: draft.conversationId,
                content: draft.responseText,
                providerMessageId: draft.providerMessageId || null,
                sentAt: draft.updatedAt,
                status: draft.sendStatus || 'failed',
                error: draft.sendError || null,
            }))
        },
        listDeliveryHistory: async (limit = 50) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.listDeliveryHistory(limit)
            if (!isBrowserProduct()) return []
            const boundedLimit = Math.min(Math.max(limit, 1), 100)
            const [drafts, emailEvents] = await Promise.all([
                getBrowserAgentdClient().listDrafts(boundedLimit),
                getBrowserAgentdClient().listEmailDeliveryHistory(boundedLimit),
            ])
            const whatsappEvents = drafts.filter(draft => draft.sendStatus === 'sent' && draft.providerMessageId).map(draft => ({
                providerMessageId: draft.providerMessageId as string,
                channel: 'whatsapp',
                status: 'sent',
                eventAt: draft.updatedAt,
                inboundId: draft.providerEventId,
            }))
            return [...whatsappEvents, ...emailEvents].sort((left, right) => right.eventAt - left.eventAt).slice(0, boundedLimit)
        },
        listEmailAttachments: async (limit = 20) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.listEmailAttachments(limit)
            if (isBrowserProduct()) return getBrowserAgentdClient().listEmailAttachments(limit)
            return []
        },
        retrieveGmailAttachment: async (messageId: string, attachmentId: string, metadata?: { mimeType?: string; name?: string }) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.retrieveGmailAttachment(messageId, attachmentId, metadata)
            if (isBrowserProduct()) {
                if (messageId.startsWith('imap:')) return getBrowserAgentdClient().getEmailInboundAttachment(messageId, attachmentId)
                return getBrowserAgentdClient().retrieveGmailAttachment(messageId, attachmentId, metadata)
            }
            return null
        },
        listDecisionEvidence: async (limit = 50) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.listDecisionEvidence(limit)
            if (isBrowserProduct()) return getBrowserAgentdClient().listDecisionEvidence(limit)
            return []
        },
        reviewDecision: async (inboundId: string, label: string, notes = '') => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.reviewDecision(inboundId, label, notes)
            if (isBrowserProduct()) return getBrowserAgentdClient().reviewDecision(inboundId, label as 'correct' | 'incorrect' | 'unnecessary_escalation' | 'missed_escalation', notes)
            return null
        },
        recordConversationOutcome: async (jid: string, revision: number, outcome: string, evidence: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.recordConversationOutcome(jid, revision, outcome, evidence)
            if (isBrowserProduct()) return getBrowserAgentdClient().recordConversationOutcome(jid, revision, outcome as 'resolved_agent' | 'resolved_human' | 'escalated' | 'closed_unresolved' | 'open', evidence)
            return null
        },
        listDrafts: async () => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.listDrafts()
            if (!isBrowserProduct()) return []
            const drafts = await getBrowserAgentdClient().listDrafts(50)
            return drafts.filter(draft => draft.status === 'draft' || draft.status === 'approved').map(draft => ({ inboundId: draft.providerEventId, jid: draft.conversationId, content: draft.responseText, contentHash: '', expiresAt: draft.updatedAt + 7 * 24 * 60 * 60 * 1000, status: draft.status, providerMessageId: draft.providerMessageId, sendStatus: draft.sendStatus, sendError: draft.sendError }))
        },
        usageHistory: async (days = 30) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.usageHistory(days)
            if (isBrowserProduct()) return getBrowserAgentdClient().getAutonomyUsageHistory(days)
            return []
        },
        channelUsage: async (days = 1) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.channelUsage(days)
            if (isBrowserProduct()) return getBrowserAgentdClient().getAutonomyChannelUsage(days)
            return []
        },
        approveDraft: async (inboundId: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.approveDraft(inboundId)
            if (!isBrowserProduct()) return null
            const draft = (await getBrowserAgentdClient().listDrafts(100)).find(item => item.providerEventId === inboundId)
            return draft ? getBrowserAgentdClient().updateDraftStatus(draft.id, 'approved').then(() => browserAutonomyState()) : null
        },
        sendApprovedDraft: async (inboundId: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.approveDraft(inboundId)
            if (!isBrowserProduct()) return null
            const draft = (await getBrowserAgentdClient().listDrafts(100, 'approved')).find(item => item.providerEventId === inboundId)
            return draft ? getBrowserAgentdClient().sendWhatsAppDraft(draft.id).then(() => browserAutonomyState()) : null
        },
        sendApprovedTemplate: async (inboundId: string, name: string, languageCode: string, parameters: string[] = []) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.sendApprovedTemplate(inboundId, name, languageCode, parameters)
            if (isBrowserProduct()) return getBrowserAgentdClient().sendApprovedTemplate(inboundId, name, languageCode, parameters).then(() => browserAutonomyState())
            return null
        },
        listNotifications: async () => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.listNotifications()
            if (isBrowserProduct()) return getBrowserAgentdClient().listAutonomyNotifications()
            return []
        },
        ackNotification: async (id: number) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.ackNotification(id)
            if (isBrowserProduct()) return getBrowserAgentdClient().ackAutonomyNotification(id)
            return null
        },
        onNotification: (callback: (data: unknown) => void) => isElectron() && window.electron?.autonomy ? window.electron.autonomy.onNotification(callback) : () => {},
        registerApprovedTemplate: async (name: string, languageCode: string, category: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.registerApprovedTemplate(name, languageCode, category)
            if (isBrowserProduct()) return getBrowserAgentdClient().registerApprovedTemplate({ name, languageCode, category })
            return null
        },
        revokeApprovedTemplate: async (name: string, languageCode: string) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.revokeApprovedTemplate(name, languageCode)
            if (isBrowserProduct()) return getBrowserAgentdClient().revokeApprovedTemplate(name, languageCode)
            return null
        },
        setMode: async (mode: string, permission: boolean) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.setMode(mode, permission)
            if (!isBrowserProduct()) return null
            const whatsapp = useWhatsAppStore.getState()
            if (mode === 'auto') {
                whatsapp.setBusinessBotMode(true)
                whatsapp.setWhatsAppEnabled(permission)
                return getBrowserAgentdClient().resumeAll().then(browserAutonomyState)
            }
            if (mode === 'draft') {
                whatsapp.setBusinessBotMode(false)
                whatsapp.setWhatsAppEnabled(permission)
                return getBrowserAgentdClient().resumeAll().then(browserAutonomyState)
            }
            whatsapp.setBusinessBotMode(false)
            whatsapp.setWhatsAppEnabled(false)
            return getBrowserAgentdClient().pauseAll().then(browserAutonomyState)
        },
        onState: (callback: (state: unknown) => void) => {
            if (isElectron() && window.electron?.autonomy) return window.electron.autonomy.onState(callback)
            if (!isBrowserProduct()) return () => {}

            // The browser has no Electron event emitter. Poll the authenticated
            // daemon status so a second tab, the native companion, or a
            // background worker can update the panel without a page reload.
            let cancelled = false
            let timer: ReturnType<typeof setTimeout> | null = null
            const poll = async () => {
                if (cancelled) return
                try { callback(await browserAutonomyState()) } catch { /* state reads fail closed in the adapter */ }
                if (!cancelled) timer = setTimeout(() => void poll(), 5_000)
            }
            void poll()
            return () => {
                cancelled = true
                if (timer) clearTimeout(timer)
            }
        },
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
            return { signedIn: false, email: null, requiresReauthentication: false }
        },
        signInGoogle: async () => {
            if (isElectron() && window.electron?.emailOAuth) {
                return window.electron.emailOAuth.signInGoogle()
            }
            return { signedIn: false, email: null, requiresReauthentication: false }
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
            return { signedIn: false, email: null, requiresReauthentication: false }
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
