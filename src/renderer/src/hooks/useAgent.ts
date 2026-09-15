/**
 * useAgent — React hook that owns all agent execution logic.
 *
 * Architecture: This is the ONLY place in the UI that knows how to run an agent.
 *   It sits between App.tsx (pure UI) and AgentRuntime (pure business logic).
 *   App.tsx calls `useAgent()` and gets back `handleSubmit`.
 *
 * Session isolation fix:
 *   `originSessionId` is captured at the START of each `handleSubmit` call and
 *   used for EVERY callback, error-handler, and cleanup throughout the lifecycle.
 *   This means switching to a different session while an agent is running does NOT:
 *     - Write error messages to the wrong session
 *     - Clear the wrong session's progress bar
 *     - Feed wrong history to the MemoryReflector
 *
 * Phase 3 readiness: When we migrate to a backend server, ONLY this file changes.
 *   Replace `new AgentRuntime(...)` with `new RemoteAgentClient(...)` — both
 *   implement the same `IAgentClient` interface. The rest of the app is unaffected.
 *
 * Dependencies:
 *   - agent-runtime.ts: AgentRuntime (the local implementation of IAgentClient)
 *   - chatStore: message history, session management, per-session abort signal
 *   - settingsStore: LLM provider configuration
 *   - memory-reflector.ts: background memory extraction (fire-and-forget)
 *
 * Key design decisions:
 *   - Uses `useChatStore.getState()` (NOT reactive hooks) inside callbacks.
 *     WHY: Callbacks are closures. If we used `useChatStore()` reactive hook,
 *     the closure would capture a stale snapshot of messages. `getState()` always
 *     reads the latest store value at call time.
 *   - `AgentRuntime` is dynamically imported (lazy) to avoid loading the heavy
 *     module on app startup. It only loads when the user first submits a message.
 */

import { useCallback, useEffect } from "react";
import { useChatStore } from "../stores/chatStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useWhatsAppStore } from "../stores/whatsappStore";
import { useEmailStore } from "../stores/emailStore";
import { useDraftStore } from "../stores/draftStore";
import electron from "../lib/electron";
import { type LLMMessage } from "../lib/types";
import { resolveWhatsAppTarget, setWhatsAppTyping, setWhatsAppPaused, getWhatsAppSystemPrompt, sendWhatsAppResponse, resolveWhatsAppMessageToLLM } from "../lib/whatsapp-integration";
import { getEmailSystemPrompt, normalizeSubject, type EmailMessage } from "../lib/email-integration";
import { createDraftResponse, evaluateEmailPolicy, getConfidenceGatePrompt } from "../lib/email-policy";
import { buildAttachmentLLMParts } from "../lib/media-utils";
import { isSameWhatsAppIdentity, normalizeWhatsAppId } from "../../../shared/whatsappIdentity";

/**
 * State returned by `useAgent`.
 * App.tsx destructures this and passes values to child components.
 */
export interface UseAgentReturn {
    /**
     * Call this when the user submits a message (text input or voice).
     * Handles: message history reconstruction, AgentRuntime instantiation,
     * background memory reflection, and error handling.
     *
     * @param content - The user's text message.
     * @param attachments - Optional file attachments (Electron exposes `.path`).
     * @param isHeadless - If true, suppresses browser UI during task execution.
     */
    handleSubmit: (
      content: string,
      attachments?: File[],
      isHeadless?: boolean,
      multimodalWhatsAppMessage?: import('../lib/whatsapp-integration').WhatsAppMessage,
      inboundEmailMessage?: EmailMessage
    ) => Promise<void>;
}

interface EmailToolCallLike {
    name?: unknown;
    function?: { name?: unknown };
    result?: unknown;
}

function isHandledEmailSendResult(result: unknown): boolean {
    if (result && typeof result === 'object') {
        const record = result as Record<string, unknown>;
        return record.success === true
            || record.sent === true
            || record.status === 'sent'
            || record.status === 'success'
            || record.status === 'draft_created';
    }

    if (typeof result !== 'string' || !result.trim()) return false;

    try {
        return isHandledEmailSendResult(JSON.parse(result));
    } catch {
        return /email sent successfully|draft created successfully/i.test(result);
    }
}

export function hasHandledEmailSendToolCall(toolCalls: unknown): boolean {
    if (!Array.isArray(toolCalls)) return false;

    return toolCalls.some((call) => {
        if (!call || typeof call !== 'object') return false;
        const typedCall = call as EmailToolCallLike;
        const isEmailSend = typedCall.name === 'email_send_message'
            || typedCall.function?.name === 'email_send_message';
        return isEmailSend && isHandledEmailSendResult(typedCall.result);
    });
}

export const LOW_CONFIDENCE_EMAIL_ACKNOWLEDGEMENT =
    'Thanks for your message. We have received it and a member of our team will review it and follow up.';

interface EmailPostResponseDependencies {
    send: (payload: {
        to: string;
        subject: string;
        body: string;
        inReplyTo?: string;
        references?: string;
        accountName?: string;
    }) => Promise<{ success: boolean; error?: string }>;
    addDraft: (draft: ReturnType<typeof createDraftResponse>) => void;
    addReviewNotice?: (content: string) => void;
}

interface HandleEmailPostResponseInput {
    responseText: string;
    inboundEmailMessage: EmailMessage;
    decision: ReturnType<typeof evaluateEmailPolicy>;
    draftMode: boolean;
    accountName?: string;
    emailSendHandledByAgent: boolean;
}

async function attemptEmailSend(
    send: EmailPostResponseDependencies['send'],
    payload: Parameters<EmailPostResponseDependencies['send']>[0]
): Promise<{ success: boolean; error?: string }> {
    try {
        return await send(payload);
    } catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function handleEmailPostResponse(
    input: HandleEmailPostResponseInput,
    dependencies: EmailPostResponseDependencies
): Promise<'skipped' | 'drafted' | 'acknowledged' | 'acknowledgement_failed' | 'sent' | 'send_failed_drafted'> {
    if (input.emailSendHandledByAgent || !input.responseText.trim()) return 'skipped';

    const { inboundEmailMessage, decision } = input;
    const originalEmail = {
        from: inboundEmailMessage.from,
        subject: inboundEmailMessage.subject,
        to: inboundEmailMessage.from,
        inReplyTo: inboundEmailMessage.messageId,
        references: inboundEmailMessage.references || inboundEmailMessage.messageId,
        accountName: input.accountName || 'default',
    };
    const outboundBase = {
        to: inboundEmailMessage.from,
        subject: `Re: ${normalizeSubject(inboundEmailMessage.subject || '(No Subject)')}`,
        inReplyTo: originalEmail.inReplyTo,
        references: originalEmail.references,
        accountName: originalEmail.accountName,
    };

    if (decision.action === 'escalate' && !decision.hasSensitiveTopic) {
        const acknowledgement = await attemptEmailSend(dependencies.send, {
            ...outboundBase,
            body: LOW_CONFIDENCE_EMAIL_ACKNOWLEDGEMENT,
        });
        const reviewDecision = acknowledgement.success
            ? decision
            : {
                ...decision,
                rationale: `${decision.rationale} Neutral acknowledgement failed (${acknowledgement.error || 'unknown error'}); owner reply required.`,
            };

        dependencies.addDraft(createDraftResponse(input.responseText, reviewDecision, originalEmail));
        dependencies.addReviewNotice?.(
            acknowledgement.success
                ? 'Low-confidence email acknowledged; response escalated for owner review in Drafts.'
                : 'Email acknowledgement failed; response escalated for owner review in Drafts.'
        );
        return acknowledgement.success ? 'acknowledged' : 'acknowledgement_failed';
    }

    if (input.draftMode || decision.action !== 'send') {
        dependencies.addDraft(createDraftResponse(input.responseText, decision, originalEmail));
        dependencies.addReviewNotice?.('Email response drafted for review in Drafts panel.');
        return 'drafted';
    }

    const sendResult = await attemptEmailSend(dependencies.send, {
        ...outboundBase,
        body: input.responseText,
    });
    if (sendResult.success) return 'sent';

    const fallbackDecision = {
        ...decision,
        action: 'draft' as const,
        rationale: `Direct send failed (${sendResult.error || 'unknown error'}). Draft created for review.`,
    };
    dependencies.addDraft(createDraftResponse(input.responseText, fallbackDecision, originalEmail));
    return 'send_failed_drafted';
}

/**
 * Encapsulates all agent execution logic, extracted from App.tsx.
 *
 * @returns `{ handleSubmit }`
 *
 * @example
 * // In App.tsx:
 * const { handleSubmit } = useAgent();
 * // Pass handleSubmit to <VoiceInput onSubmit={handleSubmit} />
 */
export function useAgent(): UseAgentReturn {
    const settings = useSettingsStore();

    /**
     * Main entry point: processes user input, runs the agent, handles errors.
     *
     * Flow:
     * 1. Guard: ignore empty submissions
     * 2. Capture `originSessionId` — the session that owns this entire execution
     * 3. Start per-session processing (creates a new AbortController just for this session)
     * 4. Add user message to store
     * 5. Reconstruct LLM-format history from store messages
     * 6. Dynamically import AgentRuntime (lazy load)
     * 7. Run agent with callbacks that write back to `originSessionId` — never the active session
     * 8. Fire-and-forget: trigger MemoryReflector against `originSessionId`'s messages
     * 9. On error: add error message to `originSessionId`
     * 10. Always: stop per-session processing state, clear session-level progress
     */
    const handleSubmit = useCallback(
        async (
          content: string,
          attachments?: File[],
          isHeadless?: boolean,
          multimodalWhatsAppMessage?: import('../lib/whatsapp-integration').WhatsAppMessage,
          inboundEmailMessage?: EmailMessage
        ) => {
            if (!content.trim() && (!attachments || attachments.length === 0) && !multimodalWhatsAppMessage && !inboundEmailMessage) return;

            const { addMessage, startProcessing } = useChatStore.getState();

            // 1. Resolve starting message shape
            let userLLMMessage: LLMMessage | null = null;
            if (multimodalWhatsAppMessage) {
                userLLMMessage = await resolveWhatsAppMessageToLLM(multimodalWhatsAppMessage);
            }

            // 2. Map Attachment Metadata (for local browser uploads)
            const attachmentData = attachments?.map((file) => {
                const nativePath = (file as File & { path?: string }).path || "";
                return {
                    name: file.name,
                    path: nativePath,
                    type: file.type,
                };
            });

            // Add the user's message to the store immediately so it appears in the
            // chat UI before the agent starts processing.
            addMessage({ 
                role: "user", 
                content: userLLMMessage ? (typeof userLLMMessage.content === 'string' ? userLLMMessage.content : "[Media Message]") : content, 
                attachments: userLLMMessage?.attachments ?? attachmentData 
            });

            // ── CRITICAL: Capture originSessionId before any await ─────────────
            // This is determined once at submit time and is used for ALL callbacks,
            // error handlers, and cleanup. Switching sessions after this point will
            // NOT affect which session receives messages or whose progress is cleared.
            // We capture this AFTER addMessage to ensure we get the real session ID
            // for brand new chats, rather than "default".
            const originSessionId = useChatStore.getState().activeSessionId ?? "default";

            // Build a plain settings object to pass to AgentRuntime.
            // WHY not pass the full Zustand store: AgentRuntime lives in lib/ and
            // should not depend on the store shape.
            const settingsForLLM = {
                preferredProvider: settings.preferredProvider,
                ollamaModel: settings.ollamaModel,
                ollamaBaseUrl: settings.ollamaBaseUrl,
                openaiApiKey: settings.openaiApiKey,
                openaiBaseUrl: settings.openaiBaseUrl,
                openaiModel: settings.openaiModel,
                geminiApiKey: settings.geminiApiKey,
                geminiModel: settings.geminiModel,
                openrouterApiKey: settings.openrouterApiKey,
                openrouterModel: settings.openrouterModel,
            };

            // Resolve the WhatsApp target once — shared by the try block (typing/delivery)
            // and the finally block (paused presence). Resolving it twice risks a race
            // condition if the user disconnects mid-run (the finally call would return null,
            // leaving the typing indicator stuck on the personal phone).
            const targetJid = resolveWhatsAppTarget(content);
            const { connectionState } = useWhatsAppStore.getState();
            const adminJid = connectionState.phoneNumber;
            const fromJid = multimodalWhatsAppMessage?.from;
            const emailConfig = useEmailStore.getState().config;
            
            // Resolve Roles
            const cleanFrom = normalizeWhatsAppId(fromJid) ?? fromJid ?? 'unknown';
            const isAdmin = isSameWhatsAppIdentity(fromJid, adminJid);
            const isEmailFlow = !!inboundEmailMessage;
            let emailSendHandledByAgent = false;

            // 1.5 Handle Customer Multimedia Rejection
            if (multimodalWhatsAppMessage && !isAdmin && multimodalWhatsAppMessage.type !== 'text') {
                const rejectionContent = "I'm sorry, I currently only support text-based inquiries for customer assistance. 🤖 Please describe your question in text so I can help you correctly.";
                
                // Update Local UI
                addMessage({
                    role: "assistant",
                    content: rejectionContent,
                });
                
                // Send back to WhatsApp
                if (targetJid) {
                    await electron.whatsapp.sendMessage(targetJid, rejectionContent);
                }
                
                return;
            }

            // Start per-session processing after all early-return guards.
            // This guarantees we always reach the finally cleanup path.
            const abortSignal = startProcessing(originSessionId);

            try {
                // ── Step 1: Reconstruct LLM message history ────────────────────────
                // WHY getState() here: We need the freshest messages AFTER addMessage()
                // has been committed to the store.
                // WHY read originSessionId's messages specifically: Not the active
                // session's messages, since the user could have switched by now.
                const freshMessages =
                    useChatStore.getState().sessions.find(s => s.id === originSessionId)?.messages ?? [];
                const reconstructedHistory: LLMMessage[] = [];

                for (const m of freshMessages) {
                    const msg: LLMMessage = {
                        role: m.role as "user" | "assistant" | "system",
                        content: m.content,
                        ...(m.thought ? { thought: m.thought } : {}),
                        ...(m.thought_signature ? { thought_signature: m.thought_signature } : {}),
                    };

                    // Handle Multimodal Recovery for WhatsApp (re-link media for the LLM)
                    if (m.attachments && m.attachments.length > 0 && m.role === 'user') {
                        msg.content = buildAttachmentLLMParts(m.attachments, m.content);
                    }

                    if (m.toolCalls) {
                        msg.tool_calls = m.toolCalls.map((tc) => ({
                            id: tc.id,
                            type: "function",
                            function: { name: tc.name, arguments: tc.arguments },
                        }));
                    }

                    reconstructedHistory.push(msg);

                    if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
                        for (const tc of m.toolCalls) {
                            if (tc.result !== undefined && tc.result !== null) {
                                reconstructedHistory.push({
                                    role: "tool",
                                    tool_call_id: tc.id,
                                    content: tc.result,
                                });
                            }
                        }
                    }
                }

                // ── Step 2: Get session context ────────────────────────────────────
                // Read from originSessionId — not activeSessionId — for the same reason.
                const activeSession = useChatStore.getState().sessions.find(
                    (s) => s.id === originSessionId
                );

                // ── Step 3: Dynamically import AgentRuntime ────────────────────────
                const { AgentRuntime } = await import("../lib/agent-runtime");
                const persona = await electron.intelligence.getPersona();

                if (targetJid) {
                    console.log(`[useAgent] WhatsApp flow detected/enabled. JID: ${targetJid} (Admin: ${isAdmin})`);
                    setWhatsAppTyping(targetJid);
                    reconstructedHistory.push(getWhatsAppSystemPrompt(targetJid, persona as { name: string, tone: string }));
                }
                if (isEmailFlow) {
                    reconstructedHistory.push(getEmailSystemPrompt(persona as { name: string, tone: string }));
                    reconstructedHistory.push(getConfidenceGatePrompt());
                    reconstructedHistory.push({
                        role: 'system',
                        content: 'For this inbound email, return response text only. Do not call email_send_message or email_create_draft; the host applies email policy, threading, acknowledgement, and review handling.',
                    });
                }

                // ── Step 4: Instantiate the agent ──────────────────────────────────
                const runtime = new AgentRuntime(
                    {
                        activeSessionId: originSessionId,
                        workspacePath: activeSession?.workspacePath,
                        settings: settingsForLLM,
                        isHeadless,
                        // The abort signal is scoped to THIS session only.
                        signal: abortSignal,

                        /**
                         * Called by AgentRuntime for every new message (user, assistant, tool).
                         * Always writes to `originSessionId` — never the currently-active session.
                         */
                        onMessage: (msg: LLMMessage) => {
                            if (isEmailFlow && (
                                hasHandledEmailSendToolCall(msg.tool_calls)
                                || hasHandledEmailSendToolCall((msg as LLMMessage & { toolCalls?: unknown }).toolCalls)
                            )) {
                                emailSendHandledByAgent = true;
                            }

                            // Do not add raw tool execution results as standalone chat bubbles.
                            if (msg.role === "tool") return undefined;

                            const { addSessionMessage: addMsg } = useChatStore.getState();

                            // Map LLMMessage → store message shape
                            const storeMsg: Omit<import('../stores/chatStore').Message, 'id' | 'timestamp'> = {
                                role: msg.role as "user" | "assistant" | "system",
                                content:
                                    typeof msg.content === "string"
                                        ? msg.content
                                        : Array.isArray(msg.content)
                                            ? (msg.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("")
                                            : "",
                            };

                            if (msg.tool_calls) {
                                storeMsg.toolCalls = msg.tool_calls.map((tc) => ({
                                    id: tc.id,
                                    name: tc.function.name,
                                    arguments: tc.function.arguments,
                                }));
                            }

                            // Persist thought signatures for Gemini 2.0 tool-calling.
                            if (msg.thought) storeMsg.thought = msg.thought;
                            if (msg.thought_signature) storeMsg.thought_signature = msg.thought_signature;

                            // Write to originSessionId — not the currently-active session
                            const newMsg = addMsg(originSessionId, storeMsg);
                            return newMsg.id;
                        },

                        /**
                         * Called by AgentRuntime to update an existing message in-place
                         * (e.g., updating the parallel execution status card).
                         * Always targets `originSessionId`.
                         */
                        onMessageUpdate: (id: string, updates: Partial<LLMMessage>) => {
                            if (isEmailFlow && hasHandledEmailSendToolCall(
                                (updates as Partial<LLMMessage> & { toolCalls?: unknown }).toolCalls
                            )) {
                                emailSendHandledByAgent = true;
                            }

                            const { updateSessionMessage } = useChatStore.getState();
                            const storeUpdates: Partial<import('../stores/chatStore').Message> = {
                                ...updates as Partial<import('../stores/chatStore').Message>
                            };

                            // Flatten content arrays to strings for the store
                            if (Array.isArray(storeUpdates.content)) {
                                storeUpdates.content = (storeUpdates.content as Array<{ text?: string }>)
                                    .map((c) => c.text ?? "")
                                    .join("");
                            }

                            // The store doesn't have a "tool" role — skip role updates
                            if ((storeUpdates as { role?: string }).role === "tool") {
                                delete (storeUpdates as { role?: string }).role;
                            }

                            updateSessionMessage(originSessionId, id, storeUpdates);
                        },

                        /**
                         * Called by AgentRuntime to update progress.
                         * Always targets `originSessionId`.
                         */
                        onProgressUpdate: (progress?: number, eta?: number, plan?: unknown) => {
                            useChatStore.getState().updateSessionProgress(
                                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                                originSessionId, progress, eta, plan as any
                            );
                        },
                    },
                    reconstructedHistory
                );

                // ── Step 5: Fire-and-forget background memory reflection ───────────
                // WHY started BEFORE awaiting runtime.chat(): Captures the user's intent
                // even if the agent gets stuck or fails early.
                // WHY read originSessionId's messages: The user may have switched to
                // another session by the time the dynamic import resolves.
                import("../lib/memory-reflector").then(({ MemoryReflector }) => {
                    const sessionMessages =
                        useChatStore.getState().sessions.find(s => s.id === originSessionId)?.messages ?? [];
                    const historyForReflector: LLMMessage[] = sessionMessages.map((m) => ({
                        role: m.role as "user" | "assistant" | "system",
                        content: m.content,
                    }));
                    MemoryReflector.getInstance().analyze(historyForReflector, settingsForLLM);
                });

                // ── Step 6: Run the agent ──────────────────────────────────────────
                // When the incoming message has multimodal content (WhatsApp image/audio),
                // we pass the resolved LLMMessage content instead of the raw text string.
                // This ensures the LLM receives the actual media parts, not "[Media Message]".
                const agentContent = userLLMMessage
                    ? (typeof userLLMMessage.content === 'string'
                        ? userLLMMessage.content
                        : content) // fallback to text prefix for JID context
                    : content;
                const agentAttachments = userLLMMessage?.attachments ?? attachmentData;
                
                // ── 60-Second Courtesy Timer ──────────────────────────────────────
                // If a customer query takes more than 1 minute, notify them that we're
                // still working and will notify them once done.
                let courtesyTimer: NodeJS.Timeout | null = null;
                if (targetJid && !isAdmin) {
                    courtesyTimer = setTimeout(async () => {
                        const courtesyMsg = "I'm still working on your request and will notify you once done. 🤖";
                        await electron.whatsapp.sendMessage(targetJid, courtesyMsg);
                        // Log this event for transparency
                        addMessage({ 
                            role: "assistant", 
                            content: `(System: Sent 60s courtesy delay notification to customer)` 
                        });
                    }, 60000); // 1 minute
                }

                const llmResponse = await runtime.chat(agentContent, agentAttachments);
                
                // Clear timer as response received
                if (courtesyTimer) clearTimeout(courtesyTimer);

                // ── Step 7: Handle Outbound WhatsApp Messages ──────────────────────
                // If WhatsApp mode is enabled, we need to send the final assistant response
                // back to the remote user via IPC.
                if (targetJid) {
                    console.log(`[useAgent] Triggering WhatsApp delivery for JID: ${targetJid}`);
                    sendWhatsAppResponse(targetJid, llmResponse, originSessionId);
                    
                    // ── Step 8: Admin Forwarding (No Hallucination logic) ───────────
                    // If the response contains the "Human Team" flag from the system prompt, 
                    // notify the admin so they can jump in.
                    const responseText = typeof llmResponse.content === 'string' ? llmResponse.content : '';
                    const isEscalation = !isAdmin && (
                        responseText.includes("flagged this for our human team") || 
                        responseText.includes("escalating this to a human") ||
                        responseText.includes("whatsapp_notify_admin") // If tool was called
                    );

                    if (isEscalation) {
                        console.log(`[useAgent] Unknown query detected — forwarding to Admin (${adminJid})`);
                        const adminNotification = `⚠️ *Action Required: Unknown Inquiry*\n\nA customer (${cleanFrom}) asked a question not found in the training data:\n\n> "${agentContent}"\n\nPlease answer them directly. I will learn from your response for next time.`;
                        if (adminJid) {
                            await electron.whatsapp.sendMessage(adminJid, adminNotification);
                            await electron.intelligence.logAccuracy({ event: 'forwarded', details: `Unanswered query from ${targetJid} forwarded to Admin` });
                        }
                    } else if (!isAdmin) {
                        await electron.intelligence.logAccuracy({ event: 'resolved', details: `Successfully answered customer query: "${agentContent.substring(0, 30)}..."` });
                    }
                } else {
                    console.log(`[useAgent] No targetJid resolved for this prompt. Skipping WhatsApp delivery.`);
                }

                if (isEmailFlow && inboundEmailMessage) {
                    const responseText = typeof llmResponse.content === 'string'
                        ? llmResponse.content
                        : Array.isArray(llmResponse.content)
                            ? llmResponse.content
                                .map((part) => {
                                    if (part && typeof part === 'object' && 'type' in part) {
                                        const typed = part as { type?: string; text?: string }
                                        if (typed.type === 'text') return typed.text || ''
                                    }
                                    return ''
                                })
                                .join('\n')
                            : '';

                    const session = useChatStore.getState().sessions.find((s) => s.id === originSessionId);
                    const toolCallCount = session?.messages
                        .filter((m) => m.role === 'assistant')
                        .reduce((count, m) => count + (m.toolCalls?.length || 0), 0) || 0;
                    const usedRag = session?.messages.some((m) =>
                        (m.toolCalls || []).some((t) => t.name === 'rag_search')
                    ) || false;
                    const decision = evaluateEmailPolicy({
                        responseText,
                        originalContent: inboundEmailMessage.body || content,
                        usedRag,
                        hasUncertaintyMarkers: false,
                        toolCallCount,
                        citesKnowledgeBase: usedRag,
                    });

                    await handleEmailPostResponse(
                        {
                            responseText,
                            inboundEmailMessage,
                            decision,
                            draftMode: emailConfig.draftMode,
                            accountName: emailConfig.accountName,
                            emailSendHandledByAgent,
                        },
                        {
                            send: (payload) => electron.email.send(payload),
                            addDraft: (draft) => useDraftStore.getState().addDraft(draft),
                            addReviewNotice: (notice) => {
                                useChatStore.getState().addSessionMessage(originSessionId, {
                                    role: 'assistant',
                                    content: notice,
                                    actions: [
                                        { type: 'custom', label: 'Open Drafts', payload: { action: 'open_drafts' } }
                                    ],
                                });
                            },
                        }
                    );
                }

            } catch (error) {
                console.error("[useAgent] Handler error:", error);
                // Write the error to originSessionId — not whatever is currently active
                const { addSessionMessage: addMsg } = useChatStore.getState();
                addMsg(originSessionId, {
                    role: "assistant",
                    content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
                });
            } finally {
                // Clear the composing state if this was a WhatsApp message.
                // Uses the same targetJid captured before the try block — safe even if
                // the user disconnects mid-run (no second resolver call).
                if (targetJid) {
                    setWhatsAppPaused(targetJid);
                }

                // Always clear the processing state for originSessionId.
                // This does NOT affect any other session that might be running.
                const store = useChatStore.getState();
                store.stopProcessing(originSessionId);
                // Clear the session-level progress bar so it never lingers
                store.updateSessionProgress(originSessionId, undefined, undefined, undefined);
            }
        },
        // WHY settings in deps: If the user changes LLM provider mid-session,
        // the next handleSubmit call should use the new settings.
        [settings]
    );

    // ── Listen for action button events from MessageBubble ───────────────────
    // MessageBubble renders action buttons (Continue, Regenerate) and fires
    // custom DOM events when clicked. We listen here and delegate to handleSubmit.
    //
    // WHY DOM events instead of props: MessageBubble is deep in the component
    // tree and doesn't have direct access to handleSubmit.
    useEffect(() => {
        const handleAgentAction = (e: CustomEvent) => {
            const { type, content } = e.detail as { type: string; content: string };
            const { activeSessionId, isSessionProcessing } = useChatStore.getState();

            if (type === "continue" && activeSessionId && !isSessionProcessing(activeSessionId)) {
                handleSubmit(content);
            }

            if (type === "regenerate" && activeSessionId && !isSessionProcessing(activeSessionId)) {
                const { sessions, removeMessage } = useChatStore.getState();
                const session = sessions.find((s) => s.id === activeSessionId);
                if (!session || session.messages.length === 0) return;

                const msgs = session.messages;
                const lastMsg = msgs[msgs.length - 1];

                if (lastMsg.role === "assistant") {
                    const userMsg = msgs[msgs.length - 2];
                    if (userMsg && userMsg.role === "user") {
                        const textToResubmit = userMsg.content;
                        removeMessage(lastMsg.id);
                        removeMessage(userMsg.id);
                        handleSubmit(textToResubmit);
                    }
                }
            }
        };

        const handleAppSubmit = (e: Event) => {
            const customEvent = e as CustomEvent<{
                content: string,
                whatsappMessage?: import('../lib/whatsapp-integration').WhatsAppMessage,
                emailMessage?: EmailMessage
            }>;
            const content = customEvent.detail?.content;
            const whatsappMessage = customEvent.detail?.whatsappMessage;
            const emailMessage = customEvent.detail?.emailMessage;
            
            if (!content && !whatsappMessage && !emailMessage) return;

            if ((customEvent.detail as { system?: boolean })?.system) {
                console.log('[useAgent] Ignored system event in submit handler.');
                // Maybe we should still add it to the chat store as a system message? No, the PR reviewer just requested filtering.
                // If it's a delivery failure, the DraftApprovalPanel handles UI update.
                return;
            }

            const { activeSessionId, createSession, setActiveSession, sessions } = useChatStore.getState();
            let sessionId = activeSessionId;
            
            if (whatsappMessage?.from) {
                const existingSession = sessions.find(s => 
                    s.whatsapp_jid === whatsappMessage.from || 
                    s.contact_id === whatsappMessage.from
                );
                
                if (existingSession) {
                    sessionId = existingSession.id;
                    setActiveSession(sessionId);
                } else {
                    sessionId = createSession();
                    // Set the omnichannel session metadata so future messages map here
                    useChatStore.setState(state => ({
                        sessions: state.sessions.map(s => 
                            s.id === sessionId 
                                ? { 
                                    ...s, 
                                    channel: 'whatsapp',
                                    contact_id: whatsappMessage.from,
                                    whatsapp_jid: whatsappMessage.from, // Legacy fallback
                                    title: `💬 ${whatsappMessage.from.split('@')[0]}` 
                                  } 
                                : s
                        )
                    }));
                    console.log(`[useAgent] Created NEW omnichannel session for: ${whatsappMessage.from}`);
                }
            } else if (emailMessage?.from) {
                const sender = emailMessage.from.toLowerCase()
                const incomingThread = emailMessage.references?.split(' ')[0] || emailMessage.inReplyTo || emailMessage.messageId;
                const existingSession = sessions.find(s =>
                    s.channel === 'email' &&
                    (s.contact_id || '').toLowerCase() === sender &&
                    (!s.thread_id || !incomingThread || s.thread_id === incomingThread || s.title === `📧 ${normalizeSubject(emailMessage.subject || sender).slice(0, 48)}`)
                )
                if (existingSession) {
                    sessionId = existingSession.id
                    setActiveSession(sessionId)
                } else {
                    sessionId = createSession();
                    useChatStore.setState(state => ({
                        sessions: state.sessions.map(s =>
                            s.id === sessionId
                                ? {
                                    ...s,
                                    channel: 'email',
                                    contact_id: sender,
                                    thread_id: incomingThread,
                                    title: `📧 ${normalizeSubject(emailMessage.subject || sender).slice(0, 48)}`,
                                }
                                : s
                        )
                    }));
                }
            } else if (!sessionId) {
                const { createSession } = useChatStore.getState();
                sessionId = createSession();
                console.log('[useAgent] Created new general session for prompt:', sessionId);
            }
            
            handleSubmit(content || '', undefined, false, whatsappMessage, emailMessage);
        };

        window.addEventListener("agent-action", handleAgentAction as EventListener);
        window.addEventListener("app:submit-message", handleAppSubmit);
        
        return () => {
            window.removeEventListener("agent-action", handleAgentAction as EventListener);
            window.removeEventListener("app:submit-message", handleAppSubmit);
        };
    }, [handleSubmit]);

    return { handleSubmit };
}
