import { createHash } from 'node:crypto'

export const MAX_SCANNED_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024

export interface EmailAttachmentScanInput {
  bytes: Uint8Array
  mimeType?: string
  name?: string
}

export interface EmailAttachmentScanResult {
  safe: boolean
  reason: string
  size: number
  sha256: string
  detectedType: 'pdf' | 'png' | 'jpeg' | 'text' | 'unknown'
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function detectType(bytes: Uint8Array): EmailAttachmentScanResult['detectedType'] {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (bytes.length === 0 || Array.from(bytes.slice(0, 4096)).every((value) => value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 126))) return 'text'
  return 'unknown'
}

function normalizedMime(mimeType?: string): string {
  return (mimeType || '').split(';', 1)[0].trim().toLowerCase()
}

export function scanEmailAttachment(input: EmailAttachmentScanInput): EmailAttachmentScanResult {
  const bytes = input.bytes
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const detectedType = detectType(bytes)
  const mime = normalizedMime(input.mimeType)

  if (bytes.byteLength > MAX_SCANNED_EMAIL_ATTACHMENT_BYTES) {
    return { safe: false, reason: 'attachment_exceeds_scan_limit', size: bytes.byteLength, sha256, detectedType }
  }

  if (mime === 'application/x-msdownload' || mime === 'application/x-executable' || mime === 'application/x-sh' || mime === 'application/x-dosexec') {
    return { safe: false, reason: 'executable_attachment_type', size: bytes.byteLength, sha256, detectedType }
  }

  const compatible =
    detectedType !== 'unknown' && (!mime ||
    (mime === 'application/pdf' && detectedType === 'pdf') ||
    (mime === 'image/png' && detectedType === 'png') ||
    ((mime === 'image/jpeg' || mime === 'image/jpg') && detectedType === 'jpeg') ||
    ((mime === 'text/plain' || mime === 'text/csv' || mime === 'application/json') && detectedType === 'text'))
  if (!compatible) return { safe: false, reason: 'mime_magic_mismatch_or_unsupported_type', size: bytes.byteLength, sha256, detectedType }

  return { safe: true, reason: 'bounded_type_check_passed', size: bytes.byteLength, sha256, detectedType }
}
