const MCP_ARGS_MAX_BYTES = 64 * 1024
const INTERNAL_COMMANDS = new Set(['internal', 'internal-memory', 'internal-rag', 'internal-filesystem', 'internal-autonomy'])
const ALLOWED_UVX_PACKAGES = new Set(['markitdown-mcp[all]', 'mcp-email-server==0.6.2'])
const DISALLOWED_BROWSER_TOOLS = new Set(['evaluate', 'browser_run_code'])

export function validateMcpServerConfig(config: unknown): { valid: true; config: Record<string, any> } | { valid: false; error: string } {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return { valid: false, error: 'Invalid MCP server configuration' }
  const value = config as Record<string, any>
  if (value.allowedTools !== undefined && (!Array.isArray(value.allowedTools) || value.allowedTools.length > 100 || value.allowedTools.some((tool: unknown) => typeof tool !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(tool)))) return { valid: false, error: 'Invalid MCP capability allowlist' }
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(value.id)) return { valid: false, error: 'Invalid MCP server ID' }
  if (value.type !== 'stdio' && value.type !== 'sse') return { valid: false, error: 'Unsupported MCP transport type' }
  if (value.type === 'stdio') {
    if (typeof value.command !== 'string' || !value.command) return { valid: false, error: 'MCP stdio command is required' }
    const args = Array.isArray(value.args) ? value.args : []
    if (INTERNAL_COMMANDS.has(value.command)) {
      if (args.length > 0) return { valid: false, error: 'Internal MCP servers do not accept process arguments' }
    } else if (value.command !== 'uvx' || args.length === 0 || !ALLOWED_UVX_PACKAGES.has(args[0])) {
      return { valid: false, error: 'MCP stdio command is not approved' }
    }
    if (args.some((arg: unknown) => typeof arg !== 'string' || ['-e', '--eval', '-c', '--command'].includes(arg))) return { valid: false, error: 'MCP eval/command flags are not allowed' }
  } else if (typeof value.url !== 'string' || !/^https?:\/\//i.test(value.url)) return { valid: false, error: 'MCP SSE URL must use HTTP(S)' }
  return { valid: true, config: value }
}

export function isMcpToolAllowed(allowedTools: unknown, toolName: string): boolean {
  return Array.isArray(allowedTools) && allowedTools.includes(toolName)
}

export function validateMcpToolCall(serverId: unknown, toolName: unknown, args: unknown): string | null {
  if (typeof serverId !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(serverId)) return 'Invalid MCP server ID'
  if (typeof toolName !== 'string' || !/^[a-zA-Z0-9._-]{1,160}$/.test(toolName)) return 'Invalid MCP tool name'
  if (DISALLOWED_BROWSER_TOOLS.has(toolName)) return 'Raw browser evaluation is disabled'
  try { if (Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8') > MCP_ARGS_MAX_BYTES) return 'MCP arguments exceed 64KB' } catch { return 'MCP arguments are not serializable' }
  return null
}
