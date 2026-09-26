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

function configuredAny(variables) {
  return variables.some(configured)
}

function valueOf(variables) {
  return variables.map(variable => process.env[variable]).find((_, index) => configured(variables[index])) || ''
}

function probeHealth(label, origin, headers = {}, pathName = '/healthz') {
  const health = new URL(pathName, origin)
  void fetch(health, { headers, signal: AbortSignal.timeout(2_000) })
    .then(response => {
      if (!response.ok) {
        missing += 1
        console.log(`${label}: health check failed (HTTP ${response.status})`)
      } else {
        console.log(`${label}: ready`)
      }
      if (missing) process.exitCode = 1
    })
    .catch(() => {
      missing += 1
      console.log(`${label}: health check failed or endpoint unreachable`)
      process.exitCode = 1
    })
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
  const webHealth = valueOf(['AICA_EXTENSION_BRIDGE_HEALTH_URL', 'AICA_EXTENSION_BRIDGE_ORIGIN'])
  if (webHealth) {
    try {
      const url = new URL(webHealth)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
      console.log(`WhatsApp Web session probe: configured (${url.origin})`)
      if (configured('AICA_EXTENSION_BRIDGE_TOKEN')) probeHealth('WhatsApp Web session probe', url.origin, { Authorization: `Bearer ${process.env.AICA_EXTENSION_BRIDGE_TOKEN}` }, '/health')
    } catch {
      missing += 1
      console.log('WhatsApp Web session probe: invalid AICA_EXTENSION_BRIDGE_HEALTH_URL/AICA_EXTENSION_BRIDGE_ORIGIN')
    }
  } else {
    console.log('WhatsApp Web session probe: not configured (live browser session evidence required)')
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
    // A syntactically valid public origin is not enough for Cloud ingress:
    // fail readiness when the relay cannot answer its unauthenticated health
    // route. The probe never sends business or credential material.
    probeHealth('WhatsApp Cloud relay', relayOrigin)
  }
}

const emailProvider = String(process.env.AICA_EMAIL_PROVIDER || process.env.EMAIL_PROVIDER || '').trim().toLowerCase()
if (emailProvider) {
  if (!['imap-smtp', 'gmail-api'].includes(emailProvider)) {
    missing += 1
    console.log(`Email transport: unsupported provider ${emailProvider}`)
  } else if (emailProvider === 'gmail-api' && ['oauth', 'google-oauth'].includes(String(process.env.AICA_EMAIL_AUTH_MODE || process.env.EMAIL_AUTH_MODE || '').trim().toLowerCase())) {
    const absent = ['GMAIL_OAUTH_CLIENT_ID', 'GMAIL_OAUTH_CLIENT_SECRET'].filter(variable => !configured(variable))
    if (absent.length) { missing += absent.length; console.log(`Gmail OAuth transport: missing ${absent.join(', ')}`) }
    else console.log('Gmail OAuth transport: client configuration present (live sign-in still required)')
  } else {
    const fields = {
      address: ['AICA_EMAIL_ADDRESS', 'EMAIL_ADDRESS'],
      imapHost: ['AICA_EMAIL_IMAP_HOST', 'EMAIL_IMAP_HOST'],
      imapPort: ['AICA_EMAIL_IMAP_PORT', 'EMAIL_IMAP_PORT'],
      smtpHost: ['AICA_EMAIL_SMTP_HOST', 'EMAIL_SMTP_HOST'],
      smtpPort: ['AICA_EMAIL_SMTP_PORT', 'EMAIL_SMTP_PORT'],
      password: ['AICA_EMAIL_PASSWORD', 'EMAIL_PASSWORD', 'AICA_EMAIL_IMAP_PASSWORD', 'EMAIL_IMAP_PASSWORD']
    }
    const absent = Object.entries(fields).filter(([, variables]) => !configuredAny(variables)).map(([name]) => name)
    if (absent.length) { missing += absent.length; console.log(`Email IMAP/SMTP transport: missing ${absent.join(', ')}`) }
    else console.log('Email IMAP/SMTP transport: configuration present (live mailbox test still required)')
  }
} else {
  console.log('Email transport: not selected (set AICA_EMAIL_PROVIDER=imap-smtp or gmail-api to preflight)')
}

const agentdOrigin = valueOf(['AICA_AGENTD_ORIGIN', 'AICA_AGENTD_ENDPOINT'])
if (agentdOrigin) {
  try {
    const url = new URL(agentdOrigin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol')
    console.log(`agentd endpoint: configured (${url.origin})`)
    probeHealth('agentd endpoint', url.origin)
  } catch {
    missing += 1
    console.log('agentd endpoint: invalid AICA_AGENTD_ORIGIN/AICA_AGENTD_ENDPOINT')
  }
} else {
  console.log('agentd endpoint: not configured (local readiness must be checked by runtime smoke)')
}
console.log('Cloud/Web/Gmail secure-store credentials and provider dashboard permissions require live owner verification.')
if (missing) process.exitCode = 1
