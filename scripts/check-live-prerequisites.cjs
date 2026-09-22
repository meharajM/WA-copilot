const fs = require('node:fs')
const path = require('node:path')

// Keep this preflight aligned with tests/utils/liveEnv.ts. Shell-provided
// values win; local env files are loaded only to make the check match the
// live-test runner without ever printing secret values.
try {
  const { config } = require('dotenv')
  for (const file of ['.env.test.local', '.env.test', '.env']) {
    const fullPath = path.resolve(process.cwd(), file)
    if (fs.existsSync(fullPath)) config({ path: fullPath, override: false })
  }
} catch {
  // dotenv is a development dependency; an installed production bundle can
  // still run the check using process-provided variables.
}

const groups = [
  ['Escalation', ['AICA_ESCALATION_CONTACT']],
  ['Gmail OAuth', ['GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET']],
  ['Meta', ['META_ACCESS_TOKEN', 'META_ACCOUNT_ID']],
  ['X DM', ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET', 'X_ACCOUNT_ID']],
  ['Live test flag', ['LIVE_LLM_TESTS']]
]

let missing = 0
function configured(variable) {
  const value = String(process.env[variable] || '').trim()
  return value !== '' && !/^replace_with_/i.test(value)
}

for (const [name, variables] of groups) {
  const absent = variables.filter(variable => !configured(variable))
  if (absent.length) { missing += absent.length; console.log(`${name}: missing ${absent.join(', ')}`) }
  else console.log(`${name}: configured (${variables.length} variables present)`)
}

const llmOptions = [
  { label: 'OpenRouter', variables: ['OPENROUTER_API_KEY', 'OPENROUTER_MODEL'] },
  { label: 'Google Gemini', variables: ['GOOGLE_API_KEY'] },
]
const configuredLlm = llmOptions.find(option => option.variables.every(configured))
if (configuredLlm) {
  console.log(`LLM: configured (${configuredLlm.label})`)
} else {
  missing += 1
  console.log('LLM: missing OPENROUTER_API_KEY + OPENROUTER_MODEL or GOOGLE_API_KEY')
}

if (!['true', '1', 'yes'].includes(String(process.env.AICA_LLM_DATA_POLICY_APPROVED || '').trim().toLowerCase())) {
  missing += 1
  console.log('LLM data policy: not approved (AICA_LLM_DATA_POLICY_APPROVED)')
} else console.log('LLM data policy: approved')

const transport = String(process.env.WHATSAPP_TRANSPORT || '').trim() || 'baileys/default'
console.log(`WhatsApp transport selection: ${transport}`)
if (transport === 'web') {
  if (!configured('AICA_EXTENSION_BRIDGE_TOKEN')) {
    missing += 1
    console.log('WhatsApp Web bridge: missing AICA_EXTENSION_BRIDGE_TOKEN')
  } else {
    console.log('WhatsApp Web bridge: configured')
  }
}
if (transport === 'cloud') {
  const relayOrigin = String(process.env.AICA_RELAY_ORIGIN || '').trim()
  const relayBusiness = String(process.env.AICA_RELAY_BUSINESS_ID || '').trim()
  if (!configured('AICA_RELAY_ORIGIN') || !configured('AICA_RELAY_BUSINESS_ID')) {
    missing += 1
    console.log('WhatsApp Cloud relay: missing AICA_RELAY_ORIGIN + AICA_RELAY_BUSINESS_ID')
  } else if (!/^https:\/\//i.test(relayOrigin) && !(String(process.env.AICA_RELAY_ALLOW_INSECURE_LOCALHOST || '').toLowerCase() === 'true' && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(relayOrigin))) {
    missing += 1
    console.log('WhatsApp Cloud relay: AICA_RELAY_ORIGIN must use HTTPS (or explicitly allow localhost HTTP)')
  } else {
    console.log(`WhatsApp Cloud relay: configured for ${relayBusiness}`)
  }
}
console.log('Cloud/Web/Gmail secure-store credentials and provider dashboard permissions require live owner verification.')
if (missing) process.exitCode = 1
