const crypto = require('node:crypto')

const MAX_MIME_ATTACHMENT_COUNT = 5
const MAX_MIME_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_MIME_ATTACHMENT_NAME_LENGTH = 256
const MAX_MIME_ATTACHMENT_MIME_LENGTH = 128

function assertHeader(value, name, max = 998) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\u0000]/.test(value)) {
    throw new Error(`Invalid email ${name}`)
  }
  return value.trim()
}

function assertAddress(value, name) {
  const address = assertHeader(value, name, 320)
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(address)) throw new Error(`Invalid email ${name}`)
  return address
}

function normalizeBody(body) {
  if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body, 'utf8') > 96 * 1024 || /\u0000/.test(body)) {
    throw new Error('Invalid email body')
  }
  return body.replace(/\r?\n/g, '\r\n').replace(/\r(?!\n)/g, '\r\n')
}

function encodeFilename(value) {
  return encodeURIComponent(value).replace(/'/g, '%27')
}

function readAttachments(attachments) {
  if (attachments === undefined) return []
  if (!Array.isArray(attachments) || attachments.length > MAX_MIME_ATTACHMENT_COUNT) throw new Error('Invalid email attachments')
  const result = []
  let total = 0
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) throw new Error('Invalid email attachment')
    const name = assertHeader(attachment.name, 'attachment name', MAX_MIME_ATTACHMENT_NAME_LENGTH)
    if (/[\\/]/.test(name)) throw new Error('Invalid email attachment name')
    const mimeType = assertHeader(attachment.mimeType, 'attachment MIME type', MAX_MIME_ATTACHMENT_MIME_LENGTH).toLowerCase()
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) throw new Error('Invalid email attachment MIME type')
    if (typeof attachment.dataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.dataBase64) || attachment.dataBase64.length % 4 === 1) throw new Error('Invalid email attachment bytes')
    const bytes = Buffer.from(attachment.dataBase64, 'base64')
    if (!bytes.length || bytes.toString('base64') !== attachment.dataBase64 || bytes.length > MAX_MIME_ATTACHMENT_BYTES) throw new Error('Invalid email attachment bytes')
    total += bytes.length
    if (total > MAX_MIME_ATTACHMENT_BYTES) throw new Error('Email attachments exceed the size limit')
    result.push({ name, mimeType, bytes })
  }
  return result
}

function wrapBase64(bytes) {
  const encoded = bytes.toString('base64')
  return encoded.match(/.{1,76}/g)?.join('\r\n') || ''
}

function buildMimeMessage({ from = '', to, subject, body, messageId, inReplyTo, references, attachments, boundary = null } = {}) {
  const sender = from ? assertAddress(from, 'sender') : ''
  const recipient = assertAddress(to, 'recipient')
  const title = assertHeader(subject || '(no subject)', 'subject')
  const normalizedBody = normalizeBody(body)
  const files = readAttachments(attachments)
  const headers = [
    `To: ${recipient}`,
    `Subject: ${title}`,
    'MIME-Version: 1.0',
  ]
  if (sender) headers.unshift(`From: ${sender}`)
  for (const [name, value] of [['Message-ID', messageId], ['In-Reply-To', inReplyTo], ['References', references]]) {
    if (value) headers.push(`${name}: ${assertHeader(value, name, 8192)}`)
  }
  if (!files.length) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit')
    return { from: sender, to: recipient, data: `${headers.join('\r\n')}\r\n\r\n${normalizedBody}` }
  }
  const marker = boundary || `aica_${crypto.randomBytes(12).toString('hex')}`
  if (!/^[A-Za-z0-9_=-]{8,80}$/.test(marker)) throw new Error('Invalid email MIME boundary')
  headers.push(`Content-Type: multipart/mixed; boundary="${marker}"`)
  const parts = [
    `--${marker}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${normalizedBody}`,
  ]
  for (const file of files) {
    const encodedName = encodeFilename(file.name)
    parts.push(`--${marker}\r\nContent-Type: ${file.mimeType}; name*=UTF-8''${encodedName}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename*=UTF-8''${encodedName}\r\n\r\n${wrapBase64(file.bytes)}`)
  }
  parts.push(`--${marker}--`)
  return { from: sender, to: recipient, data: `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}` }
}

function buildSmtpData(message) {
  const stuffed = message.data.split('\r\n').map(line => line.startsWith('.') ? `.${line}` : line).join('\r\n')
  return `${stuffed}\r\n.\r\n`
}

module.exports = {
  MAX_MIME_ATTACHMENT_COUNT,
  MAX_MIME_ATTACHMENT_BYTES,
  MAX_MIME_ATTACHMENT_NAME_LENGTH,
  MAX_MIME_ATTACHMENT_MIME_LENGTH,
  buildMimeMessage,
  buildSmtpData,
}
