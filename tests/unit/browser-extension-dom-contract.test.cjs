const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const test = require('node:test')

const source = fs.readFileSync(path.resolve(__dirname, '../../browser-extension/content.js'), 'utf8')

function loadContentScript({ chatLabel = '+1 (555) 010-0200', composerAvailable = true, mediaInputAvailable = false, clearOnEnter = true } = {}) {
  const events = []
  const input = {
    innerText: '',
    textContent: '',
    focus() {},
    dispatchEvent(event) {
      events.push(event)
      if (event.key === 'Enter' && clearOnEnter) {
        this.innerText = ''
        this.textContent = ''
      }
      return true
    },
  }
  const mediaInput = {
    files: [],
    offsetParent: {},
    dispatchEvent(event) {
      events.push(event)
      return true
    },
  }
  const header = {
    textContent: chatLabel,
    getAttribute(name) { return name === 'title' ? chatLabel : null },
  }
  const document = {
    body: {},
    visibilityState: 'visible',
    querySelector(selector) {
      if (selector === '[data-testid="conversation-info-header-chat-title"]') return header
      if (selector.includes('contenteditable')) return composerAvailable ? input : null
      return null
    },
    querySelectorAll(selector) {
      if (selector === 'header [title]') return [header]
      if (selector === 'input[type="file"]') return mediaInputAvailable ? [mediaInput] : []
      return []
    },
    execCommand(command, _showUi, text) {
      if (command !== 'insertText') return false
      input.innerText = text
      input.textContent = text
      return true
    },
  }
  const chrome = {
    runtime: {
      sendMessage(message, callback) {
        if (typeof callback === 'function') callback({ command: null })
        events.push({ type: 'runtime', message })
      },
    },
  }
  const context = vm.createContext({
    chrome,
    console,
    document,
    InputEvent: class InputEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init) } },
    KeyboardEvent: class KeyboardEvent { constructor(type, init = {}) { this.type = type; Object.assign(this, init) } },
    Event: class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init) } },
    File: class File { constructor(parts, name, options = {}) { this.parts = parts; this.name = name; this.type = options.type || '' } },
    DataTransfer: class DataTransfer {
      constructor() {
        this.files = []
        this.items = { add: file => { this.files.push(file) } }
      }
    },
    atob(value) { return Buffer.from(value, 'base64').toString('binary') },
    MutationObserver: class MutationObserver { observe() {} disconnect() {} },
    setInterval() { return 1 },
    clearInterval() {},
    setTimeout(callback) { callback(); return 1 },
    clearTimeout() {},
    Promise,
  })
  vm.runInContext(source, context, { filename: 'browser-extension/content.js' })
  return { context, input, events }
}

async function send(context, command) {
  return vm.runInContext(`sendOutbound(${JSON.stringify(command)})`, context)
}

function assertResult(result, expected) {
  assert.equal(result.success, expected.success)
  if (expected.providerMessageId !== undefined) {
    assert.equal(result.providerMessageId, expected.providerMessageId)
  }
  if (expected.error !== undefined) {
    assert.equal(result.error, expected.error)
  }
}

test('WhatsApp Web content script sends only when the visible chat matches', async () => {
  const { context, input } = loadContentScript()
  const result = await send(context, { id: 'web-send:1', to: '+15550100200', text: 'hello' })
  assertResult(result, { success: true, providerMessageId: 'web:web-send:1' })
  assert.equal(input.textContent, '')
})

test('WhatsApp Web content script refuses a different active chat before touching the composer', async () => {
  const { context, input } = loadContentScript({ chatLabel: '+1 (555) 010-0300' })
  const result = await send(context, { id: 'web-send:2', to: '+15550100200', text: 'must not send' })
  assertResult(result, { success: false, error: 'active_chat_mismatch' })
  assert.equal(input.textContent, '')
})

test('WhatsApp Web content script reports an unavailable composer', async () => {
  const { context } = loadContentScript({ composerAvailable: false })
  const result = await send(context, { id: 'web-send:3', to: '+15550100200', text: 'no composer' })
  assertResult(result, { success: false, error: 'message_composer_unavailable' })
})

test('WhatsApp Web content script does not acknowledge when the composer stays populated', async () => {
  const { context, input } = loadContentScript({ clearOnEnter: false })
  const result = await send(context, { id: 'web-send:4', to: '+15550100200', text: 'not acknowledged' })
  assertResult(result, { success: false, error: 'message_composer_did_not_clear' })
  assert.equal(input.textContent, 'not acknowledged')
})

test('WhatsApp Web content script attaches bounded media through the visible file input', async () => {
  const { context, events } = loadContentScript({ mediaInputAvailable: true })
  const result = await send(context, {
    id: 'web-media:1',
    kind: 'media',
    to: '+15550100200',
    media: {
      type: 'image',
      fileName: 'photo.png',
      mimeType: 'image/png',
      size: 5,
      dataBase64: 'aGVsbG8=',
    },
  })
  assertResult(result, { success: true, providerMessageId: 'web:web-media:1' })
  assert.ok(events.some(event => event.type === 'change'))
})
