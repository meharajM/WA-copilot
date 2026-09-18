# Task 3 — Chat-history continuity cutover

## Delivered

- Added native-bearer-only `/api/v1/continuity/chat-history/{confirm,apply,status,rollback}` routes. Browser/session authorization cannot invoke them and no source path or token is accepted through browser routes.
- Revalidated the staged manifest/file hash and source identity at confirm/apply. Read-only SQLite checks enforce integrity, required Electron `sessions`/`session_messages` schema, foreign-key/session consistency, bounded rows/text/metadata, supported roles, duplicate IDs, and secret-looking metadata-key rejection.
- Imported sessions/messages into existing `chat_sessions`/`chat_messages` in one transaction. Equivalent rows are idempotent; conflicting IDs fail before mutation. Legacy `extra_data`, `thought`, `toolCalls`, `actions`, `findings`, and `plan` survive in bounded metadata columns.
- Reused the agentd migration hold/admission fence and runtime one-writer lock. Generation, chat writes, polling and outbound send admission are held/drained for apply/rollback.
- Added durable `chat_history_cutovers` state with single-use token hash/consumption, manifest/source hashes, backup hash/path, result and recovery state. Mode-600 atomic backups support restart status and rollback of unchanged imported rows; interrupted apply becomes `needs-recovery` and holds the runtime.

## Verification

- `node --test tests/unit/agentd-chat-history-cutover.test.cjs` — 4 passing tests: clean/repeat import, native/browser boundary, metadata preservation, corruption/conflict rejection, restart/rollback, and migration admission fencing.
- `npm run test:agentd` — 16 passing tests.
- `node --check agentd/server.cjs` — pass.

## Explicit remaining gates

This task does not migrate credentials, OAuth/MCP environment values, WhatsApp auth, knowledge/memory/derived indexes, or remove Electron. The Tauri native bridge/UI does not yet expose this new scope. Windows no-reparse-safe descriptor access, credential reauthentication/handoff, signed packaging, install/upgrade/crash recovery, and full Windows continuity smoke remain release gates. Electron persistence and browser product behavior remain unchanged.
