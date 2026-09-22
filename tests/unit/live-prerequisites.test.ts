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
})
