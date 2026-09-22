# Public webhook relay

`relay/public-relay.cjs` is the minimal production-boundary relay for Cloud/Meta/X-style webhooks. It is intentionally separate from `agentd`: the relay stores signed provider events, while the local agent polls and acknowledges them after committing locally. The relay never owns model credentials, runs workflows, or sends provider messages.

## Runtime contract

- SQLite uses WAL and a unique `(business, provider, account, provider event)` key for durable deduplication.
- `POST /v1/webhooks/{business}/{provider}` verifies `sha256=` HMAC (`x-hub-signature-256` or `x-aica-signature`), bounds the raw body to 1 MiB, commits before returning `202`, and rejects unknown identities.
- `GET /v1/agents/{business}/events` requires the per-install agent bearer secret, leases pending events, and returns raw bodies base64-encoded for local parsing.
- `POST /v1/agents/{business}/events/{id}/ack` requires the lease token. Acknowledgement is expected only after the agent has committed the event locally; the relay then removes the raw body while retaining bounded audit metadata.
- Pending or leased events expire after 24 hours by default. Expired events are not returned to an agent.
- There is no outbound-send route. The relay cannot become an autonomous agent or provider credential holder.
- TLS is supported through `AICA_RELAY_TLS_KEY_PATH` and `AICA_RELAY_TLS_CERT_PATH`; production startup should set `AICA_RELAY_REQUIRE_TLS=true` and terminate on missing certificates.

## Local run

```bash
AICA_RELAY_BUSINESS_ID=business-1 \
AICA_RELAY_PROVIDER=whatsapp-cloud \
AICA_RELAY_PROVIDER_SECRET="<32+ random chars>" \
AICA_RELAY_AGENT_SECRET="<32+ random chars>" \
AICA_RELAY_REQUIRE_TLS=true \
AICA_RELAY_TLS_KEY_PATH=/etc/aica/relay.key \
AICA_RELAY_TLS_CERT_PATH=/etc/aica/relay.crt \
npm run relay
```

Use a persistent, owner-controlled database path with `AICA_RELAY_DB_PATH`; back it up and expire encrypted backups under the retention policy. Bind publicly only behind the selected HTTPS deployment, firewall, DNS and provider callback configuration. The repository tests prove the protocol and failure semantics; provider ownership, DNS/TLS reachability, backup/restore, quotas and live callback evidence remain deployment gates.
