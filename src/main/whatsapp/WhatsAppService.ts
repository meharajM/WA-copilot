/**
 * WhatsAppService.ts — Main-process WhatsApp service using Baileys.
 *
 * Runs entirely in the Node.js main process. Exposes methods that the
 * IPC handler thin-routes to from the renderer via the preload bridge.
 *
 * Auth state is persisted in the user-data directory under
 * `whatsapp-auth/` so the user does not need to re-scan the QR code
 * on every app launch.
 */

import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs'
import { app, powerSaveBlocker } from 'electron'
import type { WASocket } from '@whiskeysockets/baileys'
import { formatWhatsAppJid } from '../utils/whatsapp'
import { chatLoggingService } from './ChatLoggingService'
import { RAGService } from '../rag/RAGService'



// A simple map cache to store sent messages for retries
class SimpleMessageCache {
    private store = new Map<string, Record<string, unknown>>()
    private readonly maxSize = 100

    get(key: string) { return this.store.get(key) }
    set(key: string, value: any) {
        if (!value || typeof value !== 'object') return
        if (this.store.size >= this.maxSize) {
            const firstKey = this.store.keys().next().value
            if (firstKey) this.store.delete(firstKey)
        }
        this.store.set(key, value as Record<string, unknown>)
    }
}

class SimpleRetryCache {
    private store = new Map<string, number>()
    get<T>(key: string): T | undefined { return this.store.get(key) as unknown as T }
    set<T>(key: string, value: T): void { this.store.set(key, value as unknown as number) }
    del(key: string): void { this.store.delete(key) }
    flushAll(): void { this.store.clear() }
}

const sentMessagesCache = new SimpleMessageCache()
const msgRetryCounterCache = new SimpleRetryCache()

// Types we expose over IPC — mirrored in the renderer's whatsappStore.ts
export interface WhatsAppConnectionState {
    status: 'disconnected' | 'connecting' | 'connected' | 'error'
    qrCode: string | null
    error: string | null
    phoneNumber: string | null // Target number
    workerNumber: string | null // Self number (scanned)
    handshakeStatus: 'idle' | 'pending' | 'expired' | 'verified' | null 
}

export interface WhatsAppMessage {
    id: string
    from: string
    to: string
    content: string
    timestamp: number
    type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'spreadsheet'
    isFromMe: boolean
    mediaUrl?: string
    caption?: string
}

export class WhatsAppService extends EventEmitter {
    private connectionState: WhatsAppConnectionState = {
        status: 'disconnected',
        qrCode: null,
        error: null,
        phoneNumber: null,
        workerNumber: null,
        handshakeStatus: 'idle'
    }

    private socket: WASocket | null = null
    private authDir: string
    private wakeLockId: number | null = null
    private explicitDisconnect = false
    private reconnectAttempts = 0
    private readonly MAX_RECONNECT_ATTEMPTS = 8

    // ── Anti-Ban: Time-windowed deduplication (Gap 8) ─────────────────────
    // Maps message ID → timestamp. Entries auto-expire after DEDUP_WINDOW_MS.
    private processedMessageIds = new Map<string, number>()
    private readonly DEDUP_WINDOW_MS = 10 * 60 * 1000 // 10 minutes

    // ── Anti-Ban: Hourly volume throttle (Gap 4) ──────────────────────────
    private messageTimestamps: number[] = []
    private readonly MAX_MSGS_PER_HOUR = 120
    
    // Dedicated timestamp for handshake rate-limiting (separated from message sending)
    private _lastHandshakeTime = 0

    // ── Anti-Ban: Sleep / Off-hours Mode (Gap 5) ──────────────────────────
    private sleepModeConfig = {
        enabled: true,
        startHour: 9,  // 9 AM
        endHour: 21    // 9 PM
    }
    
    // Handshake state
    private pendingHandshake: {
        phoneNumber: string
        code: string
        expires: number
    } | null = null

    constructor() {
        super()
        this.authDir = path.join(app.getPath('userData'), 'whatsapp-auth')
    }

    // ── Public API ──────────────────────────────────────────────────────────

    async init(): Promise<void> {
        try {
            const credsFile = path.join(this.authDir, 'creds.json')
            const phoneFile = path.join(this.authDir, 'phone.txt')
            
            // Just log that we found credentials - don't auto-connect
            // Let user explicitly connect to handle any credential issues
            if (fs.existsSync(credsFile)) {
                let savedPhone = ''
                if (fs.existsSync(phoneFile)) {
                    savedPhone = fs.readFileSync(phoneFile, 'utf8').trim()
                }
                console.log('[WhatsAppService] Found existing auth credentials. Auto-connecting in background.')
                
                // Set the saved phone number in state but don't connect
                if (savedPhone) {
                    this._setState({
                        status: 'disconnected',
                        qrCode: null,
                        error: null,
                        phoneNumber: savedPhone,
                        workerNumber: null,
                        handshakeStatus: 'idle'
                    })
                    
                    console.log('[WhatsAppService] Found existing auth credentials. Auto-reconnecting...')
                    console.log(`[WhatsAppService] Restored target JID filter: ${formatWhatsAppJid(savedPhone)}`)
                    
                    // Auto-connect on launch ONLY IF we have a saved phone (indicates successful previous verification)
                    this.connect(savedPhone).catch(e => console.error('[WhatsAppService] Auto-connect error:', e))
                }
            }
        } catch (error) {
            console.error('[WhatsAppService] Init error:', error)
        }
    }

    getConnectionState(): WhatsAppConnectionState {
        return { ...this.connectionState }
    }

    async connect(targetPhoneNumber?: string): Promise<void> {
        this.explicitDisconnect = false
        if (this.connectionState.status === 'connected') return
        if (this.connectionState.status === 'connecting') return
        
        // If we have a saved phone number, use it.
        const effectivePhone: string | null = (targetPhoneNumber ?? this.connectionState.phoneNumber) ?? null

        this._setState({
            ...this.connectionState,
            status: 'connecting',
            qrCode: null,
            error: null,
            phoneNumber: effectivePhone ?? null,
            workerNumber: this.connectionState.workerNumber
        })

        // Don't clear auth here - it breaks the QR scan flow!
        // Auth is only cleared on explicit disconnect or Stream Error
        
        try {
            // Dynamically import Baileys to avoid bundling issues
            const {
                default: makeWASocket,
                useMultiFileAuthState,
                DisconnectReason,
                fetchLatestBaileysVersion,
            } = await import('@whiskeysockets/baileys')

            // Ensure auth directory exists
            fs.mkdirSync(this.authDir, { recursive: true })

            // eslint-disable-next-line react-hooks/rules-of-hooks
            const { state, saveCreds } = await useMultiFileAuthState(this.authDir)

            const { version } = await fetchLatestBaileysVersion()

            const silentLogger = {
                level: 'silent' as const,
                trace: () => {},
                debug: () => {},
                info: () => {},
                warn: (obj: unknown, msg?: string) => console.warn('[Baileys]', msg, obj),
                error: (obj: unknown, msg?: string) => console.error('[Baileys]', msg, obj),
                fatal: (obj: unknown, msg?: string) => console.error('[Baileys FATAL]', msg, obj),
                child: () => silentLogger,
            }

            // ── Anti-Ban: Rotate browser fingerprint on every connect (Gap 3) ──
            const BROWSER_PROFILES: [string, string, string][] = [
                ['WhatsApp', 'Chrome', '124.0.6367.118'],
                ['WhatsApp', 'Chrome', '122.0.6261.128'],
                ['WhatsApp', 'Chrome', '120.0.6099.130'],
                ['WhatsApp', 'Safari', '17.4'],
                ['WhatsApp', 'Firefox', '125.0'],
            ]
            const browserProfile = BROWSER_PROFILES[Math.floor(Math.random() * BROWSER_PROFILES.length)]
            console.log(`[WhatsAppService] Using browser profile: ${browserProfile.join(' / ')}`)

            const sock = makeWASocket({
                version,
                auth: state,
                logger: silentLogger,
                printQRInTerminal: false,
                browser: browserProfile,
                connectTimeoutMs: 60000,
                msgRetryCounterCache,
                getMessage: async (key) => {
                    const id = key.id;
                    if (id) {
                        const msg = sentMessagesCache.get(id);
                        if (msg) return msg;
                    }
                    return { conversation: 'Hello, this is fallback text.' };
                },
                markOnlineOnConnect: true,
            })

            this.socket = sock


            // QR code and connection state events
            // Use 'any' because Baileys exposes a complex union type that doesn't
            // match our simplified typed update object cleanly.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sock.ev.on('connection.update', (update: any) => {
                const { connection, lastDisconnect, qr } = update as {
                    connection?: string
                    lastDisconnect?: { error?: { output?: { statusCode?: number }; message?: string }; reason?: string }
                    qr?: string
                }

                console.log('[WhatsAppService] Connection update:', { connection, qr: !!qr, lastDisconnect })

                if (qr) {
                    this._setState({ ...this.connectionState, status: 'connecting', qrCode: qr })
                }

                if (connection === 'open') {
                    console.log('[WhatsAppService] Connection opened successfully!')
                    // ── Anti-Ban: Reset backoff counter on successful connect (Gap 7) ──
                    this.reconnectAttempts = 0
                    
                    const workerJid = sock.user?.id || ''
                    const workerPhone = workerJid.split(':')[0].split('@')[0]
                    
                    if (this.connectionState.phoneNumber) {
                        console.log(`[WhatsAppService] Target JID set for message filtering: ${formatWhatsAppJid(this.connectionState.phoneNumber)}`)
                    }
                    
                    this._setState({
                        ...this.connectionState,
                        status: 'connected',
                        qrCode: null,
                        error: null,
                        phoneNumber: this.connectionState.phoneNumber,
                        workerNumber: workerPhone || null
                    })
                    
                    if (this.wakeLockId === null) {
                        this.wakeLockId = powerSaveBlocker.start('prevent-app-suspension')
                        console.log(`[Main] Wake lock acquired (WhatsApp connected). ID: ${this.wakeLockId}`)
                    }
                }

                if (connection === 'close') {
                    if (this.wakeLockId !== null) {
                        powerSaveBlocker.stop(this.wakeLockId)
                        console.log('[Main] Wake lock released (WhatsApp disconnected).')
                        this.wakeLockId = null
                    }

                    const statusCode = lastDisconnect?.error?.output?.statusCode
                    const errorMessage = lastDisconnect?.error?.message || lastDisconnect?.reason || 'Unknown reason'
                    const loggedOutCode = DisconnectReason.loggedOut
                    
                    console.log('[WhatsAppService] Connection closed:', { statusCode, errorMessage, loggedOutCode })
                    this.socket = null

                    if (this.explicitDisconnect) {
                        return // disconnect() method handles state and auth clearing
                    }

                    if (statusCode === loggedOutCode) {
                        console.log('[WhatsAppService] Logged out from external device. Clearing auth...')
                        this._clearAuth()
                        this._setState({
                            ...this.connectionState,
                            status: 'disconnected',
                            qrCode: null,
                            error: 'Logged out from mobile device. Please scan QR again.',
                            phoneNumber: null,
                            workerNumber: null,
                            handshakeStatus: 'idle'
                        })
                        return
                    }

                    const isStreamError = errorMessage?.toLowerCase().includes('stream errored') || 
                                          errorMessage?.toLowerCase().includes('restart required')
                    
                    if (isStreamError) {
                        console.log('[WhatsAppService] Stream error detected, dropping to disconnected mode for manual re-auth...')
                        this._setState({
                            ...this.connectionState,
                            status: 'disconnected',
                            qrCode: null,
                            error: null, // Let user click connect normally
                            phoneNumber: (effectivePhone as string | null) ?? null,
                            workerNumber: this.connectionState.workerNumber
                        })
                        return // Don't clear auth
                    }
                    
                    const isNetworkError = statusCode === undefined || 
                        statusCode === 428 || // Server unreachable
                        statusCode === 503 || // Service unavailable  
                        statusCode === 504  // Gateway timeout

                    if (isNetworkError && effectivePhone) {
                        // ── Anti-Ban: Exponential backoff with jitter (Gap 7) ──
                        this._scheduleReconnect(effectivePhone)
                        return // Don't clear auth
                    }

                    // Fallback to absolute generic crash
                    let specificError = 'Connection closed unexpectedly. Please reconnect.'
                    if (errorMessage) {
                        specificError = `Connection failed: ${errorMessage}`
                    }
                    console.error('[WhatsAppService] Connection error:', specificError)
                    
                    this._clearAuth()
                    this._setState({
                        ...this.connectionState,
                        status: 'error',
                        qrCode: null,
                        error: specificError,
                        phoneNumber: effectivePhone ?? null,
                        workerNumber: this.connectionState.workerNumber,
                        handshakeStatus: 'idle'
                    })
                }
            })

            // Persist credentials on update
            sock.ev.on('creds.update', saveCreds)

            // Incoming messages
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sock.ev.on('messages.upsert', async (upsert: { messages: any[]; type: string }) => {
                const { messages, type } = upsert
                if (type !== 'notify') return
                
                for (const raw of messages) {
                    const rawId = raw.key?.id
                    // ── Anti-Ban: Time-windowed deduplication (Gap 8) ──
                    if (rawId && this._isDuplicate(rawId)) {
                        console.log(`[WhatsAppService] Dropping duplicate/seen message ID: ${rawId}`)
                        continue
                    }

                    const msg = await this._parseMessage(raw, sock)
                    if (msg) {

                        const fromClean = msg.from.split('@')[0].split(':')[0]
                        console.log(`[WhatsAppService] Incoming: from=${msg.from} (clean=${fromClean}) isFromMe=${msg.isFromMe} content="${msg.content.substring(0, 50)}"`)

                        // Handshake Verification Check
                        if (this.pendingHandshake && !msg.isFromMe) {
                            // If time expired, clear it
                            if (Date.now() > this.pendingHandshake.expires) {
                                console.log('[WhatsAppService] Handshake expired.')
                                this.pendingHandshake = null
                                this._setState({ ...this.connectionState, handshakeStatus: 'expired' })
                                continue
                            }

                            const handshakeClean = this.pendingHandshake.phoneNumber.replace(/\D/g, '')
                            console.log(`[WhatsAppService] Handshake Check: Expected=${handshakeClean}, Received=${fromClean}, CodeMatch=${msg.content.includes(this.pendingHandshake.code)}`)
                            
                            if ((fromClean === handshakeClean || fromClean.endsWith(handshakeClean)) && msg.content.includes(this.pendingHandshake.code)) {
                                console.log(`[WhatsAppService] Handshake SUCCESS for ${msg.from}!`)
                                const verifiedPhone = fromClean
                                this.pendingHandshake = null
                                
                                // Finalize link
                                this.connectionState.phoneNumber = verifiedPhone
                                fs.mkdirSync(this.authDir, { recursive: true })
                                fs.writeFileSync(path.join(this.authDir, 'phone.txt'), verifiedPhone)
                                
                                this._setState({
                                    ...this.connectionState,
                                    phoneNumber: verifiedPhone,
                                    handshakeStatus: 'verified'
                                })
                                // Message successfully consumed for handshake, stop processing
                                continue
                            }
                        }

                        // --- Business Bot Logic: No JID Filter ---
                        // We no longer drop messages from unknown JIDs here.
                        // Filtering is now handled in the renderer (useWhatsAppBridge) 
                        // based on whether 'Business Bot Mode' or 'WhatsApp Mode' is active.
                        
                        if (!msg.isFromMe && raw.key) {
                            try {
                                sock.readMessages([raw.key]).catch(e => console.error('[Baileys] auto-read error:', e))
                            } catch {
                                // ignore
                            }
                        }

                        // Persistently log to SQLite
                        chatLoggingService.logMessage({
                            id: msg.id,
                            from_jid: msg.from,
                            to_jid: msg.to,
                            content: msg.content,
                            timestamp: msg.timestamp,
                            type: msg.type,
                            is_from_me: msg.isFromMe ? 1 : 0,
                            media_url: msg.mediaUrl
                        })

                        this.emit('message', msg)

                        // --- Local Knowledge Ingestion (RAG) ---
                        // Automatically ingest documents and spreadsheets into the local RAG index
                        if (msg.type === 'document' || msg.type === 'spreadsheet') {
                            if (msg.mediaUrl && msg.mediaUrl.startsWith('file://')) {
                                const filePath = msg.mediaUrl.replace('file://', '')
                                RAGService.getInstance().ingestFile(filePath).then(res => {
                                    if (res.success) {
                                        console.log(`[WhatsAppService] Auto-ingested document into RAG: ${msg.content}`)
                                    } else {
                                        console.warn(`[WhatsAppService] Failed to auto-ingest document: ${res.error}`)
                                    }
                                }).catch(e => console.error('[WhatsAppService] RAG auto-ingest error:', e))
                            }
                        }

                        // Phase 2 Agent logic: No longer echoing. The renderer's useAgent 
                        // handles the agent workflow via the 'message' event emitted above.
                    } else {
                        // Log raw message if parsing failed, but only if it's not a protocol message
                        if (raw.message) {
                             console.log(`[WhatsAppService] Failed to parse message from JID: ${raw.key?.remoteJid}`)
                        }
                    }
                }
            })
        } catch (error) {
            this._setState({
                ...this.connectionState,
                status: 'error',
                qrCode: null,
                error: error instanceof Error ? error.message : String(error),
                phoneNumber: targetPhoneNumber ?? null,
                workerNumber: this.connectionState.workerNumber
            })
            throw error
        }
    }

    async setTargetPhoneNumber(phoneNumber: string): Promise<{ success: boolean; error?: string; handshakeCode?: string }> {
        if (!phoneNumber) return { success: false, error: 'Phone number required' }
        
        const normalized = phoneNumber.trim()
        
        // Rate limiting for handshake requests
        const now = Date.now()
        if (now - this._lastHandshakeTime < 5000) { // Throttled to 5 seconds per request
            return { success: false, error: 'Handshake slow-down. Please wait 5 seconds between attempts.' }
        }
        this._lastHandshakeTime = now

        // Check if matching worker (self)
        if (this.connectionState.workerNumber) {
            const workerNormalized = this.connectionState.workerNumber.replace(/\D/g, '')
            const targetNormalized = normalized.replace(/\D/g, '')
            if (workerNormalized === targetNormalized) {
                return { success: false, error: 'Cannot use the same number for both Worker and Personal' }
            }
        }

        try {
            // Generate a 6-digit handshake code
            const code = Math.floor(100000 + Math.random() * 900000).toString()
            this.pendingHandshake = {
                phoneNumber: normalized,
                code,
                expires: Date.now() + (5 * 60 * 1000) // 5 minutes
            }
            
            this._setState({ ...this.connectionState, handshakeStatus: 'pending' })
            
            // Send the handshake message
            // We do NOT send the code in the message. The code is shown on the computer screen.
            // This proves the person at the computer has control over the phone.
            const intro = `🤖 *AI-Worker Verification*\n\nPlease reply to this message with the *6-digit verification code* shown on your computer screen to link this as your personal device.`
            
            const jid = formatWhatsAppJid(normalized)
            console.log(`[WhatsAppService] Attempting handshake to JID: ${jid} (Input: ${normalized})`)
            
            const result = await this.sendMessage(normalized, intro)
            
            if (!result.success) {
                console.error(`[WhatsAppService] Handshake message failed to ${jid}: ${result.error}`)
                return { success: false, error: `Could not send verification message. ${result.error}` }
            }
            
            console.log(`[WhatsAppService] Handshake started successfully for ${normalized}. (Wait for user to reply with code shown in UI)`)
            
            return { success: true, handshakeCode: code }
        } catch (error) {
            console.error('[WhatsAppService] Handshake error:', error)
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    }

    async disconnect(clearAuth = true): Promise<void> {
        this.explicitDisconnect = true
        console.log(`[WhatsAppService] Disconnecting (clearAuth=${clearAuth})...`)
        
        if (this.wakeLockId !== null) {
            powerSaveBlocker.stop(this.wakeLockId)
            console.log('[Main] Wake lock released (WhatsApp disconnected).')
            this.wakeLockId = null
        }
        
        if (this.socket) {
            try {
                if (clearAuth) {
                    await (this.socket as { logout: () => Promise<void> }).logout()
                    console.log('[WhatsAppService] Logged out from WhatsApp')
                } else {
                    (this.socket as { end: (err: any) => void }).end(undefined) // Baileys end session
                    console.log('[WhatsAppService] Session ended (not logged out)')
                }
            } catch (err: unknown) {
                console.warn('[WhatsAppService] Disconnect warning:', err instanceof Error ? err.message : String(err))
            }
            this.socket = null
        }
        
        if (clearAuth) {
            // Clear all auth data - this ensures a fresh QR scan on next connect
            this._clearAuth()
            
            // Reset internal state completely
            this._setState({
                ...this.connectionState,
                status: 'disconnected',
                qrCode: null,
                error: null,
                phoneNumber: null,
                workerNumber: null,
                handshakeStatus: 'idle'
            })
            console.log('[WhatsAppService] Auth cleared.')
        } else {
            this._setState({
                ...this.connectionState,
                status: 'disconnected',
                qrCode: null,
            })
            console.log('[WhatsAppService] Disconnect complete - auth preserved')
        }
    }

    async sendMessage(to: string, content: string): Promise<{ success: boolean; error?: string }> {
        if (!this.socket || this.connectionState.status !== 'connected') {
            return { success: false, error: 'WhatsApp not connected' }
        }

        // ── Anti-Ban: Hourly volume throttle (Gap 4) ──
        const throttle = this._checkVolumeThrottle()
        if (!throttle.allowed) {
            const waitMin = Math.ceil(throttle.waitMs / 60000)
            return { success: false, error: `Hourly message limit (${this.MAX_MSGS_PER_HOUR}) reached. Try again in ~${waitMin} minute(s).` }
        }

        // ── Anti-Ban: Gaussian jitter delay (Gap 1) ──
        // Only apply to bot-initiated outbound messages (skip for handshake pings)
        await this._humanizedDelay()

        // ── Anti-Ban: Sleep / Off-hours Mode (Gap 5) ──
        if (!this._isInActiveHours()) {
            return { 
                success: false, 
                error: `Sleep Mode Active: Off-hours (${this.sleepModeConfig.startHour}:00 - ${this.sleepModeConfig.endHour}:00). Message suppressed to mitigate ban risk.` 
            }
        }

        try {
            // Validate and format JID
            const jid = formatWhatsAppJid(to)

            // Emit escalation if we detect a handoff string (optional: can be called explicitly too)
            if (content.includes("connect you with a team member")) {
                this.emitEscalation(to, 'frustration_detected')
            }
            if (!jid) {
                return { success: false, error: 'Invalid phone number format' }
            }
            
            const result = await this.socket.sendMessage(jid, { text: content })
            if (result && result.key && result.key.id && result.message) {
                 sentMessagesCache.set(result.key.id, result.message)
                 
                 // Log our outgoing message
                 chatLoggingService.logMessage({
                    id: result.key.id,
                    from_jid: this.connectionState.workerNumber || 'me',
                    to_jid: jid,
                    content,
                    timestamp: Date.now(),
                    type: 'text',
                    is_from_me: 1
                 })
            }
            console.log(`[WhatsAppService] Message sent successfully to: ${jid}. Content: "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`)
            return { success: true }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    }

    async sendPresence(to: string, state: 'unavailable' | 'available' | 'composing' | 'recording' | 'paused'): Promise<{ success: boolean; error?: string }> {
        if (!this.socket || this.connectionState.status !== 'connected') {
             return { success: false, error: 'WhatsApp not connected' }
        }
        try {
            const jid = formatWhatsAppJid(to)
            if (!jid) {
                return { success: false, error: 'Invalid phone number format' }
            }
            await this.socket.sendPresenceUpdate(state, jid)
            return { success: true }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    }

    async sendMediaMessage(
        to: string,
        filePath: string,
        caption?: string,
        type: 'image' | 'video' | 'audio' | 'document' | 'spreadsheet' = 'image'
    ): Promise<{ success: boolean; error?: string }> {
        if (!this.socket || this.connectionState.status !== 'connected') {
            return { success: false, error: 'WhatsApp not connected' }
        }

        try {
            const jid = formatWhatsAppJid(to)
            if (!jid) {
                return { success: false, error: 'Invalid phone number format' }
            }

            if (!fs.existsSync(filePath)) {
                return { success: false, error: 'File not found' }
            }

            const buffer = fs.readFileSync(filePath)
            
            let messageContent: any = {}
            if (type === 'image') {
                messageContent = { image: buffer, caption }
            } else if (type === 'video') {
                messageContent = { video: buffer, caption }
            } else if (type === 'audio') {
                // ptt: true sends it as a "Voice Note"
                messageContent = { audio: buffer, ptt: true }
            } else if (type === 'document' || type === 'spreadsheet') {
                const fileName = path.basename(filePath)
                messageContent = { document: buffer, fileName, caption, mimetype: 'application/octet-stream' }
            }

            const result = await this.socket.sendMessage(jid, messageContent)
            
            if (result && result.key && result.key.id && result.message) {
                sentMessagesCache.set(result.key.id, result.message)
            }

            console.log(`[WhatsAppService] Media message (${type}) sent successfully to: ${jid}`)
            return { success: true }
        } catch (error) {
            console.error('[WhatsAppService] Send media error:', error)
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    }

    // ── Private helpers ─────────────────────────────────────────────────────

    /**
     * Anti-Ban: Gaussian jitter delay before each outbound message (Gap 1).
     * Uses Box-Muller transform to sample from a normal distribution
     * centred between baseMinMs and baseMaxMs, clamped to that range.
     */
    private async _humanizedDelay(baseMinMs = 8000, baseMaxMs = 45000): Promise<void> {
        let u = 0, v = 0
        while (u === 0) u = Math.random()
        while (v === 0) v = Math.random()
        const gauss = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
        const mean = (baseMinMs + baseMaxMs) / 2
        const stddev = (baseMaxMs - baseMinMs) / 6
        const delayMs = Math.max(baseMinMs, Math.min(baseMaxMs, mean + gauss * stddev))
        console.log(`[WhatsAppService] Anti-ban delay: ${Math.round(delayMs / 1000)}s`)
        await new Promise<void>(r => setTimeout(r, delayMs))
    }

    /**
     * Anti-Ban: Sliding-window hourly volume throttle (Gap 4).
     * Returns { allowed: false, waitMs } when the limit is reached.
     */
    private _checkVolumeThrottle(): { allowed: boolean; waitMs: number } {
        const now = Date.now()
        const oneHourAgo = now - 3_600_000
        this.messageTimestamps = this.messageTimestamps.filter(t => t > oneHourAgo)
        if (this.messageTimestamps.length >= this.MAX_MSGS_PER_HOUR) {
            const waitMs = this.messageTimestamps[0] + 3_600_000 - now
            console.warn(`[WhatsAppService] Hourly limit hit. Wait ${Math.ceil(waitMs / 60000)}m.`)
            return { allowed: false, waitMs }
        }
        this.messageTimestamps.push(now)
        return { allowed: true, waitMs: 0 }
    }

    /**
     * Anti-Ban: Time-windowed message deduplication (Gap 8).
     * Returns true if message was already processed within DEDUP_WINDOW_MS.
     */
    private _isDuplicate(id: string): boolean {
        const now = Date.now()
        // Evict expired entries
        for (const [k, t] of this.processedMessageIds) {
            if (now - t > this.DEDUP_WINDOW_MS) this.processedMessageIds.delete(k)
        }
        if (this.processedMessageIds.has(id)) return true
        this.processedMessageIds.set(id, now)
        return false
    }

    /**
     * Anti-Ban: Exponential backoff reconnect with jitter (Gap 7).
     * Delay grows as 5s × 2^attempt (capped at 5 min) + up to 5s random jitter.
     */
    private _scheduleReconnect(effectivePhone: string): void {
        if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
            console.error('[WhatsAppService] Max reconnect attempts reached. Giving up.')
            this._setState({
                ...this.connectionState,
                status: 'error',
                error: 'Could not reconnect after multiple attempts. Please reconnect manually.',
            })
            return
        }
        const base = Math.min(5000 * Math.pow(2, this.reconnectAttempts), 300_000)
        const jitter = Math.random() * 5000
        const delay = Math.round(base + jitter)
        this.reconnectAttempts++
        console.log(`[WhatsAppService] Reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay / 1000)}s...`)
        this._setState({
            ...this.connectionState,
            status: 'connecting',
            qrCode: null,
            error: null,
            phoneNumber: effectivePhone ?? null,
            workerNumber: this.connectionState.workerNumber
        })
        setTimeout(() => {
            if (this.connectionState.status !== 'disconnected') {
                this.connect(effectivePhone).catch(e => {
                    console.error('[WhatsAppService] Auto-reconnect failed:', e)
                })
            }
        }, delay)
    }

    /**
     * Anti-Ban: Sleep / Off-hours Mode check (Gap 5).
     * Returns true if current time is within active hours.
     */
    private _isInActiveHours(): boolean {
        if (!this.sleepModeConfig.enabled) return true
        const hour = new Date().getHours()
        const active = hour >= this.sleepModeConfig.startHour && hour < this.sleepModeConfig.endHour
        if (!active) {
            console.log(`[WhatsAppService] Sleep Mode: Suppressing outbound message (current hour: ${hour})`)
        }
        return active
    }

    /**
     * Anti-Ban: Emit an escalation event (Gap 6).
     * Called when the agent detects frustration or reaches a loop.
     */
    public emitEscalation(jid: string, reason: string): void {
        console.log(`[WhatsAppService] ESCALATION triggered for ${jid}. Reason: ${reason}`)
        this.emit('escalation', { jid, reason, timestamp: Date.now() })
    }

    private _setState(state: WhatsAppConnectionState): void {
        this.connectionState = state
        this.emit('connectionChange', state)
    }

    private _clearAuth(): void {
        try {
            if (fs.existsSync(this.authDir)) {
                console.log('[WhatsAppService] Clearing auth directory:', this.authDir)
                fs.rmSync(this.authDir, { recursive: true, force: true })
                console.log('[WhatsAppService] Auth directory cleared')
            } else {
                console.log('[WhatsAppService] No auth directory to clear')
            }
        } catch (err: unknown) {
            console.error('[WhatsAppService] Error in logout:', err instanceof Error ? err.message : String(err))
        }  
        // Also ensure the parent directory exists for next connect
        try {
            fs.mkdirSync(this.authDir, { recursive: true })
        } catch {
            // ignore - will be created on next connect
        }
    }

    private async _parseMessage(raw: any, socket?: any): Promise<WhatsAppMessage | null> {
        try {
            if (!raw?.key || !raw?.message) return null

            const msg = raw.message
            
            // Comprehensive text extraction
            let textContent: string | null = null
            
            if (msg.conversation) {
                textContent = msg.conversation
            } else if (msg.extendedTextMessage?.text) {
                textContent = msg.extendedTextMessage.text
            } else if (msg.imageMessage?.caption) {
                textContent = msg.imageMessage.caption
            } else if (msg.videoMessage?.caption) {
                textContent = msg.videoMessage.caption
            } else if (msg.documentMessage?.caption) {
                textContent = msg.documentMessage.caption
            } else if (msg.viewOnceMessage?.message?.extendedTextMessage?.text) {
                textContent = msg.viewOnceMessage.message.extendedTextMessage.text
            } else if (msg.viewOnceMessage?.message?.conversation) {
                textContent = msg.viewOnceMessage.message.conversation
            } else if (msg.ephemeralMessage?.message?.extendedTextMessage?.text) {
                textContent = msg.ephemeralMessage.message.extendedTextMessage.text
            } else if (msg.ephemeralMessage?.message?.conversation) {
                textContent = msg.ephemeralMessage.message.conversation
            } else if (msg.stickerMessage) {
                textContent = `[User sent a sticker: ${msg.stickerMessage.mimetype}]`
            } else if (msg.contactMessage) {
                textContent = `[User shared a contact: ${msg.contactMessage.displayName} (${msg.contactMessage.vcard})]`
            } else if (msg.locationMessage) {
                textContent = `[User shared a location: Lat ${msg.locationMessage.degreesLatitude}, Long ${msg.locationMessage.degreesLongitude}]`
            } else if (msg.liveLocationMessage) {
                textContent = `[User shared a live location: Lat ${msg.liveLocationMessage.degreesLatitude}, Long ${msg.liveLocationMessage.degreesLongitude}]`
            }

            const docFileName = msg.documentMessage?.fileName || '';
            const docExt = docFileName.split('.').pop()?.toLowerCase() || '';
            const SPREADSHEET_EXTS = new Set(['xlsx', 'xls', 'csv', 'ods', 'tsv', 'numbers']);
            const isSpreadsheet = msg.documentMessage && SPREADSHEET_EXTS.has(docExt);

            const type: WhatsAppMessage['type'] = msg.imageMessage
                ? 'image'
                : msg.videoMessage
                    ? 'video'
                    : isSpreadsheet
                        ? 'spreadsheet'
                        : msg.documentMessage
                            ? 'document'
                            : msg.audioMessage
                                ? 'audio'
                                : 'text'

            let mediaUrl: string | undefined = undefined;

            if (socket && (msg.imageMessage || msg.videoMessage || msg.audioMessage || msg.documentMessage)) {
                try {
                    const { downloadMediaMessage } = await import('@whiskeysockets/baileys')
                    const buffer = await downloadMediaMessage(
                        raw,
                        'buffer',
                        {},
                        { 
                            logger: console as any,
                            reuploadRequest: socket.updateMediaMessage 
                        }
                    )
                    
                    if (Buffer.isBuffer(buffer)) {
                        let ext = 'bin';
                        if (msg.imageMessage) ext = 'jpg';
                        else if (msg.videoMessage) ext = 'mp4';
                        else if (msg.audioMessage) ext = 'ogg';
                        else if (msg.documentMessage) ext = msg.documentMessage.fileName?.split('.').pop() || 'bin';
                        let tempPath = path.join(app.getPath('temp'), `wa_media_${Date.now()}_${Math.random().toString(36).substring(7)}.${ext}`);
                        fs.writeFileSync(tempPath, buffer);

                        // MarkItDown explicitly supports .mp3 and .wav, but often ignores .ogg directly.
                        if (ext === 'ogg') {
                            try {
                                const { execSync } = require('child_process');
                                const mp3Path = tempPath.replace('.ogg', '.mp3');
                                const envPath = `${process.env.PATH || ''}:/usr/local/bin:/opt/homebrew/bin:${process.env.HOME || ''}/.local/bin`;
                                // Synchronous execution since these files are very small audio clips (a few seconds/KBs)
                                execSync(`ffmpeg -y -i "${tempPath}" "${mp3Path}"`, { 
                                    env: { ...process.env, PATH: envPath },
                                    stdio: 'ignore' 
                                });
                                try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
                                tempPath = mp3Path;
                            } catch (convErr) {
                                console.error('[WhatsAppService] MP3 conversion failed, attempting to pass OGG:', convErr);
                            }
                        }

                        mediaUrl = `file://${tempPath}`;
                        console.log(`[WhatsAppService] Successfully saved ${type} to ${tempPath}`);
                    }
                } catch (err) {
                    console.error('[WhatsAppService] Failed to download media:', err)
                }
            }

            if (!textContent && !mediaUrl) return null

            // Handle LID vs PN (WhatsApp is moving towards LIDs for some users)
            // senderPn usually contains the actual phone number JID
            const fromJid = raw.key.senderPn || raw.key.remoteJid || ''

            return {
                id: raw.key.id ?? `wa_${Date.now()}`,
                from: fromJid,
                to: raw.key.fromMe ? (raw.key.senderPn || raw.key.remoteJid || '') : 'me',
                content: textContent || '[Media Message]',
                timestamp: (raw.messageTimestamp as number) * 1000 || Date.now(),
                type,
                mediaUrl,
                caption: textContent ?? undefined,
                isFromMe: raw.key.fromMe ?? false,
            }
        } catch (err) {
            console.error('[WhatsAppService] Unhandled parsing error:', err);
            return null
        }
    }
}

// Singleton instance — created once in main process
export const whatsappService = new WhatsAppService()
