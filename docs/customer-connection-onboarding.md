# Customer connection onboarding

Status: target production flow; the current desktop pilot still uses operator
configuration and localhost webhooks. This document describes the customer-
friendly connection model to implement before supporting non-developer users.

## Product rule

Customers must not enter API keys, edit `.env` files, copy access tokens, or
configure webhook URLs. Furqanly owns the integration applications and uses
official provider authorization. The customer signs in, approves access,
selects the business asset, and receives a connection test result.

The customer must still be an administrator or authorized manager of the
provider asset. OAuth removes developer setup; it does not bypass Meta or X
account ownership, approval, pricing, rate-limit, or policy requirements.

## Target connection flow

1. The owner opens **Settings → Channels** and selects **Connect**.
2. Furqanly creates a short-lived, single-use authorization attempt bound to
   the local installation, provider, requested scopes, and signed state.
3. The system opens the provider’s official authorization page.
4. The owner signs in and grants only the scopes needed for the selected
   channel.
5. Furqanly receives the callback, exchanges the code/token on the trusted
   side, and never exposes the provider credential to the renderer.
6. The owner selects the available Business, Page, Instagram Professional
   account, WhatsApp number, or X account.
7. Furqanly validates permissions, webhook registration, sending capability,
   response-window support, and account identity.
8. The UI shows **Connected**, the selected asset, granted capabilities,
   token-expiry state, and the next action if anything is incomplete.
9. New connections start in **Observe-only**. Draft and Auto-reply require
   separate owner actions and the existing host policy gates.

## Provider flows

### Meta, Instagram, Messenger and WhatsApp

Use one Furqanly-owned Meta app and the least-privilege Meta authorization
flow. After login, present the assets returned by Meta and require explicit
selection; never guess which Page, Instagram account, or WhatsApp Business
Account should be used.

The connection wizard should show separate cards for:

- Meta Business/Page access
- Instagram Professional messaging access
- Messenger Page access
- WhatsApp Business Account and phone-number access
- Read-only lead/ad attribution, if enabled

Meta asset selection and WhatsApp onboarding may require a Business Portfolio,
WhatsApp Business Account, owned phone number, approved permissions, and
provider-side verification. If a prerequisite is missing, show a plain-language
fix link and keep the channel disconnected. Do not ask the customer to paste a
temporary token.

Production Meta webhooks require the separately operated authenticated HTTPS
relay. The desktop worker may receive a short-lived local connection handoff,
but it must not be the public webhook endpoint.

### X

Use Furqanly’s registered X application and a user authorization flow. The
customer clicks **Connect X**, signs in, grants Direct Message access, and
returns to the app. Furqanly then verifies the authorized account and the
available DM capability.

The X DM API uses user-context authorization and may impose plan, permission,
rate, or usage limits. Surface those limits before enabling Auto-reply. Keep X
public replies disabled; customer support starts as Observe-only or Draft-only
and uses the existing per-conversation cap.

If X authorization or DM access fails, retain the account as disconnected and
show the provider error category without exposing tokens or signed request
material.

### Gmail

Use OAuth with the existing narrow scope set. The owner chooses the mailbox,
reviews the requested scopes, and returns to Furqanly. Token refresh, revocation,
restricted-scope review, and mailbox identity checks remain host-side concerns.

## Credential and tenancy boundary

For the current single-business desktop pilot, store credentials in the OS
secure store and keep only provider account IDs, capability metadata, expiry,
and audit references in SQLite. Never store raw tokens in renderer state,
conversation records, logs, screenshots, or customer-visible diagnostics.

For multiple customer-owned accounts, add a hosted connection service and
encrypted server-side credential vault:

```text
Owner → OAuth provider → Furqanly connection service
                              ↓
                       encrypted credentials
                              ↓
                    webhook relay / worker
```

Each credential and webhook event must be scoped to business ID, provider,
channel-account ID, and provider account identity. A connection must not grant
access to another customer’s asset. Ownership transfer between desktop and
hosted workers remains an explicit, audited operation; two workers must never
send for the same account simultaneously.

## Connection states and recovery

Expose these states consistently in the UI:

- `not_connected`
- `authorizing`
- `asset_selection_required`
- `connected`
- `permission_incomplete`
- `webhook_incomplete`
- `token_expiring`
- `revoked`
- `provider_error`

Every failure should offer one of: **Retry authorization**, **Reconnect**,
**Open provider settings**, **Switch to observe-only**, or **Disconnect**.
Disconnect revokes or deletes the local credential reference where supported,
clears active provider subscriptions, pauses autonomous sending, and records an
operator audit event.

## Safety defaults

- New connections are observe-only.
- OAuth scopes are explicit and least-privilege.
- Provider identity and selected asset are displayed before activation.
- Send permission is separate from connection status.
- Token, webhook, and account failures pause autonomous sending and notify the
  owner.
- No browser automation is used to log in or scrape provider dashboards.
- No customer message can initiate a new connection or change permissions.
- Connection tests use a designated test account or a customer-initiated
  conversation; Furqanly does not send unsolicited outreach.

## Implementation order

1. Add a provider-neutral connection record and connection-state UI.
2. Add signed OAuth state/PKCE handling and OS secure-store persistence for
   Gmail and Meta.
3. Add Meta asset selection and capability verification.
4. Add X user authorization and DM capability verification.
5. Move production webhook receipt to an authenticated HTTPS relay.
6. Add reconnect/revoke flows, audit entries, and owner notifications.
7. Run the live provider matrix in
   `docs/omnichannel-live-pilot-matrix.md` before enabling Auto-reply.

The current environment-variable setup remains available for internal
development and is not an acceptable customer onboarding experience.
