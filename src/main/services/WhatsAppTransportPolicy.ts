export function allowsBaileysDirectSend(selected: unknown): boolean { return selected === undefined || selected === null || selected === '' || selected === 'baileys' }
export function allowsBaileysInbound(selected: unknown): boolean { return allowsBaileysDirectSend(selected) }
