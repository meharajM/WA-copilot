import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { normalizeMetaDeliveryUpdates, normalizeMetaLeadEvents, normalizeMetaWebhook, verifyMetaWebhookSignature, type MetaDeliveryUpdate, type MetaMessagingChannel, type MetaLeadEvent } from './MetaMessaging'
import type { ChannelMessage } from '../packages/omnichannel'

const MAX_BODY_BYTES = 1_000_000

export class MetaWebhookServer {
  private server: Server | null = null
  constructor(private readonly onMessage: (message: ChannelMessage) => void, private readonly onLead?: (lead: MetaLeadEvent) => void, private readonly onDelivery?: (update: MetaDeliveryUpdate) => void) {}

  async start(channel: MetaMessagingChannel, verifyToken: string, appSecret: string, port: number): Promise<void> {
    if (this.server) return
    if (!verifyToken || !appSecret || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid Meta webhook configuration')
    this.server = createServer((req, res) => void this.handle(req, res, channel, verifyToken, appSecret))
    this.server.requestTimeout = 30_000
    this.server.headersTimeout = 35_000
    this.server.keepAliveTimeout = 5_000
    await new Promise<void>((resolve, reject) => { this.server!.once('listening', resolve); this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1') })
  }

  address(): string | null { const address = this.server?.address(); return address && typeof address === 'object' ? `127.0.0.1:${address.port}` : null }
  async stop(): Promise<void> { const server = this.server; this.server = null; if (server) await new Promise<void>(resolve => server.close(() => resolve())) }

  private async handle(req: IncomingMessage, res: ServerResponse, channel: MetaMessagingChannel, verifyToken: string, appSecret: string): Promise<void> {
    if (req.method === 'GET') {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.searchParams.get('hub.mode') === 'subscribe' && url.searchParams.get('hub.verify_token') === verifyToken && url.searchParams.get('hub.challenge')) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(url.searchParams.get('hub.challenge')); return }
      res.writeHead(403); res.end(); return
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const declaredLength = Number(req.headers['content-length'] || 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) { res.writeHead(413); res.end(); return }
    const body = await this.readBody(req)
    const signature = typeof req.headers['x-hub-signature-256'] === 'string' ? req.headers['x-hub-signature-256'] : undefined
    if (body === null || !verifyMetaWebhookSignature(body, signature, appSecret)) { res.writeHead(401); res.end(); return }
    let payload: unknown
    try { payload = JSON.parse(body) } catch { res.writeHead(400); res.end(); return }
    for (const message of normalizeMetaWebhook(payload, channel)) this.onMessage(message)
    for (const lead of normalizeMetaLeadEvents(payload)) this.onLead?.(lead)
    for (const update of normalizeMetaDeliveryUpdates(payload, channel)) this.onDelivery?.(update)
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('EVENT_RECEIVED')
  }

  private readBody(req: IncomingMessage): Promise<string | null> { return new Promise(resolve => { let body = ''; let size = 0; let tooLarge = false; req.setEncoding('utf8'); req.on('data', chunk => { size += Buffer.byteLength(chunk); if (size <= MAX_BODY_BYTES) body += chunk; else tooLarge = true }); req.on('end', () => resolve(tooLarge ? null : body)); req.on('error', () => resolve(null)) }) }
}
