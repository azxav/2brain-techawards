# Issue #17 Knowledge Saved Views evidence

Verified 2026-07-13. This ledger maps the visible Knowledge experience to the
approved Notion evidence vocabulary in `2brain-notion-evidence-matrix.md` and
to current official Notion help. It does not claim that Notion implements
2Brain Source Access, evidence provenance, Source Freshness, or Last
Trustworthy State semantics.

Official sources:

- [What is a database?](https://www.notion.com/help/what-is-a-database) - a
  database is a collection of Pages; rows are Pages; properties support
  search, filter, and sort; one collection can have multiple views and sources.
- [Views, filters, sorts & groups](https://www.notion.com/help/views-filters-and-sorts) -
  table rows expose properties as columns, each view owns property visibility,
  filters, and sorts, and users can create and switch views.
- [Table view](https://www.notion.com/help/tables) - the classic database view
  is a row-and-column table whose rows open Pages and whose properties can be
  customized.
- [Search in your workspace](https://www.notion.com/help/search) - search finds
  Pages and supports narrowing full-page results with properties such as source
  and title.

The applicable approved matrix references are O-02 (search), O-03 (database
rows, properties, views, filters, sorts), O-04 (per-view settings), O-05
(table rows and columns), U-01 (dark desktop shell/table), and U-11
(loading/recovery emphasis).

## Evidence ledger

| ID | Visible surface or state | Official Notion mapping | 2Brain translation and verification |
|---|---|---|---|
| DE-017-01 | Default Knowledge database, Page rows/titles, properties, dark theme | O-03/O-05 and the official database/table help establish Pages as rows and properties as columns. U-01 establishes the restrained dark desktop shell. | At 1440x900 the in-app Browser rendered six permitted Pages in six server-shaped columns, active Knowledge navigation, no document overflow, and no warning/error console output. Artifact: `D:\Temp\gbrain-issue17-evidence\knowledge-ready-desktop-1440x900.png`. |
| DE-017-02 | Search, type/evidence/freshness filters, property picker, sort and direction | O-02/O-03/O-04 establish searchable databases and per-view filter, property-visibility, and sort settings. | Browser checks removed Type and confirmed the server response/table omitted that column. A no-match query preserved controls and displayed the dedicated no-match state. Artifact: `knowledge-no-matches-desktop-1440x900.png`. Evidence Status and Source Freshness are accurate 2Brain properties, not attributed Notion meanings. |
| DE-017-03 | Personal Saved View create, open, update, delete | O-03/O-04 establish creating/switching views and view-local settings. | Opening Policies at 1440x900 reloaded two authorized Policy rows, Title ascending, and four visible properties. The create dialog focused View name and explained that Source Access never changes. CRUD and owner isolation are also covered at the service/API seam. Artifact: `knowledge-saved-view-desktop-1440x900.png`. |
| DE-017-04 | Cursor and Load more | O-03/O-05 establish incremental database-result presentation; the opaque cursor is a 2Brain server contract. | At the same desktop viewport, the first request rendered 50 rows plus header and a visible Load more button; activating it appended the remaining 16 rows (51 to 67 table rows). Service tests prove stable query-bound cursors and reject malformed or cross-query reuse. |
| DE-017-05 | Empty Workspace, Access required, no compiled Pages, no matches | O-03/O-05 supply the database/table container; U-11 supplies compact state/recovery emphasis. | Controlled fixture routes verified distinct copy and actions for all four states at 1440x900. Source Access and compiled-Page distinctions are required 2Brain security/product semantics and are intentionally not represented as Notion capabilities. No-match artifact: `knowledge-no-matches-desktop-1440x900.png`. |
| DE-017-06 | Initial loading, connection loss, failed refresh, Last Trustworthy State | U-11 supplies loading/recovery emphasis; the persistent database context comes from O-03/O-05. | Initial load exposes a polite busy status. A forced 503 after a successful load preserved all rows, restored the displayed trustworthy filters after a failed filter attempt, displayed a potentially-outdated warning, timestamps, Retry, and safe request ID, and did not expose the loading announcement. A first-load 503 instead displayed Knowledge unavailable. Last Trustworthy State is a 2Brain trust semantic, not a Notion claim. |
| DE-017-07 | Keyboard and focus | O-02 establishes keyboard-accessible search and O-04 establishes view controls; U-01 supplies focus hierarchy. | Pressing `/` focused Search this view. Save view moved focus into View name. All controls are native links, buttons, inputs, selects, details, checkboxes, table headings, and a dialog with visible `:focus-visible` treatment. |
| DE-017-08 | Dark/light themes | U-01 establishes the approved dark shell; O-03/O-05 establish restrained table hierarchy. | Dark and light were rendered at the same 1280x720 viewport with browser media emulation. Dark resolved `--bg:#191919`/`--text:#f1f1ef`; light resolved `--bg:#fff`/`--text:#202020`; both had 1280px document/client widths. Artifacts: `knowledge-ready-dark-1280x720.png` and `knowledge-ready-light-1280x720.png`. System typography and native controls are used; no Notion logo, illustration, icon, or proprietary asset ships. |
| DE-017-09 | Supported responsive viewport | O-03/O-05 establish table hierarchy while the responsive reflow is a 2Brain accessibility adaptation. | In an exact 390x844 in-app Browser iframe, `innerWidth/clientWidth/scrollWidth` were all 390px. Controls reflowed to two columns, navigation remained available, and only the 700px table used intentional horizontal scrolling inside its 347px scroller. Artifact: `knowledge-ready-mobile-wrapper.png`. |

## Authorization and scale evidence

- Every direct list request and Saved View open resolves the current active
  Source set and current principal Source Access before querying Pages.
- Saved Views persist only personal filter, sort, and visible-property
  preferences. Deleted, archived, and newly inaccessible Sources cannot be
  recovered from saved configuration.
- The scale fixture contains 100 Sources and 100,000 Pages. Warm default and
  filtered first-page requests each return 50 rows with a stable cursor and
  remain below the approved one-second response budget.
- Page bodies never enter the list DTO. Targeted indexes cover changed-time,
  case-insensitive title, and type/changed-time keyset paths.

Status: **Pass**. Every issue #17 visible state has an explicit official
Notion primitive, an accurately labelled 2Brain semantic translation where
needed, and direct same-viewport or focused automated verification.
