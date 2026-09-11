import { beforeEach, describe, expect, it } from 'vitest'
import { useWhatsAppStore } from '../../src/renderer/src/stores/whatsappStore'
import {
  getWhatsAppSystemPrompt,
  resolveWhatsAppMessageToLLM,
  resolveWhatsAppTarget,
} from '../../src/renderer/src/lib/whatsapp-integration'

function resetWhatsAppStore(): void {
  useWhatsAppStore.setState({
    connectionState: {
      status: 'disconnected',
      qrCode: null,
      error: null,
      phoneNumber: null,
      workerNumber: null,
      handshakeStatus: 'idle',
    },
    whatsappEnabled: false,
    businessBotMode: false,
    targetPhoneNumber: null,
    isDialogOpen: false,
  })
}

describe('whatsapp integration contracts', () => {
  beforeEach(() => {
    resetWhatsAppStore()
  })

  it('resolves explicit WhatsApp JID from formatted message when connected', () => {
    useWhatsAppStore.setState({
      whatsappEnabled: true,
      connectionState: {
        ...useWhatsAppStore.getState().connectionState,
        status: 'connected',
        phoneNumber: '14155551212@s.whatsapp.net',
      },
    })

    const resolved = resolveWhatsAppTarget(
      '📱 **WhatsApp** (9876543210@s.whatsapp.net): customer asked about refund'
    )
    expect(resolved).toBe('9876543210@s.whatsapp.net')
  })

  it('resolves explicit WhatsApp JID when autonomous bot mode is connected', () => {
    useWhatsAppStore.setState({
      businessBotMode: true,
      connectionState: {
        ...useWhatsAppStore.getState().connectionState,
        status: 'connected',
        phoneNumber: '14155551212@s.whatsapp.net',
      },
    })

    const resolved = resolveWhatsAppTarget(
      '📱 **WhatsApp** (9876543210@s.whatsapp.net): customer asked about refund'
    )
    expect(resolved).toBe('9876543210@s.whatsapp.net')
  })

  it('returns null when disconnected even if a JID is present in message', () => {
    const resolved = resolveWhatsAppTarget(
      '📱 **WhatsApp** (9876543210@s.whatsapp.net): test'
    )
    expect(resolved).toBeNull()
  })

  it('falls back to connected admin phone when no explicit JID is present', () => {
    useWhatsAppStore.setState({
      whatsappEnabled: true,
      connectionState: {
        ...useWhatsAppStore.getState().connectionState,
        status: 'connected',
        phoneNumber: '14155550000@s.whatsapp.net',
      },
    })

    const resolved = resolveWhatsAppTarget('hello there')
    expect(resolved).toBe('14155550000@s.whatsapp.net')
  })

  it('switches to admin prompt for sender matching admin identity', () => {
    useWhatsAppStore.setState({
      connectionState: {
        ...useWhatsAppStore.getState().connectionState,
        phoneNumber: '919876543210@s.whatsapp.net',
      },
    })

    const prompt = getWhatsAppSystemPrompt('9876543210@s.whatsapp.net')
    expect(prompt.content).toContain('WHATSAPP ADMIN MODE ACTIVE')
  })

  it('uses customer support prompt for non-admin sender', () => {
    useWhatsAppStore.setState({
      connectionState: {
        ...useWhatsAppStore.getState().connectionState,
        phoneNumber: '14155550000@s.whatsapp.net',
      },
    })

    const prompt = getWhatsAppSystemPrompt('14155559999@s.whatsapp.net')
    expect(prompt.content).toContain('WHATSAPP CUSTOMER SUPPORT MODE ACTIVE')
  })

  it('converts plain text WhatsApp message to LLM message', async () => {
    const llmMessage = await resolveWhatsAppMessageToLLM({
      id: 'm1',
      from: '14155551212@s.whatsapp.net',
      to: '14155550000@s.whatsapp.net',
      content: 'Do you offer same-day delivery?',
      type: 'text',
      timestamp: Date.now(),
      isFromMe: false,
    })

    expect(llmMessage.role).toBe('user')
    expect(llmMessage.content).toBe('Do you offer same-day delivery?')
    expect(llmMessage.attachments).toBeUndefined()
  })
})
