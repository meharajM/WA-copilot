const { spawn } = require('node:child_process')

const MAX_SECRET_BYTES = 64 * 1024
const HELPER_TIMEOUT_MS = 5000
const ALLOWED_CREDENTIAL_KEYS = new Set([
  'openai_api_key',
  'gemini_api_key',
  'openrouter_api_key',
  'email_mcp_password',
  'email_imap_password',
  'email_smtp_password',
  'gmail_oauth_client_id',
  'gmail_oauth_refresh_token',
  'whatsapp_cloud_access_token',
  'whatsapp_cloud_app_secret',
  'whatsapp_cloud_verify_token',
])
const INTERNAL_CREDENTIAL_KEYS = new Set(['gmail_oauth_refresh_token'])

function isAllowedCredentialKey(key) {
  if (ALLOWED_CREDENTIAL_KEYS.has(key) || INTERNAL_CREDENTIAL_KEYS.has(key)) return true
  return [...new Set([...ALLOWED_CREDENTIAL_KEYS, ...INTERNAL_CREDENTIAL_KEYS])].some((allowedKey) => {
    const suffix = `_${allowedKey}`
    if (!key.startsWith('user_') || !key.endsWith(suffix)) return false
    return /^[A-Za-z0-9_-]{1,128}$/.test(key.slice(5, -suffix.length))
  })
}

function isInternalCredentialKey(key) {
  if (INTERNAL_CREDENTIAL_KEYS.has(key)) return true
  return [...INTERNAL_CREDENTIAL_KEYS].some((allowedKey) => {
    const suffix = `_${allowedKey}`
    return key.startsWith('user_') && key.endsWith(suffix)
      && /^[A-Za-z0-9_-]{1,128}$/.test(key.slice(5, -suffix.length))
  })
}

function isPublicCredentialKey(key) {
  if (isInternalCredentialKey(key)) return false
  return isAllowedCredentialKey(key)
}

class KeyringCredentialStore {
  constructor(helperPath, helperArgs = []) {
    if (!helperPath || typeof helperPath !== 'string') throw new Error('OS credential helper is unavailable')
    if (!Array.isArray(helperArgs) || helperArgs.some(argument => typeof argument !== 'string')) throw new Error('Invalid credential helper arguments')
    this.helperPath = helperPath
    this.helperArgs = helperArgs
  }

  async run(operation, key, input = Buffer.alloc(0)) {
    if (!['get', 'set', 'exists', 'delete'].includes(operation)) throw new Error('Credential operation is not allowed')
    if (!isAllowedCredentialKey(key) && key !== 'agentd_bearer_secret') throw new Error('Credential key is not allowed')
    if (input.length > MAX_SECRET_BYTES) throw new Error('Credential value is too large')

    return new Promise((resolve, reject) => {
      let settled = false
      let outputSize = 0
      const output = []
      const child = spawn(this.helperPath, [...this.helperArgs, operation, key], {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const timer = setTimeout(() => fail(new Error('OS credential helper timed out')), HELPER_TIMEOUT_MS)
      const fail = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill()
        reject(error)
      }

      child.stdout.on('data', (chunk) => {
        outputSize += chunk.length
        if (outputSize > MAX_SECRET_BYTES) return fail(new Error('OS credential helper returned oversized data'))
        output.push(chunk)
      })
      child.stderr.on('data', () => {})
      child.once('error', () => fail(new Error('OS credential helper could not start')))
      child.once('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (code === 0) return resolve(Buffer.concat(output))
        if (operation === 'get' && code === 2) return resolve(null)
        reject(new Error('OS credential store operation failed'))
      })
      child.stdin.once('error', () => fail(new Error('OS credential helper input failed')))
      child.stdin.end(input)
    })
  }

  async get(key) {
    const output = await this.run('get', key)
    if (output === null) return null
    try { return output.toString('utf8') }
    finally { output.fill(0) }
  }

  async exists(key) {
    const output = await this.run('exists', key)
    try {
      const value = output.toString('utf8').trim()
      if (value !== 'true' && value !== 'false') throw new Error('OS credential helper returned invalid data')
      return value === 'true'
    } finally {
      output.fill(0)
    }
  }

  async set(key, value) {
    if (typeof value !== 'string' || value.length === 0) throw new Error('Credential value cannot be empty')
    const input = Buffer.from(value, 'utf8')
    try {
      const output = await this.run('set', key, input)
      output.fill(0)
      return true
    } finally {
      input.fill(0)
    }
  }

  async delete(key) {
    const output = await this.run('delete', key)
    output.fill(0)
    return true
  }
}

module.exports = { KeyringCredentialStore, isAllowedCredentialKey, isPublicCredentialKey }
