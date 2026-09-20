const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { pathToFileURL } = require('node:url')

const script = path.resolve(__dirname, '../../scripts/verify-tauri-windows-bundle.mjs')

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aica-tauri-bundle-'))
  await fs.mkdir(path.join(root, 'nsis'), { recursive: true })
  await fs.mkdir(path.join(root, 'msi'), { recursive: true })
  await fs.writeFile(path.join(root, 'nsis', 'AICA-Native-Host-setup.exe'), Buffer.from('nsis'))
  await fs.writeFile(path.join(root, 'msi', 'AICA-Native-Host.msi'), Buffer.from('msi'))
  return root
}

async function verify(bundleRoot) {
  const module = await import(pathToFileURL(script).href)
  return module.verifyTauriWindowsBundle({ bundleRoot })
}

test('Windows bundle verifier accepts non-empty NSIS and MSI artifacts', async () => {
  const root = await fixture()
  try {
    const result = await verify(root)
    assert.equal(result.artifacts.length, 2)
    assert.equal(result.artifacts.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)), true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('Windows bundle verifier fails when an installer family is missing', async () => {
  const root = await fixture()
  try {
    await fs.rm(path.join(root, 'msi'), { recursive: true, force: true })
    await assert.rejects(verify(root), /missing MSI installer/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
