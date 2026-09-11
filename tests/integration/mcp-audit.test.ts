import fs from 'node:fs'
import Database from 'better-sqlite3'
import { beforeAll, describe, expect, it, vi } from 'vitest'

const dataDir = '/tmp/aica-mcp-audit-test'
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))

import { recordMcpAudit } from '../../src/main/services/McpAudit'

describe('MCP audit persistence', () => {
  beforeAll(() => { fs.rmSync(dataDir, { recursive: true, force: true }); fs.mkdirSync(dataDir, { recursive: true }) })

  it('stores sanitized control outcomes locally', () => {
    recordMcpAudit('call-tool', 'server-1', 'read_status', 'denied', { reason: 'capability_allowlist' })
    const db = new Database(`${dataDir}/mcp-audit.db`, { readonly: true })
    expect(db.prepare('SELECT action, server_id, tool_name, outcome, details FROM mcp_audit').get()).toMatchObject({ action: 'call-tool', server_id: 'server-1', tool_name: 'read_status', outcome: 'denied' })
    db.close()
  })
})
