# AICA WhatsApp inbound bridge

This Manifest V3 extension is an optional, single-chat browser ingress client
for the local AICA `agentd` bridge. It has `storage` permission and host access
only for WhatsApp Web and the configured loopback port. It reads inbound text
DOM nodes, deduplicates them in memory, and posts them to `/messages`; it never
sends messages, evaluates page scripts, reads files, or calls a remote service.

1. Start the browser-first AICA native companion/agentd with
   `AICA_EXTENSION_BRIDGE_TOKEN` on the default extension port `8790`.
   The bridge is disabled when the token is absent and rejects tokens shorter
   than 16 characters.
2. Load this directory as an unpacked extension in Chromium-based browsers.
3. Open the extension options and enter the same token and the operator-supplied
   pilot chat ID.
4. In the browser product, select WhatsApp Web transport and enable the
   channel, then open WhatsApp Web and verify the AICA owner panel receives
   the event.

The WhatsApp DOM selector and session behavior require live verification and
may change when WhatsApp Web changes. Keep the app in Observe or Draft mode
until that verification is recorded. Outbound Web automation remains
manual-only and fail-closed; Baileys or Cloud API remains the supported
provider-backed send path.
