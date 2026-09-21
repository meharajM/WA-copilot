const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { SpeechModelStore } = require('../../agentd/speech-model.cjs')

const bytes = Buffer.from('speech-model-fixture')
const digest = crypto.createHash('sha256').update(bytes).digest('hex')
const catalog = { fixture: { id: 'fixture', name: 'Fixture', modelName: 'fixture', locale: 'en-US', url: 'https://alphacephei.com/vosk/models/fixture.zip', sha256: digest } }

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Map([['content-length', String(body.length)]]), arrayBuffer: async () => body }
}

test('speech model store downloads approved model, verifies digest and reuses cache', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aica-speech-'))
  let calls = 0
  try {
    const store = new SpeechModelStore(dataDir, { catalog, fetchImpl: async () => { calls += 1; return response(bytes) } })
    assert.deepEqual(store.status('fixture'), { modelId: 'fixture', supported: true, modelDownloaded: false, locale: 'en-US', name: 'Fixture' })
    const first = await store.ensure('fixture')
    assert.equal(first.size, bytes.length)
    assert.equal(calls, 1)
    assert.equal(store.status('fixture').modelDownloaded, true)
    await store.ensure('fixture')
    assert.equal(calls, 1)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('speech model store rejects bad integrity and unapproved URLs', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aica-speech-'))
  try {
    const store = new SpeechModelStore(dataDir, { catalog: { bad: { ...catalog.fixture, id: 'bad', url: 'http://evil.test/model.zip' } }, fetchImpl: async () => response(bytes) })
    await assert.rejects(() => store.ensure('bad'), /not approved/)
    assert.equal(store.status('missing').supported, false)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
