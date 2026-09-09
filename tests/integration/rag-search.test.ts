import { describe, expect, it } from 'vitest'
import { buildFtsQuery } from '../../src/main/packages/rag-engine'

describe('RAG FTS query normalization', () => {
  it('preserves Unicode terms and neutralizes FTS operators', () => {
    expect(buildFtsQuery('नमस्ते दुकान!!! OR price:*')).toBe('"नमस्ते" "दुकान" "OR" "price"')
  })
})
