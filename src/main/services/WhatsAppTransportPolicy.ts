export function allowsBaileysDirectSend(selected: unknown): boolean { return selected === undefined || selected === null || selected === '' || selected === 'baileys' }
export function allowsBaileysInbound(selected: unknown): boolean { return allowsBaileysDirectSend(selected) }
/** Browser-extension messages are a WhatsApp Web ingress, never a Baileys ingress. */
export function allowsBrowserExtensionInbound(selected: unknown): boolean { return selected === 'web' }
