import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, unlink, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import Database from 'better-sqlite3'

export type StoreFormat = 'json' | 'sqlite'
export type StoreSource = 'electron' | 'agentd'

export interface StoreDefinition {
  id: string
  source: StoreSource
  sourceRelativePath: string
  targetRelativePath: string
  format: StoreFormat
  schemaVersion: string
  requiresReauthentication: boolean
  secret: false
}

export interface MigrationEntry extends StoreDefinition {
  sourcePath: string
  targetPath: string
  byteSize: number
  sha256: string
}

export interface MigrationManifest {
  version: 1
  electronRoot: string
  agentdRoot: string
  targetRoot: string
  entries: MigrationEntry[]
}

export interface ImportOptions {
  dryRun?: boolean
  backupRoot?: string
  /** Test hook; production callers should not set this. */
  failAfterStoreId?: string
  /** Test hook; production callers should not set this. */
  failRollbackForStoreId?: string
}

export interface ImportResult {
  id: string
  status: 'imported' | 'skipped' | 'dry-run'
  backupPath?: string
}

export const ALLOWED_MIGRATION_STORES: readonly StoreDefinition[] = [
  { id: 'electron-settings', source: 'electron', sourceRelativePath: 'settings.json', targetRelativePath: 'settings.json', format: 'json', schemaVersion: 'electron.settings.v1', requiresReauthentication: true, secret: false },
  { id: 'electron-persona', source: 'electron', sourceRelativePath: 'persona.json', targetRelativePath: 'persona.json', format: 'json', schemaVersion: 'persona.v1', requiresReauthentication: false, secret: false },
  { id: 'electron-chat-history', source: 'electron', sourceRelativePath: 'chat-history.db', targetRelativePath: 'chat-history.db', format: 'sqlite', schemaVersion: 'chat-history.v1', requiresReauthentication: true, secret: false },
  { id: 'agentd-state', source: 'agentd', sourceRelativePath: 'agentd.db', targetRelativePath: 'agentd.db', format: 'sqlite', schemaVersion: 'agentd.v1', requiresReauthentication: true, secret: false },
]

const SECRET_KEY = /(?:secret|token|password|passwd|api[_.-]?(?:key|secret|token)|private[_.-]?(?:key|secret)|refresh[_.-]?token|access[_.-]?token|cookie|session|authorization|credential|bearer|oauth|encryption[_.-]?(?:key|secret))/i
// Schema names are tokenized; avoid rejecting legitimate names such as chat_sessions.
const SECRET_SCHEMA = /(?:^|[^a-z])(secret|token|password|passwd|api[_-]?(?:key|secret|token)|private[_-]?(?:key|secret)|refresh[_-]?token|access[_-]?token|session[_-]?(?:token|secret)|cookie|authorization|credential|bearer|oauth|encryption[_-]?(?:key|secret))(?:$|[^a-z])/i
const NOFOLLOW = constants.O_NOFOLLOW
const DIRECTORY = constants.O_DIRECTORY

interface FileIdentity {
  dev: number | bigint
  ino: number | bigint
  size: number
  mtimeNs?: bigint
  ctimeNs?: bigint
}

interface FileSnapshot { bytes: Buffer; identity: FileIdentity }
interface Mutation { entry: MigrationEntry; before: FileSnapshot | undefined; after: FileIdentity }

function requireNoFollow(): void {
  if (typeof NOFOLLOW !== 'number' || typeof DIRECTORY !== 'number') throw new Error('migration requires platform no-follow directory operations')
}

function inside(root: string, candidate: string): boolean {
  const r = relative(root, candidate)
  return r === '' || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r))
}

function sameIdentity(a: FileIdentity | undefined, b: FileIdentity | undefined): boolean {
  return Boolean(a && b && a.dev === b.dev && a.ino === b.ino)
}

function sameSnapshot(a: FileIdentity | undefined, b: FileIdentity | undefined): boolean {
  return Boolean(
    sameIdentity(a, b)
      && a?.size === b?.size
      && a?.mtimeNs === b?.mtimeNs
      && a?.ctimeNs === b?.ctimeNs,
  )
}

function identity(stat: { dev: number | bigint; ino: number | bigint; size: number; mtimeNs?: bigint; ctimeNs?: bigint }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
}

async function realRoot(root: string): Promise<string> {
  requireNoFollow()
  const stat = await lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe migration root: ${root}`)
  const canonical = await realpath(root)
  const handle = await open(canonical, constants.O_RDONLY | DIRECTORY | NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isDirectory() || !sameIdentity(identity(stat), identity(opened))) throw new Error(`migration root changed: ${root}`)
  } finally { await handle.close() }
  return canonical
}

async function openNoFollow(path: string, flags: number, mode?: number) {
  requireNoFollow()
  return open(path, flags | NOFOLLOW, mode)
}

async function checkDirectory(path: string): Promise<void> {
  const handle = await openNoFollow(path, constants.O_RDONLY | DIRECTORY)
  try { if (!(await handle.stat()).isDirectory()) throw new Error(`unsafe migration directory: ${path}`) } finally { await handle.close() }
}

async function noSymlinkComponents(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error(`unsafe migration path: ${path}`)
  await checkDirectory(root)
  let current = root
  for (const part of relative(root, dirname(path)).split(sep)) {
    if (!part) continue
    current = join(current, part)
    await checkDirectory(current)
  }
}

async function safePath(root: string, relativePath: string): Promise<string> {
  if (isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) throw new Error(`unsafe migration path: ${relativePath}`)
  const rootPath = await realRoot(root)
  const candidate = join(rootPath, relativePath)
  if (!inside(rootPath, candidate)) throw new Error(`unsafe migration path: ${relativePath}`)
  await noSymlinkComponents(rootPath, candidate)
  try {
    const handle = await openNoFollow(candidate, constants.O_RDONLY)
    try { if (!(await handle.stat()).isFile()) throw new Error(`unsafe migration file: ${candidate}`) } finally { await handle.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return candidate
}

async function readNoFollow(path: string): Promise<FileSnapshot> {
  const handle = await openNoFollow(path, constants.O_RDONLY)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error(`unsafe migration file: ${path}`)
    return { bytes: await handle.readFile(), identity: identity(stat) }
  } finally { await handle.close() }
}

async function targetSnapshot(path: string): Promise<FileSnapshot | undefined> {
  try { return await readNoFollow(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await openNoFollow(path, constants.O_RDONLY | DIRECTORY)
  try { await handle.sync() } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  } finally { await handle.close() }
}

async function mkdirTreeNoSymlink(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new Error(`unsafe migration path: ${path}`)
  await checkDirectory(root)
  let current = root
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part)
    try { await checkDirectory(current) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(current, { recursive: false, mode: 0o700 })
      await checkDirectory(current)
    }
  }
}

async function writeNew(path: string, bytes: Buffer): Promise<FileIdentity> {
  const handle = await openNoFollow(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { await handle.writeFile(bytes); await handle.sync(); return identity(await handle.stat()) } finally { await handle.close() }
}

async function overwriteExisting(path: string, bytes: Buffer, expected: FileIdentity): Promise<FileIdentity> {
  const handle = await openNoFollow(path, constants.O_WRONLY)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameIdentity(identity(opened), expected)) throw new Error(`target changed during migration: ${path}`)
    await handle.truncate(0)
    if (bytes.length) await handle.writeFile(bytes)
    await handle.sync()
    const after = identity(await handle.stat())
    if (!sameIdentity(after, expected)) throw new Error(`target changed during migration: ${path}`)
    return after
  } finally { await handle.close() }
}

function assertNoSecrets(value: unknown, path = '$'): void {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error(`secret field refused: ${path}.${key}`)
    assertNoSecrets(child, `${path}.${key}`)
  }
}

function validateSqliteHeader(bytes: Buffer, sourcePath: string): number {
  if (bytes.length < 100 || bytes.subarray(0, 16).toString('ascii') !== 'SQLite format 3\x00') throw new Error(`invalid SQLite store: ${sourcePath}`)
  const pageSizeField = bytes.readUInt16BE(16); const pageSize = pageSizeField === 1 ? 65536 : pageSizeField
  const reserved = bytes[20]; const payloadMax = bytes[21]; const payloadMin = bytes[22]; const leafPayload = bytes[23]
  const pageCount = bytes.readUInt32BE(28); const schemaFormat = bytes.readUInt32BE(44); const textEncoding = bytes.readUInt32BE(56)
  if (pageSize < 512 || pageSize > 65536 || (pageSize & (pageSize - 1)) !== 0 || reserved >= pageSize || payloadMax !== 64 || payloadMin !== 32 || leafPayload !== 32 || pageCount < 1 || bytes.length !== pageCount * pageSize || bytes[18] !== 1 || bytes[19] !== 1 || schemaFormat < 1 || schemaFormat > 4 || ![1, 2, 3].includes(textEncoding)) throw new Error(`corrupt SQLite store: ${sourcePath}`)
  return pageSize
}

async function validateSqliteIntegrity(bytes: Buffer, sourcePath: string): Promise<void> {
  validateSqliteHeader(bytes, sourcePath)
  for (const sidecar of [`${sourcePath}-wal`, `${sourcePath}-shm`]) {
    try { await lstat(sidecar); throw new Error(`SQLite sidecar requires checkpoint before migration: ${sidecar}`) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const tempDir = await mkdtemp(join(tmpdir(), 'wa-copilot-sqlite-')); const tempPath = join(tempDir, 'store.db')
  try {
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    const db = new Database(tempPath, { readonly: true, fileMustExist: true })
    try {
      db.pragma('query_only = ON')
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>
      if (!integrity.length || integrity.some((row) => row.integrity_check !== 'ok')) throw new Error(`SQLite integrity check failed: ${sourcePath}`)
      const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL").all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>
      if (schema.some((row) => SECRET_SCHEMA.test(`${row.name} ${row.tbl_name} ${row.sql}`))) throw new Error(`secret SQLite store refused: ${sourcePath}`)
    } finally { db.close() }
  } catch (error) {
    if (error instanceof Error && /SQLite (?:integrity|sidecar|secret)/.test(error.message)) throw error
    throw new Error(`invalid SQLite store ${sourcePath}: ${(error as Error).message}`)
  } finally { await rm(tempDir, { recursive: true, force: true }) }
}

async function validateBytes(format: StoreFormat, bytes: Buffer, sourcePath: string): Promise<void> {
  if (bytes.length === 0) throw new Error(`empty migration store: ${sourcePath}`)
  if (format === 'json') {
    try { assertNoSecrets(JSON.parse(bytes.toString('utf8'))) } catch (error) { throw new Error(`invalid or secret JSON store ${sourcePath}: ${(error as Error).message}`) }
    return
  }
  await validateSqliteIntegrity(bytes, sourcePath)
}

export async function createMigrationManifest(input: { electronRoot: string; agentdRoot: string; targetRoot: string; stores?: readonly StoreDefinition[] }): Promise<MigrationManifest> {
  const targetRoot = await realRoot(input.targetRoot); const electronRoot = await realRoot(input.electronRoot); const agentdRoot = await realRoot(input.agentdRoot)
  if (inside(electronRoot, targetRoot) || inside(agentdRoot, targetRoot) || inside(targetRoot, electronRoot) || inside(targetRoot, agentdRoot)) throw new Error('migration target must be isolated from source roots')
  const entries: MigrationEntry[] = []
  for (const definition of input.stores ?? ALLOWED_MIGRATION_STORES) {
    const allowed = ALLOWED_MIGRATION_STORES.find((candidate) => candidate.id === definition.id)
    if (!allowed || JSON.stringify(allowed) !== JSON.stringify(definition)) throw new Error(`store not allowlisted: ${definition.id}`)
    const sourcePath = await safePath(definition.source === 'electron' ? electronRoot : agentdRoot, definition.sourceRelativePath); const targetPath = await safePath(targetRoot, definition.targetRelativePath)
    let snapshot: FileSnapshot
    try { snapshot = await readNoFollow(sourcePath) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
    await validateBytes(definition.format, snapshot.bytes, sourcePath)
    entries.push({ ...definition, sourcePath, targetPath, byteSize: snapshot.bytes.length, sha256: createHash('sha256').update(snapshot.bytes).digest('hex') })
  }
  entries.sort((a, b) => a.id.localeCompare(b.id)); return { version: 1, electronRoot, agentdRoot, targetRoot, entries }
}

export async function importMigration(manifest: MigrationManifest, options: ImportOptions = {}): Promise<{ results: ImportResult[]; backupRoot?: string }> {
  const targetRoot = await realRoot(manifest.targetRoot); const electronRoot = await realRoot(manifest.electronRoot); const agentdRoot = await realRoot(manifest.agentdRoot)
  if (manifest.version !== 1 || targetRoot !== manifest.targetRoot || inside(electronRoot, targetRoot) || inside(agentdRoot, targetRoot) || inside(targetRoot, electronRoot) || inside(targetRoot, agentdRoot)) throw new Error('tampered migration manifest')
  const seenIds = new Set<string>(); const seenTargets = new Set<string>()
  const entries = manifest.entries.map((entry) => {
    const allowed = ALLOWED_MIGRATION_STORES.find((candidate) => candidate.id === entry.id); const metadata = { id: entry.id, source: entry.source, sourceRelativePath: entry.sourceRelativePath, targetRelativePath: entry.targetRelativePath, format: entry.format, schemaVersion: entry.schemaVersion, requiresReauthentication: entry.requiresReauthentication, secret: entry.secret }
    if (!allowed || JSON.stringify(allowed) !== JSON.stringify(metadata)) throw new Error(`tampered migration entry: ${entry.id}`)
    if (seenIds.has(entry.id) || seenTargets.has(entry.targetRelativePath)) throw new Error('duplicate migration entry')
    seenIds.add(entry.id); seenTargets.add(entry.targetRelativePath)
    const sourceRoot = entry.source === 'electron' ? electronRoot : agentdRoot
    if (entry.sourcePath !== join(sourceRoot, entry.sourceRelativePath) || entry.targetPath !== join(targetRoot, entry.targetRelativePath)) throw new Error(`tampered migration path: ${entry.id}`)
    return entry
  })
  const results: ImportResult[] = []; const prior = new Map<string, FileSnapshot | undefined>(); const sources = new Map<string, FileSnapshot>(); const mutations: Mutation[] = []; const temps = new Set<string>()
  for (const entry of entries) {
    await noSymlinkComponents(entry.source === 'electron' ? electronRoot : agentdRoot, entry.sourcePath); await noSymlinkComponents(targetRoot, entry.targetPath)
    const source = await readNoFollow(entry.sourcePath); await validateBytes(entry.format, source.bytes, entry.sourcePath)
    if (source.bytes.length !== entry.byteSize || createHash('sha256').update(source.bytes).digest('hex') !== entry.sha256) throw new Error(`source changed during migration: ${entry.id}`)
    const existing = await targetSnapshot(entry.targetPath)
    if (existing?.bytes.equals(source.bytes)) { results.push({ id: entry.id, status: options.dryRun ? 'dry-run' : 'skipped' }); continue }
    prior.set(entry.id, existing); sources.set(entry.id, source); if (options.dryRun) results.push({ id: entry.id, status: 'dry-run' })
  }
  if (options.dryRun) return { results }
  // A fully skipped repeat import must not leave an empty recovery directory behind.
  if (sources.size === 0) return { results }
  for (const entry of entries) {
    const source = sources.get(entry.id); if (!source) continue
    const currentSource = await readNoFollow(entry.sourcePath); if (!sameIdentity(currentSource.identity, source.identity) || !currentSource.bytes.equals(source.bytes)) throw new Error(`source changed during migration: ${entry.id}`)
    const currentTarget = await targetSnapshot(entry.targetPath); const before = prior.get(entry.id)
    if ((before === undefined) !== (currentTarget === undefined) || (before && (!currentTarget || !sameIdentity(before.identity, currentTarget.identity) || !before.bytes.equals(currentTarget.bytes)))) throw new Error(`target changed during migration: ${entry.id}`)
  }
  const backupRoot = options.backupRoot ?? join(targetRoot, '.migration-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID())
  if (!inside(targetRoot, backupRoot) || backupRoot === targetRoot) throw new Error('unsafe migration backup path')
  await mkdirTreeNoSymlink(targetRoot, dirname(backupRoot)); await mkdir(backupRoot, { recursive: false, mode: 0o700 }); await checkDirectory(backupRoot)
  try {
    for (const entry of entries) {
      const old = prior.get(entry.id); if (old === undefined) continue
      const backupPath = join(backupRoot, entry.targetRelativePath); await mkdirTreeNoSymlink(backupRoot, dirname(backupPath)); await writeNew(backupPath, old.bytes); await syncDirectory(dirname(backupPath))
    }
    await syncDirectory(backupRoot)
    for (const entry of entries) {
      const source = sources.get(entry.id); if (!source) continue
      await noSymlinkComponents(targetRoot, entry.targetPath); const existing = await targetSnapshot(entry.targetPath); const before = prior.get(entry.id)
      if ((before === undefined) !== (existing === undefined) || (before && (!existing || !sameIdentity(before.identity, existing.identity) || !before.bytes.equals(existing.bytes)))) throw new Error(`target changed during migration: ${entry.id}`)
      const temp = `${entry.targetPath}.${randomUUID()}.tmp`; temps.add(temp); const tempIdentity = await writeNew(temp, source.bytes); await syncDirectory(dirname(entry.targetPath))
      let after: FileIdentity
      if (existing) {
        // Record before opening target. Partial writes still need guarded rollback.
        const mutation: Mutation = { entry, before, after: existing.identity }; mutations.push(mutation)
        after = await overwriteExisting(entry.targetPath, source.bytes, existing.identity); mutation.after = after; await unlink(temp)
      } else {
        await link(temp, entry.targetPath)
        // Hard link preserves temp identity, so mutation is known before any follow-up read.
        after = tempIdentity; mutations.push({ entry, before, after }); await unlink(temp)
      }
      temps.delete(temp); await syncDirectory(dirname(entry.targetPath))
      results.push({ id: entry.id, status: 'imported', backupPath: before ? join(backupRoot, entry.targetRelativePath) : undefined })
      if (options.failAfterStoreId === entry.id) throw new Error(`injected migration failure: ${entry.id}`)
    }
    return { results, backupRoot }
  } catch (error) {
    const rollbackFailures: string[] = []
    for (const mutation of mutations.reverse()) {
      try {
        const current = await targetSnapshot(mutation.entry.targetPath)
        if (!current || !sameSnapshot(current.identity, mutation.after)) throw new Error(`target changed; manual recovery required: ${mutation.entry.targetPath}`)
        if (options.failRollbackForStoreId === mutation.entry.id) throw new Error(`injected rollback failure: ${mutation.entry.id}`)
        if (mutation.before) await overwriteExisting(mutation.entry.targetPath, mutation.before.bytes, mutation.after)
        else await unlink(mutation.entry.targetPath)
        await syncDirectory(dirname(mutation.entry.targetPath))
      } catch (rollbackError) { rollbackFailures.push(`${mutation.entry.id}: ${(rollbackError as Error).message}`) }
    }
    for (const temp of temps) await unlink(temp).catch(() => undefined)
    // If no target rename completed, the backup is only a failed preparation artifact and
    // should not be presented as a recoverable snapshot. Removing the directory is safe for
    // the freshly-created path and keeps repeat/failed imports tidy.
    if (mutations.length === 0) await rm(backupRoot, { recursive: true, force: true }).catch(() => undefined)
    if (rollbackFailures.length) {
      const original = error instanceof Error ? error : new Error(String(error)); const combined = new Error(`${original.message}; rollback failures: ${rollbackFailures.join('; ')}`, { cause: original }); Object.assign(combined, { rollbackFailures }); throw combined
    }
    throw error
  }
}
