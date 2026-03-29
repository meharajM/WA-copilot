import { describe, expect, it } from 'vitest'
import {
  ensureRecord,
  parseToolCallsFromJson,
  safeParseJSON,
} from '../../src/renderer/src/lib/llm/utils'

describe('llm utils', () => {
  it('parses standard tool_calls JSON format', () => {
    const content = JSON.stringify({
      tool_calls: [{ name: 'lookup_order', arguments: { orderId: 'A123' } }],
    })

    const calls = parseToolCallsFromJson(content)
    expect(calls).toHaveLength(1)
    expect(calls?.[0].name).toBe('lookup_order')
    expect(calls?.[0].arguments).toEqual({ orderId: 'A123' })
  })

  it('parses alternate tool JSON format', () => {
    const calls = parseToolCallsFromJson(
      '{"tool":"lookup_order","params":{"orderId":"B456"}}'
    )
    expect(calls).toHaveLength(1)
    expect(calls?.[0].name).toBe('lookup_order')
    expect(calls?.[0].arguments).toEqual({ orderId: 'B456' })
  })

  it('parses bare execution plan format', () => {
    const calls = parseToolCallsFromJson(
      JSON.stringify({
        goal: 'Find order',
        steps: [
          { id: '1', instruction: 'Open CRM' },
          { id: '2', instruction: 'Search order id' },
        ],
      })
    )

    expect(calls).toHaveLength(1)
    expect(calls?.[0].name).toBe('create_execution_plan')
    expect(calls?.[0].arguments).toMatchObject({
      goal: 'Find order',
    })
  })

  it('parses plan+commands format', () => {
    const calls = parseToolCallsFromJson(
      JSON.stringify({
        analysis: 'Need to search docs',
        commands: [
          { type: 'rag_search', query: 'refund policy' },
          { type: 'web_search', q: 'refund policy latest' },
        ],
      })
    )

    expect(calls).toHaveLength(2)
    expect(calls?.[0]).toMatchObject({
      name: 'rag_search',
      arguments: { query: 'refund policy' },
    })
    expect(calls?.[1]).toMatchObject({
      name: 'web_search',
      arguments: { q: 'refund policy latest' },
    })
  })

  it('extracts JSON from noisy text with safeParseJSON', () => {
    const parsed = safeParseJSON(
      'Result from tool:\n```json\n{"ok":true,"count":3}\n```\nDone.'
    ) as { ok: boolean; count: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.count).toBe(3)
  })

  it('normalizes records with ensureRecord', () => {
    expect(ensureRecord(null)).toEqual({})
    expect(ensureRecord('{"x":1}')).toEqual({ x: 1 })
    expect(ensureRecord('hello')).toEqual({ input: 'hello' })
    expect(ensureRecord(42)).toEqual({ value: 42 })
  })
})
