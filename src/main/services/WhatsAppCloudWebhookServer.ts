import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { normalizeCloudDeliveryUpdates, normalizeCloudWebhook, verifyWebhookChallenge, verifyWebhookSignature } from './WhatsAppCloudWebhook'
import { autonomousSupervisor } from './AutonomousSupervisor'
import Store from 'electron-store'
import { readSecureSecret } from '../ipc/secure'

const MAX_BODY_BYTES = 1_000_000

export class WhatsAppCloudWebhookServer {
  private server: Server | null = null

  async start(): Promise<void> {
    const settings = new Store<Record<string, unknown>>({ name: 'aica-store', defaults: {} }) as Store<Record<string, unknown>> & { get: (key: string) => unknown }
    if (settings.get('whatsapp_transport') !== 'cloud' && process.env.WHATSAPP_TRANSPORT !== 'cloud') return
    const verifyToken = readSecureSecret('whatsapp_cloud_verify_token') || process.env.WHATSAPP_CLOUD_VERIFY_TOKEN
    const appSecret = readSecureSecret('whatsapp_cloud_app_secret') || process.env.WHATSAPP_CLOUD_APP_SECRET
    if (!verifyToken || !appSecret || this.server) return
    const port = Number(process.env.WHATSAPP_CLOUD_WEBHOOK_PORT || 8787)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid WHATSAPP_CLOUD_WEBHOOK_PORT')
    this.server = createServer((req, res) => void this.handle(req, res, verifyToken, appSecret))
    this.server.requestTimeout = 30_000
    this.server.headersTimeout = 35_000
    this.server.keepAliveTimeout = 5_000
    this.server.on('error', error => { console.error('[WhatsAppCloudWebhookServer] Listener error:', error); this.server = null })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('listening', () => resolve())
      this.server!.once('error', reject)
      this.server!.listen(port, '127.0.0.1')
    })
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>(resolve => server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse, verifyToken: string, appSecret: string): Promise<void> {
    if (req.method === 'GET') {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const challenge = verifyWebhookChallenge(url.searchParams.get('hub.mode'), url.searchParams.get('hub.verify_token'), url.searchParams.get('hub.challenge'), verifyToken)
      if (challenge) { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(challenge) } else { res.writeHead(403); res.end() }
      return
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    const declaredLength = Number(req.headers['content-length'] || 0)
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) { res.writeHead(413); res.end(); return }
    const body = await this.readBody(req)
    const signature = typeof req.headers['x-hub-signature-256'] === 'string' ? req.headers['x-hub-signature-256'] : undefined
    if (body === null || !verifyWebhookSignature(body, signature, appSecret)) { res.writeHead(401); res.end(); return }
    let payload: unknown
    try { payload = JSON.parse(body) } catch { res.writeHead(400); res.end(); return }
    for (const message of normalizeCloudWebhook(payload)) autonomousSupervisor.onMessage(message)
    for (const update of normalizeCloudDeliveryUpdates(payload)) autonomousSupervisor.onDeliveryUpdate(update)
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('EVENT_RECEIVED')
  }

  private readBody(req: IncomingMessage): Promise<string | null> {
    return new Promise(resolve => {
      let body = ''; let size = 0; let tooLarge = false
      req.setEncoding('utf8')
      req.on('data', chunk => { size += Buffer.byteLength(chunk); if (size <= MAX_BODY_BYTES) body += chunk; else tooLarge = true })
      req.on('end', () => resolve(tooLarge ? null : body))
      req.on('error', () => resolve(null))
    })
  }
}

export const whatsAppCloudWebhookServer = new WhatsAppCloudWebhookServer()
