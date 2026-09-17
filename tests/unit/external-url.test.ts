import { describe, expect, it } from 'vitest'
import { isSafeExternalUrl } from '../../src/main/utils/external-url'

describe('external URL boundary', () => {
  it('allows web URLs only', () => {
    expect(isSafeExternalUrl('https://example.com/path')).toBe(true)
    expect(isSafeExternalUrl('http://localhost:8787')).toBe(true)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false)
    expect(isSafeExternalUrl('not a URL')).toBe(false)
  })
})
