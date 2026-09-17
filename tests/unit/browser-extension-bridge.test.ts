import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { allowsBrowserExtensionMessage, BrowserExtensionBridge, normalizeExtensionMessage } from '../../src/main/services/BrowserExtensionBridge'

const originalToken = process.env.AICA_EXTENSION_BRIDGE_TOKEN
const originalPort = process.env.AICA_EXTENSION_BRIDGE_PORT
const originalTransport = process.env.WHATSAPP_TRANSPORT
const bridges: BrowserExtensionBridge[] = []

afterEach(async () => {
  for (const bridge of bridges.splice(0)) await bridge.stop()
  if (originalToken === undefined) delete process.env.AICA_EXTENSION_BRIDGE_TOKEN
  else process.env.AICA_EXTENSION_BRIDGE_TOKEN = originalToken
  if (originalPort === undefined) delete process.env.AICA_EXTENSION_BRIDGE_PORT
  else process.env.AICA_EXTENSION_BRIDGE_PORT = originalPort
  if (originalTransport === undefined) delete process.env.WHATSAPP_TRANSPORT
  else process.env.WHATSAPP_TRANSPORT = originalTransport
})

function request(port: number, token: string, path: string, body?: unknown, declaredLength?: number): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request({ hostname: '127.0.0.1', port, path, method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': declaredLength ?? Buffer.byteLength(payload) } : {}) } }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }))
    })
    req.on('error', reject)
    if (payload) req.end(payload)
    else req.end()
  })
}

describe('BrowserExtensionBridge', () => {
  it('fails closed when no token is configured and rejects unauthorized requests', async () => {
    delete process.env.AICA_EXTENSION_BRIDGE_TOKEN
    const onMessage = vi.fn()
    const bridge = new BrowserExtensionBridge(onMessage)
    bridges.push(bridge)
    expect((await bridge.start()).status).toBe('disabled')

    process.env.AICA_EXTENSION_BRIDGE_TOKEN = 'bridge-secret-1234'
    process.env.WHATSAPP_TRANSPORT = 'web'
    process.env.AICA_EXTENSION_BRIDGE_PORT = String(18_000 + Math.floor(Math.random() * 1_000))
    const running = new BrowserExtensionBridge(onMessage, () => true)
    bridges.push(running)
    expect((await running.start()).status).toBe('connected')
    const response = await request(Number(process.env.AICA_EXTENSION_BRIDGE_PORT), 'wrong', '/health')
    expect(response).toEqual({ status: 401, json: { error: 'unauthorized' } })
  })

  it('forwards only bounded authenticated text messages and reports status', async () => {
    process.env.AICA_EXTENSION_BRIDGE_TOKEN = 'bridge-secret-1234'
    process.env.WHATSAPP_TRANSPORT = 'web'
    process.env.AICA_EXTENSION_BRIDGE_PORT = String(18_000 + Math.floor(Math.random() * 1_000))
    const onMessage = vi.fn()
    const bridge = new BrowserExtensionBridge(onMessage, () => true)
    bridges.push(bridge)
    await bridge.start()
    const port = Number(process.env.AICA_EXTENSION_BRIDGE_PORT)
    expect(await request(port, 'bridge-secret-1234', '/status', { status: 'connected' })).toMatchObject({ status: 200, json: { ok: true } })
    expect(await request(port, 'bridge-secret-1234', '/messages', { message: { id: 'ext-1', from: 'customer-1', content: 'Hello', timestamp: Date.now() } })).toMatchObject({ status: 202, json: { accepted: true, id: 'ext-1' } })
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'ext-1', from: 'customer-1', content: 'Hello', isFromMe: false }))
    expect((await request(port, 'bridge-secret-1234', '/health')).json).toMatchObject({ status: 'connected', lastStatus: 'connected' })
  })

  it('rejects a declared oversized body before parsing it', async () => {
    process.env.AICA_EXTENSION_BRIDGE_TOKEN = 'bridge-secret-1234'
    process.env.AICA_EXTENSION_BRIDGE_PORT = String(18_000 + Math.floor(Math.random() * 1_000))
    const bridge = new BrowserExtensionBridge(vi.fn())
    bridges.push(bridge)
    await bridge.start()
    const response = await request(Number(process.env.AICA_EXTENSION_BRIDGE_PORT), 'bridge-secret-1234', '/messages', { message: { id: 'oversized', from: 'customer', content: 'x' } }, 256 * 1024 + 1)
    expect(response).toEqual({ status: 413, json: { error: 'body_too_large_or_invalid' } })
  })

  it('rejects a weak configured token without opening a listener', async () => {
    process.env.AICA_EXTENSION_BRIDGE_TOKEN = 'short'
    const bridge = new BrowserExtensionBridge(vi.fn())
    bridges.push(bridge)
    expect((await bridge.start()).status).toBe('error')
    expect(bridge.getState().error).toContain('at least 16 characters')
  })

  it('rejects malformed extension messages before forwarding', () => {
    expect(normalizeExtensionMessage({ id: 'x', from: 'y', content: ' ' })).toBeNull()
    expect(normalizeExtensionMessage({ id: 'x', from: 'y', content: 'ok', timestamp: 0 })).toBeNull()
    expect(normalizeExtensionMessage({ id: 'x', from: 'y', content: 'ok', timestamp: Date.now() })).toMatchObject({ type: 'text', isFromMe: false })
  })

  it('fails closed when extension transport is not explicitly selected', async () => {
    process.env.AICA_EXTENSION_BRIDGE_TOKEN = 'bridge-secret-1234'
    delete process.env.WHATSAPP_TRANSPORT
    process.env.AICA_EXTENSION_BRIDGE_PORT = String(18_000 + Math.floor(Math.random() * 1_000))
    const onMessage = vi.fn()
    const bridge = new BrowserExtensionBridge(onMessage, () => false)
    bridges.push(bridge)
    await bridge.start()
    const response = await request(Number(process.env.AICA_EXTENSION_BRIDGE_PORT), 'bridge-secret-1234', '/messages', { message: { id: 'disabled', from: 'customer-1', content: 'Hello', timestamp: Date.now() } })
    expect(response).toEqual({ status: 403, json: { accepted: false, error: 'extension_transport_not_enabled' } })
    expect(onMessage).not.toHaveBeenCalled()
  })

  it('requires a known WhatsApp identity and rejects owner/foreign recipients', () => {
    const message = normalizeExtensionMessage({ id: 'm', from: '15550000001', content: 'Hello', timestamp: Date.now() })!
    expect(allowsBrowserExtensionMessage(message, { selectedTransport: 'baileys', phoneNumber: '15550000002' })).toBe(false)
    expect(allowsBrowserExtensionMessage(message, { selectedTransport: 'web' })).toBe(false)
    expect(allowsBrowserExtensionMessage(message, { selectedTransport: 'web', phoneNumber: '15550000001' })).toBe(false)
    expect(allowsBrowserExtensionMessage({ ...message, from: '15550000003', to: '15550000002' }, { selectedTransport: 'web', phoneNumber: '15550000001' })).toBe(false)
    expect(allowsBrowserExtensionMessage({ ...message, from: '15550000003', to: '15550000001' }, { selectedTransport: 'web', phoneNumber: '15550000001' })).toBe(true)
  })
})
