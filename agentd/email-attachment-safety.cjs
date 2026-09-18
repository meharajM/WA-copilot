const crypto = require('node:crypto')

const MAX_SCANNED_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024

function startsWith(bytes, signature) {
  return signature.every((value, index) => bytes[index] === value)
}

function detectType(bytes) {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'jpeg'
  if (bytes.length === 0 || Array.from(bytes.subarray(0, 4096)).every(value => value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 126))) return 'text'
  return 'unknown'
}

function normalizedMime(mimeType) {
  return (typeof mimeType === 'string' ? mimeType : '').split(';', 1)[0].trim().toLowerCase()
}

function scanEmailAttachment({ bytes, mimeType } = {}) {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array()
  const sha256 = crypto.createHash('sha256').update(value).digest('hex')
  const detectedType = detectType(value)
  const mime = normalizedMime(mimeType)

  if (value.byteLength > MAX_SCANNED_EMAIL_ATTACHMENT_BYTES) {
    return { safe: false, reason: 'attachment_exceeds_scan_limit', size: value.byteLength, sha256, detectedType }
  }

  if (['application/x-msdownload', 'application/x-executable', 'application/x-sh', 'application/x-dosexec'].includes(mime)) {
    return { safe: false, reason: 'executable_attachment_type', size: value.byteLength, sha256, detectedType }
  }

  const compatible = detectedType !== 'unknown' && (!mime
    || (mime === 'application/pdf' && detectedType === 'pdf')
    || (mime === 'image/png' && detectedType === 'png')
    || ((mime === 'image/jpeg' || mime === 'image/jpg') && detectedType === 'jpeg')
    || ((mime === 'text/plain' || mime === 'text/csv' || mime === 'application/json') && detectedType === 'text'))
  if (!compatible) return { safe: false, reason: 'mime_magic_mismatch_or_unsupported_type', size: value.byteLength, sha256, detectedType }

  return { safe: true, reason: 'bounded_type_check_passed', size: value.byteLength, sha256, detectedType }
}

module.exports = { MAX_SCANNED_EMAIL_ATTACHMENT_BYTES, scanEmailAttachment }
