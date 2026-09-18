const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { WhatsAppBaileysService } = require('../../agentd/whatsapp-baileys.cjs')
const { AgentdServer } = require('../../agentd/server.cjs')
const { makeTempDir } = require('./temp-dir.cjs')

function fakeBaileys() {
  let socket
  const module = {
    default: options => {
      socket = new EventEmitter()
      socket.ev = new EventEmitter()
      socket.user = { id: '919999999999:0@s.whatsapp.net' }
      socket.sendMessage = async (jid, payload) => ({ key: { id: `sent-${jid}-${payload.text}` } })
      socket.end = () => {}
      socket.logout = async () => {}
      module.socket = socket
      module.options = options
      return socket
    },
    useMultiFileAuthState: async authDir => {
      fs.mkdirSync(authDir, { recursive: true })
      return { state: { creds: {} }, saveCreds: async () => {} }
    },
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1] }),
    DisconnectReason: { loggedOut: 401 },
    socket: null,
    options: null,
  }
  return module
}

test('agentd Baileys worker exposes bounded QR/state, text inbound, dedupe, and send behavior', async () => {
  const dataDir = makeTempDir('aica-agentd-whatsapp-baileys-')
  const baileys = fakeBaileys()
  const inbound = []
  const state = new Map()
  const service = new WhatsAppBaileysService({
    dataDir,
    loadBaileys: async () => baileys,
    onMessage: async message => inbound.push(message),
    logger: { warn() {}, error() {} },
  })
  service.configureStateAccessors({ get: key => state.get(key) ?? null, set: (key, value) => value === null ? state.delete(key) : state.set(key, value) })
  await service.connect()
  baileys.socket.ev.emit('connection.update', { qr: 'qr-value' })
  assert.equal(service.getState().status, 'qr_required')
  assert.equal(service.getState().qrCode, 'qr-value')
  baileys.socket.ev.emit('connection.update', { connection: 'open' })
  assert.equal(service.getState().status, 'connected')
  assert.equal(service.getState().workerNumber, '919999999999')
  const sent = await service.sendText('+919888888888', 'Hello')
  assert.match(sent.providerMessageId, /^sent-919888888888@s\.whatsapp\.net-Hello$/)
  baileys.socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { id: 'message-1', remoteJid: '919888888888@s.whatsapp.net', fromMe: false }, messageTimestamp: 1720000000, message: { conversation: 'Need help' } }],
  })
  await new Promise(resolve => setImmediate(resolve))
  baileys.socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { id: 'message-1', remoteJid: '919888888888@s.whatsapp.net', fromMe: false }, message: { conversation: 'Need help' } }],
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(inbound.length, 1)
  assert.equal(inbound[0].content, 'Need help')
  assert.equal(inbound[0].conversationId, '919888888888@s.whatsapp.net')
  baileys.socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { id: 'image-1', remoteJid: '919888888888@s.whatsapp.net', fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg' } } }],
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(inbound.length, 1)
  baileys.socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { id: 'image-2', remoteJid: '919888888888@s.whatsapp.net', fromMe: false }, message: { imageMessage: { caption: 'See this' } } }],
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(inbound.length, 2)
  assert.equal(inbound[1].content, 'See this')
  assert.equal(inbound[1].type, 'image')
  service.pendingHandshake = { phoneNumber: '919888888888', code: '123456', expires: Date.now() - 1 }
  baileys.socket.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [{ key: { id: 'message-2', remoteJid: '919888888888@s.whatsapp.net', fromMe: false }, message: { conversation: 'Still here' } }],
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(service.getState().handshakeStatus, 'expired')
  assert.equal(inbound.length, 3)
  await service.disconnect(true)
  assert.equal(service.getState().status, 'disconnected')
  assert.equal(fs.existsSync(path.join(dataDir, 'whatsapp-auth')), false)
  fs.rmSync(dataDir, { recursive: true, force: true })
})

test('agentd browser WhatsApp routes use the daemon Baileys worker for connection and text send', async () => {
  const dataDir = makeTempDir('aica-agentd-whatsapp-routes-')
  const calls = []
  const fakeService = {
    configureStateAccessors() {},
    async initialize() {},
    getState: () => ({ status: 'connected', qrCode: null, error: null, phoneNumber: null, workerNumber: '919999999999', handshakeStatus: 'idle' }),
    async connect(value) { calls.push(['connect', value]); return this.getState() },
    async disconnect(value) { calls.push(['disconnect', value]); return this.getState() },
    async setTargetPhoneNumber(value) { calls.push(['target', value]); return { success: true, handshakeCode: '123456' } },
    async sendText(to, text) { calls.push(['send', to, text]); return { providerMessageId: 'baileys-message-1' } },
  }
  const server = new AgentdServer({ dataDir, secret: 'w'.repeat(32), whatsappService: fakeService, logger: { log() {} } })
  const request = (origin, method, pathname, body, headers = {}) => new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = require('node:http').request(`${origin}${pathname}`, { method, headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }))
    })
    req.on('error', reject)
    req.end(payload)
  })
  try {
    const { origin } = await server.start()
    const auth = { authorization: `Bearer ${'w'.repeat(32)}` }
    assert.equal((await request(origin, 'GET', '/api/v1/whatsapp/connection', undefined, auth)).body.status, 'connected')
    assert.equal((await request(origin, 'POST', '/api/v1/whatsapp/connect', {}, auth)).status, 200)
    assert.equal((await request(origin, 'POST', '/api/v1/whatsapp/target', { phoneNumber: '+919888888888' }, auth)).body.handshakeCode, '123456')
    const settings = { whatsapp_transport: 'baileys', whatsapp_cloud_phone_number_id: '', whatsapp_cloud_api_version: 'v23.0' }
    assert.equal((await request(origin, 'PUT', '/api/v1/settings/whatsapp', settings, auth)).status, 200)
    const sent = await request(origin, 'POST', '/api/v1/whatsapp/messages', { to: '+919888888888', text: 'Hello' }, auth)
    assert.deepEqual(sent.body, { success: true, providerMessageId: 'baileys-message-1' })
    server.ingestWhatsAppServiceMessage({
      providerEventId: 'baileys:inbound-1',
      conversationId: '919888888888@s.whatsapp.net',
      from: '919888888888',
      to: '919999999999',
      content: 'Inbound text',
      type: 'text',
      timestamp: Date.now(),
      isFromMe: false,
    })
    const inbound = await request(origin, 'GET', '/api/v1/whatsapp/inbound?after_id=0&limit=10', undefined, auth)
    assert.equal(inbound.status, 200)
    assert.equal(inbound.body.events[0].providerEventId, 'baileys:inbound-1')
    assert.equal(inbound.body.events[0].payload.body, 'Inbound text')
    server.ingestWhatsAppServiceMessage({ providerEventId: 'unsafe\nprovider', conversationId: 'chat', content: 'ignored' })
    const afterInvalid = await request(origin, 'GET', '/api/v1/whatsapp/inbound?after_id=0&limit=10', undefined, auth)
    assert.equal(afterInvalid.body.events.length, 1)
    assert.deepEqual(calls, [['connect', undefined], ['target', '+919888888888'], ['send', '+919888888888', 'Hello']])
  } finally {
    await server.stop()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
