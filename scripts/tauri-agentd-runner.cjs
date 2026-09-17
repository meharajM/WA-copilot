#!/usr/bin/env node
const crypto = require('node:crypto')
const path = require('node:path')
const { AgentdServer } = require('./server.cjs')
const { KeyringCredentialStore } = require('./keyring-credential-store.cjs')

async function start() {
  const helperName = `aica-keyring-helper${process.platform === 'win32' ? '.exe' : ''}`
  const helperPath = process.env.AICA_AGENTD_KEYRING_HELPER || path.resolve(__dirname, '../aica-keyring-helper', helperName)
  const credentials = new KeyringCredentialStore(helperPath)
  let secret = await credentials.get('agentd_bearer_secret')
  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64url')
    await credentials.set('agentd_bearer_secret', secret)
  }

  const runtime = new AgentdServer({
    dataDir: process.env.AICA_AGENTD_DATA_DIR,
    secret,
    credentials,
    uiRoot: process.env.AICA_AGENTD_UI_ROOT || null,
  })
  await runtime.start()
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => runtime.stop().finally(() => process.exit(0)))
}

start().catch((error) => {
  process.stderr.write(`[agentd] failed to start: ${error.message}\n`)
  process.exitCode = 1
})
