# Source Access Fail-Opens: `/ingest` and `sources_admin`

## Summary

Two write paths reach brain content without passing the Source Access gate that
ADR-0013 requires. Both are pre-existing, both were found during issue #58, and
both were deliberately left in place there — #58 only narrowed the first one for
Agent credentials, and explicitly accepted the second as the ceiling of the
faithful Agent Scope mapping. This doc records the defects, the code paths, and
what a real fix has to prove, so the work is findable instead of buried in a
decision log.

Neither is fixed. Neither should be assumed fixed by the #58 branch.

Section 3 records a third, related defect found on the same branch. It is an
observability gap rather than a fail-open — it hides Agent Activity rather than
exposing content — but it shares the root cause of disagreeing Source sets.

---

## 1. `POST /ingest` performs no Source Access check

### Problem

The HTTP ingestion endpoint accepts any credential holding the `write` scope and
queues a job that writes brain pages without resolving Source Access at all. The
write lands in the default Source regardless of what Sources the caller was
granted — including a caller granted none.

### Code path

- `src/commands/serve-http.ts:993-995` — the route is gated only by
  `requireBearerAuth({ verifier: oauthProvider, requiredScopes: ['write'] })`.
  There is no `resolveOperationSourceAccess` call and no operation dispatch on
  this path; the endpoint bypasses the `src/core/operations.ts` contract
  entirely.
- `src/commands/serve-http.ts:1126-1140` — the handler enqueues an
  `ingest_capture` Minion job carrying only the event.
- `src/core/minions/handlers/ingest-capture.ts:116` — the handler calls
  `importFromContent(engine, slug, event.content, { noEmbed })`. The deliberate
  bypass of the `put_page` operation layer is documented in that file's header
  (lines 7-18); the consequence for Source Access is not.
- `src/core/import-file.ts:1101-1106` — `importFromContent`'s options accept a
  `sourceId`, and the ingest handler never supplies one.
- `src/core/import-file.ts:1122` and `:1255` — with no `sourceId`, the write
  normalizes to the schema default (`source_id: sourceId ?? 'default'`,
  `const edgeSourceId = sourceId || 'default'`).

Compare `src/mcp/dispatch.ts:312-325`, where a `write`-scope operation with a
`sources`-kind grant is refused outright when the grant is empty or does not
include the write target.

### Who is affected

Every credential class that can present a `write` scope on this endpoint except
Agent credentials. That includes member-bound consent tokens (#47) whose Member
holds **No Source Access** — the Member cannot write through `put_page`, but the
same token reaches the default Source through `/ingest`.

Agent credentials are the one exception: `src/commands/serve-http.ts:1002-1012`
refuses them with a 403 (`agent_credential_not_accepted`) under #58 decision D7,
precisely because this unchecked path exists.

### Why it was not fixed

#58's scope was the Agent tier. Closing the endpoint for every other credential
class changes the behavior of the shipped webhook ingestion substrate (v0.38) and
needs its own decision about what a Source-less ingest credential should do —
refuse, or require an explicit target Source on the event. Refusing Agent
credentials was the minimum that kept #58 fail-closed without that decision.

### What a correct fix looks like

Fail closed, per ADR-0013:

1. Resolve Source Access for the authenticated principal on the `/ingest`
   request, the same resolution dispatch uses.
2. Determine the write target explicitly. Either the event carries a target
   Source, or the endpoint requires one. Do **not** fall back to the default
   Source when the target is missing or unresolvable.
3. Refuse with `permission_denied` when the grant is empty, or when the resolved
   target is outside it — mirroring the dispatch gate's two refusals.
4. Thread the resolved `sourceId` through the queued job into
   `importFromContent`, so the write lands where the grant says it may.
5. Once the general gate exists, the Agent-credential 403 becomes redundant;
   removing it is a separate, deliberate decision, not an automatic consequence.

### Proof a fix needs

- HTTP-seam behavioral tests: a `write` credential with an empty grant is
  refused; a credential granted Source A is refused when targeting Source B; a
  credential granted Source A succeeds and the page is readable **at Source A**,
  not at `default`.
- A test that an accepted ingest with no explicit target does not silently write
  to the default Source.
- Postgres boundary parity for the write-landing assertions
  (`test/e2e/workspace-boundary-postgres.test.ts`), since the target-Source
  landing is a storage-level claim and PGLite can mask engine differences.

---

## 2. `sources_admin` operations bypass the dispatch Source Access gate

### Problem

The Source Access gate in dispatch only fires for `write`-scope operations. The
Source-management operations declare `sources_admin`, so an admin-capable
credential with **No Source Access** can still remove a Source — a hard removal
that cascades its pages, chunks, and embeddings.

### Code path

- `src/mcp/dispatch.ts:312-325` — the gate's condition is
  `op.scope === 'write' && ctx.sourceAccess?.kind === 'sources'`. No other scope
  is checked against `ctx.sourceAccess`.
- `src/core/operations.ts:3815-3847` — `sources_add` declares
  `scope: 'sources_admin'`.
- `src/core/operations.ts:3915-3946` — `sources_remove` declares
  `scope: 'sources_admin'` and is described as a hard remove that "cascades
  pages/chunks/embeddings".
- `src/core/operations.ts:686-694` — scope hierarchy note: `admin` implies all,
  so an `admin` capability satisfies `sources_admin`.
- `src/core/oauth-provider.ts:919-922` — #58 decision D8, the faithful Agent
  Scope mapping: an `admin`-scoped Agent credential resolves to `['admin']`, and
  the comment records that implying the `*_admin` siblings was accepted
  explicitly.

So the capability check passes and the Source Access check never runs.

### Who is affected

Any credential resolving to `admin` (or directly to `sources_admin`) over an
authenticated transport, whatever its Source Access grant. Local CLI callers are
out of scope by design — `ctx.remote === false` is the trusted case.

### Why it was not fixed

The Agent Scope tiers are a product surface, and #58 chose a mapping faithful to
them rather than a mapping that quietly withheld authority the tier promises.
Constraining `sources_admin` by Source Access is a change to what the `admin`
tier means, not an implementation detail, and it affects every admin-scoped
credential — not only Agents. D8 records it as the accepted ceiling so the
decision is made once, in the open, rather than re-litigated per call site.

### What a correct fix looks like

Fail closed, per ADR-0013:

1. Extend the dispatch gate so Source-targeted operations are checked against
   `ctx.sourceAccess` regardless of declared scope — the gate should key on
   whether the operation targets a Source, not on `scope === 'write'`.
2. For `sources_remove`, the target is the named Source: refuse when the grant is
   empty or does not include it.
3. For `sources_add`, decide and document what the created Source's relationship
   to the grant is — creating a Source the caller cannot then see or write is a
   coherent outcome, but it must be a stated one.
4. If the product intends `admin` to keep unrestricted Source management, then
   supersede D8 with an ADR rather than leaving the gap implicit; the invariant
   is that the code and the accepted decision agree.

### Proof a fix needs

- Dispatch-seam behavioral tests: an admin-capable remote caller with an empty
  grant is refused on `sources_remove`; a caller granted Source A is refused when
  removing Source B and permitted when removing Source A; a local
  (`remote: false`) caller is unaffected.
- A regression test that the refusal happens **before** any cascade, i.e. the
  Source and its pages still exist after a denied call.
- Postgres boundary parity for the cascade-did-not-happen assertion, since it is
  a storage-level claim.

---

## 3. Agent Activity loses Source attribution for non-provisioned Sources

This one is **not** a fail-open. It errs toward hiding: the affected rows are
recorded, but with no Source, so they drop out of the Member Activity view. It
is recorded here because it shares the root cause — two different notions of
"the Sources of this Workspace" — and because the loss is silent.

### Problem

`sources` and `workspace_sources` are separate tables that can disagree. Only
the Workspace provisioning path writes `workspace_sources`; the core
`sources_add` operation writes `sources` alone. The Activity recorder validates
its Source context against `workspace_sources`, so an Agent write to a
`sources`-only Source is persisted with `source_id = NULL`. Nothing warns, and
the row is then filtered out of the Member Activity view.

### Code path

- `src/workspace/source-provisioning.ts:364-372` — the only `INSERT INTO
  workspace_sources` in `src/`.
- `src/core/operations.ts` — `sources_add` (`scope: 'sources_admin'`) creates a
  row in `sources` and never touches `workspace_sources`.
- `src/workspace/source-access.ts:55-63` — `resolveOperationSourceAccess`, the
  resolution dispatch uses, enumerates candidate Sources with `SELECT id FROM
  sources`. With `access_mode = 'all'`
  (`src/workspace/source-access.ts:163-165`) an Agent's grant therefore includes
  `sources`-only Sources, so the write itself is legitimately authorized.
- `src/workspace/agent-activity.ts:136-142` — `recordWorkspaceAgentActivity`
  rejects a `sourceId` absent from `workspace_sources` with `source_not_found`.
- `src/commands/serve-http.ts:741-747` — the MCP recorder catches that failure
  and re-records the same Activity **without** `sourceId`, so the write is
  logged but unattributed.
- `src/workspace/agent-activity.ts:311-339` —
  `listWorkspaceAgentActivity`'s Member branch resolves accessible Sources from
  `workspace_sources` and filters `AND a.source_id = ANY($2::text[])`. A NULL
  `source_id` never matches, so the row is invisible to Members. The
  Administrator branch omits the filter and still shows it.

### Who is affected

Any Workspace where a Source was created through `sources_add` rather than
Workspace Source provisioning — reachable today by an `admin`-scoped Agent
credential, which is the same authority described in section 2. Members lose
visibility of every Agent Activity row touching such a Source; Administrators do
not. Page evidence is lost with it: `agent-activity.ts:127` requires a
`sourceId` for a `pageSlug`, so the retry drops the Page and relationship
labels too.

### Why it was not fixed

#58 did not introduce the divergence and does not own either table's write path.
Reconciling them is a data-model decision — either `sources_add` provisions a
Workspace Source, or the Activity recorder validates against `sources` — and
both have consequences beyond Agent Activity.

### What a correct fix looks like

1. Decide which table is authoritative for "a Source of this Workspace", and
   make the other derive from it rather than drift.
2. Until then, make the loss loud rather than silent: an Activity write whose
   Source context is rejected should be observable (a recorded marker or an
   operator-visible warning), not a quiet downgrade to a NULL column.
3. Whatever the resolution, the Member Activity view and the Source Access
   resolution used to authorize the write must agree on the same Source set.

### Proof a fix needs

- A behavioral test at the Activity seam: an Agent with `access: all` writes to a
  `sources_add`-created Source; the recorded Activity row carries that Source,
  and a Member granted it sees the row.
- A test that the Member and Administrator views do not silently disagree in row
  count for the same Agent under an all-Sources grant.
- Postgres boundary parity for the recorded `source_id`, since it is a
  storage-level claim.

---

## Related

- ADR-0013 — Source Access fails closed.
- The dispatch gate and its `#50` member-bound-token note:
  `src/mcp/dispatch.ts:294-325`.
- Issue #58 decisions D7 (Agent credentials refused on `/ingest`) and D8
  (faithful Agent Scope mapping).
- Anchor comments pointing here live at both sites:
  `src/mcp/dispatch.ts` (write-target gate) and `src/commands/serve-http.ts`
  (the `/ingest` handler).
