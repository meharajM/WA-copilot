/**
 * Omnichannel Bridge - Standard Interfaces for Messaging Platforms
 * 
 * This package defines the abstraction layer required to integrate 
 * multiple communication channels (WhatsApp, Telegram, Email, Instagram)
 * into the WA Co-Pilot Business Intelligence Suite.
 */

export type ChannelType = 'whatsapp' | 'telegram' | 'email' | 'instagram' | 'twitter' | 'web'

export interface ChannelMessage {
    id: string
    channel: ChannelType
    from: string // JID, Chat ID, or Email Address
    to: string
    content: string
    timestamp: number
    type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'spreadsheet'
    isFromMe: boolean
    mediaUrl?: string
    caption?: string
    rawPayload?: any // The original provider-specific payload
}

export interface ChannelConnectionState {
    status: 'disconnected' | 'connecting' | 'connected' | 'error'
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
