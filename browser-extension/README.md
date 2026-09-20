# AICA WhatsApp Web bridge

This Manifest V3 extension is an optional, single-chat browser connector for
the local AICA `agentd` bridge. It has `storage` permission and host access
only for WhatsApp Web and the configured loopback port. It reads inbound text
DOM nodes, deduplicates them in memory, and posts them to `/messages`. It can
also poll for one explicit text-send command and acknowledge it after a
feature-detected active-chat composer action; media, arbitrary navigation,
page-script evaluation, files, and remote services remain unsupported.

1. Start the browser-first AICA native companion/agentd with
   `AICA_EXTENSION_BRIDGE_TOKEN` on the default extension port `8790`.
   The bridge is disabled when the token is absent and rejects tokens shorter
   than 16 characters.
2. Load this directory as an unpacked extension in Chromium-based browsers.
3. Open the extension options and enter the same token and the operator-supplied
   pilot chat ID.
4. In the browser product, select WhatsApp Web transport and enable the
   channel, then open the configured chat in WhatsApp Web. The browser product
   sends only when the visible conversation header matches the configured chat
   ID; verify the AICA owner panel receives the inbound event before trying an
   explicit text send.

The WhatsApp DOM selectors and session behavior require live verification and
may change when WhatsApp Web changes. Keep Autonomous Bot Mode off until a
human confirms the active-chat send behavior. If the composer or visible chat
cannot be proven, the extension reports a bounded failure and agentd marks the
send failed; Baileys or Cloud API remains the provider-backed path for media
and unattended operation.
