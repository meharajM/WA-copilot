const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')
const helper = process.env.AICA_AGENTD_KEYRING_HELPER || path.join(root, 'src-tauri', 'sidecar', 'aica-keyring-helper.exe')

function invoke(operation, key, input) {
  return spawnSync(helper, [operation, key], {
    input,
    encoding: null,
    windowsHide: true,
    maxBuffer: 128 * 1024,
  })
}

test('packaged helper round-trips a scoped secret through Windows Credential Manager', { skip: process.platform !== 'win32' }, () => {
  assert.equal(fs.existsSync(helper), true, 'prepared Windows keyring helper is required')
  const key = `user_ci_${crypto.randomUUID().replace(/-/g, '')}_openai_api_key`
  const secret = Buffer.from(`runtime-smoke-${crypto.randomBytes(16).toString('hex')}`, 'utf8')
  try {
    const set = invoke('set', key, secret)
    assert.equal(set.status, 0, 'Credential Manager set failed')

    const exists = invoke('exists', key)
    assert.equal(exists.status, 0, 'Credential Manager exists failed')
    assert.equal(exists.stdout.toString('utf8').trim(), 'true')

    const get = invoke('get', key)
    assert.equal(get.status, 0, 'Credential Manager get failed')
    assert.equal(get.stdout.equals(secret), true, 'Credential Manager returned a different value')
  } finally {
    const remove = invoke('delete', key)
    assert.equal(remove.status, 0, 'Credential Manager delete failed')
    const absent = invoke('exists', key)
    assert.equal(absent.status, 0, 'Credential Manager post-delete exists failed')
    assert.equal(absent.stdout.toString('utf8').trim(), 'false')
    secret.fill(0)
  }
})
