import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { normalizeXDirectMessage, verifyXWebhookSignature, xCrcResponse } from './XDirectMessages'
import type { ChannelMessage } from '../packages/omnichannel'

const MAX_BODY_BYTES = 1_000_000

export class XWebhookServer {
  private server: Server | null = null
  constructor(private readonly onMessage: (message: ChannelMessage) => void) {}
  async start(consumerSecret: string, port: number, accountId = ''): Promise<void> {
    if (this.server) return
    if (!consumerSecret || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid X webhook configuration')
    this.server = createServer((req, res) => void this.handle(req, res, consumerSecret, accountId))
    await new Promise<void>((resolve, reject) => { this.server!.once('listening', resolve); this.server!.once('error', reject); this.server!.listen(port, '127.0.0.1') })
  }
  address(): string | null { const address = this.server?.address(); return address && typeof address === 'object' ? `127.0.0.1:${address.port}` : null }
  async stop(): Promise<void> { const server = this.server; this.server = null; if (server) await new Promise<void>(resolve => server.close(() => resolve())) }
  private async handle(req: IncomingMessage, res: ServerResponse, secret: string, accountId: string): Promise<void> {
    if (req.method === 'GET') { const token = new URL(req.url || '/', 'http://127.0.0.1').searchParams.get('crc_token'); if (!token) { res.writeHead(400); res.end(); return }; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(xCrcResponse(token, secret))); return }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const body = await this.readBody(req)
    const signature = typeof req.headers['x-twitter-webhooks-signature'] === 'string' ? req.headers['x-twitter-webhooks-signature'] : undefined
    if (body === null || !verifyXWebhookSignature(body, signature, secret)) { res.writeHead(401); res.end(); return }
    try { for (const message of normalizeXDirectMessage(JSON.parse(body), accountId)) this.onMessage(message) } catch { res.writeHead(400); res.end(); return }
    res.writeHead(200); res.end('EVENT_RECEIVED')
  }
  private readBody(req: IncomingMessage): Promise<string | null> { return new Promise(resolve => { let body = ''; let size = 0; let tooLarge = false; req.setEncoding('utf8'); req.on('data', chunk => { size += Buffer.byteLength(chunk); if (size <= MAX_BODY_BYTES) body += chunk; else tooLarge = true }); req.on('end', () => resolve(tooLarge ? null : body)); req.on('error', () => resolve(null)) }) }
}
