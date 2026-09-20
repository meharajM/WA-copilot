/**
 * email-integration.ts — Email Channel Adapter
 *
 * Converts inbound/outbound email payloads to/from the internal ChannelMessage format.
 * This module owns:
 *   - Email session key generation (deterministic, thread-aware)
 *   - Subject normalization (strip Re:, Fwd:, etc.)
 *   - Email → LLMMessage conversion
 *   - Email system prompt generation
 *   - Thread header extraction (Message-ID, In-Reply-To, References)
 *
 * Design principles:
 *   - Thin adapter: only transforms data, no business logic
 *   - Reuses existing AgentRuntime, chatStore, and MCP infrastructure
 *   - Safe-by-default: no auto-send, drafts only until Phase 3
 */

import { type LLMMessage, type LLMContentPart } from './types';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Raw email payload as received from an MCP email server or IMAP fetch.
 * Mirrors the shape returned by `mcp-email-server` tools.
 */
export interface EmailMessage {
  /** Unique email identifier (typically the Message-ID header) */
  id: string;
  /** Sender email address */
  from: string;
  /** Comma-separated recipient addresses */
  to: string;
  /** Email subject line (may contain Re:, Fwd:, etc.) */
  subject: string;
  /** Email body — plain text or HTML */
  body: string;
  /** Body format */
  bodyType: 'text' | 'html';
  /** Original Message-ID header — critical for threading */
  messageId?: string;
  /** In-Reply-To header — references the parent message's Message-ID */
  inReplyTo?: string;
  /** References header — chain of Message-IDs for deep thread history */
  references?: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Whether this email was sent by us (outbound) */
  isFromMe: boolean;
  /** Attached file metadata */
  attachments?: EmailAttachment[];
}

/** Metadata for an email attachment */
export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  /** Local filesystem path after download */
  path?: string;
  /** Bounded browser data URL after authenticated Gmail retrieval */
  dataUrl?: string;
}

/**
 * Deterministic session key for an email thread.
 * Format: `email::<normalized_sender>::<thread_id>`
 *
 * Why deterministic: The same email thread must always map to the same
 * chat session, even across app restarts or polling cycles.
 */
export interface EmailSessionKey {
  /** Full session key string */
  key: string;
  /** Normalized sender email (lowercased, trimmed) */
  sender: string;
  /** Thread identifier (subject hash or Message-ID root) */
  threadId: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Prefix used to identify email sessions in the chat store */
export const EMAIL_CHANNEL_PREFIX = 'email';

/** Regex patterns to strip from subjects for thread normalization */
const SUBJECT_PREFIX_PATTERN = /^(?:re|fwd|fw|aw|sv|vs|wg)\s*[:;]\s*/i;

/**
 * Maximum length for a session title derived from email subject.
 * Keeps sidebar titles readable without truncation artifacts.
 */
const MAX_SESSION_TITLE_LENGTH = 50;

// ── Session Key Generation ────────────────────────────────────────────────────

/**
 * Generates a deterministic session key for an email thread.
 *
 * The key format is `email::<sender>::<thread_id>` where:
 *   - sender is the normalized (lowercased, trimmed) sender address
 *   - thread_id is derived from In-Reply-To, References, or subject hash
 *
 * This ensures that:
 *   - Replies to the same thread always map to the same session
 *   - New subjects from the same sender create separate sessions
 *   - Subject prefixes (Re:, Fwd:) don't break thread continuity
 *
 * @param email - The email message to generate a session key for
 * @returns An EmailSessionKey with the full key and its components
 *
 * @example
 * // New thread
 * generateEmailSessionKey({ from: 'alice@example.com', subject: 'Help with order', ... })
 * // → { key: 'email::alice@example.com::help_with_order', sender: 'alice@example.com', threadId: 'help_with_order' }
 *
 * @example
 * // Reply to existing thread
 * generateEmailSessionKey({ from: 'alice@example.com', subject: 'Re: Help with order', inReplyTo: '<abc123@mail.example.com>', ... })
 * // → { key: 'email::alice@example.com::abc123', sender: 'alice@example.com', threadId: 'abc123' }
 */
export function generateEmailSessionKey(email: Pick<EmailMessage, 'from' | 'subject' | 'messageId' | 'inReplyTo' | 'references'>): EmailSessionKey {
  const sender = normalizeEmailAddress(email.from);
  
  // Thread ID priority: In-Reply-To > References root > subject hash
  // This matches RFC 5322 threading semantics
  const threadId = extractThreadId(email);
  
  return {
    key: `${EMAIL_CHANNEL_PREFIX}::${sender}::${threadId}`,
    sender,
    threadId,
  };
}

/**
 * Extracts a stable thread identifier from email threading headers.
 *
 * Priority order (per RFC 5322):
 *   1. First Message-ID in References — root of the thread (most reliable for deep chains)
 *   2. In-Reply-To — direct parent reference
 *   3. Email's own Message-ID — for first message in thread
 *   4. Normalized subject hash — fallback for new threads
 *
 * We check References FIRST because it contains the full chain, allowing us
 * to always resolve back to the root message even for deeply nested replies.
 */
function extractThreadId(email: Pick<EmailMessage, 'messageId' | 'inReplyTo' | 'references' | 'subject'>): string {
  // Priority 1: Use References to find the root of the thread
  // This ensures all replies in a chain map to the same session
  if (email.references) {
    const messageIds = email.references.trim().split(/\s+/);
    if (messageIds.length > 0) {
      return cleanMessageId(messageIds[0]);
    }
  }
  
  // Priority 2: Use In-Reply-To as the thread identifier
  // For the first reply (no References yet), In-Reply-To points to the original
  if (email.inReplyTo) {
    return cleanMessageId(email.inReplyTo);
  }
  
  // Priority 3: Use the email's own Message-ID (for first message in thread)
  if (email.messageId) {
    return cleanMessageId(email.messageId);
  }
  
  // Fallback: Hash the normalized subject
  return hashSubject(normalizeSubject(email.subject));
}

/**
 * Strips angle brackets and truncates a Message-ID to a stable identifier.
 *
 * Message-IDs can be very long (e.g., `<CABc123xyz@mail.gmail.com>`),
 * so we extract the local part (before @) and truncate for readability.
 */
function cleanMessageId(messageId: string): string {
  // Strip angle brackets
  const cleaned = messageId.replace(/^<|>$/g, '');
  
  // Extract local part (before @) for brevity
  const localPart = cleaned.split('@')[0] || cleaned;
  
  // Truncate to 20 chars to keep session keys manageable
  return localPart.substring(0, 20);
}

/**
 * Generates a short hash from a normalized subject line.
 *
 * Uses a simple djb2-style hash for deterministic, collision-resistant
 * thread identification without external dependencies.
 */
function hashSubject(subject: string): string {
  let hash = 5381;
  for (let i = 0; i < subject.length; i++) {
    hash = ((hash << 5) + hash) + subject.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  // Return as hex string, prefixed with 'subj_' for clarity
  return `subj_${Math.abs(hash).toString(36).substring(0, 12)}`;
}

// ── Subject Normalization ─────────────────────────────────────────────────────

/**
 * Normalizes an email subject by stripping reply/forward prefixes.
 *
 * Handles common prefixes across languages:
 *   - English: Re:, Fwd:, FW:
 *   - German: AW:, WG:
 *   - Swedish: SV:, VS:
 *
 * Repeated prefixes (e.g., "Re: Re: Fwd: Subject") are fully stripped.
 *
 * @param subject - Raw email subject line
 * @returns Normalized subject without reply/forward prefixes
 *
 * @example
 * normalizeSubject('Re: Fwd: Order #12345') // → 'Order #12345'
 * normalizeSubject('Meeting notes')          // → 'Meeting notes'
 */
export function normalizeSubject(subject: string): string {
  let normalized = subject.trim();
  
  // Repeatedly strip prefixes until none remain
  let prev: string;
  do {
    prev = normalized;
    normalized = normalized.replace(SUBJECT_PREFIX_PATTERN, '');
  } while (normalized !== prev);
  
  return normalized.trim();
}

// ── Email Address Normalization ───────────────────────────────────────────────

/**
 * Normalizes an email address for consistent session matching.
 *
 * Operations:
 *   - Lowercase (email is case-insensitive per RFC 5321)
 *   - Trim whitespace
 *   - Extract bare address from display name format
 *     (e.g., "John Doe <john@example.com>" → "john@example.com")
 *
 * @param email - Raw email address (may include display name)
 * @returns Normalized email address
 *
 * @example
 * normalizeEmailAddress('John Doe <john@example.com>') // → 'john@example.com'
 * normalizeEmailAddress('  JOHN@Example.COM  ')         // → 'john@example.com'
 */
export function normalizeEmailAddress(email: string): string {
  if (!email) return '';
  
  // Extract address from angle brackets if present
  const angleBracketMatch = email.match(/<([^>]+)>/);
  const bareAddress = angleBracketMatch ? angleBracketMatch[1] : email;
  
  return bareAddress.trim().toLowerCase();
}

// ── LLM Message Conversion ────────────────────────────────────────────────────

/**
 * Converts a raw EmailMessage into an LLMMessage for the agent.
 *
 * The resulting message includes:
 *   - Sender context (from address)
 *   - Subject line (normalized for readability)
 *   - Body content (text or HTML)
 *   - Attachment metadata (if present)
 *
 * This format is consumed by AgentRuntime exactly like WhatsApp messages,
 * ensuring the agent reasoning loop is channel-agnostic.
 *
 * @param email - Raw email message from MCP server or IMAP fetch
 * @returns LLMMessage ready for agent processing
 */
export function convertEmailToLLMMessage(email: EmailMessage): LLMMessage {
  const parts: LLMContentPart[] = [];
  
  // Build a structured text representation for the LLM
  // This gives the agent full email context (headers + body) in one message
  const headerBlock = [
    `From: ${email.from}`,
    `Subject: ${normalizeSubject(email.subject)}`,
    `Date: ${new Date(email.timestamp).toISOString()}`,
  ].join('\n');
  
  // Add threading context if available
  let headerBlockText = headerBlock;
  if (email.inReplyTo || email.references) {
    headerBlockText += '\n[This is a reply in an ongoing thread]';
  }
  
  parts.push({ type: 'text', text: headerBlockText });
  
  // Add body content
  const bodyText = email.bodyType === 'html' 
    ? stripHtmlTags(email.body) 
    : email.body;
  
  if (bodyText) {
    parts.push({ type: 'text', text: `\n---\n${bodyText}` });
  }
  
  // Add attachment metadata if present
  if (email.attachments && email.attachments.length > 0) {
    const attachmentList = email.attachments
      .map(a => `- ${a.filename} (${a.contentType}, ${formatFileSize(a.size)})`)
      .join('\n');
    parts.push({ type: 'text', text: `\n\n[ATTACHMENTS]\n${attachmentList}` });
  }
  
  return {
    role: 'user',
    content: parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts,
    attachments: email.attachments
      ?.filter(a => a.path || a.dataUrl)
      .map(a => ({
        name: a.filename,
        path: a.path || '',
        type: a.contentType,
        ...(a.dataUrl ? { dataUrl: a.dataUrl } : {}),
      })),
  };
}

/**
 * Strips HTML tags from email body content.
 *
 * This is a lightweight sanitizer — not a full HTML parser.
 * It handles common email HTML patterns:
 *   - Removes all tags
 *   - Converts <br> and block elements to newlines
 *   - Decodes common HTML entities
 *
 * For complex HTML emails, consider using a proper parser in production.
 */
function stripHtmlTags(html: string): string {
  return html
    // Convert block elements to newlines
    .replace(/<\/?(?:p|div|br|h[1-6]|li|tr|td|th|ul|ol|blockquote)[^>]*>/gi, '\n')
    // Remove all remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    // Collapse multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Formats a file size in bytes to a human-readable string.
 */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Email System Prompt ───────────────────────────────────────────────────────

/**
 * Returns the email-specific system prompt for the agent.
 *
 * This prompt instructs the agent to:
 *   - Be thread-aware (reference prior context)
 *   - Use professional email formatting
 *   - Ground responses in RAG/memory
 *   - Escalate when uncertain
 *
 * @param persona - Business persona (name, tone)
 * @returns LLMMessage with the email system prompt
 */
export function getEmailSystemPrompt(persona?: { name: string; tone: string }): LLMMessage {
  const businessName = persona?.name || 'Our Business';
  const businessTone = persona?.tone || 'professional';
  
  return {
    role: 'system',
    content: `EMAIL CUSTOMER SUPPORT MODE ACTIVE: You are the professional Support Agent for *${businessName}*.
Role: Senior Email Support Representative.
Tone: ${businessTone}

THREAD AWARENESS:
1. This is an email conversation — maintain thread context across messages.
2. Reference prior messages naturally (e.g., "As mentioned in my previous email...").
3. Do NOT repeat information already provided in this thread.

EMAIL FORMATTING RULES:
4. Use professional email structure: greeting, body, sign-off.
5. Keep responses concise — customers read emails on mobile devices.
6. Use plain text formatting (no markdown). Use line breaks for paragraphs.
7. Include a brief, professional sign-off (e.g., "Best regards, ${businessName} Support").

STRICT GROUNDING RULES:
8. ALWAYS check 'rag_search' before answering business queries.
9. NO HALLUCINATIONS: If information is NOT in the knowledge base, say so.
10. UNKNOWN ANSWER: If RAG returns no result, say: "I don't have that specific information. I've flagged this for our human team and we'll follow up shortly."

ESCALATION:
11. If the query involves refunds, legal matters, or account security, flag for human review.
12. When uncertain, create a draft for approval rather than sending directly.`,
  };
}

// ── Session Title Generation ──────────────────────────────────────────────────

/**
 * Generates a human-readable session title from an email.
 *
 * Uses the normalized subject, truncated to a reasonable length.
 * Falls back to the sender address if subject is missing.
 *
 * @param email - Email message
 * @returns Session title for the UI
 */
export function generateEmailSessionTitle(email: Pick<EmailMessage, 'subject' | 'from'>): string {
  const subject = normalizeSubject(email.subject);
  
  if (subject) {
    // Truncate with ellipsis if too long
    return subject.length > MAX_SESSION_TITLE_LENGTH
      ? `${subject.substring(0, MAX_SESSION_TITLE_LENGTH - 3)}...`
      : subject;
  }
  
  // Fallback to sender
  const sender = normalizeEmailAddress(email.from);
  return `Email from ${sender}`;
}

// ── Email Validation ──────────────────────────────────────────────────────────

/**
 * Validates an email address format.
 *
 * Uses a pragmatic regex that covers 99.9% of real-world email addresses
 * without being overly strict (per RFC 5322, most regexes are too restrictive).
 *
 * @param email - Email address to validate
 * @returns true if the email format is valid
 */
export function isValidEmailAddress(email: string): boolean {
  if (!email || email.trim().length === 0) return false;
  
  // Pragmatic email regex — covers common cases without being overly strict
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

/**
 * Validates a raw EmailMessage for required fields and data integrity.
 *
 * @param email - Email message to validate
 * @returns Object with isValid flag and optional error message
 */
export function validateEmailMessage(email: Partial<EmailMessage>): { isValid: boolean; error?: string } {
  if (!email.from) {
    return { isValid: false, error: 'Missing required field: from' };
  }
  
  if (!isValidEmailAddress(email.from)) {
    return { isValid: false, error: `Invalid sender email: ${email.from}` };
  }
  
  if (!email.body && email.body !== '') {
    return { isValid: false, error: 'Missing required field: body' };
  }
  
  if (!email.timestamp) {
    return { isValid: false, error: 'Missing required field: timestamp' };
  }
  
  return { isValid: true };
}
