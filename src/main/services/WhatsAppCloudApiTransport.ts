export interface WhatsAppCloudApiConfig {
  phoneNumberId: string
  accessToken: string
  apiVersion: string
}

export interface CloudSendResult {
  providerMessageId: string
}

export class WhatsAppCloudApiTransport {
  constructor(private readonly config: WhatsAppCloudApiConfig) {}

  sendText(to: string, body: string): Promise<CloudSendResult> {
    return this.send({ messaging_product: 'whatsapp', to, type: 'text', text: { body } })
  }

  sendTemplate(to: string, name: string, languageCode: string, parameters: string[] = []): Promise<CloudSendResult> {
    return this.send({
      messaging_product: 'whatsapp', to, type: 'template',
      template: {
        name,
        language: { code: languageCode },
        ...(parameters.length ? { components: [{ type: 'body', parameters: parameters.map(text => ({ type: 'text', text })) }] } : {})
      }
    })
  }

  private async send(payload: Record<string, unknown>): Promise<CloudSendResult> {
    const response = await fetch(`https://graph.facebook.com/${this.config.apiVersion}/${this.config.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.config.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const data = await response.json().catch(() => ({})) as { messages?: Array<{ id?: string }>; error?: { message?: string } }
    if (!response.ok) throw new Error(data.error?.message || `WhatsApp Cloud API request failed (${response.status})`)
    const providerMessageId = data.messages?.[0]?.id
    if (!providerMessageId) throw new Error('WhatsApp Cloud API response did not include a message ID')
    return { providerMessageId }
  }
}
