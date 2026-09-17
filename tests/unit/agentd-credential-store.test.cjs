const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { KeyringCredentialStore, isAllowedCredentialKey } = require('../../agentd/keyring-credential-store.cjs')

test('keyring adapter sends secret values only over stdin and supports allowlisted operations', async () => {
  const dataDir = fs.mkdtempSync('/tmp/aica-keyring-adapter-')
  const filename = path.join(dataDir, 'fake-keyring.json')
  const previousPath = process.env.AICA_TEST_KEYRING_FILE
  process.env.AICA_TEST_KEYRING_FILE = filename
  const helper = path.resolve(__dirname, '../fixtures/fake-keyring-helper.cjs')
  const store = new KeyringCredentialStore(process.execPath, [helper])
  try {
    assert.equal(isAllowedCredentialKey('openai_api_key'), true)
    assert.equal(isAllowedCredentialKey('user_demo_openai_api_key'), true)
    assert.equal(isAllowedCredentialKey('user_demo_openai_api_key_extra'), false)
    assert.equal(isAllowedCredentialKey('arbitrary'), false)
    assert.equal(await store.exists('openai_api_key'), false)
    await store.set('openai_api_key', 'secret-not-in-args')
    assert.equal(await store.exists('openai_api_key'), true)
    assert.equal(await store.get('openai_api_key'), 'secret-not-in-args')
    assert.equal(await store.get('gemini_api_key'), null)
    await store.delete('openai_api_key')
    assert.equal(await store.exists('openai_api_key'), false)
    await assert.rejects(() => store.get('arbitrary'), /Credential key is not allowed/)
    await assert.rejects(() => store.set('gemini_api_key', 'x'.repeat(64 * 1024 + 1)), /too large/)
  } finally {
    if (previousPath === undefined) delete process.env.AICA_TEST_KEYRING_FILE
    else process.env.AICA_TEST_KEYRING_FILE = previousPath
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
