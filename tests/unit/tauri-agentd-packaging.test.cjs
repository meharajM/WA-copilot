const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const rust = fs.readFileSync(path.join(root, 'src-tauri/src/main.rs'), 'utf8')
const runner = fs.readFileSync(path.join(root, 'scripts/tauri-agentd-runner.cjs'), 'utf8')

test('Tauri package declares fixed agentd runtime, entrypoint, and keyring helper resources', () => {
  assert.deepEqual(config.bundle.resources, {
    'sidecar/agentd-runtime*': 'sidecar/',
    'sidecar/agentd-http': 'sidecar/agentd-http',
    'sidecar/aica-keyring-helper*': 'sidecar/',
    '../dist/': 'ui/',
  })
  assert.match(rust, /const AGENTD_RUNTIME_RESOURCE: &str = "sidecar\/agentd-runtime"/)
  assert.match(rust, /const AGENTD_RUNTIME_RESOURCE: &str = "sidecar\/agentd-runtime\.exe"/)
  assert.match(rust, /const AGENTD_ENTRY_RESOURCE: &str = "sidecar\/agentd-http\/index\.cjs"/)
  assert.match(rust, /const AGENTD_HELPER_RESOURCE: &str = "sidecar\/aica-keyring-helper"/)
  assert.match(rust, /const AGENTD_UI_RESOURCE: &str = "ui"/)
  assert.match(rust, /AICA_AGENTD_UI_ROOT/)
})

test('Windows sidecar preparation preserves executable extensions', () => {
  const preparation = fs.readFileSync(path.join(root, 'scripts/prepare-tauri-agentd.mjs'), 'utf8')
  assert.match(preparation, /agentd-runtime\$\{process\.platform === 'win32' \? '\.exe' : ''\}/)
})

test('packaged runner owns agentd startup and does not accept renderer-selected commands', () => {
  assert.match(runner, /new AgentdServer\(/)
  assert.match(runner, /process\.env\.AICA_AGENTD_DATA_DIR/)
  assert.match(runner, /process\.env\.AICA_AGENTD_KEYRING_HELPER/)
  assert.match(runner, /process\.env\.AICA_AGENTD_UI_ROOT/)
  assert.doesNotMatch(runner, /process\.argv\.slice/)
})
