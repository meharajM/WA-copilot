/**
 * DraftApprovalPanel.tsx — UI for reviewing, editing, and sending email drafts.
 *
 * Displays drafts created by the confidence gate with:
 *   - Original email context (from, subject)
 *   - AI-generated response (editable)
 *   - Policy decision rationale (why it's a draft vs send vs escalate)
 *   - Approve/Reject/Send actions
 *
 * Drafts with 'escalated' status are flagged for human intervention
 * and cannot be auto-sent.
 */

import React, { useState } from 'react';
import { useDraftStore } from '../../stores/draftStore';
import { Card } from '../primitives/Card';
import electron, { isElectron } from '../../lib/electron';
import { getBrowserAgentdClient } from '../../lib/browser-agentd-client';
import { normalizeSubject } from '../../lib/email-integration';
import {
  CheckCircle,
  XCircle,
  Send,
  Edit2,
  AlertTriangle,
  Clock,
  Mail,
  Paperclip,
  Shield,
  Eye,
} from 'lucide-react';

const MAX_BROWSER_EMAIL_ATTACHMENTS = 5;
const MAX_BROWSER_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.txt': 'text/plain',
};

const fileToDraftAttachment = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  return {
    name: file.name,
    mimeType: file.type || MIME_BY_EXTENSION[extension] || 'application/octet-stream',
    size: bytes.byteLength,
    dataBase64: btoa(binary),
  };
};

const dispatchBrowserDeliveryStatus = (status: 'sent' | 'failed', subject: string, error?: string) => {
  const text = status === 'sent'
    ? `Email delivered: ${subject || '(No subject)'}`
    : `Email delivery failed: ${subject || '(No subject)'}${error ? ` — ${error}` : ''}`
  window.dispatchEvent(new CustomEvent('app:submit-message', {
    detail: { content: `📨 ${text}`, system: true },
  }))
}

export function DraftApprovalPanel() {
  const { drafts, approveDraft, rejectDraft, markDraftSent, markDraftFailed, updateDraftText, updateDraftAttachments, removeDraft, cleanupOldDrafts } = useDraftStore();
  const browserRuntime = !isElectron();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  // Cleanup old drafts on mount
  React.useEffect(() => {
    cleanupOldDrafts();
  }, [cleanupOldDrafts]);

  const pendingDrafts = drafts.filter(d => d.status === 'pending_review');
  const escalatedDrafts = drafts.filter(d => d.status === 'escalated');
  const recentHistory = drafts.filter(d => ['approved', 'rejected', 'sent', 'failed'].includes(d.status)).slice(0, 10);

  const startEditing = (draftId: string, currentText: string) => {
    setEditingId(draftId);
    setEditText(currentText);
  };

  const saveEdit = (draftId: string) => {
    if (editText.trim()) {
      updateDraftText(draftId, editText.trim());
    }
    setEditingId(null);
  };

  const handleApproveAndSend = async (draftId: string) => {
    const draft = useDraftStore.getState().drafts.find((d) => d.id === draftId);
    if (!draft) return;

    if (!isElectron()) {
      try {
        await getBrowserAgentdClient().updateEmailDraft(draftId, { status: 'approved' });
        const sent = await getBrowserAgentdClient().sendEmailDraft(draftId);
        if (sent.status === 'sent') {
          markDraftSent(draftId);
          dispatchBrowserDeliveryStatus('sent', draft.originalSubject || '');
        }
      } catch (error) {
        markDraftFailed(draftId);
        dispatchBrowserDeliveryStatus('failed', draft.originalSubject || '', error instanceof Error ? error.message : undefined);
      }
      return;
    }

    const sendResult = await electron.email.send({
      to: draft.replyTo || draft.originalFrom,
      subject: `Re: ${normalizeSubject(draft.originalSubject || '(No Subject)')}`,
      body: draft.responseText,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      accountName: draft.accountName || 'default',
    });

    if (sendResult.success) {
      approveDraft(draftId);
      markDraftSent(draftId);
      return;
    }

    // Keep failed drafts visible for retry.
    updateDraftText(draftId, `${draft.responseText}\n\n[Send failure: ${sendResult.error || 'unknown'}]`);
  };

  const handleAddAttachments = async (draftId: string, files: FileList | null) => {
    if (!files?.length) return;
    setAttachmentError(null);
    const draft = drafts.find((candidate) => candidate.id === draftId);
    if (!draft) return;
    const current = draft.attachments || [];
    if (current.length + files.length > MAX_BROWSER_EMAIL_ATTACHMENTS) {
      setAttachmentError(`Choose at most ${MAX_BROWSER_EMAIL_ATTACHMENTS} attachments per email draft.`);
      return;
    }
    try {
      const added = [];
      let total = current.reduce((sum, attachment) => sum + attachment.size, 0);
      for (const file of Array.from(files)) {
        if (!file.size || total + file.size > MAX_BROWSER_EMAIL_ATTACHMENT_BYTES) throw new Error('Attachments exceed the 10 MiB total limit.')
        total += file.size;
        added.push(await fileToDraftAttachment(file));
      }
      await updateDraftAttachments(draftId, [...current, ...added]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Attachment selection failed');
    }
  };

  const handleRemoveAttachment = async (draftId: string, index: number) => {
    const draft = drafts.find((candidate) => candidate.id === draftId);
    if (!draft?.attachments) return;
    try {
      await updateDraftAttachments(draftId, draft.attachments.filter((_, attachmentIndex) => attachmentIndex !== index));
      setAttachmentError(null);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : 'Attachment update failed');
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-bold text-[var(--color-text-primary)]">Email Drafts</h3>
        {pendingDrafts.length > 0 && (
          <span className="bg-amber-500/20 text-amber-300 text-xs px-2 py-1 rounded-full font-bold">
            {pendingDrafts.length} pending
          </span>
        )}
      </div>
      {browserRuntime && drafts.length > 0 && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-xs text-amber-200">
          Browser mode uses local agentd for gated IMAP/Gmail polling and explicitly approved SMTP/Gmail delivery. Safe operator-selected PDF, image, and text attachments are bounded and scanned before delivery.
        </div>
      )}

      {/* Pending Drafts */}
      {pendingDrafts.length > 0 && (
        <div className="space-y-4">
          <h4 className="text-sm font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-2">
            <Clock size={14} />
            Pending Review
          </h4>
          {pendingDrafts.map(draft => (
            <DraftCard
              key={draft.id}
              draft={draft}
              isEditing={editingId === draft.id}
              editText={editingId === draft.id ? editText : ''}
              onEditChange={setEditText}
              onStartEdit={() => startEditing(draft.id, draft.responseText)}
              onSaveEdit={() => saveEdit(draft.id)}
              onCancelEdit={() => setEditingId(null)}
              onApprove={() => approveDraft(draft.id)}
              onSend={() => handleApproveAndSend(draft.id)}
              onReject={() => rejectDraft(draft.id)}
              browserRuntime={browserRuntime}
              attachmentError={attachmentError}
              onAddAttachments={(files) => void handleAddAttachments(draft.id, files)}
              onRemoveAttachment={(index) => void handleRemoveAttachment(draft.id, index)}
              canSend={true}
            />
          ))}
        </div>
      )}

      {/* Escalated Drafts */}
      {escalatedDrafts.length > 0 && (
        <div className="space-y-4">
          <h4 className="text-sm font-bold text-red-400 uppercase tracking-wider flex items-center gap-2">
            <AlertTriangle size={14} />
            Escalated — Requires Human Response
          </h4>
          {escalatedDrafts.map(draft => (
            <DraftCard
              key={draft.id}
              draft={draft}
              isEditing={editingId === draft.id}
              editText={editingId === draft.id ? editText : ''}
              onEditChange={setEditText}
              onStartEdit={() => startEditing(draft.id, draft.responseText)}
              onSaveEdit={() => saveEdit(draft.id)}
              onCancelEdit={() => setEditingId(null)}
              onApprove={() => approveDraft(draft.id)}
              onSend={() => handleApproveAndSend(draft.id)}
              onReject={() => rejectDraft(draft.id)}
              browserRuntime={browserRuntime}
              attachmentError={attachmentError}
              onAddAttachments={(files) => void handleAddAttachments(draft.id, files)}
              onRemoveAttachment={(index) => void handleRemoveAttachment(draft.id, index)}
              canSend={true}
              isEscalated
            />
          ))}
        </div>
      )}

      {/* Recent History */}
      {recentHistory.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-bold text-[var(--color-text-muted)] uppercase tracking-wider flex items-center gap-2">
            <Eye size={14} />
            Recent History
          </h4>
          <div className="space-y-1">
            {recentHistory.map(draft => (
              <div
                key={draft.id}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--color-surface)] text-xs"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <StatusIcon status={draft.status} />
                  <span className="truncate text-[var(--color-text-muted)]">
                    {draft.originalSubject}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-[var(--color-text-dim)]">
                    {new Date(draft.createdAt).toLocaleTimeString()}
                  </span>
                  <button
                    onClick={() => removeDraft(draft.id)}
                    className="text-[var(--color-text-dim)] hover:text-red-400"
                  >
                    <XCircle size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {drafts.length === 0 && (
        <Card variant="glass" padding="lg" className="text-center">
          <Mail size={32} className="mx-auto text-[var(--color-text-dim)] mb-3 opacity-30" />
          <p className="text-sm text-[var(--color-text-muted)]">No drafts yet.</p>
          <p className="text-xs text-[var(--color-text-dim)] mt-1">
            Drafts will appear here when the AI generates responses that need review.
          </p>
        </Card>
      )}
    </div>
  );
}

/** Individual draft card with edit/approve/reject actions */
function DraftCard({
  draft,
  isEditing,
  editText,
  onEditChange,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onApprove: _onApprove,
  onSend,
  onReject,
  canSend,
  browserRuntime,
  attachmentError,
  onAddAttachments,
  onRemoveAttachment,
  isEscalated = false,
}: {
  draft: import('../../lib/email-policy').EmailDraft;
  isEditing: boolean;
  editText: string;
  onEditChange: (text: string) => void;
  onStartEdit: () => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onApprove: () => void;
  onSend: () => void;
  onReject: () => void;
  canSend: boolean;
  browserRuntime: boolean;
  attachmentError: string | null;
  onAddAttachments: (files: FileList | null) => void;
  onRemoveAttachment: (index: number) => void;
  isEscalated?: boolean;
}) {
  return (
    <Card variant="glass" padding="md" className={`space-y-3 ${isEscalated ? 'border-red-500/30' : ''}`}>
      {/* Original email context */}
      <div className="flex items-start gap-2 text-xs text-[var(--color-text-muted)]">
        <Mail size={12} className="shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="font-medium text-[var(--color-text-primary)] truncate">
            {draft.originalSubject}
          </p>
          <p>From: {draft.originalFrom}</p>
        </div>
      </div>

      {/* Policy rationale */}
      <div className={`flex items-start gap-2 text-xs px-3 py-2 rounded-lg ${
        isEscalated
          ? 'bg-red-500/10 text-red-300'
          : draft.policyDecision.confidence >= 0.7
            ? 'bg-amber-500/10 text-amber-300'
            : 'bg-blue-500/10 text-blue-300'
      }`}>
        <Shield size={12} className="shrink-0 mt-0.5" />
        <div>
          <p className="font-medium">{draft.policyDecision.rationale}</p>
          {draft.policyDecision.sensitiveTopics.length > 0 && (
            <p className="mt-1">Topics: {draft.policyDecision.sensitiveTopics.join(', ')}</p>
          )}
        </div>
      </div>

      {/* Response text (editable) */}
      <div className="relative">
        {isEditing ? (
          <div className="space-y-2">
            <textarea
              value={editText}
              onChange={(e) => onEditChange(e.target.value)}
              className="w-full bg-[var(--color-bg-dark)] border border-[var(--color-border)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-brand-teal)] min-h-[120px] resize-y"
            />
            <div className="flex gap-2">
              <button
                onClick={onSaveEdit}
                className="text-xs bg-[var(--color-brand-teal)]/20 text-[var(--color-brand-teal)] px-3 py-1 rounded hover:bg-[var(--color-brand-teal)]/30"
              >
                Save
              </button>
              <button
                onClick={onCancelEdit}
                className="text-xs text-[var(--color-text-muted)] px-3 py-1 rounded hover:text-[var(--color-text-primary)]"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-[var(--color-bg-dark)] rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] whitespace-pre-wrap">
            {draft.responseText}
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 pt-2 border-t border-[var(--color-border)]">
      {!isEditing && (
          <button
            onClick={onStartEdit}
            className="flex items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] px-2 py-1 rounded hover:bg-[var(--color-surface)]"
          >
            <Edit2 size={12} />
            Edit
          </button>
      )}

      {draft.attachments?.length ? (
        <div className="flex flex-wrap gap-2 text-xs text-[var(--color-text-muted)]">
          {draft.attachments.map((attachment, index) => (
            <span key={`${attachment.name}-${attachment.size}-${index}`} className="inline-flex items-center gap-1 rounded bg-[var(--color-surface)] px-2 py-1">
              <Paperclip size={11} />{attachment.name}
              {browserRuntime && <button type="button" aria-label={`Remove attachment ${attachment.name}`} onClick={() => onRemoveAttachment(index)} className="text-[var(--color-text-dim)] hover:text-red-400"><XCircle size={11} /></button>}
            </span>
          ))}
        </div>
      ) : null}

      {browserRuntime && canSend && (
        <div className="space-y-1">
          <label className="inline-flex cursor-pointer items-center gap-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
            <Paperclip size={12} />
            Add safe attachments
            <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.txt,.csv,.json,application/pdf,image/png,image/jpeg,text/plain,text/csv,application/json" className="sr-only" onChange={(event) => { onAddAttachments(event.target.files); event.currentTarget.value = '' }} />
          </label>
          {attachmentError && <p className="text-xs text-amber-300">{attachmentError}</p>}
        </div>
      )}

        <div className="flex-1" />

        {isEscalated ? (
          <button
            onClick={onSend}
            disabled={!canSend}
            title={!canSend ? 'Email delivery is unavailable in browser mode' : undefined}
            className="flex items-center gap-1 text-xs bg-red-500/20 text-red-300 px-3 py-1.5 rounded-lg hover:bg-red-500/30 font-bold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send size={12} />
            {canSend ? 'Review & Send' : 'Send unavailable'}
          </button>
        ) : (
          <>
            <button
              onClick={onReject}
              className="flex items-center gap-1 text-xs text-red-400 px-3 py-1.5 rounded-lg hover:bg-red-500/10"
            >
              <XCircle size={12} />
              Discard
            </button>
            <button
              onClick={onSend}
              disabled={!canSend}
              title={!canSend ? 'Email delivery is unavailable in browser mode' : undefined}
              className="flex items-center gap-1 text-xs bg-[var(--color-brand-teal)]/20 text-[var(--color-brand-teal)] px-3 py-1.5 rounded-lg hover:bg-[var(--color-brand-teal)]/30 font-bold disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle size={12} />
              {canSend ? 'Approve & Send' : 'Send unavailable'}
            </button>
          </>
        )}
      </div>
    </Card>
  );
}

/** Status icon for draft history entries */
function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'approved':
      return <CheckCircle size={12} className="text-green-400 shrink-0" />;
    case 'rejected':
      return <XCircle size={12} className="text-red-400 shrink-0" />;
    case 'sent':
      return <Send size={12} className="text-blue-400 shrink-0" />;
    default:
      return <Clock size={12} className="text-amber-400 shrink-0" />;
  }
}
