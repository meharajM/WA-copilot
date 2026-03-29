import { EventEmitter } from 'events'

export interface ConnectionState {
    status: 'disconnected' | 'connecting' | 'connected' | 'error'
    qrCode: string | null
    error: string | null
    phoneNumber: string | null
    workerNumber: string | null
}

export interface BridgeMessage {
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

/**
 * @copilot/whatsapp-bridge
 * 
 * Modular WhatsApp connectivity layer using Baileys.
 * Decoupled from Electron and UI logic.
 */
export class WhatsAppBridge extends EventEmitter {
    // private socket: WASocket | null = null
    // ... logic for connect, disconnect, sendMessage, etc.
}
