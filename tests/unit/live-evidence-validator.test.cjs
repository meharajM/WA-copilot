const assert = require('node:assert/strict')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

let validateLiveEvidence
test('live evidence validator rejects incomplete records and unsafe fields', async () => {
  ({ validateLiveEvidence } = await import(pathToFileURL(require('node:path').resolve(__dirname, '../../scripts/validate-live-evidence.mjs')).href))
  const result = validateLiveEvidence({ schemaVersion: 1, runId: 'run-1', recordedAt: '2026-09-22T00:00:00Z', operator: 'owner', appVersion: '1.0.1', commit: 'abc123', provider: 'test', mode: 'draft', redactionConfirmed: true, apiToken: 'must-not-be-present', scenarios: [], signoff: { decision: 'continue', reviewer: 'owner', signedAt: '2026-09-22T00:00:00Z' } })
  assert.equal(result.valid, false)
  assert.match(result.errors.join('\n'), /missing required scenario inbound-customer-message/)
  assert.match(result.errors.join('\n'), /secret or raw-content field names are forbidden/)
})

test('live evidence validator accepts complete redacted records', () => {
  const names = ['inbound-customer-message', 'duplicate-webhook-event', 'owner-takeover-echo', 'opt-out-opt-in', 'inside-response-window', 'outside-response-window', 'media-attachment', 'token-expiry-revocation', 'rate-limit-429', 'provider-5xx-timeout', 'restart-recovery', 'pause-all']
  const result = validateLiveEvidence({
    schemaVersion: 1,
    runId: 'run-1',
    recordedAt: '2026-09-22T00:00:00Z',
    operator: 'owner',
    appVersion: '1.0.1',
    commit: 'abc123',
    provider: 'redacted-sandbox',
    mode: 'draft',
    redactionConfirmed: true,
    scenarios: names.map((name) => ({ name, expected: 'bounded expected result', observed: 'bounded observed result', providerEventIds: [], evidence: ['redacted://evidence/run-1'], pass: true })),
    signoff: { decision: 'pause', reviewer: 'owner', signedAt: '2026-09-22T00:00:00Z' },
  })
  assert.deepEqual(result, { valid: true, errors: [] })
})
