const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const test = require('node:test')
const { AgentdServer } = require('../../agentd/server.cjs')

function request(origin, method, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(`${origin}${pathname}`, { method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
}

test('agentd email settings are authenticated, bounded, durable, and secret-free', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-agentd-email-settings-')
  const secret = 'e'.repeat(32)
  const server = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const { origin } = await server.start()
  const bearer = { authorization: `Bearer ${secret}` }
  assert.equal((await request(origin, 'GET', '/api/v1/settings/email', undefined, bearer)).status, 200)
  const settings = {
    accountName: 'support', provider: 'imap-smtp', gmailAuthMode: 'app-password',
    imapHost: 'imap.example.test', imapPort: 993, smtpHost: 'smtp.example.test', smtpPort: 587,
    emailAddress: 'support@example.test', userName: 'support@example.test', imapTls: true, smtpTls: true,
    pollingIntervalSeconds: 120, enabled: true, autoReplyMode: false, draftMode: true,
  }
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', settings, bearer)).status, 200)
  assert.equal((await request(origin, 'PUT', '/api/v1/settings/email', { ...settings, password: 'must-not-be-accepted' }, bearer)).status, 400)
  await server.stop()

  const restarted = new AgentdServer({ dataDir, secret, logger: { log() {} } })
  const recovered = await restarted.start()
  const response = await request(recovered.origin, 'GET', '/api/v1/settings/email', undefined, bearer)
  assert.deepEqual(response.body, settings)
  assert.equal(Object.prototype.hasOwnProperty.call(response.body, 'password'), false)
  await restarted.stop()
  fs.rmSync(dataDir, { recursive: true, force: true })
})
