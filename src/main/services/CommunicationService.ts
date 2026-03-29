import { IntelligenceService } from './IntelligenceService';

/**
 * Supported communication channels
 */
export type CommunicationChannel = 'whatsapp' | 'email' | 'telegram' | 'twitter' | 'instagram';

/**
 * Interface for a communication provider
 */
export interface ICommunicationProvider {
    channel: CommunicationChannel;
    sendMessage(to: string, content: string): Promise<{ success: boolean; error?: string }>;
    sendMedia?(to: string, filePath: string, caption?: string): Promise<{ success: boolean; error?: string }>;
}

/**
 * CommunicationService
 * 
 * Orchestrates messages across different channels.
 * Allows adding new providers (Email, Telegram, etc.) dynamically.
 */
export class CommunicationService {
    private static instance: CommunicationService;
    private providers: Map<CommunicationChannel, ICommunicationProvider> = new Map();

    private constructor() {}

    static getInstance(): CommunicationService {
        if (!CommunicationService.instance) {
            CommunicationService.instance = new CommunicationService();
        }
        return CommunicationService.instance;
    }

    /**
     * Register a new channel provider
     */
    registerProvider(provider: ICommunicationProvider) {
        this.providers.set(provider.channel, provider);
        console.log(`[CommunicationService] Registered provider for channel: ${provider.channel}`);
    }

    /**
     * Send a message via any registered channel
     */
    async sendMessage(channel: CommunicationChannel, to: string, content: string) {
        const provider = this.providers.get(channel);
        if (!provider) {
            const error = `No provider registered for channel: ${channel}`;
            console.error(`[CommunicationService] ${error}`);
            return { success: false, error };
        }

        try {
            const result = await provider.sendMessage(to, content);
            
            // Log to intelligence if successful
            if (result.success) {
                IntelligenceService.getInstance().logEvent(
                    'accuracy', 
                    'resolved', 
                    `Message sent to ${to} via ${channel}`
                );
            }

            return result;
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[CommunicationService] Failed to send via ${channel}:`, err);
            return { success: false, error: errorMsg };
        }
    }

    /**
     * Get list of active channels
     */
    getActiveChannels(): CommunicationChannel[] {
        return Array.from(this.providers.keys());
    }
}
