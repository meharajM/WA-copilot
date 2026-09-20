import { describe, expect, it } from 'vitest'
import { isMcpToolAllowed, validateMcpRequestId, validateMcpServerConfig, validateMcpToolCall } from '../../src/main/services/McpPolicy'

describe('MCP host policy', () => {
  it('rejects shell and eval launches', () => {
    expect(validateMcpServerConfig({ id: 'x', type: 'stdio', command: 'bash' })).toMatchObject({ valid: false })
    expect(validateMcpServerConfig({ id: 'x', type: 'stdio', command: 'node', args: ['--eval', 'process.exit()'] })).toMatchObject({ valid: false })
    expect(validateMcpServerConfig({ id: 'x', type: 'stdio', command: 'node', args: ['server.js'] })).toMatchObject({ valid: false })
    expect(validateMcpServerConfig({ id: 'x', type: 'stdio', command: 'uvx', args: ['arbitrary-package'] })).toMatchObject({ valid: false })
    expect(validateMcpServerConfig({ id: 'markitdown', type: 'stdio', command: 'uvx', args: ['markitdown-mcp[all]'] })).toMatchObject({ valid: true })
    expect(validateMcpServerConfig({ id: 'internal', type: 'stdio', command: 'internal', args: [] })).toMatchObject({ valid: true })
    expect(validateMcpServerConfig({ id: 'autonomy', type: 'stdio', command: 'internal-autonomy', args: [] })).toMatchObject({ valid: true })
  })

  it('bounds tool identity and argument size', () => {
    expect(validateMcpToolCall('server', 'browser_evaluate', { script: 'x'.repeat(65 * 1024) })).toBe('MCP arguments exceed 64KB')
    expect(validateMcpToolCall('bad/id', 'tool', {})).toBe('Invalid MCP server ID')
    expect(validateMcpToolCall('server', 'bad/name!', {})).toBe('Invalid MCP tool name')
    expect(validateMcpToolCall('server', 'evaluate', { script: 'document.body' })).toBe('Raw browser evaluation is disabled')
    expect(validateMcpToolCall('server', 'browser_run_code', { script: 'document.body' })).toBe('Raw browser evaluation is disabled')
  })

  it('defaults external capability checks to deny', () => {
    expect(isMcpToolAllowed(undefined, 'browser_navigate')).toBe(false)
    expect(isMcpToolAllowed(['convert_to_markdown'], 'convert_to_markdown')).toBe(true)
    expect(validateMcpServerConfig({ id: 'x', type: 'sse', url: 'https://example.test', allowedTools: ['tool'] })).toMatchObject({ valid: true })
  })

  it('validates cancellable request IDs before dispatch', () => {
    expect(validateMcpRequestId(undefined)).toBeNull()
    expect(validateMcpRequestId('request-1')).toBeNull()
    expect(validateMcpRequestId(42)).toBe('Invalid MCP request ID')
    expect(validateMcpRequestId('x'.repeat(101))).toBe('Invalid MCP request ID')
  })
})
