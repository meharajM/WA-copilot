import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

/**
 * AdminRelayService
 * 
 * Maps Admin Notification Message IDs to Customer JIDs.
 * This allows the bot to know that when an Admin replies to a 
 * "Unresolved Query" alert, it should forward that reply back 
 * to the specific customer.
 */
export class AdminRelayService {
    private static instance: AdminRelayService
    private relayMap: Map<string, string> = new Map()
    private persistPath: string

    private constructor() {
        this.persistPath = path.join(app.getPath('userData'), 'admin_relay_map.json')
        this.load()
    }

    public static getInstance(): AdminRelayService {
        if (!AdminRelayService.instance) {
            AdminRelayService.instance = new AdminRelayService()
        }
        return AdminRelayService.instance
    }

    public setRelay(adminMsgId: string, customerJid: string) {
        this.relayMap.set(adminMsgId, customerJid)
        this.save()
        
        // Cleanup old mappings after 24 hours to keep the map small
        setTimeout(() => {
            this.relayMap.delete(adminMsgId)
            this.save()
        }, 24 * 60 * 60 * 1000)
    }

    public getCustomerJid(adminMsgId: string): string | undefined {
        return this.relayMap.get(adminMsgId)
    }

    private save() {
        try {
            const data = JSON.stringify(Array.from(this.relayMap.entries()))
            fs.writeFileSync(this.persistPath, data)
        } catch (e) {
            console.error('[AdminRelay] Save error:', e)
        }
    }

    private load() {
        try {
            if (fs.existsSync(this.persistPath)) {
                const data = fs.readFileSync(this.persistPath, 'utf8')
                this.relayMap = new Map(JSON.parse(data))
            }
        } catch (e) {
            console.error('[AdminRelay] Load error:', e)
        }
    }
}
