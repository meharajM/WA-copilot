import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('live prerequisite preflight', () => {
  it('reports missing configuration without printing secret values', () => {
    const script = path.resolve(process.cwd(), 'scripts/check-live-prerequisites.cjs')
    const withSecret = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH, GOOGLE_API_KEY: 'do-not-print' }, encoding: 'utf8' })
    expect(withSecret.status).not.toBe(0)
    expect(withSecret.stdout).not.toContain('do-not-print')
    const withoutSecrets = spawnSync(process.execPath, [script], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
    expect(withoutSecrets.status).not.toBe(0)
    const output = withoutSecrets.stdout
    expect(output).toContain('LLM: missing OPENROUTER_API_KEY + OPENROUTER_MODEL or GOOGLE_API_KEY')
    expect(output).not.toContain('do-not-print')
    expect(output).toContain('secure-store credentials')
  })

  it('does not treat example placeholders as configured', () => {
    const script = path.resolve(process.cwd(), 'scripts/check-live-prerequisites.cjs')
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
      GOOGLE_API_KEY: 'replace_with_google_gemini_api_key',
      OPENROUTER_API_KEY: 'replace_with_your_openrouter_api_key',
      OPENROUTER_MODEL: 'anthropic/claude-3.5-sonnet',
      AICA_LLM_DATA_POLICY_APPROVED: 'true'
      },
      encoding: 'utf8'
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('LLM: missing OPENROUTER_API_KEY + OPENROUTER_MODEL or GOOGLE_API_KEY')
  })

  it('requires an extension token when the WhatsApp Web transport is selected', () => {
    const script = path.resolve(process.cwd(), 'scripts/check-live-prerequisites.cjs')
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        WHATSAPP_TRANSPORT: 'web',
        OPENROUTER_API_KEY: 'replace_with_your_openrouter_api_key',
        OPENROUTER_MODEL: 'replace_with_model',
      },
      encoding: 'utf8'
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('WhatsApp Web bridge: missing AICA_EXTENSION_BRIDGE_TOKEN')
  })

  it('requires an HTTPS relay boundary when WhatsApp Cloud transport is selected', () => {
    const script = path.resolve(process.cwd(), 'scripts/check-live-prerequisites.cjs')
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        WHATSAPP_TRANSPORT: 'cloud',
        OPENROUTER_API_KEY: 'replace_with_your_openrouter_api_key',
        OPENROUTER_MODEL: 'replace_with_model',
        AICA_RELAY_BUSINESS_ID: 'business-1',
        AICA_RELAY_ORIGIN: 'http://public.example.test',
      },
      encoding: 'utf8'
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('WhatsApp Cloud relay: AICA_RELAY_ORIGIN must use HTTPS')
  })

  it('requires IMAP/SMTP fields for selected app-password email transport', () => {
    const script = path.resolve(process.cwd(), 'scripts/check-live-prerequisites.cjs')
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        AICA_EMAIL_PROVIDER: 'imap-smtp',
        OPENROUTER_API_KEY: 'replace_with_your_openrouter_api_key',
        OPENROUTER_MODEL: 'replace_with_model',
      },
      encoding: 'utf8'
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('Email IMAP/SMTP transport: missing address, imapHost, imapPort, smtpHost, smtpPort, password')
  })

  it('requires OAuth client configuration for selected Gmail OAuth transport', () => {
    const script = path.resolve(process.cwd(), 'scripts/check-live-prerequisites.cjs')
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        AICA_EMAIL_PROVIDER: 'gmail-api',
        AICA_EMAIL_AUTH_MODE: 'google-oauth',
        OPENROUTER_API_KEY: 'replace_with_your_openrouter_api_key',
        OPENROUTER_MODEL: 'replace_with_model',
      },
      encoding: 'utf8'
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('Gmail OAuth transport: missing GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET')
  })

  it('rejects an invalid configured agentd endpoint without exposing values', () => {
    const script = path.resolve(process.cwd(), 'scripts/check-live-prerequisites.cjs')
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        AICA_AGENTD_ORIGIN: 'javascript:secret-agentd-endpoint',
        OPENROUTER_API_KEY: 'replace_with_your_openrouter_api_key',
        OPENROUTER_MODEL: 'replace_with_model',
      },
      encoding: 'utf8'
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('agentd endpoint: invalid AICA_AGENTD_ORIGIN/AICA_AGENTD_ENDPOINT')
    expect(result.stdout).not.toContain('secret-agentd-endpoint')
  })

})
