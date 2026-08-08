# 2Brain v1 trust evidence

Verified on 2026-07-14. Verdict: **pass**.

The Trust gate asks one question: can a reader believe what the Workspace shows?
Every surface must be traceable to a real Source, must say how fresh it is, must
say what verified it, and must refuse rather than invent.

## Live data only, never fabricated

ADR-0028 forbids placeholder, seeded, or illustrative content in the production
UI. The surfaces are rendered from live projections, and the primary browser
journey drives them against a real Postgres database with a real provisioned
Managed Git Source — an empty Workspace renders a cause-specific empty state,
not a plausible-looking one (`workspace-home`, `workspace-setup-checklist`).

Ask is the sharpest case, because a synthesizer is the one component that could
invent text:

| Property | Evidence |
| --- | --- |
| Only an extractively supported cited answer is persisted | `workspace-ask`: *searches first and persists only a supported cited answer* |
| An unsupported claim is refused even when it cites a real retrieved Page | `workspace-ask`: *refuses an unsupported claim even when it cites a real retrieved Page* |
| Citation syntax and unsupported Page references are refused with an evidence gap | `workspace-ask`: *refuses citation syntax and unsupported Page references with an evidence gap* |
| Only product-owned safe execution evidence is stored from synthesizer callbacks | `workspace-ask`: *stores only product-owned safe execution evidence from synthesizer callbacks* |

The refusal path is also driven black-box through the browser. The journey asks a
question whose synthesized answer (`The Workspace guarantees 99.99% uptime for
every Member.`) is supported by no retrieved Page. The product refuses it with an
evidence gap, and the journey asserts the fabricated sentence never appears in
the document (`ask_refusal_on_unsupported_claim`). A synthesizer that invents
cannot get its invention onto the page.

## Provenance, Freshness, and Evidence Status

| Property | Evidence |
| --- | --- |
| Page detail carries provenance, versions, and rechecked denial | `workspace-page-detail`; Postgres parity: *keeps Page detail provenance, versions, and rechecked denial in Postgres parity* |
| Source Freshness is derived and surfaced, including `Unknown freshness` | `workspace-source-freshness` |
| Evidence Status filters Knowledge to source-backed material | `workspace-knowledge`; browser journey: `knowledge_and_page_inspection` (Evidence filters alternate between `source_backed` and `missing_evidence` and the list changes accordingly) |
| Search results carry Source, Evidence Status, and Freshness | `workspace-search`; browser journey: `deterministic_search` |

## Citation authorization

An answer that was authorized when it was generated must not remain readable
after access changes. Ask Results are re-authorized on every open against current
Membership, cited Source Access, active Source state, and cited Page existence:

- `workspace-ask`: *reauthorizes citations after synthesis and never delivers an answer after revocation*
- `workspace-ask`: *does not expose an answered result after a cited Page is deleted*
- `workspace-ask`: *reauthorizes shared answered links against current Membership and Source lifecycle*
- Postgres parity: *keeps Ask synthesis, reauthorization, cancellation, and retention lifecycle in Postgres parity*

## Verified Attention resolution

Attention Items are resolved by verified recovery, not by optimistic dismissal:
`workspace-attention-detectors` and `workspace-attention-policy` cover detection,
deduplication by condition episode (ADR-0044), dismissal, and verified recovery;
Postgres parity re-verifies the same lifecycle (*operates Source-health Attention
Items through detection, dedup, dismissal, and verified recovery with Postgres
parity*). The browser journey assigns an Attention Item and observes it through
the Member's Notification surface (`attention_and_notifications`).

## Last Trustworthy State

When a surface cannot refresh, it must show what it last knew and say so, rather
than render an empty Workspace that reads as "you have nothing" (ADR-0039).
`workspace-live-updates` and `workspace-home` cover the stale-data notice, the
`Last Trustworthy State — Potentially outdated` marker, connection loss, and
retry; Postgres parity re-verifies Home trust evidence fail-closed under current
Source Access.
