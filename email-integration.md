# Email Integration Blueprint (End-to-End, Modular, MCP-First)

## 1) Goal
Build an end-to-end automated **email customer support agent** in this project, matching the WhatsApp flow style:
- Same reasoning/runtime core
- Same RAG + memory + escalation behavior
- Channel-specific adapter only (plug-and-play)
- Safe-by-default automation

Chosen direction:
- **Integration model:** MCP Email Server first
- **Scope:** Full support loop (inbound, triage, response, escalation, threading)
- **Send policy:** Confidence gate (auto-send only when safe/high confidence; otherwise draft + approval)

---

## 2) Target Architecture (Modular)

### 2.1 Channel Abstraction (single agent core)
Use existing omnichannel primitives (`ChannelType`, `ChannelMessage`, `ChannelProvider`) as the base contract.

Design:
- `EmailChannelAdapter` converts inbound email payloads -> internal `ChannelMessage`
- Agent runtime consumes normalized messages exactly like WhatsApp
- Outbound actions route through a generic channel send path

### 2.2 End-to-End Flow
1. MCP email server fetches new emails (inbox poll / fetch cycle)
2. Adapter normalizes to session message (`channel='email'`, `contact_id=<sender_email>`)
3. Session enters same agent loop (RAG, memory, tools)
4. Agent decides:
   - high confidence + policy-safe => send
   - uncertain/sensitive => draft + human approval
5. Persist:
   - session + messages in existing persistence tables
   - email threading fields (`message_id`, `in_reply_to`, `references`)
6. Escalation/handoff follows existing human-in-loop style

### 2.3 Threading Rules
- Preserve `Message-ID`, `In-Reply-To`, `References`
- Maintain deterministic session key:
  - `email::<normalized_sender>::<thread_id_or_subject_hash>`
- Subject normalization (`Re:`, `Fwd:`) without breaking thread mapping

---

## 3) MCP Server Selection (Safe + Secure First)

## Recommendation: `ai-zerolab/mcp-email-server`
Why this is the best current fit:
- Open-source and free (BSD-3-Clause)
- Purpose-built for MCP + IMAP/SMTP (send + receive)
- Attachment download disabled by default (good secure default)
- Supports standard threading fields in send flow (`in_reply_to`, `references`)
- Active repository with tests/docs and packaged distribution (PyPI)

Primary references:
- GitHub: https://github.com/ai-zerolab/mcp-email-server
- Docs: https://ai-zerolab.github.io/mcp-email-server/
- PyPI: https://pypi.org/project/mcp-email-server/

## Alternative: `non-dirty/imap-mcp`
- Open-source IMAP-focused MCP server (MIT)
- Smaller ecosystem and lower adoption vs recommendation
- Good backup candidate if we need stronger inbox-management primitives

Reference:
- https://github.com/non-dirty/imap-mcp

## Important security context
MCP ecosystem has already seen supply-chain style malicious server incidents, so we must treat server onboarding as security-critical.

References:
- Koi report on malicious MCP package incident: https://www.koi.ai/blog/postmark-mcp-npm-malicious-backdoor-email-theft
- MCP security best practices: https://modelcontextprotocol.io/specification/2025-06-18/basic/security_best_practices

---

## 4) Security Guardrails (Mandatory for this repo)

When adding any email MCP server:
- Pin exact version (no floating `@latest` in production profile)
- Prefer `stdio` transport for local-only trust boundary
- Run with least-privilege mailbox account (dedicated support inbox)
- Use app-specific password or OAuth app token (never primary mailbox password)
- Disable attachment download initially
- Restrict writable paths for any file output tools
- Add outbound allowlist policy (approved domains if needed)
- Add audit logging for every send/draft action
- Add “high-risk intent requires approval” policy (refunds, legal, account/security)
- Add integrity checks in setup docs:
  - verify package source/owner
  - lock dependency/version in config
  - rotate credentials on suspicious behavior

---

## 4.1) Secrets & Credential Storage (Explicit)

Do NOT store mailbox secrets in git-tracked files, plaintext local JSON, or prompt history.

Implementation requirement for this app:
- Store email credentials in OS-backed secure storage via Electron safe storage/keychain bridge (Keychain on macOS, Credential Manager on Windows, Secret Service/libsecret on Linux where available).
- Persist only non-secret connection metadata in app config (account label, host, port, ssl flags).
- Load secrets into MCP env only at process launch time (in-memory), never writing them back to disk.
- Support credential rotation UI action (replace token/password and restart MCP server process).
- Redact all secret-shaped keys from logs (`password`, `token`, `secret`, `apiKey`, `auth`).

---

## 5) Implementation Plan in This Codebase

## Phase A - Channel Wiring
- Add generic email channel config/state in store + settings UI
- Add `EmailChannelAdapter` and session mapping (`channel='email'`)
- Keep WhatsApp behavior unchanged (no regressions)

## Phase B - MCP Tool Bridge
- Add MCP tool mapping layer for concrete tools exposed by `mcp-email-server`:
  - `list_available_accounts`
  - `list_emails_metadata`
  - `get_emails_content`
  - `send_email`
  - `delete_emails` (optional in v1; admin-only)
  - `download_attachment` (disabled in v1 by policy)
- Normalize MCP responses into internal message/session events
- Add polling scheduler in **main process ownership** (not renderer-only) so ingestion survives UI tab/state changes
- Use renderer only for display/actions; message ingestion authority stays in main IPC/service layer

## Phase C - Agent + Policy
- Inject email-specific system instructions (thread-aware and concise support format)
- Add confidence gate evaluator for send vs draft
- Reuse escalation path for unresolved/sensitive cases

## Phase D - Persistence + UI
- Store thread metadata in session/message extras
- Add session filters by channel (All / WhatsApp / Email)
- Add human approval UI for drafts

## Phase E - Hardening + QA
- Add idempotency keys for outbound sends
- Add retries with backoff and duplicate suppression
- Add tests for threading, policy gate, escalation, and mixed-channel isolation

---

## 6) Suggested Initial MCP Config (Development)
Use this only for local testing; move to pinned-version config for production rollout.

```json
{
  "mcpServers": {
    "email": {
      "command": "uvx",
      "args": ["mcp-email-server==0.6.2", "stdio"],
      "env": {
        "MCP_EMAIL_SERVER_ENABLE_ATTACHMENT_DOWNLOAD": "false"
      }
    }
  }
}
```

Notes:
- Replace version with latest audited version at integration time.
- Do not store credentials in repo files.

### 6.1) Hardened Production Launch Mode (Preferred)

For production, avoid runtime package resolution via `uvx` where possible.

Preferred pattern:
- Preinstall audited package version during controlled setup.
- Launch MCP server via explicit entrypoint path (`command: "/absolute/path/to/mcp-email-server"` + `args: ["stdio"]`).
- Keep pinned version documented in release notes + security checklist.
- Re-run verification before every version bump.

### 6.2) Gmail OAuth Model (Current: Option 3)

Current shipping model for desktop app:
- App-managed OAuth config (end users do not provide client ID/secret)
- PKCE enabled in desktop flow
- `GMAIL_OAUTH_CLIENT_ID` and `GMAIL_OAUTH_CLIENT_SECRET` injected by app owner at runtime/build environment
- Refresh/access tokens stored in OS-backed secure storage, not in repo files

Important:
- In desktop distribution, OAuth `client_secret` is treated as client metadata, not a high-security secret.
- Do not present client ID/secret fields to end users.
- Planned migration: move token exchange/refresh to backend broker so secret never ships with clients.

---

## 7) Acceptance Criteria
- Inbound email creates/updates correct session thread automatically
- Agent produces grounded responses using existing RAG/memory rules
- High confidence replies auto-send; low confidence replies become drafts
- Human can approve draft and send in same thread
- No cross-leak between WhatsApp and email sessions
- Full audit log for every outbound email action
- SMTP/API delivery failures are surfaced to operator with retry/backoff state
- Bounce/undeliverable responses map back to thread and trigger escalation path

---

## 8) Immediate Next Build Tasks
1. Add `email` channel wiring to session routing and store lifecycle.
2. Add MCP email tool adapter in `src/renderer/src/lib/mcp.ts` execution path.
3. Add draft/approval action in chat message actions UI.
4. Add integration tests for email thread continuity and confidence gating.
