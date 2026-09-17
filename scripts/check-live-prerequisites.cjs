const groups = [
  ['LLM', ['GOOGLE_API_KEY']],
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

if (!['true', '1', 'yes'].includes(String(process.env.AICA_LLM_DATA_POLICY_APPROVED || '').trim().toLowerCase())) {
  missing += 1
  console.log('LLM data policy: not approved (AICA_LLM_DATA_POLICY_APPROVED)')
} else console.log('LLM data policy: approved')

const transport = String(process.env.WHATSAPP_TRANSPORT || '').trim() || 'baileys/default'
console.log(`WhatsApp transport selection: ${transport}`)
console.log('Cloud/Web/Gmail secure-store credentials and provider dashboard permissions require live owner verification.')
if (missing) process.exitCode = 1
