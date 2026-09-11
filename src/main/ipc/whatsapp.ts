/**
 * whatsapp.ts — IPC handlers for WhatsApp operations.
 *
 * Thin router: validate args → call whatsappService → return result.
 * All business logic lives in WhatsAppService.ts.
 */

import { ipcMain, BrowserWindow } from 'electron'
import Store from 'electron-store'
import { whatsappService } from '../whatsapp/WhatsAppService'
import { autonomousSupervisor } from '../services/AutonomousSupervisor'
import { WhatsAppWebConnector } from '../services/WhatsAppWebConnector'
import { allowsBaileysDirectSend } from '../services/WhatsAppTransportPolicy'

const whatsappWebConnector = new WhatsAppWebConnector()

export function registerWhatsAppHandlers(): void {
    // Attempt auto-restore of saved session credentials
    const settings = new Store<Record<string, unknown>>({ name: 'aica-store', defaults: {} }) as Store<Record<string, unknown>> & { get: (key: string) => unknown }
    if (settings.get('whatsapp_transport') !== 'cloud' && settings.get('whatsapp_transport') !== 'web' && process.env.WHATSAPP_TRANSPORT !== 'cloud' && process.env.WHATSAPP_TRANSPORT !== 'web') {
        whatsappService.init()
            .then(() => autonomousSupervisor.recover())
            .catch(e => console.error('[whatsapp.ts] Init failed', e))
    } else autonomousSupervisor.recover()

    // ── One-way state push: main → renderer ─────────────────────────────────
    // When connection state changes, push it to all renderer windows.
    whatsappService.on('connectionChange', (state) => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send('whatsapp:connection-change', state)
            }
        }
    })

    // When a new WhatsApp message arrives, push it to all renderer windows.
    whatsappService.on('message', (message) => {
        autonomousSupervisor.onMessage(message)
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send('whatsapp:message', message)
            }
        }
    })

    // When a frustration escalation occurs, push it to all renderer windows.
    whatsappService.on('escalation', (data) => {
        for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) {
                win.webContents.send('whatsapp:escalation', data)
            }
        }
    })

    // ── Request/response handlers ────────────────────────────────────────────

    ipcMain.handle('whatsapp:get-state', async () => {
        return whatsappService.getConnectionState()
    })

    ipcMain.handle('whatsapp:connect', async (_event, phoneNumber: unknown) => {
        const phone = typeof phoneNumber === 'string' && phoneNumber.trim() !== '' ? phoneNumber.trim() : undefined
        try {
            await whatsappService.connect(phone)
            return { success: true }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipcMain.handle('whatsapp:disconnect', async (_event, clearAuth: unknown) => {
        try {
            await whatsappService.disconnect(clearAuth !== false)
            return { success: true }
        } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) }
        }
    })

    ipcMain.handle('whatsapp:send-message', async (_event, to: unknown, content: unknown) => {
        const selected = process.env.WHATSAPP_TRANSPORT || settings.get('whatsapp_transport')
        if (!allowsBaileysDirectSend(selected)) throw new Error('Direct Baileys sending is disabled while another WhatsApp transport is selected')
        if (typeof to !== 'string' || to.trim() === '') {
            throw new Error('Invalid "to" argument')
        }
        if (typeof content !== 'string' || content.trim() === '') {
            throw new Error('Invalid "content" argument')
        }
        return whatsappService.sendMessage(to.trim(), content.trim())
    })
    ipcMain.handle('whatsapp:send-presence', async (_event, to: unknown, state: unknown) => {
        if (typeof to !== 'string' || to.trim() === '') {
            throw new Error('Invalid "to" argument')
        }
        if (typeof state !== 'string' || !['unavailable', 'available', 'composing', 'recording', 'paused'].includes(state)) {
            throw new Error('Invalid "state" argument')
        }
        return whatsappService.sendPresence(to.trim(), state as 'unavailable' | 'available' | 'composing' | 'recording' | 'paused')
    })

    ipcMain.handle('whatsapp:send-media-message', async (_event, to: unknown, filePath: unknown, caption: unknown, type: unknown) => {
        const selected = process.env.WHATSAPP_TRANSPORT || settings.get('whatsapp_transport')
        if (!allowsBaileysDirectSend(selected)) throw new Error('Direct Baileys media sending is disabled while another WhatsApp transport is selected')
        if (typeof to !== 'string' || to.trim() === '') {
            throw new Error('Invalid "to" argument')
        }
        if (typeof filePath !== 'string' || filePath.trim() === '') {
            throw new Error('Invalid "filePath" argument')
        }
        
        const validTypes = ['image', 'video', 'audio', 'document']
        const mediaType = typeof type === 'string' && validTypes.includes(type) ? type : 'image'
        
        return whatsappService.sendMediaMessage(
            to.trim(),
            filePath.trim(),
            typeof caption === 'string' ? caption.trim() : undefined,
            mediaType as any
        )
    })

    ipcMain.handle('whatsapp:set-target-number', async (_event, phoneNumber: unknown) => {
        if (typeof phoneNumber !== 'string' || phoneNumber.trim() === '') {
            throw new Error('Invalid phone number argument')
        }
        return whatsappService.setTargetPhoneNumber(phoneNumber.trim())
    })
    ipcMain.handle('whatsapp-web:get-state', () => whatsappWebConnector.getState())
    ipcMain.handle('whatsapp-web:start', () => whatsappWebConnector.start())
    ipcMain.handle('whatsapp-web:stop', () => whatsappWebConnector.stop().then(() => whatsappWebConnector.getState()))
    ipcMain.handle('whatsapp-web:human-takeover', () => whatsappWebConnector.humanTakeover())
    ipcMain.handle('whatsapp-web:capture-failure', (_event, name: unknown) => whatsappWebConnector.captureFailure(typeof name === 'string' && /^[a-z0-9_-]{1,40}$/i.test(name) ? name : undefined))
    ipcMain.handle('whatsapp-web:start-monitoring', async (_event, chatId: unknown) => {
        if (typeof chatId !== 'string' || !/^[a-zA-Z0-9@._:+-]{1,200}$/.test(chatId)) throw new Error('Invalid WhatsApp Web conversation ID')
        await whatsappWebConnector.startMonitoring(chatId, message => autonomousSupervisor.onMessage(message))
        return whatsappWebConnector.getState()
    })
    ipcMain.handle('whatsapp-web:stop-monitoring', () => whatsappWebConnector.stopMonitoring())
}
