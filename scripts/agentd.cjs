#!/usr/bin/env node
const { AgentdServer } = require('../agentd/server.cjs')

const runtime = new AgentdServer({
  dataDir: process.env.AICA_AGENTD_DATA_DIR,
  secret: process.env.AICA_AGENTD_BEARER_SECRET,
  uiRoot: process.env.AICA_AGENTD_UI_ROOT
})

runtime.start().catch(error => {
  console.error(`[agentd] failed to start: ${error.message}`)
  process.exitCode = 1
})

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => runtime.stop().finally(() => process.exit(0)))
