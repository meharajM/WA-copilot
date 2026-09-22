const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')
const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'))
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const cargoToml = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8')
const rust = fs.readFileSync(path.join(root, 'src-tauri/src/main.rs'), 'utf8')
const agentdApi = fs.readFileSync(path.join(root, 'src-tauri/src/agentd_api.rs'), 'utf8')
const runner = fs.readFileSync(path.join(root, 'scripts/tauri-agentd-runner.cjs'), 'utf8')
const windowsWorkflow = fs.readFileSync(path.join(root, '.github/workflows/tauri-windows.yml'), 'utf8')

test('Tauri package declares fixed agentd runtime, entrypoint, and keyring helper resources', () => {
  assert.deepEqual(config.bundle.resources, {
    'sidecar/agentd-runtime*': 'sidecar/',
    'sidecar/agentd-http': 'sidecar/agentd-http',
    'sidecar/aica-keyring-helper*': 'sidecar/',
    'sidecar/aica-migration-reader*': 'sidecar/',
    '../dist/': 'ui/',
  })
  assert.match(rust, /const AGENTD_RUNTIME_RESOURCE: &str = "sidecar\/agentd-runtime"/)
  assert.match(rust, /const AGENTD_RUNTIME_RESOURCE: &str = "sidecar\/agentd-runtime\.exe"/)
  assert.match(rust, /const AGENTD_ENTRY_RESOURCE: &str = "sidecar\/agentd-http\/index\.cjs"/)
  assert.match(rust, /const AGENTD_HELPER_RESOURCE: &str = "sidecar\/aica-keyring-helper"/)
  assert.match(rust, /const AGENTD_MIGRATION_READER_RESOURCE: &str = "sidecar\/aica-migration-reader\.exe"/)
  assert.match(rust, /AICA_AGENTD_MIGRATION_READER/)
  assert.match(rust, /const AGENTD_UI_RESOURCE: &str = "ui"/)
  assert.match(rust, /AICA_AGENTD_UI_ROOT/)
  assert.match(agentdApi, /fn reject_reparse_path\(path: &Path\)/)
  assert.match(agentdApi, /let source_for_agentd = source_path\.to_path_buf\(\)/)
})

test('native package versions match the browser package version for upgrade semantics', () => {
  assert.equal(config.version, packageJson.version)
  assert.match(cargoToml, new RegExp(`^version = "${packageJson.version.replaceAll('.', '\\.') }"$`, 'm'))
})

test('Tauri dev stages sidecars before Cargo watch starts', () => {
  assert.match(packageJson.scripts['dev:tauri'], /prepare:agentd:keyring-helper.*prepare:agentd:migration-reader.*prepare:tauri:agentd.*tauri dev/)
  assert.equal(config.build.beforeDevCommand, 'npm run dev:tauri:web')
  assert.match(config.build.beforeBuildCommand, /prepare:agentd:keyring-helper.*prepare:agentd:migration-reader.*prepare:tauri:agentd/)
})

test('Windows sidecar preparation preserves executable extensions', () => {
  const preparation = fs.readFileSync(path.join(root, 'scripts/prepare-tauri-agentd.mjs'), 'utf8')
  assert.match(preparation, /gmail-oauth\.cjs/)
  assert.match(preparation, /gmail-api\.cjs/)
  assert.match(preparation, /whatsapp-baileys\.cjs/)
  assert.match(preparation, /whatsapp-extension-bridge\.cjs/)
  assert.match(preparation, /continuity-migration\.cjs/)
  assert.match(preparation, /email-mime\.cjs/)
  assert.match(preparation, /email-attachment-safety\.cjs/)
  assert.match(preparation, /email-transport\.cjs/)
  assert.match(preparation, /email-inbound-worker\.cjs/)
  assert.match(preparation, /mcp-worker\.cjs/)
  assert.match(preparation, /speech-model\.cjs/)
  assert.match(preparation, /public-relay-client\.cjs/)
  assert.match(preparation, /@whiskeysockets\/baileys/)
  assert.match(preparation, /@modelcontextprotocol\/sdk/)
  assert.match(preparation, /optionalDependencies/)
  assert.match(preparation, /agentd-runtime\$\{process\.platform === 'win32' \? '\.exe' : ''\}/)
  assert.match(preparation, /staleRuntimePath = join\(sidecarRoot, `agentd-runtime\$\{process\.platform === 'win32' \? '' : '\.exe'\}`\)/)
  assert.match(preparation, /await rm\(staleRuntimePath, \{ force: true \}\)\s+await cp\(process\.execPath, runtimePath\)/)
})

test('Sidecar preparation removes stale opposite-platform executables', () => {
  const keyring = fs.readFileSync(path.join(root, 'scripts/prepare-agentd-keyring-helper.mjs'), 'utf8')
  assert.match(keyring, /staleKeyringHelperPath = join\(resourcesDirectory, `aica-keyring-helper\$\{executableExtension \? '' : '\.exe'\}`\)/)
  assert.match(keyring, /await rm\(staleKeyringHelperPath, \{ force: true \}\)\s+await cp\(/)
})

test('Windows package stages a native migration reader', () => {
  const preparation = fs.readFileSync(path.join(root, 'scripts/prepare-agentd-migration-reader.mjs'), 'utf8')
  assert.match(preparation, /aica-migration-reader\$\{executableExtension\}/)
  assert.match(preparation, /--bin', 'aica-migration-reader'/)
})

test('packaged runner owns agentd startup and does not accept renderer-selected commands', () => {
  assert.match(runner, /new AgentdServer\(/)
  assert.match(runner, /process\.env\.AICA_AGENTD_DATA_DIR/)
  assert.match(runner, /process\.env\.AICA_AGENTD_KEYRING_HELPER/)
  assert.match(runner, /process\.env\.AICA_AGENTD_UI_ROOT/)
  assert.match(runner, /PublicRelayClient/)
  assert.match(runner, /relay_agent_secret/)
  assert.doesNotMatch(runner, /process\.argv\.slice/)
})

test('Windows CI runs target-specific native host tests before packaging', () => {
  const browserBundle = windowsWorkflow.indexOf('npm run build:tauri:web')
  const nativeTests = windowsWorkflow.indexOf('cargo test --locked --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc')
  const bundle = windowsWorkflow.indexOf('npm run build:tauri:win')
  assert.notEqual(browserBundle, -1)
  assert.notEqual(nativeTests, -1)
  assert.notEqual(bundle, -1)
  assert.ok(browserBundle < nativeTests, 'browser assets must exist before native host compilation')
  assert.ok(nativeTests < bundle, 'native host tests must run before packaging')
})

test('Windows CI verifies prepared sidecar and browser resources before packaging', () => {
  const browserBundle = windowsWorkflow.indexOf('npm run build:tauri:web')
  const keyring = windowsWorkflow.indexOf('npm run prepare:agentd:keyring-helper')
  const migrationReader = windowsWorkflow.indexOf('npm run prepare:agentd:migration-reader')
  const sidecar = windowsWorkflow.indexOf('npm run prepare:tauri:agentd')
  const resourceGate = windowsWorkflow.indexOf('node scripts/verify-tauri-resources.mjs')
  const bundle = windowsWorkflow.indexOf('npm run build:tauri:win')
  assert.notEqual(keyring, -1)
  assert.notEqual(migrationReader, -1)
  assert.notEqual(sidecar, -1)
  assert.notEqual(resourceGate, -1)
  assert.ok(browserBundle < migrationReader, 'browser assets must exist before migration-reader compilation')
  assert.ok(keyring < resourceGate, 'keyring helper must be prepared before resource verification')
  assert.ok(migrationReader < resourceGate, 'migration reader must be prepared before resource verification')
  assert.ok(sidecar < resourceGate, 'agentd sidecar must be prepared before resource verification')
  assert.ok(resourceGate < bundle, 'resource verification must run before packaging')
})

test('Windows CI verifies installer artifacts before upload', () => {
  const bundle = windowsWorkflow.indexOf('npm run build:tauri:win')
  const artifactGate = windowsWorkflow.indexOf('node scripts/verify-tauri-windows-bundle.mjs')
  const upload = windowsWorkflow.indexOf('Upload unsigned Windows artifacts')
  assert.notEqual(bundle, -1)
  assert.notEqual(artifactGate, -1)
  assert.notEqual(upload, -1)
  assert.ok(bundle < artifactGate, 'installer artifacts must exist before verification')
  assert.ok(artifactGate < upload, 'installer artifacts must pass verification before upload')
})

test('Windows CI runs Credential Manager runtime smoke after preparing the helper', () => {
  const helper = windowsWorkflow.indexOf('npm run prepare:agentd:keyring-helper')
  const runtimeSmoke = windowsWorkflow.indexOf('node --test tests/unit/windows-keyring-runtime.test.cjs')
  assert.notEqual(helper, -1)
  assert.notEqual(runtimeSmoke, -1)
  assert.ok(helper < runtimeSmoke, 'Credential Manager smoke must use the prepared helper')
})
