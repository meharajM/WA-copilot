import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REQUIRED_SCENARIOS = [
  'inbound-customer-message',
  'duplicate-webhook-event',
  'owner-takeover-echo',
  'opt-out-opt-in',
  'inside-response-window',
  'outside-response-window',
  'media-attachment',
  'token-expiry-revocation',
  'rate-limit-429',
  'provider-5xx-timeout',
  'restart-recovery',
  'pause-all',
]

const MODES = new Set(['observe', 'draft', 'auto'])
const DECISIONS = new Set(['continue', 'pause', 'rollback'])
const SENSITIVE_KEY = /(token|secret|password|api[-_]?key|authorization|cookie|customer[-_]?content|message[-_]?body)/i
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

const text = (value) => typeof value === 'string' ? value.trim() : ''
const nonEmpty = (value) => text(value).length > 0

function collectSensitiveKeys(value, path = '$', result = []) {
  if (!value || typeof value !== 'object') return result
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectSensitiveKeys(item, `${path}[${index}]`, result))
    return result
  }
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) result.push(`${path}.${key}`)
    collectSensitiveKeys(child, `${path}.${key}`, result)
  }
  return result
}

function fail(errors, path, message) {
  errors.push(`${path}: ${message}`)
}

export function validateLiveEvidence(record) {
  const errors = []
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: ['$: record must be a JSON object'] }
  }
  if (record.schemaVersion !== 1) fail(errors, '$.schemaVersion', 'must equal 1')
  for (const field of ['runId', 'operator', 'appVersion', 'commit', 'provider']) {
    if (!nonEmpty(record[field])) fail(errors, `$.${field}`, 'must be non-empty')
  }
  if (!ISO_DATE.test(text(record.recordedAt))) fail(errors, '$.recordedAt', 'must be an ISO UTC timestamp')
  if (!MODES.has(record.mode)) fail(errors, '$.mode', 'must be observe, draft, or auto')
  if (record.redactionConfirmed !== true) fail(errors, '$.redactionConfirmed', 'must be true')
  if (!Array.isArray(record.scenarios)) {
    fail(errors, '$.scenarios', 'must be an array')
  } else {
    const byName = new Map()
    for (const [index, scenario] of record.scenarios.entries()) {
      const path = `$.scenarios[${index}]`
      if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
        fail(errors, path, 'must be an object')
        continue
      }
      const name = text(scenario.name)
      if (!name) fail(errors, `${path}.name`, 'must be non-empty')
      else if (byName.has(name)) fail(errors, `${path}.name`, `duplicate scenario ${name}`)
      else byName.set(name, scenario)
      for (const field of ['expected', 'observed']) {
        if (!nonEmpty(scenario[field])) fail(errors, `${path}.${field}`, 'must be non-empty')
      }
      if (typeof scenario.pass !== 'boolean') fail(errors, `${path}.pass`, 'must be boolean')
      if (!Array.isArray(scenario.evidence) || scenario.evidence.length === 0 || scenario.evidence.some((item) => !nonEmpty(item))) {
        fail(errors, `${path}.evidence`, 'must contain at least one redacted log, screenshot, event ID, or review link')
      }
      if (!Array.isArray(scenario.providerEventIds) || scenario.providerEventIds.some((item) => !nonEmpty(item))) {
        fail(errors, `${path}.providerEventIds`, 'must be an array of non-empty redacted IDs (use [] when not applicable)')
      }
    }
    for (const name of REQUIRED_SCENARIOS) {
      const scenario = byName.get(name)
      if (!scenario) fail(errors, '$.scenarios', `missing required scenario ${name}`)
      else if (scenario.pass !== true) fail(errors, `$.scenarios[${name}]`, 'must pass before sign-off')
    }
  }
  if (!record.signoff || typeof record.signoff !== 'object' || Array.isArray(record.signoff)) {
    fail(errors, '$.signoff', 'must be an object')
  } else {
    if (!DECISIONS.has(record.signoff.decision)) fail(errors, '$.signoff.decision', 'must be continue, pause, or rollback')
    if (!nonEmpty(record.signoff.reviewer)) fail(errors, '$.signoff.reviewer', 'must be non-empty')
    if (!ISO_DATE.test(text(record.signoff.signedAt))) fail(errors, '$.signoff.signedAt', 'must be an ISO UTC timestamp')
  }
  const sensitiveKeys = collectSensitiveKeys(record)
  if (sensitiveKeys.length) fail(errors, '$', `secret or raw-content field names are forbidden: ${sensitiveKeys.join(', ')}`)
  return { valid: errors.length === 0, errors }
}

export async function readAndValidateLiveEvidence(filePath) {
  const raw = await readFile(resolve(filePath), 'utf8')
  let record
  try {
    record = JSON.parse(raw)
  } catch (error) {
    return { valid: false, errors: [`${filePath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`] }
  }
  return validateLiveEvidence(record)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const filePath = process.argv[2]
  if (!filePath) {
    console.error('Usage: node scripts/validate-live-evidence.mjs <evidence.json>')
    process.exitCode = 2
  } else {
    const result = await readAndValidateLiveEvidence(filePath)
    if (!result.valid) {
      console.error(`Live evidence validation failed:\n${result.errors.map((error) => `- ${error}`).join('\n')}`)
      process.exitCode = 1
    } else {
      console.log(`Live evidence valid: ${resolve(filePath)}`)
    }
  }
}
