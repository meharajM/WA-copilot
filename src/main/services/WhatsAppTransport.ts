import Store from 'electron-store'
import { readSecureSecret } from '../ipc/secure'
import { whatsappService } from '../whatsapp/WhatsAppService'
import { WhatsAppCloudApiTransport } from './WhatsAppCloudApiTransport'
export { allowsBaileysDirectSend } from './WhatsAppTransportPolicy'

export interface WhatsAppOutboundTransport {
  readonly kind: 'baileys' | 'cloud' | 'web'
  sendText(to: string, body: string): Promise<{ success: boolean; providerMessageId?: string; error?: string }>
  sendTemplate(to: string, name: string, languageCode: string, parameters?: string[]): Promise<{ success: boolean; providerMessageId?: string; error?: string }>
}

class BaileysOutboundTransport implements WhatsAppOutboundTransport {
  readonly kind = 'baileys' as const
  sendText(to: string, body: string) { return whatsappService.sendMessage(to, body) }
  async sendTemplate() { return { success: false, error: 'Approved templates require WhatsApp Cloud transport' } }
}

class CloudOutboundTransport implements WhatsAppOutboundTransport {
  readonly kind = 'cloud' as const
  constructor(private readonly transport: WhatsAppCloudApiTransport) {}
  async sendText(to: string, body: string) {
    try { return { success: true, ...(await this.transport.sendText(to, body)) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  }
  async sendTemplate(to: string, name: string, languageCode: string, parameters: string[] = []) {
    try { return { success: true, ...(await this.transport.sendTemplate(to, name, languageCode, parameters)) } }
    catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) } }
  }
}

class WebOutboundTransport implements WhatsAppOutboundTransport {
  readonly kind = 'web' as const
  async sendText() { return { success: false, error: 'WhatsApp Web transport is manual-takeover-only until live send semantics are verified' } }
  async sendTemplate() { return { success: false, error: 'WhatsApp Web does not support approved template dispatch' } }
}

export function createWhatsAppOutboundTransport(): WhatsAppOutboundTransport {
  const settings = new Store<Record<string, unknown>>({ name: 'aica-store', defaults: {} }) as Store<Record<string, unknown>> & { get: (key: string) => unknown }
  const selected = process.env.WHATSAPP_TRANSPORT || settings.get('whatsapp_transport')
  if (selected === 'web') return new WebOutboundTransport()
  if (selected !== 'cloud') return new BaileysOutboundTransport()
  const phoneNumberId = settings.get('whatsapp_cloud_phone_number_id')
  const apiVersion = settings.get('whatsapp_cloud_api_version')
  const accessToken = readSecureSecret('whatsapp_cloud_access_token')
  if (typeof phoneNumberId !== 'string' || !phoneNumberId || typeof apiVersion !== 'string' || !apiVersion || !accessToken) {
    throw new Error('Cloud transport is selected but its credentials are incomplete')
  }
  return new CloudOutboundTransport(new WhatsAppCloudApiTransport({ phoneNumberId, apiVersion, accessToken }))
}
