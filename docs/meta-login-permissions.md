# Meta login and permissions boundary

This repository does not implement Meta OAuth, Embedded Signup or an in-app
account picker. The recommended pilot flow is operator-provisioned credentials
from Meta's Facebook Login/Page-token route, shared by the Page-backed
Messenger adapter and the Instagram Professional account connected to that
Page. This matches the current `graph.facebook.com/{accountId}/messages`
transport and avoids adding a second OAuth implementation before the pilot has
real account demand.

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

For the recommended messaging-only route, request only the permissions the
Meta App Dashboard confirms are required for the connected assets: Page list
and engagement access, Page messaging, Page metadata/webhook subscription, and
Instagram messaging access for the connected Professional account. Do not
request comment management, content publishing, ads management, lead retrieval,
or marketing-messaging permissions in the support pilot. The exact current
permission names and review requirements must be copied from the live Meta App
Dashboard before submission; Meta has separate Instagram Login and Facebook
Login permission families.

The deployment owner must record the approved permission set, app-review
status, account eligibility, webhook subscriptions, and expiry or revocation
procedure before enabling that adapter. Until then, keep the adapter in
observe-only or draft mode.

Implementation references: `src/main/services/MetaMessaging.ts`,
`src/main/services/MetaWebhookServer.ts`, and the opt-in startup wiring in
`src/main/index.ts`.

Official starting points: [Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api),
[Messenger Platform](https://developers.facebook.com/docs/messenger-platform/overview),
and [Lead Ads retrieval](https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/).
