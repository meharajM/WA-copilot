# Omnichannel live-pilot evidence matrix

This is the operator worksheet for the remaining live gates. Copy
`docs/omnichannel-live-evidence-record.md` for each run. A row is complete only
when the owner records the date, account/provider, observed result, and a
redacted log or screenshot reference. Repository tests do not substitute for a
live provider result.

| Area | Prerequisite | Operator action | Expected result | Evidence |
| --- | --- | --- | --- | --- |
| WhatsApp account | Verified Business account, owned number, Cloud access | Send a customer message and an owner reply through the connected number | One normalized inbound event; owner reply pauses the conversation; no duplicate send | Date/account/log |
| WhatsApp window/templates | Approved template and response-window policy | Test inside and outside the 24-hour window | Inside-window policy applies; outside-window automation is blocked unless the approved template path is explicitly used | Message IDs/statuses |
| WhatsApp failures | Test credentials and provider test controls | Exercise expired token, 429 and 5xx responses | Auth/permission failures stop; confirmed pre-send rate limits retry within bounds; ambiguous failures become `delivery-unknown` | Failure IDs |
| Email | Gmail project verification and mailbox authorization | Send a threaded reply, bounce, attachment, revoked-token and restart cases | Thread headers are preserved; bounces are excluded from agent processing but retained in delivery history and owner failures; attachments escalate; revoked auth pauses processing; queued mail recovers | Message IDs/logs |
| Meta | Approved Page/Instagram assets, exact live scopes and webhook subscriptions | Send Instagram and Messenger test messages; send a lead event without messaging consent | Signed webhooks normalize correctly; lead does not create outbound consent; delivery callbacks reconcile | App/account IDs |
| Meta window/failures | Meta test user and approved messaging route | Test outside-window, token failure, 429 and 5xx behavior | Unsupported sends escalate; provider failures are classified and audited; no duplicate outbound | Event/provider IDs |
| X | Approved developer project, user-context DM access and spend limit | Receive an owner echo and exercise the 5-message/24-hour cap | Owner echo pauses the thread; cap blocks before provider access; usage is visible by channel | DM IDs/cost record |
| Autonomy staging | Owner escalation contact and SLA configured | Run observe-only → draft → narrowly allowlisted auto-reply | Observe sends nothing; draft requires approval; auto only sends approved FAQ decisions; Pause All works at each stage | Operator-action IDs |
| Recovery | Backup, isolated test account and owner availability | Stop/restart the desktop, stage a backup, clear recovery hold, reconnect a channel | Work is recoverable, restore starts paused, no dual sender exists, and recovery duration is recorded | Drill record |
| Daily operations | Provider billing access | Review pilot logs, usage, provider charges and unresolved delivery states daily | Caps/limits and unexpected charges are recorded and escalated before further auto-reply | Daily review link |

Before enabling unattended operation, resolve every prerequisite and attach the
evidence to the corresponding checklist item. Keep the desktop pilot
localhost-only; production webhooks require the separately operated HTTPS
relay described in `docs/release-readiness.md`.
