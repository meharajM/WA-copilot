import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
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

  it('probes the configured Cloud relay health route before declaring readiness', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      response.writeHead(request.url === '/healthz' ? 200 : 404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Unable to allocate test port')
    try {
      const script = path.resolve(process.cwd(), 'scripts/check-live-prerequisites.cjs')
      const result = await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          env: {
            PATH: process.env.PATH,
            WHATSAPP_TRANSPORT: 'cloud',
            AICA_RELAY_ORIGIN: `http://127.0.0.1:${address.port}`,
            AICA_RELAY_BUSINESS_ID: 'business-1',
            AICA_RELAY_ALLOW_INSECURE_LOCALHOST: 'true',
            OPENROUTER_API_KEY: 'replace_with_your_openrouter_api_key',
            OPENROUTER_MODEL: 'replace_with_model',
          },
        })
        let stdout = ''
        child.stdout.on('data', chunk => { stdout += String(chunk) })
        child.once('error', reject)
        child.once('close', status => resolve({ status, stdout }))
      })
      expect(result.status).not.toBe(0)
      expect(requests).toEqual(['GET /healthz'])
      expect(result.stdout).toContain('WhatsApp Cloud relay: configured for business-1')
      expect(result.stdout).toContain('WhatsApp Cloud relay: ready')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('fails closed when the configured Cloud relay health route is unreachable', async () => {
    const server = createServer()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Unable to allocate test port')
    await new Promise<void>(resolve => server.close(() => resolve()))
    const script = path.resolve(process.cwd(), 'scripts/check-live-prerequisites.cjs')
    const result = spawnSync(process.execPath, [script], {
      env: {
        PATH: process.env.PATH,
        WHATSAPP_TRANSPORT: 'cloud',
        AICA_RELAY_ORIGIN: `http://127.0.0.1:${address.port}`,
        AICA_RELAY_BUSINESS_ID: 'business-1',
        AICA_RELAY_ALLOW_INSECURE_LOCALHOST: 'true',
        OPENROUTER_API_KEY: 'replace_with_your_openrouter_api_key',
        OPENROUTER_MODEL: 'replace_with_model',
      },
      encoding: 'utf8'
    })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toContain('WhatsApp Cloud relay: health check failed or endpoint unreachable')
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

  it('probes the Web extension health route without printing its bearer token', async () => {
    const requests: string[] = []
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      expect(request.headers.authorization).toBe(`Bearer ${'w'.repeat(32)}`)
      response.writeHead(request.url === '/health' ? 200 : 404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'connected' }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Unable to allocate test port')
    try {
      const script = path.resolve(process.cwd(), 'scripts/check-live-prerequisites.cjs')
      const result = await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [script], {
          env: {
            PATH: process.env.PATH,
            WHATSAPP_TRANSPORT: 'web',
            AICA_EXTENSION_BRIDGE_TOKEN: 'w'.repeat(32),
            AICA_EXTENSION_BRIDGE_HEALTH_URL: `http://127.0.0.1:${address.port}`,
            OPENROUTER_API_KEY: 'replace_with_your_openrouter_api_key',
            OPENROUTER_MODEL: 'replace_with_model',
          },
        })
        let stdout = ''
        child.stdout.on('data', chunk => { stdout += String(chunk) })
        child.once('error', reject)
        child.once('close', status => resolve({ status, stdout }))
      })
      expect(result.status).not.toBe(0)
      expect(requests).toEqual(['GET /health'])
      expect(result.stdout).toContain('WhatsApp Web session probe: ready')
      expect(result.stdout).not.toContain('w'.repeat(32))
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

})
