import { describe, expect, it } from 'vitest'
import { readableAgentError } from '../../src/renderer/src/hooks/useAgent'

describe('useAgent error normalization', () => {
  it('preserves safe string and structured native-host errors', () => {
    expect(readableAgentError('Provider unavailable')).toBe('Provider unavailable')
    expect(readableAgentError({ error: 'Chat generation unavailable' })).toBe('Chat generation unavailable')
    expect(readableAgentError({ message: 'agentd stopped' })).toBe('agentd stopped')
  })

  it('does not leak arbitrary object text into the UI', () => {
    expect(readableAgentError({ secret: 'must not render' })).toBe('Unknown error')
  })
})
