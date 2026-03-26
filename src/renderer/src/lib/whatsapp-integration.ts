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
export const resolveWhatsAppTarget = (text: string): string | null => {
    let jid: string | null = null;
    
    if (text && typeof text === 'string') {
        const patterns = [
            /📱 \*\*WhatsApp\*\* \(([^)]+)\):/,
            /📱 WhatsApp \(([^)]+)\):/,
            /WhatsApp.*?\((\+?[^)]+)\):/, // Handle LID or numbers
        ];
        for (const pattern of patterns) {
            const match = text.match(pattern);
            if (match && match[1]) {
                jid = match[1];
                console.log(`[WhatsAppIntegration] Extracted JID from message: ${jid}`);
                break;
            }
        }
    }
    
    const waState = useWhatsAppStore.getState();
    const isWaConnected = waState.whatsappEnabled && waState.connectionState.status === "connected";
    
    // Fallback to active WhatsApp Mode if enabled
    if (!jid && isWaConnected && waState.connectionState.phoneNumber) {
        jid = waState.connectionState.phoneNumber;
        console.log(`[WhatsAppIntegration] Falling back to global target phone: ${jid}`);
    }
    
    if (jid && !isWaConnected) {
        console.warn(`[WhatsAppIntegration] Found JID ${jid} but WhatsApp mode is disabled or disconnected. (Enabled: ${waState.whatsappEnabled}, Status: ${waState.connectionState.status})`);
    }

    // Ensure we only return a JID if the socket is actually connected and mode is valid
    const result = isWaConnected ? jid : null;
    if (result) {
        console.log(`[WhatsAppIntegration] Resolved final target JID: ${result}`);
    }
    return result;
};

/**
 * Returns the mobile-formatting system prompt to be invisibly injected 
 * into the agent's context whenever it is handling a WhatsApp message.
 * Optimized for multimodal interactions.
 */
export const getWhatsAppSystemPrompt = (): LLMMessage => {
  // Read business context, falling back to basic generic strings if missing
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
};

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

/**
 * Resolves a raw WhatsApp message into a structured LLMMessage,
 * handling multimodal content (images, audio, docs) by fetching
 * actual file content or creating descriptive proxies.
 */
export const resolveWhatsAppMessageToLLM = async (waMsg: WhatsAppMessage): Promise<LLMMessage> => {
    let parts: LLMContentPart[] = [];
    
    // 1. Handle Multimodal Attachments (Priority for Vision models)
    if (waMsg.mediaUrl) {
        const localPath = waMsg.mediaUrl.replace('file://', '');
        const mediaType = waMsg.type as MediaType;
        
        // Use global media util to construct standard payload
        parts = buildMediaLLMParts(localPath, mediaType, waMsg.content && waMsg.content !== '[Media Message]' ? waMsg.content : undefined);
    } else if (waMsg.content && waMsg.content !== '[Media Message]') {
        parts.push({ type: 'text', text: waMsg.content });
    }

    return {
        role: "user",
        // Fallback to plain string if it's just one text part, otherwise use multimodal array
        content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
        attachments: waMsg.mediaUrl ? [{
            name: waMsg.caption || `whatsapp_${waMsg.type}_${Date.now()}`,
            path: waMsg.mediaUrl.replace('file://', ''),
            type: waMsg.type
        }] : undefined
    };
};

/**
 * Convenience methods for presence updates.
 */
export const setWhatsAppTyping = (jid: string) => {
    electron.whatsapp.sendPresence(jid, "composing")
        .catch(err => console.error("[WhatsApp] Failed to send typing presence:", err));
};

export const setWhatsAppPaused = (jid: string) => {
    electron.whatsapp.sendPresence(jid, "paused")
        .catch(err => console.error("[WhatsApp] Failed to send paused presence:", err));
};

interface QueuedMessage {
    targetJid: string;
    text: string;
    originSessionId: string;
}

class OutboundManager {
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

        // 1. Signal 'composing' — the customer sees the typing indicator
        setWhatsAppTyping(msg.targetJid);

        // 2. Hold it proportional to word count (simulates ~50 WPM typing speed)
        const wordCount = msg.text.trim().split(/\s+/).length;
        const typingMs = Math.max(2000, Math.min(wordCount * 220, 12000));
        await new Promise<void>(r => setTimeout(r, typingMs));

        // 3. send — mirrors real user behaviour
        setWhatsAppPaused(msg.targetJid);
        await new Promise<void>(r => setTimeout(r, 300));

        console.log('[WhatsAppOutbound] Final WhatsApp delivery — typing sim complete, sending...');
        electron.whatsapp.sendMessage(msg.targetJid, msg.text)
            .catch(err => console.error('[WhatsApp] Failed to send response:', err));

        // Wait slightly before processing the next message for this JID to simulate human breath/gap
        await new Promise<void>(r => setTimeout(r, 1000));
        this.processNext(targetJid);
    }
}

const outboundQueue = new OutboundManager();

/**
 * Anti-Ban Gap 2: Typing simulation before every outbound WhatsApp reply.
 *
 * Safely parses the LLM output (accounting for tool strings or text arrays)
 * and sends the final string to the designated JID over IPC, preceded by
 * a 'composing' presence update held for a duration proportional to message
 * length (~50 WPM equivalent: 200-250 ms per word, clamped 2s–12s).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sendWhatsAppResponse = async (targetJid: string, llmResponse: any, originSessionId: string): Promise<void> => {
    let responseText = '';

    if (typeof llmResponse.content === 'string') {
        responseText = llmResponse.content;
    } else if (Array.isArray(llmResponse.content)) {
        responseText = llmResponse.content
            .filter((part: { type: string; text?: string }) => part.type === 'text')
            .map((part: { type: string; text?: string }) => part.text)
            .join('\n');
    }
    
    let isEscalated = false;

    // Intercept critical ESCALATE signal to prevent customer leak
    if (responseText && (responseText.includes("ESCALATE:") || responseText.includes("I understand your frustration"))) {
        console.warn(`[WhatsAppIntegration] Intercepted escalation signal. Executing warm handoff...`);
        
        isEscalated = true;
        
        // Dispatch browser event so UI can display an 'Escalated' badge on this session
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('whatsapp:escalate', { 
                detail: { sessionId: originSessionId, targetJid } 
            }));
        }
        
        // Override the AI thought with the hardcoded warm handoff
        responseText = "I understand your frustration and I'm sorry for the trouble. Let me connect you with a team member right away. 🙏";
        
        // Push safely to concurrent outbox
        outboundQueue.enqueue(targetJid, responseText, originSessionId);
    } else if (responseText) {
        // Normal text enqueueing
        outboundQueue.enqueue(targetJid, responseText, originSessionId);
    } else {
        // Fallback: retrieve last plain assistant text from the store
        const finalMessages = useChatStore.getState().sessions.find((s: any) => s.id === originSessionId)?.messages ?? [];
        const lastAssistantMessage = finalMessages.slice().reverse().find((m: any) => m.role === "assistant" && (!m.toolCalls || m.toolCalls.length === 0));
        
        if (lastAssistantMessage?.content && typeof lastAssistantMessage.content === 'string') {
            let fallbackText = lastAssistantMessage.content;
            if (fallbackText.includes("ESCALATE:") || fallbackText.includes("I understand your frustration")) {
                fallbackText = "I understand your frustration and I'm sorry for the trouble. Let me connect you with a team member right away. 🙏";
                if (typeof window !== 'undefined') {
                    window.dispatchEvent(new CustomEvent('whatsapp:escalate', { 
                        detail: { sessionId: originSessionId, targetJid } 
                    }));
                }
            }
            outboundQueue.enqueue(targetJid, fallbackText, originSessionId);
        }
    }
};
