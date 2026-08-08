# Issue #20 Permanent deletion of an Archived Source evidence

Verified 2026-07-13. This ledger maps the visible danger-zone, impact
preview, typed confirmation, progress, success, failure, permission,
keyboard, theme, and viewport states of permanent Source deletion to the
approved Notion evidence vocabulary in `2brain-notion-evidence-matrix.md`
and to current official Notion help. It does not claim that Notion
implements 2Brain Source Access, Archive-before-delete, redacted retention,
or Background Operation semantics.

Official sources:

- [Duplicate, delete & restore content](https://www.notion.com/help/duplicate-delete-and-restore-content) -
  deletion is a deliberate action distinct from ordinary removal; deleted
  content passes through a recoverable state (Trash) before it is
  permanently and irreversibly deleted, and permanent deletion is an
  explicit, separate confirmation.
- [Account settings & preferences](https://www.notion.com/en-gb/help/account-settings) -
  destructive account-level actions live in Settings behind explicit
  confirmation ("danger zone" grouping).
- [Views, filters, sorts & groups](https://www.notion.com/help/views-filters-and-sorts) -
  server-driven collection vocabulary reused for the archived Source list.

The applicable approved matrix references are U-03 (two-pane Settings modal),
U-08 (focused destructive confirmation modal with backdrop, primary
destructive action, and cancel), U-09 (large modal form grammar), and U-11
(loading/recovery emphasis). The matrix records that exact Notion captures
for delete-specific confirmation remain capture-required, so the dialog
follows the issue #6/#16 precedent: hierarchy and component grammar are
inferred from U-03/U-08/U-09/U-11 and labelled 2Brain semantics rather than
represented as direct Notion captures. The Archive-first requirement is
2Brain's translation of Notion's Trash-before-permanent-deletion sequence
(ADR 0017); typed-identifier confirmation is a permitted
security-clarity deviation strengthening U-08's destructive confirmation.

## Evidence ledger

| ID | Visible surface or state | Official Notion mapping | 2Brain translation and verification |
|---|---|---|---|
| DE-020-01 | Danger zone available only to Administrators, only in Settings, only for Archived Sources | Official trash help sequences recoverable removal before permanent deletion; U-03 places destructive configuration inside Settings | In-app Browser at 1440x900 (dark): `Permanently delete…` renders as a danger-styled button only on rows of the Archived tab of Settings → Sources, beside `Restore Source`. Active rows offer only `Archive Source`. A Member session rendered the Settings route as `Forbidden — Administrator access is required.` and both endpoints returned 403 (DE-020-07). |
| DE-020-02 | Impact preview before confirmation, counts only | U-08 requires the destructive modal to state consequences; counts-only disclosure is a 2Brain security deviation (no unauthorized content) | Opening the dialog fetched `GET …/deletion-impact` and rendered "14 Pages, 15 Page Versions, 1 Saved Views referencing this Source, 0 Background Operations, 0 verification records, and 1 access grants are affected. Redacted lifecycle history and immutable Audit Events are retained until Workspace deletion." No titles, bodies, or names appear — the service projects counts only (pinned by unit and Postgres-parity tests). While the preview loads, the confirm action stays disabled; a failed preview keeps deletion disabled with recovery copy and a request ID. |
| DE-020-03 | Typed confirmation of the immutable Source ID | U-08 destructive confirmation; typing the identifier is a recorded security-clarity deviation | The confirm button stayed disabled with an empty field and with the display name `Legacy Notes` typed, and enabled only for the exact immutable ID `legacy-notes`. The hint reads "The Source ID, not the display name." Server-side, `confirm_source_id` mismatches fail closed as `confirmation_mismatch` (400) regardless of client state. |
| DE-020-04 | Required reason and immutable audit trail | Audit reasoning is a 2Brain governance semantic (ADR 0032), not a Notion claim | The dialog requires a Reason "Recorded with the immutable Audit Event." The request audit (`source.delete.request`) records the reason; the destructive completion audit (`source.delete`) records outcome `succeeded` with the same reason; failed executions record `source.delete.fail` with outcome `failed`. Audit rows are UPDATE/DELETE-blocked by trigger (unit and Postgres-parity tests). |
| DE-020-05 | Durable Background Operation with visible progress, success, and safe retry semantics | U-11 loading/status emphasis; Background Operation lifecycle is 2Brain design §8.3 | Submitting rendered "Permanent deletion queued. Operation `<id>` is Queued. Track progress under Background operations." Settings → Background operations showed the operation at `Queued · Attempt 0 of 3 · 0%` with a progress bar, request ID, and a Cancel action while cancellation-safe; after the worker ran it showed `Completed · 100%` with "Source permanently deleted. Redacted lifecycle history and Audit Events are retained." Generic execution failures remain retryable within attempt limits (unit tests); lease expiry lets a replacement worker reclaim and idempotently repeat the purge (restart-recovery unit test). |
| DE-020-06 | Revalidation immediately before destructive execution; failure state | Fail-closed revalidation is a 2Brain security semantic; U-11 supplies the failure/recovery grammar | Restoring `old-wiki` after queueing its deletion made the worker fail before any purge: the operation rendered `Failed · Attempt 1 of 3` with "The deletion assumptions changed before destructive execution. Request permanent deletion again." and no Retry action (`retryable=false` — stale typed confirmation must not be replayed). Content and the lifecycle row were untouched. Archived state, requester role/status, and Source Access are re-checked inside the destructive transaction with row locks (unit and Postgres-parity tests). |
| DE-020-07 | Permission states | U-03 Settings access model; deny-by-default is 2Brain authorization | Member session: the Sources settings route rendered the Forbidden document with recovery copy and a request ID; `deletion-impact` and `permanently-delete` returned 403. Administrators without Source Access fail as `source_deletion_forbidden` (403, unit-tested). Disabling the requesting Administrator after queueing fails execution as `authorization_revoked` (unit and Postgres parity). |
| DE-020-08 | Purge and retention outcome | Official trash help establishes permanent deletion as irreversible; redacted retention is 2Brain design §14.1 | After completion the archived list no longer offers the Source; restore of a deleted Source fails as `source_not_found`; legacy Pages, Page Versions, chunks, and ingest evidence for the Source are purged while the redacted lifecycle row (identifiers and lifecycle facts only — name and remote URL overwritten) and every Audit Event remain until Workspace deletion (unit and Postgres-parity tests). |
| DE-020-09 | Keyboard, focus, themes, and supported viewports | U-08 modal grammar; U-01 dark shell; responsive reflow is a 2Brain accessibility adaptation | Escape closed only the delete dialog and returned focus to the originating `Permanently delete…` button; Tab focus is trapped inside the open dialog; all controls are native buttons/inputs with `:focus-visible` treatment. Dark 1440x900 and light 1280x720 rendered from the same tokens via media emulation. At an exact 390x844 viewport the mutation buttons are absent, the status card reads "Use a larger viewport to Archive or restore Sources. Permanent deletion also requires a larger viewport.", and document client/scroll widths stayed 390px with no horizontal scrolling. |

## Authorization and retention evidence

- Queueing revalidates Administrator role, active status, and Source Access
  with row locks inside the protected mutation; the archived, non-deleted
  Source row is locked in the same transaction (`source_not_archived` /
  `source_not_found` otherwise).
- The Background Operation is idempotent: replaying the same idempotency key
  returns the same operation; the same key with a different payload fails as
  `idempotency_key_reused` (unit and Postgres parity).
- The destructive transaction re-checks archived state, non-deleted state,
  and the initiator's current authorization immediately before the first
  destructive statement; every purge statement is idempotent so reclaimed
  leases repeat safely.
- Deleted Sources disappear from active and archived listings, cannot be
  restored or re-deleted, and their redacted lifecycle rows plus immutable
  Audit Events persist until Workspace deletion (design §14.1).

Status: **Pass**. Every issue #20 visible state has an explicit official
Notion primitive or a recorded capture-required inference per the approved
matrix, an accurately labelled 2Brain semantic translation where needed, and
direct same-viewport or focused automated verification.
