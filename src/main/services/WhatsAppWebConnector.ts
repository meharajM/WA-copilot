import { app } from 'electron'
import type { Page } from 'playwright-core'
import { BrowserManager } from './playwright/BrowserManager'
import type { WhatsAppMessage } from '../whatsapp/WhatsAppService'

export type WhatsAppWebStatus = 'disconnected' | 'connecting' | 'qr_required' | 'connected' | 'logged_out' | 'error' | 'human_takeover'
export interface WhatsAppWebState { status: WhatsAppWebStatus; error: string | null; lastHealthCheck: number; profile: string }

export function normalizeWhatsAppWebDomMessage(id: string, content: string, chatId: string, timestamp = Date.now()): WhatsAppMessage | null {
  if (!id || !content.trim() || !chatId) return null
  return { id, from: chatId, to: '', content: content.trim(), timestamp, type: 'text', isFromMe: false }
}

export function classifyWhatsAppWebPage(hasQr: boolean, url: string): WhatsAppWebStatus {
  if (/\/auth|logged.?out/i.test(url)) return 'logged_out'
  if (hasQr) return 'qr_required'
  return /web\.whatsapp\.com/i.test(url) ? 'connected' : 'connecting'
}

export class WhatsAppWebConnector {
  private readonly browser = new BrowserManager('whatsapp-web-profile')
  private monitorTimer: NodeJS.Timeout | null = null
  private healthTimer: NodeJS.Timeout | null = null
  private readonly seenDomMessageIds = new Set<string>()
  private state: WhatsAppWebState = { status: 'disconnected', error: null, lastHealthCheck: 0, profile: 'whatsapp-web-profile' }

  async start(): Promise<WhatsAppWebState> {
    try {
      this.state = { ...this.state, status: 'connecting', error: null }
      const page = await this.browser.getPage(undefined)
      await page.goto('https://web.whatsapp.com', { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await this.refresh(page)
      this.startHealthMonitor()
    } catch (error) { this.state = { ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error) } }
    return this.getState()
  }

  async healthCheck(): Promise<WhatsAppWebState> { const page = this.browser.getCurrentPage(); if (page && !page.isClosed()) await this.refresh(page); else this.state = { ...this.state, status: 'disconnected', lastHealthCheck: Date.now() }; return this.getState() }
  async startMonitoring(chatId: string, onMessage: (message: WhatsAppMessage) => void): Promise<void> {
    if (!chatId.trim()) throw new Error('WhatsApp Web monitoring requires a conversation ID')
    const page = this.browser.getCurrentPage() || await this.browser.getPage(undefined)
    if (this.monitorTimer) clearInterval(this.monitorTimer)
    this.monitorTimer = setInterval(() => void this.pollIncoming(page, chatId, onMessage), 2_000)
    this.startHealthMonitor()
    await this.pollIncoming(page, chatId, onMessage)
  }
  stopMonitoring(): void { if (this.monitorTimer) clearInterval(this.monitorTimer); this.monitorTimer = null }
  async humanTakeover(): Promise<WhatsAppWebState> { await this.browser.surfaceBrowser(); this.state = { ...this.state, status: 'human_takeover', error: null, lastHealthCheck: Date.now() }; return this.getState() }
  async captureFailure(name = 'whatsapp-web-failure'): Promise<string | null> { const page = this.browser.getCurrentPage(); if (!page || page.isClosed()) return null; const target = `${app.getPath('userData')}/${name}-${Date.now()}.png`; await page.screenshot({ path: target }).catch(() => {}); return target }
  async stop(): Promise<void> { this.stopMonitoring(); if (this.healthTimer) clearInterval(this.healthTimer); this.healthTimer = null; await this.browser.close(); this.state = { ...this.state, status: 'disconnected', lastHealthCheck: Date.now() } }
  getState(): WhatsAppWebState { return { ...this.state } }

  private startHealthMonitor(): void { if (this.healthTimer) return; this.healthTimer = setInterval(() => void this.healthCheck(), 30_000); this.healthTimer.unref?.() }
  private async refresh(page: Page): Promise<void> { try { const count = await page.locator('canvas').count(); this.state = { ...this.state, status: classifyWhatsAppWebPage(count > 0, page.url()), lastHealthCheck: Date.now() } } catch (error) { this.state = { ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error), lastHealthCheck: Date.now() } } }
  private async pollIncoming(page: Page, chatId: string, onMessage: (message: WhatsAppMessage) => void): Promise<void> {
    try {
      const messages = page.locator('[data-id^="false_"]')
      for (let index = 0, count = await messages.count(); index < count; index++) {
        const node = messages.nth(index)
        const id = await node.getAttribute('data-id')
        if (!id || this.seenDomMessageIds.has(id)) continue
        const message = normalizeWhatsAppWebDomMessage(id, await node.innerText(), chatId)
        this.seenDomMessageIds.add(id)
        if (message) onMessage(message)
      }
    } catch (error) { this.state = { ...this.state, status: 'error', error: error instanceof Error ? error.message : String(error), lastHealthCheck: Date.now() } }
  }
}

export const whatsappWebConnector = new WhatsAppWebConnector()
