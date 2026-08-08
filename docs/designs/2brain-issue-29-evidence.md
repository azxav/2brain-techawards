# Issue #29 Ask 2Brain design evidence

Verified functionally on 2026-07-14. This ledger maps the visible Ask 2Brain
flow to current official Notion material and the approved evidence vocabulary in
`2brain-notion-evidence-matrix.md`. It does not claim that Notion implements
2Brain's fail-closed Source Access, final citation reauthorization, refusal, or
durable cancellation semantics.

Official sources (retrieved 2026-07-14):

- [Search in your workspace](https://www.notion.com/help/search) establishes
  Search as a first-class entry and documents the separate `Search all sources
  with AI` action, source filters, keyboard entry, and a full-page result.
- [Enterprise Search](https://www.notion.com/help/enterprise-search) documents
  a single question in Home, explicit search scope, source selection, and the
  rule that workspace/connector answers cite their sources.
- [Find answers and generate reports with enterprise search](https://www.notion.com/help/guides/find-answers-and-generate-reports-with-enterprise-search)
  shows the question entry, AI overview, consulted-source breakdown, source
  picker, verified Page signal, and longer-running Research progress.
- [Notion AI Connectors](https://www.notion.com/help/notion-ai-connectors)
  explicitly describes answers that surface relevant information and cite the
  specific sources referenced.
- [Enterprise Search product page](https://www.notion.com/product/enterprise-search)
  provides the official answer/result visual and states that answers include
  verified content and citations using selected Sources.

The applicable approved matrix references are O-01/O-02 (Search and source
scope), U-01 (restrained shell), U-09 (control/dialog grammar), and U-11
(loading/recovery emphasis). Ask remains `Capture required` in the matrix.
2Brain-specific evidence safety is therefore documented as a product/security
translation, not attributed to Notion.

The in-app Browser runtime could not initialize after the Windows fallback had
reserved its required process shim (`Cannot redefine property: process`). The
operator then explicitly requested the fallback. Installed Microsoft Edge was
run headlessly against isolated profiles, current official Notion pages, and a
seeded PGlite server using the production Workspace router and shell. Reference
and implementation desktop captures use the same 1440x900 viewport; responsive
captures use 390x844. The visual harness injects only a synthetic authenticated
session, deterministic result rows, dialog state, and light-token emulation; it
does not replace or restyle the production shell.

## Evidence ledger

| ID | 2Brain surface and state | Official Notion mapping | 2Brain translation and automated evidence | Same-viewport status |
|---|---|---|---|---|
| DE-029-01 | `/app/search`, Ask entry, keyboard/focus, light/dark, desktop/mobile | Search Help + Enterprise Search: Search and AI question are distinct explicit actions in the same retrieval area | `workspace-shell.ts` renders an enabled adjacent `Ask 2Brain` button; the Search submit path still calls only deterministic Search. Focus-visible tokens and the existing light/dark/mobile shell apply. `workspace-search.test.ts` preserves Search isolation. | **Verified:** official Search and Enterprise Search plus 1440x900 light/dark and 390x844 implementation captures show distinct adjacent Search/Ask entry. |
| DE-029-02 | Single-question dialog, empty/filled/validation/submitting states | Enterprise Search question field and source scope; U-09 dialog/control grammar | One required `textarea`, 200-character maximum, one submit action, optional currently selected permitted Source, no persona, thread list, or history UI. HTTP returns `202` with durable `queued` state before synthesis. | **Verified:** empty, filled, native required-field validation, held acknowledgement, and 390x844 dialog captures use the real form and browser validation. |
| DE-029-03 | Queued/running progress and Cancel | Official enterprise/research result progress vocabulary; U-11 loading emphasis | `/app/ask/:id` exposes an `aria-live` progress region, polls durable state, and keeps `Cancel Ask` visible for `queued`/`running`. Unit and Postgres tests prove delayed completion cannot overwrite cancellation. | **Verified via approved composed fallback:** official Research progress/source grammar plus the 1440x900 running capture; terminal captures confirm Cancel is absent after completion. |
| DE-029-04 | Supported cited answer | Enterprise Search Help, AI Connectors, and product result visual all establish source-cited answers | Answer text is rendered only after every structured citation resolves to a retrieved Page, every answer sentence is present in cited Page evidence, and each Page is reauthorized at finalization. Citations are internal Page links and result open rechecks current access. Unit, HTTP, and Postgres parity tests pass. | **Verified:** official enterprise result/citation references and 1440x900 plus 390x844 cited-answer captures. Browser capture also found and fixed trust-state rendering and citation-label encoding defects. |
| DE-029-05 | `Not enough evidence`, Evidence Gap, searched Sources, trust state, safe next action | U-11 state emphasis and enterprise source breakdown; refusal semantics are the 2Brain translation required by ADR-0021 | The refusal is a terminal structured result with no answer text. The UI labels the Evidence Gap, accessible Sources searched, trust state, and safe next action. Tests cover no permitted match, fabricated Page reference, and mid-request revocation. | **Verified via approved composed fallback:** official source-breakdown/recovery grammar plus a 1440x900 structured refusal capture; no public Notion refusal is claimed. |
| DE-029-06 | Cancelled outcome | Research/progress grammar plus 2Brain safety translation | Cancellation persists `cancelled`, aborts the active synthesizer when local, removes citations/answer, and renders an understandable terminal outcome stating that no partial unsupported answer was presented. | **Verified via approved composed fallback:** the 1440x900 terminal capture shows safe cancellation and no partial answer; exact Notion cancellation semantics are not claimed. |
| DE-029-07 | Permission/revoked internal result | Search/AI uses content the Notion user can access; 2Brain adds fail-closed nondisclosure | Every supported-result open checks active Membership plus every cited Source. Denied, archived, expired, and inaccessible cited results share the same unavailable state and request identifier. If access changes before an answer is finalized, the requester instead receives a safe refusal containing only the Sources still accessible. Unit and Postgres parity tests cover revocation. | **Verified:** a denied-Source result produces the common unavailable state with request ID and no Source/title disclosure at 1440x900. |
| DE-029-08 | Loading/failure/retry-safe outcome | U-11 loading/recovery grammar | Progress is durable; unexpected synthesis failure stores `failed` with no answer/citations; browser errors expose safe copy and a request ID rather than provider details. | **Verified:** running, failed-safe, and unavailable captures exercise progress and recovery-safe terminal copy without provider detail. |
| DE-029-09 | Reduced motion and supported viewport reflow | Existing approved shell primitives; responsive behavior is a WCAG/2Brain adaptation | Global reduced-motion disables animation duration; Ask controls wrap and remain at least 38â€“40px high, with the existing mobile shell breakpoint at 720px. HTML contract assertions cover responsive and theme rules. | **Verified:** 1440x900 light/dark and 390x844 dark captures show reflow without document clipping; reduced-motion remains a targeted CSS contract because a still image cannot evidence motion. |

## Functional and authorization evidence

- `test/workspace-ask.test.ts` covers Search-first context, supported citations,
  refusal of citation syntax/fabricated Page references, mid-request revocation,
  durable cancellation, HTTP acknowledgment, and non-chat UI contracts.
- `test/e2e/workspace-boundary-postgres.test.ts` covers answer, refusal, final
  reauthorization, and cancellation on real Postgres.
- `workspace_ask_results` stores the question and structured result fields; it
  has no raw provider prompt or full-parameter column, expires after 30 days,
  and is not joined into the Page/Search index.
- Deterministic `searchWorkspaceKnowledge` runs first. Its permitted Source set
  is then passed into one-hop Page graph expansion, and every expanded Page is
  read through reauthorized `getWorkspacePage`; the unit fixture proves a link
  into a denied Source is excluded. No hybrid, take/fact, or trajectory arm is
  invoked, so there is no additional unscoped retrieval arm.

## Rendered artifact ledger

Redacted synthetic artifacts remain outside the repository under
`C:\Users\aziz\.codex\visualizations\2026\07\14\019f5f74-42de-7690-a690-e29fe36444da`.
No personal Workspace data appears in them.

| Surface/state | Artifact |
|---|---|
| Official Search, 1440x900 | `notion-search-1440x900.png` |
| Official Enterprise Search, 1440x900 | `notion-enterprise-search-1440x900.png` |
| Official enterprise-search guide, 1440x900 | `notion-enterprise-guide-1440x900.png` |
| Official AI Connectors, 1440x900 | `notion-ai-connectors-1440x900.png` |
| Official Enterprise Search product page, 1440x900 | `notion-enterprise-product-1440x900.png` |
| Search dark/light desktop | `2brain-search-1440x900.png`, `2brain-search-light-1440x900.png` |
| Search mobile | `2brain-search-390x844.png` |
| Dialog empty/filled/validation/submitting | `2brain-ask-dialog-light-1440x900.png`, `2brain-ask-dialog-filled-1440x900.png`, `2brain-ask-dialog-validation-1440x900.png`, `2brain-ask-dialog-submitting-1440x900.png` |
| Dialog mobile | `2brain-ask-dialog-390x844.png` |
| Running/answer/refusal | `2brain-running-1440x900.png`, `2brain-answer-1440x900.png`, `2brain-refusal-1440x900.png` |
| Cancelled/failed/revoked | `2brain-cancelled-1440x900.png`, `2brain-failed-1440x900.png`, `2brain-revoked-1440x900.png` |
| Answer mobile | `2brain-answer-390x844.png` |

The headless fallback emitted no application console output. Captures exposed
two real client defects that the HTML-only contract had missed: string-valued
freshness crashed the result renderer, and the Ask action display rule
overrode the terminal `hidden` state. Both now have targeted regression
assertions. Citation labels are normalized to an ASCII separator so rendered
evidence is not affected by legacy source-file encoding.

Status: **Verified with operator-approved fallback.** DE-029-01 through
DE-029-09 have official reference mapping, same-viewport implementation
captures, functional/authorization coverage, and explicit records for the
2Brain-only refusal, cancellation, and nondisclosure translations.
