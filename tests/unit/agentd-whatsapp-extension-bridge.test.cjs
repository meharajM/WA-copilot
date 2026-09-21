const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const test = require('node:test')
const { WhatsAppExtensionBridge, normalizeMessage } = require('../../agentd/whatsapp-extension-bridge.cjs')
const { AgentdServer } = require('../../agentd/server.cjs')
const { makeTempDir } = require('./temp-dir.cjs')

function request(port, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = http.request(`http://127.0.0.1:${port}${pathname}`, {
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }, response => {
      let text = ''
      response.on('data', chunk => { text += chunk })
      response.on('end', () => {
        let parsed = null
        try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
        resolve({ status: response.statusCode, body: parsed })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}

test('agentd extension message normalization rejects unbounded or empty payloads', () => {
  assert.deepEqual(normalizeMessage({ id: 'm1', from: 'chat-1', content: ' hello ', timestamp: 123 }), {
    id: 'm1', from: 'chat-1', to: '', content: 'hello', timestamp: 123,
  })
  assert.equal(normalizeMessage({ id: '', from: 'chat-1', content: 'hello' }), null)
  assert.equal(normalizeMessage({ id: 'm1', from: 'chat-1', content: 'x'.repeat(100_001) }), null)
})

test('agentd extension bridge requires the configured token and bounds requests', async () => {
  const token = 'extension-token-1234'
  const bridge = new WhatsAppExtensionBridge({ token, port: 19_000 + Math.floor(Math.random() * 500), allowMessage: () => true })
  try {
    assert.equal((await bridge.start()).status, 'connected')
    assert.equal((await request(bridge.getState().port, 'GET', '/health', undefined, 'wrong-token')).status, 401)
    assert.equal((await request(bridge.getState().port, 'POST', '/messages', { id: 'm1', from: 'chat', content: 'hello' }, token)).status, 202)
    assert.equal((await request(bridge.getState().port, 'POST', '/messages', { id: 'm2', from: 'chat', content: '' }, token)).status, 400)
  } finally {
    await bridge.stop()
  }
})

test('agentd extension bridge queues outbound text only for the configured chat and settles an acknowledgement', async () => {
  const token = 'extension-token-outbound'
  const bridge = new WhatsAppExtensionBridge({ token, port: 19_500 + Math.floor(Math.random() * 400), allowOutbound: () => true })
  try {
    assert.equal((await bridge.start()).status, 'connected')
    const pending = bridge.enqueueOutbound({ to: 'chat-1', text: 'hello from AICA' })
    const port = bridge.getState().port
    assert.deepEqual((await request(port, 'GET', '/outbound?chatId=other', undefined, token)).body, { command: null })
    const command = (await request(port, 'GET', '/outbound?chatId=chat-1', undefined, token)).body.command
    assert.match(command.id, /^web-send:/)
    assert.deepEqual(command, { id: command.id, to: 'chat-1', text: 'hello from AICA', createdAt: command.createdAt })
    const result = await request(port, 'POST', '/outbound/result', { id: command.id, success: true, providerMessageId: `web:${command.id}` }, token)
    assert.deepEqual(result.body, { accepted: true, id: command.id })
    assert.deepEqual(await pending, { providerMessageId: `web:${command.id}` })
    assert.equal(bridge.getState().outboundPending, 0)
    assert.equal((await request(port, 'POST', '/outbound/result', { id: command.id, success: true }, token)).status, 409)
  } finally {
    await bridge.stop()
  }
})

test('agentd extension bridge queues bounded outbound media commands', async () => {
  const token = 'extension-token-media'
  const bridge = new WhatsAppExtensionBridge({ token, port: 19_900 + Math.floor(Math.random() * 400), allowOutbound: () => true })
  try {
    assert.equal((await bridge.start()).status, 'connected')
    const pending = bridge.enqueueOutbound({
      kind: 'media',
      to: 'chat-1',
      media: { type: 'image', fileName: 'photo.png', mimeType: 'image/png', size: 5, dataBase64: 'aGVsbG8=', caption: 'photo' },
    })
    const port = bridge.getState().port
    const command = (await request(port, 'GET', '/outbound?chatId=chat-1', undefined, token)).body.command
    assert.deepEqual(command, {
      id: command.id,
      to: 'chat-1',
      kind: 'media',
      media: { type: 'image', fileName: 'photo.png', mimeType: 'image/png', size: 5, dataBase64: 'aGVsbG8=', caption: 'photo' },
      createdAt: command.createdAt,
    })
    const result = await request(port, 'POST', '/outbound/result', { id: command.id, success: true }, token)
    assert.deepEqual(result.body, { accepted: true, id: command.id })
    assert.deepEqual(await pending, { providerMessageId: `web:${command.id}` })
  } finally {
    await bridge.stop()
  }
})

test('agentd owns browser WhatsApp Web ingress only when Web transport and channel are enabled', async () => {
  const dataDir = makeTempDir('aica-agentd-whatsapp-extension-')
  const token = 'extension-token-5678'
  const port = 20_000 + Math.floor(Math.random() * 500)
  const previousToken = process.env.AICA_EXTENSION_BRIDGE_TOKEN
  const previousPort = process.env.AICA_EXTENSION_BRIDGE_PORT
  process.env.AICA_EXTENSION_BRIDGE_TOKEN = token
  process.env.AICA_EXTENSION_BRIDGE_PORT = String(port)
  const fakeService = {
    configureStateAccessors() {},
    async initialize() {},
    async disconnect() {},
    getState: () => ({ status: 'disconnected', qrCode: null, error: null, phoneNumber: null, workerNumber: null, handshakeStatus: 'idle' }),
  }
  const server = new AgentdServer({ dataDir, secret: 'x'.repeat(32), whatsappService: fakeService, logger: { log() {}, warn() {} } })
  const api = (method, pathname, body) => request(Number(new URL(server.origin).port), method, pathname, body, 'x'.repeat(32))
  try {
    await server.start()
    const settings = { whatsapp_transport: 'web', whatsapp_cloud_phone_number_id: '', whatsapp_cloud_api_version: 'v23.0' }
    assert.equal((await api('PUT', '/api/v1/settings/whatsapp', settings)).status, 200)
    assert.equal((await api('PUT', '/api/v1/settings/whatsapp-ui', { whatsappEnabled: true, businessBotMode: false, targetPhoneNumber: null })).status, 200)
    const accepted = await request(port, 'POST', '/messages', { message: { id: 'dom-1', from: 'chat-1', content: 'Hello from Web' } }, token)
    assert.deepEqual(accepted.body, { accepted: true, id: 'dom-1' })
    const inbound = await api('GET', '/api/v1/whatsapp/inbound?after_id=0&limit=10')
    assert.equal(inbound.body.events[0].providerEventId, 'web:dom-1')
    assert.equal(inbound.body.events[0].payload.body, 'Hello from Web')

    await api('PUT', '/api/v1/settings/whatsapp', { ...settings, whatsapp_transport: 'baileys' })
    const rejected = await request(port, 'POST', '/messages', { message: { id: 'dom-2', from: 'chat-1', content: 'blocked' } }, token)
    assert.equal(rejected.status, 403)
  } finally {
    await server.stop()
    if (previousToken === undefined) delete process.env.AICA_EXTENSION_BRIDGE_TOKEN
    else process.env.AICA_EXTENSION_BRIDGE_TOKEN = previousToken
    if (previousPort === undefined) delete process.env.AICA_EXTENSION_BRIDGE_PORT
    else process.env.AICA_EXTENSION_BRIDGE_PORT = previousPort
  }
})

test('agentd routes explicitly enabled Web text sends through the authenticated extension bridge', async () => {
  const dataDir = makeTempDir('aica-agentd-whatsapp-extension-outbound-')
  const calls = []
  const extensionBridge = {
    async start() { return { status: 'connected', port: 8790, lastStatus: null, error: null, outboundPending: 0 } },
    async stop() {},
    getState() { return { status: 'connected', port: 8790, lastStatus: 'connected', error: null, outboundPending: 0 } },
    async enqueueOutbound(message) { calls.push(message); return { providerMessageId: 'web-send:fixture' } },
  }
  const fakeService = {
    configureStateAccessors() {},
    async initialize() {},
    async disconnect() {},
    getState: () => ({ status: 'disconnected', qrCode: null, error: null, phoneNumber: null, workerNumber: null, handshakeStatus: 'idle' }),
  }
  const server = new AgentdServer({ dataDir, secret: 'z'.repeat(32), whatsappService: fakeService, whatsappExtensionBridge: extensionBridge, logger: { log() {}, warn() {} } })
  const { origin } = await server.start()
  const port = Number(new URL(origin).port)
  const auth = 'z'.repeat(32)
  try {
    const api = (method, pathname, body) => request(port, method, pathname, body, auth)
    assert.equal((await api('PUT', '/api/v1/settings/whatsapp', { whatsapp_transport: 'web', whatsapp_cloud_phone_number_id: '', whatsapp_cloud_api_version: 'v23.0' })).status, 200)
    assert.equal((await api('PUT', '/api/v1/settings/whatsapp-ui', { whatsappEnabled: true, businessBotMode: false, targetPhoneNumber: null })).status, 200)
    const sent = await api('POST', '/api/v1/whatsapp/messages', { to: 'chat-1', text: 'hello from browser' })
    assert.deepEqual(sent.body, { success: true, providerMessageId: 'web-send:fixture' })
    assert.deepEqual(calls, [{ to: 'chat-1', text: 'hello from browser' }])
    assert.equal((await api('PUT', '/api/v1/settings/whatsapp-ui', { whatsappEnabled: false, businessBotMode: false, targetPhoneNumber: null })).status, 200)
    assert.equal((await api('POST', '/api/v1/whatsapp/messages', { to: 'chat-1', text: 'blocked' })).status, 409)
  } finally {
    await server.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('agentd routes explicitly enabled Web media sends through the authenticated extension bridge', async () => {
  const dataDir = makeTempDir('aica-agentd-whatsapp-extension-media-')
  const calls = []
  const extensionBridge = {
    async start() { return { status: 'connected', port: 8790, lastStatus: null, error: null, outboundPending: 0 } },
    async stop() {},
    getState() { return { status: 'connected', port: 8790, lastStatus: 'connected', error: null, outboundPending: 0 } },
    async enqueueOutbound(message) { calls.push(message); return { providerMessageId: 'web-media:fixture' } },
  }
  const fakeService = {
    configureStateAccessors() {},
    async initialize() {},
    async disconnect() {},
    getState: () => ({ status: 'disconnected', qrCode: null, error: null, phoneNumber: null, workerNumber: null, handshakeStatus: 'idle' }),
  }
  const server = new AgentdServer({ dataDir, secret: 'm'.repeat(32), whatsappService: fakeService, whatsappExtensionBridge: extensionBridge, logger: { log() {}, warn() {} } })
  const { origin } = await server.start()
  const port = Number(new URL(origin).port)
  const auth = 'm'.repeat(32)
  try {
    const api = (method, pathname, body) => request(port, method, pathname, body, auth)
    const settings = { whatsapp_transport: 'web', whatsapp_cloud_phone_number_id: '', whatsapp_cloud_api_version: 'v23.0' }
    assert.equal((await api('PUT', '/api/v1/settings/whatsapp', settings)).status, 200)
    assert.equal((await api('PUT', '/api/v1/settings/whatsapp-ui', { whatsappEnabled: true, businessBotMode: false, targetPhoneNumber: null })).status, 200)
    const sent = await api('POST', '/api/v1/whatsapp/media', {
      to: 'chat-1', type: 'image', fileName: 'photo.png', mimeType: 'image/png', size: 5, dataBase64: 'aGVsbG8=', caption: 'photo',
    })
    assert.deepEqual(sent.body, { success: true, providerMessageId: 'web-media:fixture' })
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], {
      kind: 'media',
      to: 'chat-1',
      media: { type: 'image', fileName: 'photo.png', mimeType: 'image/png', size: 5, dataBase64: 'aGVsbG8=', caption: 'photo' },
    })
  } finally {
    await server.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
