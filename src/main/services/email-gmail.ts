export interface ParsedInboundGmailMessage {
  id: string
  from: string
  to: string
  subject: string
  body: string
  bodyType: 'text'
  timestamp: number
  messageId?: string
  inReplyTo?: string
  references?: string
  isFromMe: boolean
  attachments?: EmailAttachmentMetadata[]
}

export interface EmailAttachmentMetadata {
  id: string
  name?: string
  mimeType?: string
  size?: number
}

function parseEmailAddress(input: unknown): string {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return ''
    const match = trimmed.match(/<([^>]+@[^>]+)>/)
    if (match?.[1]) return match[1].trim().toLowerCase()
    if (trimmed.includes('@')) return trimmed.toLowerCase()
    return ''
  }

  return ''
}

function readHeader(headers: Array<Record<string, unknown>>, name: string): string {
  const found = headers.find((header) => String(header.name || '').toLowerCase() === name.toLowerCase())
  return typeof found?.value === 'string' ? found.value : ''
}

export function buildGmailQuery(lastSyncSeconds: number, unreadOnly: boolean): string {
  const queryParts = [lastSyncSeconds > 0 ? `after:${lastSyncSeconds}` : 'newer_than:1h']
  if (unreadOnly) queryParts.push('is:unread')
  return queryParts.join(' ')
}

export function decodeGmailBase64(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export function extractGmailBody(payload: Record<string, unknown> | null): string {
  if (!payload) return ''

  const mimeType = String(payload.mimeType || '').toLowerCase()
  const body = payload.body as Record<string, unknown> | undefined
  if (typeof body?.data === 'string' && body.data) {
    const decoded = decodeGmailBase64(body.data)
    if (decoded) {
      return mimeType === 'text/html' ? stripHtml(decoded) : decoded
    }
  }

  const parts = Array.isArray(payload.parts) ? (payload.parts as Array<Record<string, unknown>>) : []
  let htmlFallback = ''

  for (const part of parts) {
    const partMimeType = String(part.mimeType || '').toLowerCase()

    if (partMimeType === 'text/plain') {
      const text = extractGmailBody(part)
      if (text) return text
      continue
    }

    if (partMimeType.startsWith('multipart/')) {
      const nested = extractGmailBody(part)
      if (nested) return nested
      continue
    }

    if (partMimeType === 'text/html' && !htmlFallback) {
      htmlFallback = extractGmailBody(part)
    }
  }

  return htmlFallback
}

export function extractGmailAttachments(
  payload: Record<string, unknown> | null,
  output: EmailAttachmentMetadata[] = [],
  seen = new Set<string>(),
  depth = 0,
): EmailAttachmentMetadata[] {
  if (!payload || output.length >= 20 || depth > 8) return output
  const body = payload.body && typeof payload.body === 'object' ? payload.body as Record<string, unknown> : {}
  const attachmentId = typeof body.attachmentId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(body.attachmentId) ? body.attachmentId : ''
  const name = typeof payload.filename === 'string' ? payload.filename.trim().slice(0, 256) : ''
  const mimeType = typeof payload.mimeType === 'string' ? payload.mimeType.trim().slice(0, 128) : ''
  const size = typeof body.size === 'number' ? body.size : Number(body.size)
  if (attachmentId && !seen.has(attachmentId)) {
    seen.add(attachmentId)
    output.push({
      id: attachmentId,
      ...(name ? { name } : {}),
      ...(mimeType ? { mimeType } : {}),
      ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
    })
  }
  const parts = Array.isArray(payload.parts) ? payload.parts as Array<Record<string, unknown>> : []
  for (const part of parts) {
    if (output.length >= 20) break
    extractGmailAttachments(part, output, seen, depth + 1)
  }
  return output
}

export function toInboundGmailMessage(
  item: Record<string, unknown>,
  ownerEmail?: string | null
): ParsedInboundGmailMessage | null {
  const payload =
    item.payload && typeof item.payload === 'object'
      ? (item.payload as Record<string, unknown>)
      : null
  const headers = Array.isArray(payload?.headers)
    ? (payload.headers as Array<Record<string, unknown>>)
    : []
  const from = parseEmailAddress(readHeader(headers, 'From')) || 'unknown-sender'
  const labelIds = Array.isArray(item.labelIds)
    ? item.labelIds.filter((label): label is string => typeof label === 'string')
    : []
  const body = extractGmailBody(payload) || (typeof item.snippet === 'string' ? item.snippet : '')
  const internalDateRaw =
    typeof item.internalDate === 'string' || typeof item.internalDate === 'number'
      ? Number(item.internalDate)
      : 0
  const timestamp =
    Number.isFinite(internalDateRaw) && internalDateRaw > 0
      ? internalDateRaw
      : Date.now()
  const normalizedOwnerEmail = parseEmailAddress(ownerEmail)
  const attachments = extractGmailAttachments(payload)

  return {
    id: String(item.id || `gmail_${Date.now()}`),
    from,
    to: parseEmailAddress(readHeader(headers, 'To')) || '',
    subject: readHeader(headers, 'Subject') || '(No Subject)',
    body,
    bodyType: 'text',
    timestamp,
    messageId: readHeader(headers, 'Message-Id') || readHeader(headers, 'Message-ID'),
    inReplyTo: readHeader(headers, 'In-Reply-To'),
    references: readHeader(headers, 'References'),
    isFromMe: labelIds.includes('SENT') || (!!normalizedOwnerEmail && from === normalizedOwnerEmail),
    ...(attachments.length ? { attachments } : {}),
  }
}
