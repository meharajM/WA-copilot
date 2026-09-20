const fs = require('node:fs')
const path = require('node:path')

const root = process.cwd()
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const minimum = String(packageJson.engines?.node || '').match(/>=\s*(\d+)\.(\d+)\.(\d+)/)
const current = process.versions.node.split('.').map(Number)
const failures = []
const nativeModules = []

function packagePath(name) {
  return path.join(root, 'node_modules', ...name.split('/'), 'package.json')
}

function readPackage(name) {
  const file = packagePath(name)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
}

function electronBinary() {
  if (process.platform === 'darwin') return path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
  if (process.platform === 'win32') return path.join(root, 'node_modules/electron/dist/electron.exe')
  return path.join(root, 'node_modules/electron/dist/electron')
}

if (!minimum) failures.push('package.json must declare a simple >= Node engine')
else {
  const [major, minor, patch] = minimum.slice(1).map(Number)
  const minimumVersion = `${major}.${minor}.${patch}`
  if (current[0] < major || (current[0] === major && (current[1] < minor || (current[1] === minor && current[2] < patch)))) {
    failures.push(`Node ${process.versions.node} is below the declared minimum ${minimumVersion}`)
  }
}

const electron = readPackage('electron')
if (!electron) failures.push('electron is not installed')
else if (!fs.existsSync(electronBinary())) failures.push(`Electron ${electron.version} executable is missing at ${electronBinary()}`)

const resolvedSecurityDependencies = {}
for (const name of ['protobufjs', 'uuid']) {
  const pkg = readPackage(name)
  resolvedSecurityDependencies[name] = pkg?.version || null
  if (!pkg) failures.push(`transitive security dependency ${name} is not installed`)
}

for (const name of ['better-sqlite3']) {
  try {
    const loaded = require(name)
    const database = new loaded(':memory:')
    database.prepare('SELECT 1').get()
    database.close()
    nativeModules.push({ name, status: 'loaded', nodeAbi: process.versions.modules })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    nativeModules.push({ name, status: 'failed', nodeAbi: process.versions.modules, error: message.split('\n')[0] })
    failures.push(`native module ${name} could not load under Node ABI ${process.versions.modules}: ${message.split('\n')[0]}`)
  }
}

try {
  const signal = require('@whiskeysockets/libsignal-node')
  const identity = signal.keyhelper.generateIdentityKeyPair()
  const preKey = signal.keyhelper.generatePreKey(1)
  const curvePair = signal.curve.generateKeyPair()
  if (identity.pubKey?.length !== 33 || preKey.keyPair?.pubKey?.length !== 33 || curvePair.pubKey?.length !== 33) {
    throw new Error('unexpected Signal key length')
  }
  nativeModules.push({ name: '@whiskeysockets/libsignal-node', status: 'key-generation-ok' })
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  nativeModules.push({ name: '@whiskeysockets/libsignal-node', status: 'failed', error: message.split('\n')[0] })
  failures.push(`Signal compatibility smoke check failed: ${message.split('\n')[0]}`)
}

const direct = { ...packageJson.dependencies, ...packageJson.devDependencies }
const licenses = []
for (const name of Object.keys(direct).sort()) {
  const pkg = readPackage(name)
  const license = typeof pkg?.license === 'string' ? pkg.license : Array.isArray(pkg?.licenses) ? pkg.licenses.map(item => item.type).filter(Boolean).join(',') : ''
  licenses.push({ name, version: pkg?.version || 'missing', license: license || 'UNKNOWN' })
  if (!pkg) failures.push(`direct dependency ${name} is not installed`)
  else if (!license) failures.push(`direct dependency ${name}@${pkg.version} has no machine-readable license field`)
}

console.log(JSON.stringify({ node: process.versions.node, nodeAbi: process.versions.modules, electron: electron?.version || null, electronBinary: electronBinary(), resolvedSecurityDependencies, nativeModules, licenses }, null, 2))
if (failures.length) {
  console.error('\nRuntime compatibility check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
}
