# Connected App administrative changes do not require free-text reasons

ADR-0032 remains authoritative: protected administrative changes create immutable Audit Events with actor, action, target, timestamp, redacted before/after values, result, and request ID.

Connected App Access Level changes and pair-wide revocations are a narrow exception to ADR-0032's free-text reason requirement. The selected level or revocation is itself the complete structured intent, so requiring prose adds friction without improving the evidence. Administrator actions remain protected and audited transactionally; Member-own changes are not administrative Audit Events. No Notification is generated solely for either action.

This decision supersedes ADR-0032 only for the reason field on `connected_app.access_level.change` and `connected_app.revoke`.
