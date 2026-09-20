# AICA WhatsApp inbound bridge (pilot)

This Manifest V3 extension is an optional, single-chat pilot client for the
local AICA bridge. It has `storage` permission and host access only for
WhatsApp Web and the configured loopback port. It reads inbound text DOM nodes,
deduplicates them in memory, and posts them to `/messages`; it never sends
messages, evaluates page scripts, reads files, or calls a remote service.

1. Start AICA with `AICA_EXTENSION_BRIDGE_TOKEN` on the default extension
   port `8790`.
2. Load this directory as an unpacked extension in Chromium-based browsers.
3. Open the extension options and enter the same token and the operator-supplied
   pilot chat ID.
4. Open WhatsApp Web and verify the AICA owner panel receives the event.

The WhatsApp DOM selector and session behavior require live verification and
may change when WhatsApp Web changes. Keep the app in Observe or Draft mode
until that verification is recorded.
