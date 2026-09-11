/**
 * Omnichannel Bridge - Standard Interfaces for Messaging Platforms
 * 
 * This package defines the abstraction layer required to integrate 
 * multiple communication channels (WhatsApp, Telegram, Email, Instagram)
 * into the AIConsumerAgent Business Intelligence Suite.
 */

export type ChannelType = 'whatsapp' | 'telegram' | 'email' | 'instagram' | 'messenger' | 'twitter' | 'web'

export interface ChannelCapabilities {
    responseWindowMs: number | null
    maxTextLength: number
    supportsTemplates: boolean
    supportsDeliveryReceipts: boolean
    supportsIdempotency: boolean
}

const CHANNEL_CAPABILITIES: Record<ChannelType, ChannelCapabilities> = {
    whatsapp: { responseWindowMs: 24 * 60 * 60 * 1000, maxTextLength: 4096, supportsTemplates: true, supportsDeliveryReceipts: true, supportsIdempotency: true },
    email: { responseWindowMs: null, maxTextLength: 100_000, supportsTemplates: false, supportsDeliveryReceipts: false, supportsIdempotency: true },
    instagram: { responseWindowMs: 24 * 60 * 60 * 1000, maxTextLength: 2000, supportsTemplates: false, supportsDeliveryReceipts: false, supportsIdempotency: true },
    messenger: { responseWindowMs: 24 * 60 * 60 * 1000, maxTextLength: 2000, supportsTemplates: false, supportsDeliveryReceipts: false, supportsIdempotency: true },
    twitter: { responseWindowMs: 24 * 60 * 60 * 1000, maxTextLength: 2000, supportsTemplates: false, supportsDeliveryReceipts: false, supportsIdempotency: true },
    telegram: { responseWindowMs: null, maxTextLength: 4096, supportsTemplates: false, supportsDeliveryReceipts: false, supportsIdempotency: true },
    web: { responseWindowMs: null, maxTextLength: 4096, supportsTemplates: false, supportsDeliveryReceipts: false, supportsIdempotency: false }
}

export function getChannelCapabilities(channel: ChannelType): ChannelCapabilities {
    return { ...CHANNEL_CAPABILITIES[channel] }
}

export interface ChannelAttachment {
    id?: string
    name?: string
    mimeType?: string
    size?: number
}

export interface ChannelMessage {
    schemaVersion?: 1
    id: string
    channel: ChannelType
    from: string // JID, Chat ID, or Email Address
    to: string
    content: string
    timestamp: number
    type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'spreadsheet'
    isFromMe: boolean
    mediaUrl?: string
    mediaId?: string
    caption?: string
    replyToId?: string
    providerEventId?: string
    rawPayload?: any // The original provider-specific payload
    subject?: string
    messageId?: string
    inReplyTo?: string
    references?: string
    actor?: 'customer' | 'owner' | 'system'
    businessId?: string
    channelAccountId?: string
    conversationId?: string
    attachments?: ChannelAttachment[]
}

export function withChannelScope(message: ChannelMessage, businessId = process.env.AICA_BUSINESS_ID || 'local-business'): ChannelMessage {
    return { ...message, businessId, channelAccountId: message.channelAccountId || message.to }
}

export function isValidNormalizedChannelMessage(value: unknown): value is ChannelMessage {
    if (!value || typeof value !== 'object') return false
    const message = value as Partial<ChannelMessage>
    return message.schemaVersion === 1 && typeof message.id === 'string' && Boolean(message.id.trim()) && typeof message.channel === 'string' && typeof message.businessId === 'string' && Boolean(message.businessId.trim()) && typeof message.channelAccountId === 'string' && Boolean(message.channelAccountId.trim()) && typeof message.from === 'string' && Boolean(message.from.trim()) && typeof message.to === 'string' && Boolean(message.to.trim()) && typeof message.timestamp === 'number' && Number.isFinite(message.timestamp) && message.timestamp > 0 && (typeof message.providerEventId === 'string' && Boolean(message.providerEventId.trim()) || Boolean(message.id)) && (typeof message.conversationId === 'string' && Boolean(message.conversationId.trim()) || Boolean(message.from))
}

export interface NormalizedEmailInput {
    id: string
    from: string
    to: string
    subject: string
    body: string
    timestamp: number
    messageId?: string
    inReplyTo?: string
    references?: string
    isFromMe: boolean
    rawPayload?: unknown
    attachments?: ChannelAttachment[]
}

export function normalizeEmailMessage(email: NormalizedEmailInput): ChannelMessage {
    return withChannelScope({
        schemaVersion: 1, id: email.id, channel: 'email', from: email.from, to: email.to,
        content: email.body, timestamp: email.timestamp, type: 'text', isFromMe: email.isFromMe,
        subject: email.subject, messageId: email.messageId, inReplyTo: email.inReplyTo,
        references: email.references, providerEventId: email.messageId || email.id,
        actor: email.isFromMe ? 'owner' : 'customer', conversationId: email.references || email.inReplyTo || email.messageId || email.id, rawPayload: email.rawPayload,
        attachments: email.attachments
    })
}

export interface ChannelConnectionState {
    status: 'disconnected' | 'connecting' | 'qr_required' | 'connected' | 'logged_out' | 'blocked' | 'error'
    channel: ChannelType
    accountId: string | null // e.g., phone number, bot token, email address
    error: string | null
    metadata?: Record<string, any> // QR codes, auth URLs, etc.
}

/**
 * Common Interface all messaging bridges MUST implement
 */
export interface ChannelProvider {
    /** 
     * Unique identifier for this provider (e.g., 'telegram', 'whatsapp')
     */
    readonly type: ChannelType

    /**
     * Initialize the provider (load stored auth, setup listeners)
     */
    init(): Promise<void>

    /**
     * Connect or authenticate to the provider network
     * @param identifier Optional target account identifier
     */
    connect(identifier?: string): Promise<void>

    /**
     * Disconnect from the network and optionally clear auth
     */
    disconnect(clearAuth?: boolean): Promise<void>

    /**
     * Send a text message to a contact on this channel
     */
    sendMessage(to: string, content: string): Promise<{ success: boolean; error?: string }>
    
    /**
     * Send media to a contact on this channel
     */
    sendMediaMessage?(
        to: string, 
        filePath: string, 
        caption?: string, 
        type?: ChannelMessage['type']
    ): Promise<{ success: boolean; error?: string }>

    /**
     * Get current connection state
     */
    getConnectionState(): ChannelConnectionState

    // Event hooks
    onMessage(handler: (msg: ChannelMessage) => void): void
    onConnectionChange(handler: (state: ChannelConnectionState) => void): void
}

/**
 * Omnichannel Manager - Routes messages to their respective providers
 */
export class ChannelManager {
    private static instance: ChannelManager
    private providers: Map<ChannelType, ChannelProvider> = new Map()

    private constructor() {}

    static getInstance(): ChannelManager {
        if (!ChannelManager.instance) {
            ChannelManager.instance = new ChannelManager()
        }
        return ChannelManager.instance
    }

    /**
     * Register a new messaging channel provider (e.g., WhatsApp, Telegram)
     */
    registerProvider(provider: ChannelProvider) {
        this.providers.set(provider.type, provider)
        console.log(`[Omnichannel] Registered provider: ${provider.type}`)
        
        // Setup global event passthrough here if needed
    }

    getProvider(type: ChannelType): ChannelProvider | undefined {
        return this.providers.get(type)
    }

    async sendMessage(type: ChannelType, to: string, content: string) {
        const provider = this.getProvider(type)
        if (!provider) throw new Error(`Provider ${type} not registered`)
        return provider.sendMessage(to, content)
    }
}
