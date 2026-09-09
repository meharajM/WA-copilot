import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const dataDir = '/tmp/aica-autonomy-restore-startup-test'
vi.mock('electron', () => ({
  app: { getPath: () => dataDir, getName: () => 'aica', getVersion: () => '1.0.0' },
  safeStorage: { isEncryptionAvailable: () => false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('electron-store', () => ({
  default: class TestStore { store: Record<string, string> = {}; get(key: string) { return this.store[key] } set(key: string, value: string) { this.store[key] = value } delete(key: string) { delete this.store[key] } }
}))

describe('autonomy restore startup', () => {
  let supervisor: typeof import('../../src/main/services/AutonomousSupervisor').autonomousSupervisor

  beforeAll(async () => {
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.mkdirSync(dataDir, { recursive: true })
    const current = new Database(path.join(dataDir, 'autonomy.db'))
    current.exec('CREATE TABLE old_runtime_marker (id TEXT PRIMARY KEY)')
    current.close()
    const firstBoot = (await import('../../src/main/services/AutonomousSupervisor')).autonomousSupervisor
    firstBoot.stop()
    const checkpoint = new Database(path.join(dataDir, 'autonomy.db'))
    checkpoint.pragma('wal_checkpoint(TRUNCATE)')
    checkpoint.close()
    fs.copyFileSync(path.join(dataDir, 'autonomy.db'), path.join(dataDir, 'autonomy.db.restore'))
    const staged = new Database(path.join(dataDir, 'autonomy.db.restore'))
    staged.exec('DROP TABLE old_runtime_marker; CREATE TABLE restored_runtime_marker (id TEXT PRIMARY KEY)')
    staged.close()
    vi.resetModules()
    ;({ autonomousSupervisor: supervisor } = await import('../../src/main/services/AutonomousSupervisor'))
  })

  it('swaps a valid staged database at startup and enters recovery hold', () => {
    expect(supervisor.getState()).toMatchObject({ recoveryMode: true, paused: true, status: 'degraded' })
    expect(fs.existsSync(path.join(dataDir, 'autonomy.db.restore'))).toBe(false)
    expect(fs.readdirSync(dataDir).some(name => /^autonomy\.db\.pre-restore-\d+$/.test(name))).toBe(true)
    const db = new Database(path.join(dataDir, 'autonomy.db'), { readonly: true })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbound_events'").get()).toBeTruthy()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'old_runtime_marker'").get()).toBeUndefined()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'restored_runtime_marker'").get()).toBeTruthy()
    db.close()
    supervisor.clearRecoveryMode()
    supervisor.stop()
  })
})
