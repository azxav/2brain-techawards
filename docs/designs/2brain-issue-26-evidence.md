# Issue #26 authenticated non-jumping live-update evidence

Verified 2026-07-14. This ledger records the approved evidence fallback for
Issue #26. It maps the live-update status surface to the project-owned Notion
captures U-01, U-03, and U-11 and the official Notion database references
O-03 through O-05 in `2brain-notion-evidence-matrix.md`. It does not claim
that Notion implements 2Brain authentication, Source Access filtering,
server-sent events, cursor recovery, or the non-jumping pending-update model.

Official references:

- [What is a database?](https://www.notion.com/help/what-is-a-database) —
  rows, properties, views, filtering, and sorting provide the stable list
  grammar used by Knowledge and operational surfaces.
- [Views, filters, sorts & groups](https://www.notion.com/help/views-filters-and-sorts) —
  visible view controls and ordering remain under the Member's control.
- [Table view](https://www.notion.com/help/tables) — row and property
  interaction supports explicit application of updates to an existing list.

The fallback was verified against the real server-rendered Workspace document,
its responsive CSS contracts, the authenticated polling and SSE routes, and
the safe event projector in targeted automated tests. The in-app Browser
runtime could not initialize because its bundled client failed while defining
the required `process` shim (`TypeError: Cannot redefine property: process`),
so this ledger records DOM/accessibility and route-contract evidence rather
than new bitmaps. The same status markup is emitted for desktop and mobile;
the U-01 desktop shell and U-03 Settings-dialog captures establish those
surfaces, while the `max-width: 720px` contract moves the status surface to a
bottom, full-width mobile placement without changing its controls or wording.

## Evidence ledger

| ID | Visible surface or state | Approved mapping | 2Brain translation and verification |
|---|---|---|---|
| DE-026-01 | Connected | U-01 shell tokens | The shared status region announces `Live updates connected` through `role=status` and `aria-live=polite`. It is fixed above the current surface and does not replace, reorder, or obscure the active list. |
| DE-026-02 | Pending count without list movement | O-03/O-04/O-05 stable view and row grammar | Authorized invalidations enter an ID-keyed pending map. The visible list, filters, sort, selection, and scroll position are untouched until the Member activates `Apply N new updates`; duplicate event IDs cannot increase the count. |
| DE-026-03 | Explicit apply | O-04 member-controlled view settings; O-05 table interaction | Applying refreshes only the active surface through its existing loader. Knowledge, Search, Agents, Attention, and Settings keep their current surface controls; an empty safe state may apply immediately because there is no existing order or position to disrupt. |
| DE-026-04 | Stream failure and safe polling fallback | U-11 elevated status/recovery emphasis | A failed stream changes the status to `Live stream unavailable — polling for updates`. Constructor failure or a stream that does not connect within four seconds enters the same fallback. Polling uses the authenticated safe projector every two seconds, while a reconnect is attempted after ten seconds; stale poll responses and superseded stream events are ignored. Only one transport mode schedules requests at a time. |
| DE-026-05 | Complete connection loss | U-11 loading/recovery emphasis | When neither transport is trustworthy, the region shows `Last Trustworthy State — Potentially outdated` and `Retry connection`; the prior list remains visible and unchanged. Retry is a native focusable button and the status change is announced politely. |
| DE-026-06 | Initial connection, reconnect, and duplicate delivery | O-03/O-05 stable rows | The authenticated document embeds the current committed Workspace cursor before any client surface loader starts, so history is not replayed and no change can fall between a later baseline and the initial snapshot. A `latest` API bootstrap remains a stable fallback: it resolves and persists a numeric cursor, then reloads the surface before opening SSE so the snapshot and baseline cannot diverge. Subsequent numeric cursors are persisted and supplied as the SSE cursor/Last-Event-ID equivalent. Polling and streaming share a monotonic cursor; the applied-ID and pending-ID sets prevent duplicate application across reconnects and transport changes. |
| DE-026-07 | Source Access reduction or membership/session revocation | U-11 recovery emphasis; 2Brain authorization deviation | Each stream tick and polling request reauthenticates current membership and recomputes current Source Access, including for Administrators. A self access invalidation discards all queued updates before reloading; unrelated membership/invitation changes enter the explicit pending flow instead. Session or membership revocation returns 401 or closes the stream before future delivery. Previously queued restricted Source and Source-derived Attention events are projected out at read time. |
| DE-026-08 | Safe event content | O-03 property grammar; 2Brain security deviation | Client events contain only event ID, numeric cursor, affected surface, and timestamp. Source IDs, Page content, prompts, secrets, request details, hidden resource metadata, and raw worker output are absent. Denied rows still advance the cursor so timing/retry behavior cannot expose their identity. |
| DE-026-09 | Desktop, mobile, theme, keyboard, and reduced-motion contracts | U-01/U-03 shell surfaces | The status surface uses existing theme tokens, native buttons, and a visible focus outline. Desktop anchors it at the upper right with a reserved top canvas/Page-peek inset; at 720px and below it reflows across the lower viewport with reserved content insets, wrapping, and 44px touch controls. Settings owns the status controls inside its modal focus scope and above its backdrop. The same accessible names and state transitions are emitted in both layouts. The component introduces no animation, transition, or auto-moving list content, so its live-update states do not require motion to understand or operate. |

## Authorization and timing evidence

- `workspace_change_events` has a monotonic `event_sequence` and indexed
  `(workspace_id, event_sequence)` cursor. Delivery never trusts client role
  or Source Access claims: it reloads the active membership and resolves the
  Member's effective Source Access for every batch. Event insertion locks the
  Workspace row before sequence allocation, making cursor order follow commit
  order even when mutations run concurrently.
- Source and Source-derived Attention invalidations are projected through
  current Source Access. Organization-visible Agent invalidations are visible
  to active Members; Workspace, invitation, and Background Operation
  invalidations are Administrator-only. Unknown resource types fail closed.
- SSE checks every second and fallback polling checks every two seconds, both
  below the five-second acceptance threshold. Hidden events advance the safe
  cursor without exposing a payload. Batch projection uses a bounded set of
  resource queries rather than one query per event; a 100-event burst is
  pinned to at most five database calls in focused coverage.
- Targeted unit and HTTP coverage verifies unauthenticated rejection, current
  access projection, access reduction, session revocation, invalid cursors,
  polling/SSE projection parity, current-cursor bootstrap, overflow rejection,
  cursor checkpoints, executable duplicate-safe pending/apply behavior, and
  trustworthy-state recovery.
  The targeted Postgres parity test verifies the same cursor and Source Access
  behavior against PostgreSQL.
