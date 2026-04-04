import { beforeEach, describe, expect, it } from 'vitest'
import { useWhatsAppStore } from '../../src/renderer/src/stores/whatsappStore'

function resetStore(): void {
  localStorage.removeItem('aica-whatsapp-v1')
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

describe('whatsapp store contracts', () => {
  beforeEach(() => {
    resetStore()
  })

  it('toggles operational flags and target phone', () => {
    const store = useWhatsAppStore.getState()
    store.setWhatsAppEnabled(true)
    store.setBusinessBotMode(true)
    store.setTargetPhoneNumber('14155550000@s.whatsapp.net')

    const state = useWhatsAppStore.getState()
    expect(state.whatsappEnabled).toBe(true)
    expect(state.businessBotMode).toBe(true)
    expect(state.targetPhoneNumber).toBe('14155550000@s.whatsapp.net')
  })

  it('updates runtime connection state separately from persisted toggles', () => {
    useWhatsAppStore.getState().setWhatsAppEnabled(true)
    useWhatsAppStore.getState().setConnectionState({
      status: 'connected',
      qrCode: null,
      error: null,
      phoneNumber: '14155550000@s.whatsapp.net',
      workerNumber: '14155559999@s.whatsapp.net',
      handshakeStatus: 'verified',
    })

    const state = useWhatsAppStore.getState()
    expect(state.whatsappEnabled).toBe(true)
    expect(state.connectionState.status).toBe('connected')
    expect(state.connectionState.handshakeStatus).toBe('verified')
  })

  it('opens and closes connection dialog state', () => {
    useWhatsAppStore.getState().openDialog()
    expect(useWhatsAppStore.getState().isDialogOpen).toBe(true)
    useWhatsAppStore.getState().closeDialog()
    expect(useWhatsAppStore.getState().isDialogOpen).toBe(false)
  })
})

