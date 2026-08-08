# Issue #30 temporary Ask Result lifecycle evidence

Verified functionally on 2026-07-14. Issue #30 adds no new visual component:
current results continue to use the cited-answer/refusal surfaces verified for
issue #29, while expired, revoked, archived, deleted, and otherwise
inaccessible results all use the same nondisclosing unavailable state. This
ledger makes that lifecycle equivalence explicit without claiming that Notion
implements 2Brain's retention or fail-closed authorization semantics.

Official references and same-viewport captures are inherited from
`2brain-issue-29-evidence.md`:

- [Search in your workspace](https://www.notion.com/help/search) establishes
  Search as a first-class entry, keyboard access, Source filters, and a
  separate AI-search action.
- [Enterprise Search](https://www.notion.com/help/enterprise-search) documents
  single-question entry, explicit Source scope, cited answers, and full-page
  results.
- [Find answers and generate reports with enterprise search](https://www.notion.com/help/guides/find-answers-and-generate-reports-with-enterprise-search)
  supplies consulted-Source, verified-Page, result, and progress grammar.
- [Notion AI Connectors](https://www.notion.com/help/notion-ai-connectors) and
  the [Enterprise Search product page](https://www.notion.com/product/enterprise-search)
  establish visible citations to the Sources used for an answer.

The 2Brain-only security translations remain governed by ADR-0030: generated
Ask Results are temporary snapshots outside Knowledge, and every open checks
current Membership, cited Source Access, active Source state, and cited Page
existence. ADR-0023 supplies the fixed 30-day retention rule and bounded purge
requirement.

The in-app Browser runtime repeated the issue #29 initialization failure
(`Cannot redefine property: process`). The previously approved fallback used
installed Microsoft Edge headlessly through its DevTools protocol, the seeded
PGLite production router, and a 390x844 viewport. DOM, overflow, framework
overlay, console, screenshot, and citation-link interaction checks were run.
The only console errors were the intentional `404` responses that drive the
expired/revoked common unavailable state.

## Evidence ledger

| ID | Visible state | Official Notion mapping | 2Brain lifecycle evidence | Same-viewport verification |
|---|---|---|---|---|
| DE-030-01 | Current cited result and internal citation links | Enterprise Search and AI Connectors establish cited full-page answers using selected Sources | `getWorkspaceAsk` reauthorizes every stored citation through `getWorkspacePage` before returning any answer. The citation remains an internal Page link. PGLite and Postgres tests prove that deleting a cited Page makes the entire result unavailable. | Official result references at 1440x900 and `notion-enterprise-product-390x844.png` are paired with `2brain-answer-1440x900.png` and `2brain-answer-390x844.png`. The mobile citation was clicked through to its internal Knowledge route. |
| DE-030-02 | Refusal snapshot | U-11 recovery emphasis and enterprise consulted-Source grammar; the refusal semantics are a 2Brain safety translation | `Not enough evidence` remains a requester-only temporary result with Evidence Gap, accessible searched Sources, trust state, and a safe next action. It contains no answer content. | `2brain-refusal-1440x900.png` and `2brain-refusal-390x844.png` are paired with the official enterprise guide at both 1440x900 and `notion-enterprise-guide-390x844.png`. The mobile first viewport has no horizontal overflow or runtime error. |
| DE-030-03 | Expired result | Notion access-aware result grammar; logical expiry is a documented 2Brain retention divergence | Reads select only rows with `expires_at > now()`. The API returns the common `ask_result_not_found` payload with no answer, citation slug, or Source title. A bounded executor deletes eligible rows later; reads never depend on physical cleanup. | The unavailable state is captured at 1440x900 in `2brain-revoked-1440x900.png` and explicitly as expired at 390x844 in `2brain-expired-390x844.png`; official Search/access-aware references exist at matching 1440x900 and `notion-enterprise-search-390x844.png`. The expected API `404` is the only console error. |
| DE-030-04 | Revoked, Membership-disabled, Source-archived/deleted, Page-deleted, or partially inaccessible result | Notion AI operates only over content the viewer can access; exact fail-closed semantics are a documented 2Brain security divergence | Every open checks active Membership, all required Sources, and every cited Page. Any failed check throws the same generic error before `toView`, so no partially authorized answer or citation metadata can escape. | `2brain-revoked-1440x900.png` and `2brain-revoked-390x844.png` verify the shared unavailable rendering against official Search/Enterprise Search references at the same viewports. Cause-specific variants are intentionally absent because they would contradict nondisclosure. |
| DE-030-05 | Loading and safe failure | Enterprise/research progress grammar and U-11 recovery emphasis | Queued/running states preserve `aria-live` progress; unexpected failure persists no answer or citations and exposes safe recovery copy with a request ID. Only allowlisted product-owned progress/refusal evidence is persisted. | `2brain-running-1440x900.png`, `2brain-running-390x844.png`, `2brain-failed-1440x900.png`, and `2brain-failed-390x844.png` are paired with the official enterprise guide at matching 1440x900 and 390x844 viewports. Both mobile states fit the first viewport without horizontal overflow or runtime error. |
| DE-030-06 | Keyboard, theme, reduced motion, and supported viewport states | Search Help keyboard entry plus the approved Notion shell/control grammar | Issue #30 introduces no controls or CSS. The verified focus-visible, light/dark tokens, reduced-motion rule, 720px responsive breakpoint, and touch-sized Ask controls therefore remain the production behavior. | `notion-search-1440x900.png` and `notion-search-390x844.png` are paired with `2brain-search-1440x900.png`, `2brain-search-light-1440x900.png`, `2brain-search-390x844.png`, and `2brain-answer-390x844.png` for matching desktop/mobile reference viewports. |

## Functional and storage verification

- `workspace_ask_results` is a separate table with a 30-day default and an
  `(expires_at, ask_result_id)` index. It is never a Page and is not read by
  deterministic Search, graph expansion, Page relationships, or later Ask
  retrieval.
- `test/workspace-ask.test.ts` covers logical expiry, secret-free structured
  persistence, cited Page deletion, shared-link Membership and Source
  reauthorization, generic HTTP nondisclosure, and bounded PGLite cleanup.
- `test/e2e/workspace-boundary-postgres.test.ts` covers cited Page deletion and
  bounded cleanup through the same public functions on real Postgres.
- `purgeExpiredWorkspaceAskResults` clamps batch size to 1..1000, orders
  eligibility by `(expires_at, ask_result_id)`, and deletes only rows whose
  expiry has passed.
- Result storage has structured outcome/evidence columns only. There is no
  credential, provider-secret, raw-provider-prompt, or full-parameter column.
  Synthesizer progress is mapped to a product-owned allowlist and synthesizer
  refusal prose is replaced with fixed safe Evidence Gap/next-action copy
  before persistence; a regression test injects secret-like callback values.

## Rendered artifact ledger

The inherited redacted synthetic artifacts remain outside the repository under
`C:\Users\aziz\.codex\visualizations\2026\07\14\019f5f74-42de-7690-a690-e29fe36444da`.
Issue #30 mobile captures are under
`C:\Users\aziz\.codex\visualizations\2026\07\14\019f5fd2-d3c1-7c33-afa1-9237b2f5e675`.
The inherited artifacts were rechecked. The complete official-reference,
dialog, cancellation, and terminal-state inventory is recorded in
`2brain-issue-29-evidence.md`; issue #30 relies on the following lifecycle
subset:

| Surface/state | Artifact |
|---|---|
| Official Search / Enterprise Search / guide / connectors / product, 1440x900 | `notion-search-1440x900.png`, `notion-enterprise-search-1440x900.png`, `notion-enterprise-guide-1440x900.png`, `notion-ai-connectors-1440x900.png`, `notion-enterprise-product-1440x900.png` |
| Official Search / Enterprise Search / guide / product, 390x844 | `notion-search-390x844.png`, `notion-enterprise-search-390x844.png`, `notion-enterprise-guide-390x844.png`, `notion-enterprise-product-390x844.png` |
| Search dark/light desktop and mobile | `2brain-search-1440x900.png`, `2brain-search-light-1440x900.png`, `2brain-search-390x844.png` |
| Running / cited answer / refusal / safe failure | `2brain-running-1440x900.png`, `2brain-answer-1440x900.png`, `2brain-refusal-1440x900.png`, `2brain-failed-1440x900.png` |
| Common expired/revoked/inaccessible state | `2brain-revoked-1440x900.png` |
| Supported mobile cited result | `2brain-answer-390x844.png` |
| Issue #30 mobile refusal / running / safe failure | `2brain-refusal-390x844.png`, `2brain-running-390x844.png`, `2brain-failed-390x844.png` |
| Issue #30 mobile expired / revoked / inaccessible | `2brain-expired-390x844.png`, `2brain-revoked-390x844.png` |

Status: **Verified by inherited official references, same-viewport desktop and
mobile implementation captures, interaction QA, and issue #30 lifecycle
tests.** Security-only differences deliberately collapse to one nondisclosing
unavailable state.
