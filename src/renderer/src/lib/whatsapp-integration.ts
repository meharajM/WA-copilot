import { useWhatsAppStore } from '../stores/whatsappStore';
import { useChatStore } from '../stores/chatStore';
import { type LLMMessage, type LLMContentPart } from './types';
import { buildMediaLLMParts, type MediaType } from './media-utils';
import electron from './electron';

/**
 * Extracts and resolves the target WhatsApp JID.
 * It first checks if the prompt is an incoming remote message prefixed with the WhatsApp identifier.
 * If not, it falls back to the active user's JID if 'WhatsApp Mode' is toggled on.
 */
export interface WhatsAppMessage {
    id: string;
    from: string;
    to: string;
    content: string;
    type: 'image' | 'audio' | 'video' | 'spreadsheet' | 'document' | 'text' | string;
    mediaUrl?: string;
    caption?: string;
    timestamp: number;
    isFromMe: boolean;
}

interface QueuedMessage {
    targetJid: string;
    text: string;
    originSessionId: string;
}

export class OutboundQueueManager {
    private queues: Record<string, QueuedMessage[]> = {};
    private activeLocks: Record<string, boolean> = {};

    enqueue(targetJid: string, text: string, originSessionId: string) {
        if (!this.queues[targetJid]) this.queues[targetJid] = [];
        this.queues[targetJid].push({ targetJid, text, originSessionId });
        
        if (!this.activeLocks[targetJid]) {
            this.processNext(targetJid);
        }
    }

    private async processNext(targetJid: string) {
        const queue = this.queues[targetJid];
        if (!queue || queue.length === 0) {
            this.activeLocks[targetJid] = false;
            return;
        }
        
        this.activeLocks[targetJid] = true;
        const msg = queue.shift()!;

        // 1. Signal 'composing'
        electron.whatsapp.sendPresence(msg.targetJid, "composing").catch(err => console.error(err));

        // 2. Typing delay
        const wordCount = msg.text.trim().split(/\s+/).length;
        const typingMs = Math.max(2000, Math.min(wordCount * 220, 12000));
        await new Promise<void>(r => setTimeout(r, typingMs));

        // 3. Paused then send
        electron.whatsapp.sendPresence(msg.targetJid, "paused").catch(err => console.error(err));
        await new Promise<void>(r => setTimeout(r, 300));

        console.log('[WhatsAppOutbound] Final WhatsApp delivery — typing sim complete, sending...');
        electron.whatsapp.sendMessage(msg.targetJid, msg.text)
            .catch(err => console.error('[WhatsApp] Failed to send response:', err));

        // Wait before processing next message
        await new Promise<void>(r => setTimeout(r, 1000));
        this.processNext(targetJid);
    }
}

export class WhatsAppChannel {
    private outboundQueue = new OutboundQueueManager();

    public resolveTarget(text: string): string | null {
        let jid: string | null = null;
        if (text && typeof text === 'string') {
            const patterns = [
                /📱 \*\*WhatsApp\*\* \(([^)]+)\):/,
                /📱 WhatsApp \(([^)]+)\):/,
                /WhatsApp.*?\((\+?[^)]+)\):/,
            ];
            for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match && match[1]) {
                    jid = match[1];
                    console.log(`[WhatsAppChannel] Extracted JID: ${jid}`);
                    break;
                }
            }
        }
        
        const waState = useWhatsAppStore.getState();
        const isConnected = waState.whatsappEnabled && waState.connectionState.status === "connected";
        
        if (!jid && isConnected && waState.connectionState.phoneNumber) {
            jid = waState.connectionState.phoneNumber;
        }
        
        return isConnected ? jid : null;
    }

    public getSystemPrompt(): LLMMessage {
        const { businessBotMode, businessName, businessHours, businessLanguage } = useWhatsAppStore.getState() as any;
        const bName = businessName || "the business";
        const bHours = businessHours || "standard business hours";
        const bLang = businessLanguage || "the language the customer uses";

        const persona = businessBotMode 
            ? `You are a 'Business Customer Support Agent' for ${bName}. Your goal is to help customers professionally based on the local knowledge base. Our business hours are ${bHours}.`
            : "You are the 'WA Co-Pilot', a personal assistant for the business owner.";

        return {
            role: "system",
            content: `WHATSAPP MODE ACTIVE: ${persona} ` +
            "CRITICAL: Your primary knowledge base is the local 'rag_search' and 'memory_search' tools. " +
            "1. For any business-related query, ALWAYS check the local knowledge base first. " +
            "2. Keep replies SHORT — max 3 sentences. Use line breaks (\\n), NOT markdown (*bold*, headers). " +
            "3. Do NOT use asterisks (*) for emphasis — they show literally on some phones. " +
            "4. Add one relevant emoji at the end of each reply. " +
            `5. Match the customer's language (${bLang}). ` +
            "6. If RAG returns no result, say: 'Let me check and get back to you shortly! 🙏' — never guess."
        };
    }

    public async resolveMessageToLLM(waMsg: WhatsAppMessage): Promise<LLMMessage> {
        let parts: LLMContentPart[] = [];
        if (waMsg.mediaUrl) {
            const localPath = waMsg.mediaUrl.replace('file://', '');
            const mediaType = waMsg.type as MediaType;
            parts = buildMediaLLMParts(localPath, mediaType, waMsg.content && waMsg.content !== '[Media Message]' ? waMsg.content : undefined);
        } else if (waMsg.content && waMsg.content !== '[Media Message]') {
            parts.push({ type: 'text', text: waMsg.content });
        }

        return {
            role: "user",
            content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
            attachments: waMsg.mediaUrl ? [{
                name: waMsg.caption || `whatsapp_${waMsg.type}_${Date.now()}`,
                path: waMsg.mediaUrl.replace('file://', ''),
                type: waMsg.type
            }] : undefined
        };
    }

    public setTyping(jid: string) {
        electron.whatsapp.sendPresence(jid, "composing").catch(e => console.error(e));
    }

    public setPaused(jid: string) {
        electron.whatsapp.sendPresence(jid, "paused").catch(e => console.error(e));
    }

    public async sendResponse(targetJid: string, llmResponse: any, originSessionId: string): Promise<void> {
        let responseText = '';
        if (typeof llmResponse.content === 'string') {
            responseText = llmResponse.content;
        } else if (Array.isArray(llmResponse.content)) {
            responseText = llmResponse.content
                .filter((part: any) => part.type === 'text')
                .map((part: any) => part.text)
                .join('\n');
        }
        
        let finalOutput = responseText;
        if (responseText && (responseText.includes("ESCALATE:") || responseText.includes("I understand your frustration"))) {
            console.warn(`[WhatsAppChannel] Intercepted escalation signal. Executing warm handoff...`);
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('whatsapp:escalate', { detail: { sessionId: originSessionId, targetJid } }));
            }
            finalOutput = "I understand your frustration and I'm sorry for the trouble. Let me connect you with a team member right away. 🙏";
        } else if (!responseText) {
            const finalMessages = useChatStore.getState().sessions.find((s: any) => s.id === originSessionId)?.messages ?? [];
            const lastAssistantMessage = finalMessages.slice().reverse().find((m: any) => m.role === "assistant" && (!m.toolCalls || m.toolCalls.length === 0));
            if (lastAssistantMessage?.content && typeof lastAssistantMessage.content === 'string') {
                finalOutput = lastAssistantMessage.content;
                if (finalOutput.includes("ESCALATE:") || finalOutput.includes("I understand your frustration")) {
                    finalOutput = "I understand your frustration and I'm sorry for the trouble. Let me connect you with a team member right away. 🙏";
                    if (typeof window !== 'undefined') {
                        window.dispatchEvent(new CustomEvent('whatsapp:escalate', { detail: { sessionId: originSessionId, targetJid } }));
                    }
                }
            }
        }
        
        if (finalOutput) {
            this.outboundQueue.enqueue(targetJid, finalOutput, originSessionId);
        }
    }
}

export const whatsappChannel = new WhatsAppChannel();
