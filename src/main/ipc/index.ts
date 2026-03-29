import { registerAppHandlers } from './app'
import { registerMcpHandlers } from './mcp'
import { registerLlmHandlers } from './llm'
import { registerStoreHandlers } from './store'
import { registerLogsHandlers } from './logs'
import { registerSpeechHandlers } from './speech'
import { registerSecureHandlers } from './secure'
import { registerFsHandlers } from './fs'
import { registerMemoryHandlers } from './memory'
import { registerAntigravityHandlers } from './antigravity'
import { ipcMain } from 'electron'
import { registerWhatsAppHandlers } from './whatsapp'
import { RAGEngine } from '../packages/rag-engine/index'
import { BusinessPersona } from '../packages/persona/index'
import { whatsappService } from '../whatsapp/WhatsAppService'
import { IntelligenceService } from '../services/IntelligenceService'
import { ChatPersistenceService } from '../services/ChatPersistenceService'
import { SessionMirrorService } from '../services/SessionMirrorService'

export function setupIpcHandlers(): void {
    registerAppHandlers()
    registerMcpHandlers()
    registerMemoryHandlers()
    registerLlmHandlers()
    registerStoreHandlers()
    registerLogsHandlers()
    registerSpeechHandlers()
    registerSecureHandlers()
    registerFsHandlers()
    registerAntigravityHandlers()
    registerWhatsAppHandlers()
    
    // Self-learning analytics
    ipcMain.handle('intelligence:get-knowledge', async () => {
        return RAGEngine.getInstance().getAllDocuments()
    })
    ipcMain.handle('intelligence:delete-knowledge', async (_, id: number) => {
        return RAGEngine.getInstance().deleteDocument(id)
    })
    ipcMain.handle('intelligence:get-persona', async () => {
        return BusinessPersona.getInstance().getProfile()
    })
    ipcMain.handle('intelligence:update-persona', async (_, updates: any) => {
        return BusinessPersona.getInstance().updateProfile(updates)
    })
    IntelligenceService.getInstance().registerIpc()
    
    // Setup Chat Persistence & Mirroring
    const chatPersistence = ChatPersistenceService.getInstance()
    const mirrorService = SessionMirrorService.getInstance()
    
    chatPersistence.registerIpc()
    mirrorService.registerIpc()

    // Extend 'chat:save-sessions' to also trigger mirroring for each session
    ipcMain.handle('chat:save-sessions-with-mirror', async (_event, sessions: any[]) => {
        try {
            for (const s of sessions) {
                chatPersistence.saveSession(s)
                mirrorService.mirrorSession(s)
            }
            return { success: true }
        } catch (err) {
            console.error('[Persistence] Save/Mirror error:', err)
            return { success: false, error: String(err) }
        }
    })

    // Agent Admin Escalation
    ipcMain.handle('whatsapp:notify-admin', async (_event, { customerJid, summary, mainQuestion }) => {
        return whatsappService.notifyAdminUnresolved(customerJid, summary, mainQuestion)
    })
}
