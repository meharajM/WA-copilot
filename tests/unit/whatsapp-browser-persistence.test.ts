import { afterEach, describe, expect, it, vi } from 'vitest'

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

describe('browser WhatsApp persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    window.localStorage.clear()
    delete (window as Window & { __AICA_AGENTD_CSRF_TOKEN__?: string }).__AICA_AGENTD_CSRF_TOKEN__
  })

  it('migrates legacy UI state once, preserves autonomous mode, and writes only to agentd', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    window.localStorage.setItem('aica-whatsapp-v1', JSON.stringify({
      state: { whatsappEnabled: true, businessBotMode: true, targetPhoneNumber: '+1 (415) 555-0199' },
      version: 0,
    }))
    ;(window as Window & { __AICA_AGENTD_CSRF_TOKEN__?: string }).__AICA_AGENTD_CSRF_TOKEN__ = 'csrf-token'
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith('/api/v1/settings/whatsapp-ui')) {
        if (init?.method === 'PUT') return jsonResponse(JSON.parse(String(init.body)))
        return jsonResponse({ whatsappEnabled: false, businessBotMode: false, targetPhoneNumber: null })
      }
      return jsonResponse({ success: true })
    }))

    const { useWhatsAppStore } = await import('../../src/renderer/src/stores/whatsappStore')
    await useWhatsAppStore.persist.rehydrate()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(useWhatsAppStore.getState()).toMatchObject({
      whatsappEnabled: true,
      targetPhoneNumber: '+1 (415) 555-0199',
      businessBotMode: true,
    })
    expect(window.localStorage.getItem('aica-whatsapp-v1')).toBeNull()
    const migration = calls.find(call => call.init?.method === 'PUT')
    expect(migration).toBeDefined()
    expect(JSON.parse(String(migration?.init?.body))).toEqual({ whatsappEnabled: true, businessBotMode: true, targetPhoneNumber: '+1 (415) 555-0199' })
    expect(new Headers(migration?.init?.headers).get('x-csrf-token')).toBe('csrf-token')

    useWhatsAppStore.getState().setWhatsAppEnabled(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    const writes = calls.filter(call => call.init?.method === 'PUT')
    expect(JSON.parse(String(writes.at(-1)?.init?.body))).toEqual({ whatsappEnabled: false, businessBotMode: true, targetPhoneNumber: '+1 (415) 555-0199' })
    expect(JSON.stringify(writes)).toContain('businessBotMode')
  })

  it('does not crash on a null legacy payload and clears it after paired hydration', async () => {
    window.localStorage.setItem('aica-whatsapp-v1', 'null')
    ;(window as Window & { __AICA_AGENTD_CSRF_TOKEN__?: string }).__AICA_AGENTD_CSRF_TOKEN__ = 'csrf-token'
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ whatsappEnabled: false, businessBotMode: false, targetPhoneNumber: null })))

    const { useWhatsAppStore } = await import('../../src/renderer/src/stores/whatsappStore')
    await useWhatsAppStore.persist.rehydrate()

    expect(useWhatsAppStore.getState()).toMatchObject({ whatsappEnabled: false, targetPhoneNumber: null, businessBotMode: false })
    expect(window.localStorage.getItem('aica-whatsapp-v1')).toBeNull()
  })
})
