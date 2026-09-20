import type { ChannelAttachment } from '../packages/omnichannel'

function value(raw: Record<string, unknown>, key: string): string {
  const direct = raw[key] ?? raw[key.toLowerCase()] ?? raw[key.replace(/-/g, '_')]
  return typeof direct === 'string' ? direct.trim() : ''
}

function readString(raw: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) if (typeof raw[key] === 'string' && (raw[key] as string).trim()) return (raw[key] as string).trim()
  return ''
}

function readNumber(raw: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = typeof raw[key] === 'number' ? raw[key] : typeof raw[key] === 'string' ? Number(raw[key]) : NaN
    if (Number.isFinite(value) && value >= 0) return value
  }
  return undefined
}

export function normalizeEmailAttachmentMetadata(item: Record<string, unknown>): ChannelAttachment[] {
  const raw = item.attachments ?? item.files
  if (!Array.isArray(raw)) return []
  return raw.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const attachment = value as Record<string, unknown>
    const normalized = {
      id: readString(attachment, ['id', 'attachment_id', 'attachmentId']) || undefined,
      name: readString(attachment, ['name', 'filename', 'file_name']) || undefined,
      mimeType: readString(attachment, ['mime_type', 'mimeType', 'content_type']) || undefined,
      size: readNumber(attachment, ['size', 'bytes', 'length'])
    }
    return normalized.id || normalized.name || normalized.mimeType || normalized.size !== undefined ? [normalized] : []
  })
}

export function isEmailDeliveryBounce(email: { from?: string; subject?: string }, raw?: Record<string, unknown>): boolean {
  if (/^(mailer-daemon|postmaster)(@|$)/i.test(email.from || '') || /delivery status notification|mail delivery failed|undeliverable|returned mail/i.test(email.subject || '')) return true
  if (!raw) return false
  const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers as Record<string, unknown> : raw
  return /multipart\/report/i.test(value(headers, 'content-type'))
}

export function shouldProcessEmailInbound(email: { isFromMe: boolean; timestamp: number; from?: string; subject?: string }, raw: Record<string, unknown> | undefined, now = Date.now()): boolean {
  if (email.isFromMe || (email.timestamp > 0 && now - email.timestamp > 60 * 60 * 1000)) return false
  if (isEmailDeliveryBounce(email, raw)) return false
  if (!raw) return true
  if (['answered', 'is_answered', 'isAnswered', 'replied', 'is_replied', 'isReplied'].some(key => raw[key] === true)) return false
  const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers as Record<string, unknown> : raw
  if (value(headers, 'auto-submitted') && !/^no$/i.test(value(headers, 'auto-submitted'))) return false
  if (/^(bulk|list|junk)$/i.test(value(headers, 'precedence')) || value(headers, 'list-id') || value(headers, 'x-autorespond') || value(headers, 'x-auto-response-suppress')) return false
  if (/multipart\/report/i.test(value(headers, 'content-type'))) return false
  return true
}

export function isGmailAuthFailure(status: number): boolean { return status === 401 || status === 403 }
