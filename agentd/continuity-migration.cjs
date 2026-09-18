const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const Database = require('better-sqlite3')

const MANIFEST_VERSION = 1
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// This module deliberately stages into a new directory. It never replaces the
// live agentd database or reads credentials. Cutover remains a separate,
// schema-aware release gate.
const STORES = Object.freeze([
  { id: 'electron-settings', relativePath: 'aica-store.json', format: 'json', schemaVersion: 'electron.settings.v1', requiresReauthentication: true },
  { id: 'electron-persona', relativePath: 'business_profile.json', format: 'json', schemaVersion: 'persona.v1', requiresReauthentication: false },
  { id: 'electron-chat-history', relativePath: 'chat_history.v2.db', format: 'sqlite', schemaVersion: 'chat-history.v2', requiresReauthentication: true },
])
const SECRET_KEY = /(?:secret|token|password|passwd|api[_.-]?(?:key|secret|token)|private[_.-]?(?:key|secret)|refresh[_.-]?token|access[_.-]?token|cookie|session|authorization|credential|bearer|oauth|encryption[_.-]?(?:key|secret))/i
const SECRET_SCHEMA = /(?:^|[^a-z])(secret|token|password|passwd|api[_-]?(?:key|secret|token)|private[_-]?(?:key|secret)|refresh[_-]?token|access[_-]?token|session[_-]?(?:token|secret)|cookie|authorization|credential|bearer|oauth|encryption[_-]?(?:key|secret))(?:$|[^a-z])/i

function fail(message, statusCode = 400) {
  throw Object.assign(new Error(message), { statusCode })
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function isSecretMigrationKey(key) {
  return SECRET_KEY.test(String(key))
}

function assertNoSqliteSidecars(root, relativePath = 'chat_history.v2.db') {
  for (const suffix of ['-wal', '-shm']) {
    const filename = path.join(root, `${relativePath}${suffix}`)
    if (fs.existsSync(filename)) fail(`SQLite sidecar is not allowed: ${path.basename(filename)}`, 409)
  }
}

function writeAtomically(filename, bytes) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  let handle
  try {
    handle = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(handle, bytes)
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    handle = undefined
    fs.renameSync(temporary, filename)
    fs.chmodSync(filename, 0o600)
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle) } catch {}
    }
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
}

function writeNewAtomically(filename, bytes) {
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`
  let handle
  try {
    handle = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(handle, bytes)
    fs.fsyncSync(handle)
    fs.closeSync(handle)
    handle = undefined
    // Hard-linking a fully written temporary file makes destination creation
    // exclusive on both Unix and Windows; a concurrent destination cannot be
    // replaced by rename semantics.
    fs.linkSync(temporary, filename)
    fs.unlinkSync(temporary)
    fs.chmodSync(filename, 0o600)
  } catch (error) {
    if (handle !== undefined) {
      try { fs.closeSync(handle) } catch {}
    }
    try { fs.unlinkSync(temporary) } catch {}
    throw error
  }
}

function stagedFile(root, id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) fail('Invalid staged store id', 409)
  const filename = path.join(root, id)
  let listed
  try { listed = fs.lstatSync(filename) } catch (error) {
    if (error.code === 'ENOENT') fail(`Missing staged migration file: ${id}`, 409)
    throw error
  }
  if (!listed.isFile() || listed.isSymbolicLink()) fail(`Unsafe staged migration file: ${id}`, 409)
  return filename
}

function validateStagedSnapshot(stagingRoot, preview) {
  let rootStat
  try { rootStat = fs.lstatSync(stagingRoot) } catch (error) {
    if (error.code === 'ENOENT') fail('Migration staging disappeared', 409)
    throw error
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('Unsafe migration staging path', 409)
  const manifestPath = path.join(stagingRoot, 'manifest.json')
  let manifestStat
  try { manifestStat = fs.lstatSync(manifestPath) } catch (error) {
    if (error.code === 'ENOENT') fail('Migration manifest is incomplete', 409)
    throw error
  }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) fail('Unsafe migration manifest', 409)
  let persisted
  try { persisted = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) } catch { fail('Invalid migration manifest', 409) }
  if (persisted.version !== MANIFEST_VERSION || persisted.previewId !== preview.previewId
    || JSON.stringify(persisted.manifest) !== JSON.stringify(preview.manifest)) {
    fail('Staged migration manifest does not match preview', 409)
  }
  for (const entry of preview.manifest.entries) {
    const bytes = fs.readFileSync(stagedFile(stagingRoot, entry.id))
    if (bytes.length !== entry.byteSize || digest(bytes) !== entry.sha256) fail(`Staged migration file changed: ${entry.id}`, 409)
  }
  const allowed = new Set(['manifest.json', ...preview.manifest.entries.map(entry => entry.id)])
  for (const filename of fs.readdirSync(stagingRoot)) {
    if (!allowed.has(filename)) fail(`Unexpected staged migration file: ${filename}`, 409)
  }
  return true
}

function rootPath(input, targetRoot) {
  if (typeof input !== 'string' || !input.trim()) fail('Source folder is required')
  const source = fs.realpathSync(input)
  const target = fs.realpathSync(targetRoot)
  const sourceToTarget = path.relative(source, target)
  const targetToSource = path.relative(target, source)
  const inside = value => value !== '' && !value.startsWith('..' + path.sep) && !path.isAbsolute(value)
  if (!fs.statSync(source).isDirectory() || !fs.statSync(target).isDirectory() || sourceToTarget === '' || inside(sourceToTarget) || inside(targetToSource)) fail('Source folder cannot overlap agentd data')
  return source
}

function safeSourceFile(root, relativePath) {
  const candidate = path.resolve(root, relativePath)
  if (path.relative(root, candidate).startsWith('..') || !path.relative(root, candidate).split(path.sep).every(part => part !== '..')) fail('Unsafe migration path')
  if (!fs.existsSync(candidate)) return null
  const listed = fs.lstatSync(candidate)
  if (!listed.isFile() || listed.isSymbolicLink()) fail(`Unsafe migration file: ${relativePath}`)
  return candidate
}

function assertNoSecrets(value, location = '$') {
  if (Array.isArray(value)) return value.forEach((item, index) => assertNoSecrets(item, `${location}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (isSecretMigrationKey(key)) fail(`Secret field refused: ${location}.${key}`)
    assertNoSecrets(child, `${location}.${key}`)
  }
}

function validateSqlite(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const integrity = db.pragma('integrity_check')
    if (!Array.isArray(integrity) || integrity.some(row => row.integrity_check !== 'ok')) fail('SQLite integrity check failed')
    const schema = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL").all()
    if (schema.some(row => SECRET_SCHEMA.test(`${row.name} ${row.tbl_name} ${row.sql}`))) fail('Secret SQLite store refused')
  } catch (error) {
    if (error.statusCode) throw error
    fail(`Invalid SQLite store: ${error.message}`)
  } finally { db.close() }
}

function inspect(sourceRoot, targetRoot) {
  const root = rootPath(sourceRoot, targetRoot)
  const entries = []
  for (const store of STORES) {
    if (store.id === 'electron-chat-history') assertNoSqliteSidecars(root, store.relativePath)
    const sourcePath = safeSourceFile(root, store.relativePath)
    if (!sourcePath) continue
    const bytes = fs.readFileSync(sourcePath)
    if (!bytes.length) fail(`Empty migration store: ${store.id}`)
    if (store.format === 'json') {
      try { assertNoSecrets(JSON.parse(bytes.toString('utf8'))) } catch (error) {
        if (error.statusCode) throw error
        fail(`Invalid JSON store: ${store.id}`)
      }
    } else validateSqlite(sourcePath)
    entries.push({
      id: store.id,
      source: 'electron',
      target: 'staged-agentd',
      format: store.format,
      schemaVersion: store.schemaVersion,
      requiresReauthentication: store.requiresReauthentication,
      byteSize: bytes.length,
      sha256: digest(bytes),
    })
  }
  if (!entries.length) fail('No allowlisted Electron stores found', 404)
  return { sourceRoot: root, entries }
}

function createPreview(sourceRoot, targetRoot) {
  const manifest = inspect(sourceRoot, targetRoot)
  const previewId = crypto.randomUUID()
  return { previewId, createdAt: Date.now(), manifest }
}

function importPreview(preview, targetRoot) {
  if (!preview || typeof preview !== 'object' || !UUID.test(preview.previewId) || !preview.manifest || !Array.isArray(preview.manifest.entries)) fail('Invalid migration preview', 400)
  const stagingRoot = path.join(targetRoot, '.migration-staging', preview.previewId)
  const stagingParent = path.dirname(stagingRoot)
  if (fs.existsSync(stagingParent)) {
    const parentStat = fs.lstatSync(stagingParent)
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('Unsafe migration staging path')
  } else fs.mkdirSync(stagingParent, { recursive: false, mode: 0o700 })
  if (fs.existsSync(stagingRoot)) {
    // A native request may time out after the snapshot is complete. Validate
    // and return it instead of copying again or requiring a second preview.
    validateStagedSnapshot(stagingRoot, preview)
    return { migrationId: preview.previewId, state: 'staged', entries: preview.manifest.entries }
  }
  const latest = inspect(preview.manifest.sourceRoot, targetRoot)
  if (JSON.stringify(latest.entries) !== JSON.stringify(preview.manifest.entries)) fail('Source changed after preview', 409)
  fs.mkdirSync(stagingRoot, { recursive: false, mode: 0o700 })
  try {
    for (const entry of preview.manifest.entries) {
      const source = safeSourceFile(preview.manifest.sourceRoot, STORES.find(store => store.id === entry.id).relativePath)
      const destination = path.join(stagingRoot, entry.id)
      const bytes = fs.readFileSync(source)
      const sourceAfterRead = fs.lstatSync(source)
      if (!sourceAfterRead.isFile() || sourceAfterRead.isSymbolicLink() || bytes.length !== entry.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) fail(`Source changed after preview: ${entry.id}`, 409)
      writeNewAtomically(destination, bytes)
    }
    writeAtomically(path.join(stagingRoot, 'manifest.json'), Buffer.from(JSON.stringify({ version: MANIFEST_VERSION, ...preview, stagedAt: Date.now() }) + '\n'))
    return { migrationId: preview.previewId, state: 'staged', entries: preview.manifest.entries }
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true })
    throw error
  }
}

function rollback(migrationId, targetRoot) {
  if (typeof migrationId !== 'string' || !/^[0-9a-f-]{36}$/.test(migrationId)) fail('Invalid migration id')
  const stagingRoot = path.join(targetRoot, '.migration-staging', migrationId)
  if (!fs.existsSync(stagingRoot)) fail('Migration staging not found', 404)
  const listed = fs.lstatSync(stagingRoot)
  if (!listed.isDirectory() || listed.isSymbolicLink()) fail('Unsafe migration staging path')
  fs.rmSync(stagingRoot, { recursive: true, force: false })
  return { migrationId, state: 'rolled-back' }
}

module.exports = { assertNoSqliteSidecars, createPreview, importPreview, isSecretMigrationKey, rollback }
