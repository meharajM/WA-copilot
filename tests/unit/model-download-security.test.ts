import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isSha256Digest, ModelManager, sha256File, validateModelArchiveEntries } from '../../src/main/services/ModelManager'
import { ModelServer } from '../../src/main/services/ModelServer'

const servers: ModelServer[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
})

describe('model download security boundary', () => {
  it('rejects unsafe names and non-approved model hosts before network access', async () => {
    const manager = new ModelManager(os.tmpdir())
    await expect(manager.downloadModel('../outside', 'https://alphacephei.com/model.zip', () => {})).resolves.toMatchObject({ success: false, error: 'Invalid model name' })
    await expect(manager.downloadModel('safe-model', 'https://example.test/model.zip', () => {})).resolves.toMatchObject({ success: false, error: 'Model URL is not approved' })
    await expect(manager.downloadModel('safe-model', 'https://alphacephei.com/model.zip', () => {}, '')).resolves.toMatchObject({ success: false, error: 'Model integrity metadata is unavailable' })
  })

  it('accepts only a complete SHA-256 digest as integrity metadata', () => {
    expect(isSha256Digest('a'.repeat(64))).toBe(true)
    expect(isSha256Digest('a'.repeat(63))).toBe(false)
    expect(isSha256Digest('not-a-digest')).toBe(false)
  })

  it('hashes model archives without loading the whole file into one buffer', async () => {
    const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aica-model-hash-')), 'model.zip')
    fs.writeFileSync(filePath, 'model-bytes')
    await expect(sha256File(filePath)).resolves.toBe('357e5d6fafa34d27360fec24b4326d3534905e33c6acdee60198fb078b7b79e5')
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true })
  })

  it('keeps speech IPC model resolution in the main-process catalog', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/main/ipc/speech.ts'), 'utf8')
    expect(source).toContain("function approvedModel(modelId?: unknown)")
    expect(source).toContain("ipcMain.handle('speech:get-model-path', async (_event, modelId: unknown)")
    expect(source).not.toContain("ipcMain.handle('speech:get-model-path', async (_event, modelName: string)")
    expect(source).toContain("error: 'Speech model is not approved'")
  })

  it('keeps Windows archive extraction argument-bound', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/main/services/ModelManager.ts'), 'utf8')
    expect(source).toContain("execFileSync('powershell.exe'")
    expect(source).not.toContain('Expand-Archive -Path \'${zipPath}\'')
  })

  it('rejects traversal and absolute archive entries', () => {
    for (const entry of ['../outside', 'nested/../../outside', '..\\outside', '/absolute', 'C:\\absolute']) {
      expect(() => validateModelArchiveEntries([entry])).toThrow('unsafe path')
    }
    expect(() => validateModelArchiveEntries(['vosk-model/config/model.conf'])).not.toThrow()
    expect(() => validateModelArchiveEntries(['other-model/config/model.conf'], 'vosk-model')).toThrow('unexpected root')
    expect(() => validateModelArchiveEntries(['vosk-model/config/model.conf'], 'vosk-model')).not.toThrow()
  })

  it('does not serve files outside the model directory through traversal', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aica-model-'))
    const sibling = `${root}-secret.txt`
    fs.writeFileSync(sibling, 'secret')
    const server = new ModelServer(root)
    servers.push(server)
    const base = await server.start()
    const response = await fetch(`${base}/../${path.basename(sibling)}`)
    expect(response.status).not.toBe(200)
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(sibling, { force: true })
  })

  it('does not follow a model symlink outside the model directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aica-model-'))
    const secret = `${root}-secret.txt`
    const link = path.join(root, 'model.zip')
    fs.writeFileSync(secret, 'secret')
    fs.symlinkSync(secret, link)
    const server = new ModelServer(root)
    servers.push(server)
    const base = await server.start()
    const response = await fetch(`${base}/model.zip`)
    expect(response.status).toBe(403)
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(secret, { force: true })
  })
})
