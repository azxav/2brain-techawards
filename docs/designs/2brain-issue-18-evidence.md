# Issue #18 Page provenance, history, and Evidence Status evidence

Verified 2026-07-13. This ledger maps the visible Page detail, provenance,
history, and Evidence Status experience to the approved Notion evidence
vocabulary in `2brain-notion-evidence-matrix.md` and to current official
Notion help. It does not claim that Notion implements 2Brain Source Access,
Evidence Status, Source Freshness, or unknown-attribution semantics.

Official sources:

- [Views, filters, sorts & groups](https://www.notion.com/help/views-filters-and-sorts) -
  database rows open as a side peek or a full page; the side peek preserves
  the collection context behind it.
- [What is a database?](https://www.notion.com/help/what-is-a-database) - rows
  are Pages whose properties describe the Page and remain visible on the Page.
- [Table view](https://www.notion.com/help/tables) - table rows open Pages
  from their title cell.
- [Page history](https://www.notion.com/help/duplicate-delete-and-restore-content) -
  Notion retains timestamped page versions that can be inspected and compared
  against the current content.

The applicable approved matrix references are O-03/O-04/O-05 (database rows,
side-peek opening, table row titles), U-01 (restrained dark desktop shell),
U-09 (dialog/panel control grammar), and U-11 (loading/recovery emphasis).
The matrix records that controlled Notion captures for "Page detail and
provenance" and "Page history panel and diff" are still capture-required, so
those layouts follow the issue #6 precedent: hierarchy and component grammar
are inferred from U-01/U-09/U-11 and labelled 2Brain semantics rather than
represented as direct Notion captures.

## Evidence ledger

| ID | Visible surface or state | Official Notion mapping | 2Brain translation and verification |
|---|---|---|---|
| DE-018-01 | Page trust header before rendered content: title, type, Source, original location, ingestion path, timestamps, Source Freshness with evidence, Evidence Status with plain-language explanation, composite Page identity | O-03 establishes properties describing a Page; U-01 supplies the restrained elevated surface | In-app Browser at 1440x900 (dark) rendered every trust-header field for `handbook-source / onboarding`: type, Source name with immutable ID, composite identity, original location, `sync — revision-4f2c91d` ingestion evidence with its recorded time, created/last-changed/effective timestamps, `Current — Daily cadence, last verified …` freshness evidence, and `Cited — Explicit traceable citations are present (2).` The body rendered below the header as read-only text. |
| DE-018-02 | Side-peek opening from a Knowledge row title with a stable full route | O-04/O-05 establish side-peek opening from table row titles with the collection preserved behind it | Clicking the row title opened the peek over the still-visible Knowledge table and pushed the stable route `/app/knowledge/handbook-source/onboarding`; loading the same route directly reopened the peek (deep link and mobile fallback). Close restored `/app/knowledge` and returned focus to the originating row link. |
| DE-018-03 | Page history side panel preserving Page context | O-04 supplies the persistent-context panel pattern; the Page history semantic follows the official page-history help; layout inferred per the capture-required matrix note | History opened as a side panel beside the still-visible trust header and body. Two Page Versions listed newest first with snapshot timestamps, content, and metadata snapshots proven at the service seam and in Postgres parity. |
| DE-018-04 | Unknown attribution and evidenced cause | Official page-history help establishes timestamped versions; attribution honesty is a 2Brain trust semantic, not a Notion claim | The newest version showed `Actor: Unknown · Cause: sync — revision-4f2c91d` (ingest evidence inside its snapshot interval); the earliest showed `Actor: Unknown · Cause: Unknown` with `Earliest retained snapshot.` Actor is never recorded in v1, so the service returns null and the product says Unknown; nothing fabricates authorship. |
| DE-018-05 | Version diff against the adjacent version | Version comparison follows the official page-history help; presentation inferred from U-01 monospace/panel grammar | `Diff against previous version` expanded to a deterministic removed/added line diff (`- Read the handbook first.` / `+ Read the security policy first.` …). Identical snapshots render `No content change between snapshots.` |
| DE-018-06 | Deterministic Evidence Status | Evidence Status is an accurate 2Brain property, not an attributed Notion meaning | Cited, Source-backed, and Missing evidence are classified by one shared SQL expression (explicit citations array, then traceable original, else missing) with explainable inputs (citation count, traceable-original flag) surfaced in the trust header and pinned by unit and Postgres-parity tests. |
| DE-018-07 | Read-only browser with restricted/failure states and no disclosure | U-11 supplies compact state/recovery emphasis; fail-closed denial is required 2Brain security semantics | A direct request for `denied-source/private` rendered `Page unavailable` with recovery copy and a request ID; no denied title or body text reached the response (asserted at the API seam). Denied, archived, deleted, and absent Pages are indistinguishable `page_not_found`. The peek offers only Close, Copy Workspace Link, and History — no edit, revert, or attribution control exists in markup or script. |
| DE-018-08 | Loading, keyboard, and focus | U-09/U-11 supply dialog control and loading grammar | The peek exposes a polite `aria-busy` loading status. Escape closes History first (focus returns to the History toggle), then the peek (focus returns to the originating row link). All controls are native buttons/links/details with visible `:focus-visible` treatment. |
| DE-018-09 | Dark/light themes and supported viewports | U-01 establishes the dark shell; the responsive reflow is a 2Brain accessibility adaptation | Dark 1440x900 and light 1280x720 rendered from the same tokens via media emulation. At an exact 390x844 viewport the peek computed to the full 390px width, the history panel stacked below the body, trust fields wrapped to single-column, and document client/scroll widths stayed 390px with no horizontal document scrolling. |

## Authorization and retention evidence

- Every direct Page and version request revalidates the active (non-archived)
  Source row, then the Member's current Source Access, before touching Pages;
  removing access or archiving the Source between requests flips both
  endpoints to `page_not_found` (unit and Postgres-parity tests).
- Page Versions are served only for non-deleted Pages of active Sources and
  retain full content and metadata snapshots; a missing versions store yields
  an honest empty history instead of an error.
- Ingestion evidence comes solely from recorded ingest-log rows scoped to the
  Page's Source and slug; a version's cause must fall inside that version's
  snapshot interval, and anything less specific is presented as Unknown.

Status: **Pass**. Every issue #18 visible state has an explicit official
Notion primitive or a recorded capture-required inference per the approved
matrix, an accurately labelled 2Brain semantic translation where needed, and
direct same-viewport or focused automated verification.
