import { mkdtemp, mkdir, readFile, symlink, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createMigrationManifest, importMigration, type StoreDefinition } from '../../src/shared/migration.js'

const fakeSqlite = Buffer.alloc(1024); fakeSqlite.write('SQLite format 3\0'); fakeSqlite.writeUInt16BE(1024, 16); fakeSqlite[21] = 64; fakeSqlite[22] = 32; fakeSqlite[23] = 32; fakeSqlite.writeUInt32BE(1, 28); fakeSqlite.writeUInt32BE(1, 92); fakeSqlite.writeUInt32BE(1, 96)
const stores: readonly StoreDefinition[] = [
  { id: 'electron-settings', source: 'electron', sourceRelativePath: 'settings.json', targetRelativePath: 'settings.json', format: 'json', schemaVersion: 'electron.settings.v1', requiresReauthentication: true, secret: false },
  { id: 'electron-chat-history', source: 'electron', sourceRelativePath: 'chat-history.db', targetRelativePath: 'chat-history.db', format: 'sqlite', schemaVersion: 'chat-history.v1', requiresReauthentication: true, secret: false },
]

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'migration-'))
  const electron = join(root, 'electron'); const agentd = join(root, 'agentd'); const target = join(root, 'target')
  await Promise.all([mkdir(electron), mkdir(agentd), mkdir(target)])
  await writeFile(join(electron, 'settings.json'), JSON.stringify({ theme: 'dark' }))
  const db = new Database(join(electron, 'chat-history.db'))
  db.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO messages (body) VALUES (\'hello\')')
  db.close()
  return { electron, agentd, target }
}

async function manifest() { const f = await fixture(); return { ...f, manifest: await createMigrationManifest({ electronRoot: f.electron, agentdRoot: f.agentd, targetRoot: f.target, stores }) } }

describe('host-neutral migration', () => {
  it('previews and imports cleanly without changing source', async () => {
    const f = await manifest(); const before = await readFile(join(f.electron, 'settings.json'))
    const preview = await importMigration(f.manifest, { dryRun: true })
    expect(preview.results.every((r) => r.status === 'dry-run')).toBe(true)
    await importMigration(f.manifest)
    expect(await readFile(join(f.target, 'settings.json'))).toEqual(before)
    expect(await readFile(join(f.electron, 'settings.json'))).toEqual(before)
  })

  it('is idempotent on repeat import', async () => {
    const f = await manifest(); await importMigration(f.manifest); const second = await importMigration(f.manifest)
    expect(second.results.every((r) => r.status === 'skipped')).toBe(true)
  })

  it('rejects corruption and secrets', async () => {
    const f = await fixture(); await writeFile(join(f.electron, 'settings.json'), '{broken')
    await expect(createMigrationManifest({ electronRoot: f.electron, agentdRoot: f.agentd, targetRoot: f.target, stores: [stores[0]] })).rejects.toThrow(/invalid/)
    await writeFile(join(f.electron, 'settings.json'), JSON.stringify({ apiKey: 'never' }))
    await expect(createMigrationManifest({ electronRoot: f.electron, agentdRoot: f.agentd, targetRoot: f.target, stores: [stores[0]] })).rejects.toThrow(/secret/)
  })

  it('rejects header-only SQLite and accepts a real 65536-byte-page database', async () => {
    const f = await fixture()
    await writeFile(join(f.electron, 'chat-history.db'), fakeSqlite)
    await expect(createMigrationManifest({ electronRoot: f.electron, agentdRoot: f.agentd, targetRoot: f.target, stores: [stores[1]] })).rejects.toThrow(/SQLite|corrupt|invalid/)

    await rm(join(f.electron, 'chat-history.db'))
    const db = new Database(join(f.electron, 'chat-history.db'))
    db.pragma('page_size = 65536')
    db.exec('VACUUM; CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL); INSERT INTO messages (body) VALUES (\'large page\')')
    db.close()
    expect((await stat(join(f.electron, 'chat-history.db'))).size % 65536).toBe(0)
    await expect(createMigrationManifest({ electronRoot: f.electron, agentdRoot: f.agentd, targetRoot: f.target, stores: [stores[1]] })).resolves.toBeTruthy()
  })

  it('rejects traversal and symlink paths', async () => {
    const f = await fixture()
    const traversal = { ...stores[0], targetRelativePath: '../outside.json' }
    await expect(createMigrationManifest({ electronRoot: f.electron, agentdRoot: f.agentd, targetRoot: f.target, stores: [traversal] })).rejects.toThrow(/allowlisted|unsafe/)
    await symlink(f.electron, join(f.target, 'link'))
    const linked = { ...stores[0], targetRelativePath: 'link/settings.json' }
    await expect(createMigrationManifest({ electronRoot: f.electron, agentdRoot: f.agentd, targetRoot: f.target, stores: [linked] })).rejects.toThrow(/allowlisted|symlink/)
  })

  it('fails closed when a custom backup ancestor is a symlink', async () => {
    const f = await manifest(); const outside = join(f.electron, 'outside-backups')
    await mkdir(outside); await symlink(outside, join(f.target, 'backup-link'))
    await expect(importMigration(f.manifest, { backupRoot: join(f.target, 'backup-link', 'run') })).rejects.toThrow(/unsafe|ELOOP|migration/)
  })

  it('rolls back every prior store after partial failure and keeps backup', async () => {
    const f = await manifest(); await writeFile(join(f.target, 'settings.json'), JSON.stringify({ old: true }))
    await expect(importMigration(f.manifest, { failAfterStoreId: 'electron-chat-history' })).rejects.toThrow(/injected/)
    expect(JSON.parse(await readFile(join(f.target, 'settings.json'), 'utf8'))).toEqual({ old: true })
    await expect(readFile(join(f.target, 'chat-history.db'))).rejects.toThrow()
  })

  it('backs up an existing empty target instead of treating it as absent', async () => {
    const f = await manifest(); await writeFile(join(f.target, 'settings.json'), Buffer.alloc(0))
    const result = await importMigration(f.manifest)
    expect(result.backupRoot).toBeTruthy()
    expect((await stat(join(result.backupRoot!, 'settings.json'))).size).toBe(0)
  })

  it('preserves original failure while collecting rollback failures', async () => {
    const f = await manifest(); await writeFile(join(f.target, 'settings.json'), JSON.stringify({ old: true }))
    await expect(importMigration(f.manifest, { failAfterStoreId: 'electron-chat-history', failRollbackForStoreId: 'electron-chat-history' })).rejects.toMatchObject({
      message: expect.stringMatching(/injected migration failure.*rollback failures.*injected rollback failure/),
      cause: expect.objectContaining({ message: expect.stringMatching(/injected migration failure/) }),
    })
  })

  it('rejects tampered manifest metadata and source changes after preview', async () => {
    const f = await manifest()
    for (const field of ['sourcePath', 'targetPath', 'schemaVersion', 'requiresReauthentication', 'byteSize', 'sha256'] as const) {
      const copy = structuredClone(f.manifest); const entry = copy.entries[0]
      if (field === 'sourcePath' || field === 'targetPath') entry[field] = join(f.target, 'other')
      else if (field === 'requiresReauthentication') entry[field] = !entry[field]
      else if (field === 'byteSize') entry[field] += 1
      else if (field === 'sha256') entry[field] = '0'.repeat(64)
      else entry[field] = 'tampered'
      await expect(importMigration(copy)).rejects.toThrow(/tampered|changed/)
    }
    await writeFile(join(f.electron, 'settings.json'), JSON.stringify({ theme: 'changed' }))
    await expect(importMigration(f.manifest)).rejects.toThrow(/changed/)
  })
})
