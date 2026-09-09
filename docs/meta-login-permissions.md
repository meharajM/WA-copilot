# Meta login and permissions boundary

This repository does not implement Meta OAuth, Embedded Signup or an in-app
account picker. The current pilot flow is operator-provisioned credentials:

1. Create/configure the Meta app and the target Page or Instagram Professional
   account in Meta Business tools.
2. Obtain an access token through the approved Meta operator flow and store it
   outside source control.
3. Set `META_ACCESS_TOKEN`, `META_ACCOUNT_ID`, `META_GRAPH_API_VERSION` (optional),
   `META_WEBHOOK_CHANNEL`, `META_WEBHOOK_VERIFY_TOKEN`, and `META_APP_SECRET`.
4. Start the opt-in localhost webhook listener. A separately operated
   authenticated HTTPS relay is required to receive production webhooks.

The host uses the token only for the Graph text-send boundary. The webhook
server requires the verify token for subscription verification and validates
`X-Hub-Signature-256` with the app secret before normalizing messages, lead
events, or delivery updates. Lead events never imply messaging consent.

The exact minimum permissions are not claimed here because they depend on the
chosen Meta login route and the specific Page, Instagram, Messenger, or Lead
Ads capability. The deployment owner must record the approved permission set,
app-review status, account eligibility, webhook subscriptions, and expiry or
revocation procedure before enabling that adapter. Until then, keep the
adapter in observe-only or draft mode.

Implementation references: `src/main/services/MetaMessaging.ts`,
`src/main/services/MetaWebhookServer.ts`, and the opt-in startup wiring in
`src/main/index.ts`.
