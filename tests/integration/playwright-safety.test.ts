import { describe, expect, it } from 'vitest'
import { getPlaywrightTools } from '../../src/main/services/playwright/ToolRegistry'

describe('Playwright tool safety', () => {
  it('does not publish raw browser evaluation tools', () => {
    const names = getPlaywrightTools().flatMap(tool => [tool.name, ...tool.aliases])
    expect(names).not.toContain('evaluate')
    expect(names).not.toContain('browser_run_code')
  })
})
