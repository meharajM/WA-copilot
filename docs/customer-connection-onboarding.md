# Customer connection onboarding

Status: target production flow. The current desktop pilot still uses operator
configuration and localhost webhooks; this document defines the customer-
friendly flow required for non-developer users.

## Product rule

Customers must not enter API keys, edit `.env` files, copy access tokens, or
configure webhook URLs. Furqanly owns the integration applications and uses
official provider authorization. The customer signs in, approves access,
selects the business asset, and receives a connection test result.

OAuth removes developer setup; it does not bypass provider ownership, approval,
pricing, rate-limit, or policy requirements. The customer must still be an
administrator or authorized manager of the selected asset.

## Target connection flow

1. Owner opens **Settings → Channels** and selects **Connect**.
2. Furqanly creates a short-lived, single-use authorization attempt bound to
   the installation, provider, requested scopes, and signed state.
3. The app opens the provider’s official authorization page.
4. Owner signs in and grants only the scopes needed for that channel.
5. The trusted side handles the callback and token exchange; credentials never
   cross into renderer state.
6. Owner selects the Business, Page, Instagram Professional account, WhatsApp
   number, mailbox, or X account to connect.
7. Furqanly verifies identity, permissions, webhook registration, sending
   capability, response-window support, and account limits.
8. The UI shows the selected asset, granted capabilities, token status, and a
   plain-language fix when anything is incomplete.
9. Every new connection starts in **Observe-only**. Draft and Auto-reply are
   separate owner-controlled actions.

## Provider flows

### Meta, Instagram, Messenger and WhatsApp

Use one Furqanly-owned Meta app and least-privilege authorization. Show the
assets returned by Meta and require explicit selection; never guess which Page,
Instagram account, or WhatsApp Business Account is intended.

Show separate connection cards for Meta Business/Page, Instagram Professional
messaging, Messenger Page, WhatsApp Business Account/phone number, and
read-only lead/ad attribution when enabled. Missing Business Portfolio,
WhatsApp account, owned number, permission, or provider verification keeps the
channel disconnected and provides a fix link.

Production Meta webhooks require a separately operated authenticated HTTPS
relay. The desktop worker must not be the public webhook endpoint.

### X

Use Furqanly’s registered X application and user authorization. The customer
clicks **Connect X**, signs in, grants Direct Message access, and returns to the
app. Furqanly verifies the authorized account and DM capability before showing
it as connected.

Surface X plan, permission, rate, and usage limits before Auto-reply. Keep
public replies disabled; support starts as Observe-only or Draft-only and uses
the existing per-conversation cap. Authorization failures leave the account
disconnected and expose only a safe error category, never tokens or signatures.

### Gmail

Use OAuth with the existing narrow scope set. The owner selects the mailbox and
reviews the requested scopes. Token refresh, revocation, restricted-scope
review, and mailbox identity checks remain host-side concerns.

## Credential and tenancy boundary

For the single-business desktop pilot, store credentials in the OS secure store
and keep only provider IDs, capability metadata, expiry, and audit references
in SQLite. Never store raw tokens in renderer state, conversation records,
logs, screenshots, or customer-visible diagnostics.

For multiple customer-owned accounts, add a hosted connection service and
encrypted credential vault:

```text
Owner → OAuth provider → Furqanly connection service
                              ↓
                       encrypted credentials
                              ↓
                    webhook relay / worker
```

Every credential and webhook event is scoped to business ID, channel-account
ID, and provider identity. Ownership transfer between desktop and hosted
workers is explicit and audited; two workers must never send for one account.

## Connection states and recovery

Expose `not_connected`, `authorizing`, `asset_selection_required`, `connected`,
`permission_incomplete`, `webhook_incomplete`, `token_expiring`, `revoked`,
and `provider_error` consistently across channels.

Every failure offers **Retry authorization**, **Reconnect**, **Open provider
settings**, **Switch to observe-only**, or **Disconnect**. Disconnect pauses
autonomous sending, clears provider subscriptions where supported, removes the
local credential reference where supported, and records an operator audit event.

## Safety defaults

- New connections are observe-only.
- Scopes and selected assets are shown before activation.
- Connection status never grants send permission.
- Token, webhook, and account failures pause autonomous sending and notify the owner.
- Browser automation is never used for provider login or dashboard scraping.
- Customer messages cannot initiate connections or change permissions.
- Connection tests use a designated test account or customer-initiated conversation.

## Implementation order

1. Add provider-neutral connection records and connection-state UI.
2. Add signed OAuth state/PKCE handling and OS secure-store persistence.
3. Add Meta asset selection and capability verification.
4. Add X user authorization and DM capability verification.
5. Move production webhook receipt to an authenticated HTTPS relay.
6. Add reconnect/revoke flows, audit entries, and owner notifications.
7. Run `docs/omnichannel-live-pilot-matrix.md` before enabling Auto-reply.

The current environment-variable setup remains for internal development only;
it is not an acceptable customer onboarding experience.
