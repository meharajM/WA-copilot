const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const root = path.resolve(__dirname, '../..')
const reader = process.env.AICA_AGENTD_MIGRATION_READER || path.join(root, 'src-tauri', 'sidecar', 'aica-migration-reader.exe')

function invoke(file) {
  return spawnSync(reader, [file], { encoding: null, windowsHide: true, maxBuffer: 128 * 1024 })
}

test('packaged migration reader rejects final and parent reparse paths', { skip: process.platform !== 'win32' }, () => {
  assert.equal(fs.existsSync(reader), true, 'prepared Windows migration reader is required')
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aica-migration-reader-runtime-'))
  const realDir = path.join(rootDir, 'real')
  const realFile = path.join(realDir, 'settings.json')
  const finalLink = path.join(rootDir, 'final-link.json')
  const parentLink = path.join(rootDir, 'parent-link')
  fs.mkdirSync(realDir)
  fs.writeFileSync(realFile, '{"safe":true}')
  try {
    fs.symlinkSync(realFile, finalLink, 'file')
    fs.symlinkSync(realDir, parentLink, 'junction')
    assert.notEqual(invoke(finalLink).status, 0, 'final reparse point must fail closed')
    assert.notEqual(invoke(path.join(parentLink, 'settings.json')).status, 0, 'parent reparse point must fail closed')
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})
