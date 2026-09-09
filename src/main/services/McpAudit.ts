import Database from 'better-sqlite3'
import { app } from 'electron'
import * as path from 'node:path'

let db: Database.Database | undefined

function getDb(): Database.Database {
  return db ??= (() => {
    const value = new Database(path.join(app.getPath('userData'), 'mcp-audit.db'))
    value.exec('CREATE TABLE IF NOT EXISTS mcp_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, server_id TEXT, tool_name TEXT, outcome TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_mcp_audit_created ON mcp_audit(created_at)')
    return value
  })()
}

export function recordMcpAudit(action: string, serverId: string | null, toolName: string | null, outcome: 'allowed' | 'denied' | 'success' | 'failure', details: Record<string, unknown> = {}): void {
  try {
    const now = Date.now()
    getDb().prepare('INSERT INTO mcp_audit (action,server_id,tool_name,outcome,details,created_at) VALUES (?,?,?,?,?,?)').run(action, serverId, toolName, outcome, JSON.stringify(details), now)
    getDb().prepare('DELETE FROM mcp_audit WHERE created_at < ?').run(now - 90 * 24 * 60 * 60 * 1000)
  } catch (error) { console.error('[MCP] audit write failed', error) }
}
