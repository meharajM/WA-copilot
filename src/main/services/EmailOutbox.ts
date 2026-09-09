import Database from 'better-sqlite3'
import { app } from 'electron'
import * as path from 'node:path'

export interface EmailOutboxPayload { to: string; subject: string; body: string; inReplyTo?: string; references?: string; accountName?: string }
let db: Database.Database | undefined
const EMAIL_SEND_LEASE_MS = 10 * 60 * 1000

function getDb(): Database.Database {
  return db ??= (() => {
    const value = new Database(path.join(app.getPath('userData'), 'email-outbox.db'))
    value.exec('CREATE TABLE IF NOT EXISTS email_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, dedupe_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, provider_message_id TEXT, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)')
    return value
  })()
}

export function claimEmailSend(dedupeKey: string, payload: EmailOutboxPayload): 'claimed' | 'sent' | 'inflight' {
  const existing = getDb().prepare('SELECT status, updated_at FROM email_outbox WHERE dedupe_key = ?').get(dedupeKey) as { status: string; updated_at: number } | undefined
  if (existing?.status === 'sent') return 'sent'
  if (existing?.status === 'sending' && Date.now() - existing.updated_at >= EMAIL_SEND_LEASE_MS) {
    getDb().prepare('UPDATE email_outbox SET updated_at = ? WHERE dedupe_key = ? AND status = ?').run(Date.now(), dedupeKey, 'sending')
    return 'claimed'
  }
  if (existing) return 'inflight'
  const now = Date.now()
  getDb().prepare('INSERT INTO email_outbox (dedupe_key,payload,status,provider_message_id,error,created_at,updated_at) VALUES (?,?,?,NULL,NULL,?,?)').run(dedupeKey, JSON.stringify(payload), 'sending', now, now)
  return 'claimed'
}

export function markEmailSent(dedupeKey: string, providerMessageId?: string): void { getDb().prepare('UPDATE email_outbox SET status = ?, provider_message_id = ?, updated_at = ? WHERE dedupe_key = ?').run('sent', providerMessageId || null, Date.now(), dedupeKey) }
export function markEmailFailed(dedupeKey: string, error: string): void { getDb().prepare('UPDATE email_outbox SET status = ?, error = ?, updated_at = ? WHERE dedupe_key = ?').run('failed', error, Date.now(), dedupeKey) }
