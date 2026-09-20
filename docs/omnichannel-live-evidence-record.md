# Omnichannel live-evidence record

Use one copied record per pilot run. Do not enter secrets, access tokens, full
customer content, or unredacted personal data. A checklist item is complete
only after the owner fills the applicable fields and links a redacted log,
screenshot, provider event ID, billing export, or signed review decision.

## Run metadata

- Run ID:
- Date/time and timezone:
- Operator:
- App version/commit:
- Test account and provider:
- Mode: `observe` / `draft` / `auto`
- Escalation contact and SLA:
- Evidence links:

## Provider and access gates

- WhatsApp Business account, owned number, Cloud API access and Coexistence status:
- Meta Business/Page/Instagram assets and approved scopes:
- X developer project, user-context DM access and spend limit:
- Gmail OAuth project verification and restricted-scope status:
- Approved LLM, region, retention and allowed-data decision:
- Package/license/signing review result:

## Scenario results

For each scenario, record the exact provider event/message IDs, expected
result, observed result, and whether the result passed.

| Scenario | Expected result | Observed result | Provider/event IDs | Evidence | Pass? |
| --- | --- | --- | --- | --- | --- |
| Inbound customer message | One normalized event and one ordered job | | | | |
| Duplicate webhook/event | No duplicate job or outbound send | | | | |
| Owner takeover/echo | Conversation pauses for automation | | | | |
| Opt-out and opt-in | No send while opted out; explicit opt-in resumes eligibility | | | | |
| Inside response window | Normal policy path applies | | | | |
| Outside response window | Approved utility template only, otherwise escalation | | | | |
| Media/attachment | Human escalation before model generation | | | | |
| Token expiry/revocation | Processing pauses and owner is notified | | | | |
| Rate limit (429) | Bounded pre-send retry only | | | | |
| Provider 5xx/timeout | `delivery-unknown`; no automatic ambiguous retry | | | | |
| Restart/recovery | Durable work resumes or remains paused/quarantined | | | | |
| Pause All | In-flight work stops before the next side effect | | | | |

## Staging and operations

- Observe-only evidence:
- Draft approval and edit-time evidence:
- Allowlisted auto-reply evidence:
- Daily log/usage review:
- Provider charge review:
- Recovery drill duration and result:
- Backup/restore and ownership-transfer result:
- Unresolved delivery states and disposition:

## Sign-off

- Owner decision: `continue` / `pause` / `rollback`
- Failed scenarios and corrective action:
- Reviewer:
- Signed date:
