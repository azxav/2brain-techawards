# Issue #19 Search Knowledge and reauthorized internal link evidence

Verified 2026-07-13. This ledger maps the visible Search experience and the
internal Page link reauthorization behavior to the approved Notion evidence
vocabulary in `2brain-notion-evidence-matrix.md` and to current official
Notion help. It does not claim that Notion implements 2Brain Source Access,
Included in Workspace Search eligibility, Evidence Status, or Source
Freshness semantics.

Official sources:

- [Search in your workspace](https://www.notion.com/help/search) - search is
  its own explicit entry point with a query input, filters (including
  filtering to a location/source), sorted results, and keyboard entry.
- [Navigate with the sidebar](https://www.notion.com/help/navigate-with-the-sidebar) -
  Search is a first-class sidebar entry above content collections.
- [Views, filters, sorts & groups](https://www.notion.com/help/views-filters-and-sorts) -
  server-driven filtering vocabulary reused for the Evidence, Freshness, and
  Type filters.

The applicable approved matrix references are O-01/O-02 (sidebar search entry
and workspace search semantics), U-01 (restrained dark desktop shell), U-09
(control grammar), and U-11 (loading/recovery emphasis). The matrix records
"Global Search — Semantics via O-02" as capture-required, so the layout
follows the issue #6 precedent: hierarchy and component grammar are inferred
from O-02/U-01/U-09/U-11 and labelled 2Brain semantics rather than
represented as direct Notion captures.

## Evidence ledger

| ID | Visible surface or state | Official Notion mapping | 2Brain translation and verification |
|---|---|---|---|
| DE-019-01 | Search as the default global retrieval entry with an explicit, separate Ask 2Brain action | O-01/O-02 establish Search as a dedicated sidebar entry; ADR 0020 fixes deterministic-Search-first | In-app Browser at 1440x900 (dark): the sidebar exposes a `Search` item routed at `/app/search`; submitting the form calls only `GET /api/workspace/v1/search`. Ask 2Brain renders as a separate explicit adjacent button (disabled in this slice, labelled "separate explicit action") and no code path invokes synthesis from a search submission. The empty state states "Results stay deterministic; Ask 2Brain is never invoked automatically." |
| DE-019-02 | Search input, Type/Evidence/Freshness filters, and Source selector | O-02 supplies query input plus filters including source scoping; U-09 supplies the control grammar | Same-viewport verification: query `onboarding` returned two permitted results; the Source selector listed only the caller's permitted active Sources — `Team Handbook` and `Research Archive — excluded from default search` — and never listed the inaccessible `Finance` Source. Selecting the excluded Source explicitly returned its `Q3 market study` Page; with `All included Sources` the excluded and denied Sources never contributed results. |
| DE-019-03 | Result rows with Page identity, Source context, trust context, and inspectable matching evidence | O-02 sorted result semantics; O-03 property vocabulary; Evidence Status / Source Freshness are accurate 2Brain properties, not attributed Notion meanings | Each rendered result showed the title link, Source name with immutable ID, type, `Evidence: Cited/Source Backed`, `Freshness: Current`, the last-changed time, `Matched in title/body`, and a snippet with the matched term highlighted via `<mark>` (`<mark>Onboarding</mark> guide`; body snippets window at most 160 characters around the match). Restricted metadata is structurally absent: the service projects only these fields. |
| DE-019-04 | Deterministic ranking and stable cursor pagination | O-02 sorted results; determinism and keyset pagination are 2Brain requirements from design §7.9/§12.2 | Title matches rank before slug matches before body matches, then last-changed descending with `(source_id, slug)` tie-breaks. The cursor is bound to a hash of query, Source selection, and filters and pins the first-page evaluation time; a cursor replayed under a different query or selection fails as `invalid_cursor` (unit and Postgres-parity tests). |
| DE-019-05 | No-result, no-searchable-source, and restricted states without disclosure | U-11 state emphasis; fail-closed semantics are 2Brain security requirements | Same-viewport: an unmatched query rendered `No matching results`; excluding every Source from Workspace Search rendered `No Sources are included in Workspace Search` with the explicit-selection recovery; revoking Source Access rendered `Access required`. Explicitly selecting an inaccessible Source is indistinguishable from no matches at the API seam, and denied titles/bodies never appeared in any serialized response (asserted in tests). |
| DE-019-06 | Included in Workspace Search changes eligibility only | The eligibility flag is a 2Brain Source setting (issue #16 precedent), not a Notion claim | Disabling the flag removed the Source from default search while its Pages stayed reachable through explicit selection; enabling the flag on a denied Source never exposed its Pages. Pinned by unit and Postgres-parity tests. |
| DE-019-07 | Internal Page links recheck Membership, Source state, and Source Access on every open | ADR 0031; O-04 side-peek opening from result titles | Result titles link to the stable route `/app/knowledge/<source>/<slug>`. Same-viewport: the link opened the Page peek (`Onboarding guide` with its body); after revoking Source Access, reloading the identical URL rendered `Page unavailable` with recovery copy and a request ID and no content; re-granting access restored the same link. Every open re-runs the session Membership check (`status='active'`) and the Page authorization added in issue #18. |
| DE-019-08 | Loading, failure, and keyboard states | U-11 loading/recovery grammar; O-02 keyboard entry | The status region exposes `aria-busy` with `Searching permitted Sources` while in flight. A network failure rendered `Connection lost` with retry guidance, a request-ID line, and a working Retry button. Pressing `/` outside a field focuses the search input; form submission works from the keyboard. |
| DE-019-09 | Dark/light themes and supported viewports | U-01 dark shell; responsive reflow is a 2Brain accessibility adaptation | Dark 1440x900 and light 1280x720 rendered from the same tokens via media emulation. At an exact 390x844 viewport the filters stacked to two columns, the Search action spanned full width, results wrapped cleanly, and document client/scroll widths stayed 390px with no horizontal scrolling. |
| DE-019-10 | Response budget at target scale | §12.2 one-second List/filter/Search budget | With 100 Sources and 100,000 Pages on PGLite, a body-matching search completes in under one second across repeated runs, backed by the `idx_pages_trgm`, `idx_pages_slug_trgm`, and `idx_pages_body_trgm` trigram indexes (migration 121 plus schema parity in both engines). |

## Authorization and eligibility evidence

- Default Search eligibility is the intersection of active (non-archived)
  Sources, the caller's current Source Access resolved per request, and
  `included_in_workspace_search=TRUE`; explicit selection bypasses only the
  inclusion flag and is silently intersected with the permitted set.
- The Source selector endpoint returns only the caller's permitted active
  Sources, so restricted Sources are absent rather than marked.
- `Included in Workspace Search` never grants access: enabling it on a denied
  Source changes nothing for that caller (unit and Postgres-parity tests).
- Search never invokes Ask 2Brain or any generated synthesis; the module has
  no synthesis dependency and ADR 0020 fixes the default.

Status: **Pass**. Every issue #19 visible state has an explicit official
Notion primitive or a recorded capture-required inference per the approved
matrix, an accurately labelled 2Brain semantic translation where needed, and
direct same-viewport or focused automated verification.
