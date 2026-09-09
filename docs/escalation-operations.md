# Escalation operations

The desktop supervisor records escalation and failure notifications locally and
shows the configured response target in the owner panel. Configure the
deployment before enabling autonomous replies:

```sh
AICA_ESCALATION_CONTACT="support-owner@example.com"
AICA_ESCALATION_SLA_MINUTES=60
```

`AICA_ESCALATION_SLA_MINUTES` accepts a positive bounded value; the default is
60 minutes. An unset contact is intentionally reported as “contact not
configured” and does not silently claim that a human escalation path exists.

The operator must define who owns the contact, acknowledge escalations within
the SLA, review `delivery-unknown` and failure notifications, and complete
pause/recovery and live-provider drills. Retention defaults and deletion
behavior are documented in `docs/release-readiness.md` and the implementation
checklist.
