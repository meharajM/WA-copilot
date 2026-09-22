#!/usr/bin/env node
const crypto = require('node:crypto')
const path = require('node:path')
const { AgentdServer } = require('../agentd/server.cjs')
const { KeyringCredentialStore } = require('../agentd/keyring-credential-store.cjs')
const { PublicRelayClient } = require('../agentd/public-relay-client.cjs')

async function start() {
  const helperName = `aica-keyring-helper${process.platform === 'win32' ? '.exe' : ''}`
  const helperPath = process.env.AICA_AGENTD_KEYRING_HELPER || path.resolve(__dirname, '../src-tauri/sidecar', helperName)
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
    uiRoot: process.env.AICA_AGENTD_UI_ROOT
  })
  if (process.env.AICA_RELAY_ORIGIN) {
    const relayAgentSecret = await credentials.get('relay_agent_secret')
    if (!relayAgentSecret) throw new Error('Relay is configured but relay_agent_secret is unavailable in the OS credential store')
    runtime.publicRelayClient = new PublicRelayClient({
      origin: process.env.AICA_RELAY_ORIGIN,
      businessId: process.env.AICA_RELAY_BUSINESS_ID,
      provider: process.env.AICA_RELAY_PROVIDER || 'whatsapp-cloud',
      agentSecret: relayAgentSecret,
      onEvent: event => runtime.ingestRelayEvent(event),
      allowInsecureLocalhost: process.env.AICA_RELAY_ALLOW_INSECURE_LOCALHOST === 'true',
    })
  }
  await runtime.start()

  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => runtime.stop().finally(() => process.exit(0)))
}

start().catch(error => {
  console.error(`[agentd] failed to start: ${error.message}`)
  process.exitCode = 1
})
