import { describe, expect, it } from 'vitest'
import {
  isSameWhatsAppIdentity,
  normalizeWhatsAppId,
} from '../../src/shared/whatsappIdentity'

describe('whatsapp identity matching', () => {
  it('normalizes JID, phone, and device variants to digits', () => {
    expect(normalizeWhatsAppId('+1 (415) 555-1212')).toBe('14155551212')
    expect(normalizeWhatsAppId('14155551212@s.whatsapp.net')).toBe(
      '14155551212'
    )
    expect(normalizeWhatsAppId('14155551212:16@s.whatsapp.net')).toBe(
      '14155551212'
    )
  })

  it('matches exact identity', () => {
    expect(
      isSameWhatsAppIdentity('14155551212@s.whatsapp.net', '+1-415-555-1212')
    ).toBe(true)
  })

  it('matches suffix-compatible identity for partial country code variants', () => {
    expect(isSameWhatsAppIdentity('919876543210@s.whatsapp.net', '9876543210')).toBe(
      true
    )
    expect(isSameWhatsAppIdentity('9876543210@s.whatsapp.net', '919876543210')).toBe(
      true
    )
  })

  it('does not match unrelated identities', () => {
    expect(isSameWhatsAppIdentity('14155550000@s.whatsapp.net', '14155559999')).toBe(
      false
    )
  })

  it('returns false for empty inputs', () => {
    expect(isSameWhatsAppIdentity(undefined, '14155551212')).toBe(false)
    expect(isSameWhatsAppIdentity('', '')).toBe(false)
  })
})
