function value(raw: Record<string, unknown>, key: string): string {
  const direct = raw[key] ?? raw[key.toLowerCase()] ?? raw[key.replace(/-/g, '_')]
  return typeof direct === 'string' ? direct.trim() : ''
}

export function shouldProcessEmailInbound(email: { isFromMe: boolean; timestamp: number; from?: string; subject?: string }, raw: Record<string, unknown> | undefined, now = Date.now()): boolean {
  if (email.isFromMe || (email.timestamp > 0 && now - email.timestamp > 60 * 60 * 1000)) return false
  if (/^(mailer-daemon|postmaster)(@|$)/i.test(email.from || '') || /delivery status notification|mail delivery failed|undeliverable|returned mail/i.test(email.subject || '')) return false
  if (!raw) return true
  if (['answered', 'is_answered', 'isAnswered', 'replied', 'is_replied', 'isReplied'].some(key => raw[key] === true)) return false
  const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers as Record<string, unknown> : raw
  if (value(headers, 'auto-submitted') && !/^no$/i.test(value(headers, 'auto-submitted'))) return false
  if (/^(bulk|list|junk)$/i.test(value(headers, 'precedence')) || value(headers, 'list-id') || value(headers, 'x-autorespond') || value(headers, 'x-auto-response-suppress')) return false
  if (/multipart\/report/i.test(value(headers, 'content-type'))) return false
  return true
}

export function isGmailAuthFailure(status: number): boolean { return status === 401 || status === 403 }
