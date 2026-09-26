#!/usr/bin/env node
const { relayFromEnv } = require('../relay/public-relay.cjs')

async function start() {
  const relay = relayFromEnv()
  const host = process.env.AICA_RELAY_HOST || '127.0.0.1'
  const port = Number(process.env.AICA_RELAY_PORT || 8443)
  const info = await relay.start({ host, port })
  console.log(`[relay] listening on ${info.origin}`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => relay.stop().finally(() => process.exit(0)))
}

start().catch(error => {
  console.error(`[relay] failed to start: ${error.message}`)
  process.exitCode = 1
})
