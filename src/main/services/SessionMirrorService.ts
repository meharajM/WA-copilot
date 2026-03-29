import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'

/**
 * SessionMirrorService
 * 
 * Watches the chat sessions and saves them as separate, human-readable 
 * JSON and Markdown files in the user-data/sessions/ directory.
 * This fulfills the requirement for individual, portable files for each lead.
 */
export class SessionMirrorService {
  private static instance: SessionMirrorService
  private sessionsDir: string

  private constructor() {
    this.sessionsDir = path.join(app.getPath('userData'), 'sessions')
    if (!fs.existsSync(this.sessionsDir)) {
      fs.mkdirSync(this.sessionsDir, { recursive: true })
    }
  }

  public static getInstance(): SessionMirrorService {
    if (!SessionMirrorService.instance) {
      SessionMirrorService.instance = new SessionMirrorService()
    }
    return SessionMirrorService.instance
  }

  /**
   * Mirror a specific session as individual files
   */
  public mirrorSession(session: any) {
    try {
      const sessionId = session.id || `chat_${Date.now()}`
      const baseName = `${sessionId.replace(/[^a-z0-9]/gi, '_')}`
      
      // 1. Save as JSON
      const jsonPath = path.join(this.sessionsDir, `${baseName}.json`)
      fs.writeFileSync(jsonPath, JSON.stringify(session, null, 2))

      // 2. Save as Markdown (Human Readable)
      const mdPath = path.join(this.sessionsDir, `${baseName}.md`)
      const mdContent = this.convertToMarkdown(session)
      fs.writeFileSync(mdPath, mdContent)
      
      // console.log(`[MirrorService] Mirrored session ${sessionId} to ${mdPath}`)
    } catch (err) {
      console.error('[MirrorService] Failed to mirror session:', err)
    }
  }

  private convertToMarkdown(session: any): string {
    const title = session.title || 'Untitled Chat'
    const date = new Date(session.createdAt || Date.now()).toLocaleString()
    const status = session.status || 'active'
    const channel = session.channel || 'direct'
    
    let md = `# ${title}\n\n`
    md += `- **Session ID**: ${session.id}\n`
    md += `- **Date**: ${date}\n`
    md += `- **Status**: ${status.toUpperCase()}\n`
    md += `- **Channel**: ${channel}\n`
    if (session.topic) md += `- **Topic**: ${session.topic}\n`
    md += `\n---\n\n`

    if (session.messages && Array.isArray(session.messages)) {
      for (const msg of session.messages) {
        const time = new Date(msg.timestamp || Date.now()).toLocaleTimeString()
        const role = msg.role === 'user' ? '**Customer**' : '**Agent**'
        
        md += `### ${role} (${time})\n${msg.content}\n\n`
        
        if (msg.thought) {
          md += `> **Thought**: ${msg.thought.replace(/\n/g, '\n> ')}\n\n`
        }

        if (msg.toolCalls && msg.toolCalls.length > 0) {
          md += `#### Actions Taken:\n`
          for (const call of msg.toolCalls) {
            md += `- **${call.name}**: ${JSON.stringify(call.arguments)}\n`
            if (call.result) {
               md += `  - *Result*: ${call.result.substring(0, 100)}${call.result.length > 100 ? '...' : ''}\n`
            }
          }
          md += '\n'
        }
      }
    }

    return md
  }

  public registerIpc() {
    // We already handle session mirroring via the save-sessions IPC call
    // But we might want to trigger a manual mirror or open folder
    const { ipcMain, shell } = require('electron')
    
    ipcMain.handle('sessions:open-folder', async () => {
       shell.openPath(this.sessionsDir)
       return { success: true }
    })
  }
}
