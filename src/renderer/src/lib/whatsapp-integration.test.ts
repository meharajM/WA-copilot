import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getWhatsAppSystemPrompt,
  sendWhatsAppResponse
} from './whatsapp-integration';
import electron from './electron';
import { useWhatsAppStore } from '../stores/whatsappStore';

// Mock electron
vi.mock('./electron', () => {
    return {
        default: {
            whatsapp: {
                sendMessage: vi.fn(() => Promise.resolve()),
                sendPresence: vi.fn(() => Promise.resolve())
            }
        }
    }
});

// Mock stores
vi.mock('../stores/whatsappStore', () => ({
    useWhatsAppStore: {
        getState: vi.fn()
    }
}));

vi.mock('../stores/chatStore', () => ({
    useChatStore: {
        getState: vi.fn()
    }
}));

describe('whatsapp-integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        // Setup default mock for window event dispatch
        vi.stubGlobal('window', {
            dispatchEvent: vi.fn()
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    describe('getWhatsAppSystemPrompt', () => {
        it('should format prompt with dynamic business context', () => {
            (useWhatsAppStore.getState as any).mockReturnValue({
                businessBotMode: true,
                businessName: 'Test Corp',
                businessHours: '9-5',
                businessLanguage: 'Spanish'
            });

            const prompt = getWhatsAppSystemPrompt();
            expect(prompt.role).toBe('system');
            
            // Should contain the dynamic variables
            expect(prompt.content).toContain('Test Corp');
            expect(prompt.content).toContain('9-5');
            expect(prompt.content).toContain('Spanish');
            expect(prompt.content).toContain("WHATSAPP MODE ACTIVE: You are a 'Business Customer Support Agent'");
        });

        it('should provide fallback string if context is empty', () => {
            (useWhatsAppStore.getState as any).mockReturnValue({
                businessBotMode: true,
                businessName: '',
                businessHours: '',
                businessLanguage: ''
            });

            const prompt = getWhatsAppSystemPrompt();
            expect(prompt.content).toContain('the business');
            expect(prompt.content).toContain('standard business hours');
        });
    });

    describe('sendWhatsAppResponse / OutboundManager Queue', () => {
        beforeEach(() => {
            vi.useFakeTimers();
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('should intercept ESCALATE and trigger warm handoff', async () => {
            const targetJid = '1234567890@s.whatsapp.net';
            const sessionId = 'session_1';
            
            const llmResponse = {
                content: 'I cannot help you. ESCALATE: user is angry.'
            };

            sendWhatsAppResponse(targetJid, llmResponse, sessionId);
            
            await vi.runAllTimersAsync();

            expect(window.dispatchEvent).toHaveBeenCalled();

            // Assert that the sent message to Baileys was NOT the LLM string, but the handoff 
            expect(electron.whatsapp.sendMessage).toHaveBeenCalledWith(
                targetJid, 
                "I understand your frustration and I'm sorry for the trouble. Let me connect you with a team member right away. 🙏"
            );
        });

        it('should enqueue standard messages sequentially for same user', async () => {
            const targetJid = 'userA@s.whatsapp.net';
            
            sendWhatsAppResponse(targetJid, { content: 'Message 1' }, 'sessionA');
            sendWhatsAppResponse(targetJid, { content: 'Message 2' }, 'sessionA');

            await vi.advanceTimersByTimeAsync(2500); 
            
            expect(electron.whatsapp.sendMessage).toHaveBeenCalledTimes(1);
            expect(electron.whatsapp.sendMessage).toHaveBeenCalledWith(targetJid, 'Message 1');

            await vi.advanceTimersByTimeAsync(3500);
            
            expect(electron.whatsapp.sendMessage).toHaveBeenCalledTimes(2);
            expect(electron.whatsapp.sendMessage).toHaveBeenCalledWith(targetJid, 'Message 2');
        });
    });
});
