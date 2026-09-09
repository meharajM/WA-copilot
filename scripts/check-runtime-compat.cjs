const fs = require('node:fs')
const path = require('node:path')

const root = process.cwd()
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const minimum = String(packageJson.engines?.node || '').match(/>=\s*(\d+)\.(\d+)\.(\d+)/)
const current = process.versions.node.split('.').map(Number)
const failures = []

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

const direct = { ...packageJson.dependencies, ...packageJson.devDependencies }
const licenses = []
for (const name of Object.keys(direct).sort()) {
  const pkg = readPackage(name)
  const license = typeof pkg?.license === 'string' ? pkg.license : Array.isArray(pkg?.licenses) ? pkg.licenses.map(item => item.type).filter(Boolean).join(',') : ''
  licenses.push({ name, version: pkg?.version || 'missing', license: license || 'UNKNOWN' })
  if (!pkg) failures.push(`direct dependency ${name} is not installed`)
  else if (!license) failures.push(`direct dependency ${name}@${pkg.version} has no machine-readable license field`)
}

console.log(JSON.stringify({ node: process.versions.node, electron: electron?.version || null, electronBinary: electronBinary(), licenses }, null, 2))
if (failures.length) {
  console.error('\nRuntime compatibility check failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
}
