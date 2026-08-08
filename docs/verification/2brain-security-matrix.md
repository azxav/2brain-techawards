# 2Brain v1 security matrix

Verified on 2026-07-14. Verdict: **pass** — no open P0 defects.

Every row below is an executed, named test. Each matrix is enforced server-side
at the operation boundary; none of it depends on the UI hiding anything.

## Role

| Property | Evidence |
| --- | --- |
| Membership administration is session, CSRF, and Administrator gated without leaking data | `workspace-setup`: *membership administration is session, CSRF, and Administrator gated without leaking data* |
| Production dispatch enforces human roles and Agent capabilities independently of Source Access | `workspace-source-operations`: *production dispatch enforces human roles and Agent capabilities independently from Source Access* |
| Only Administrators mutate Agents; every Member may read the safe Directory | `workspace-agents`: *every Member can read the safe Directory while only Administrators mutate Agents* |
| Permanent deletion is limited to Administrators holding Source Access | `workspace-source-deletion`: *is limited to Administrators with Source Access*, *only an active Administrator with Source Access can queue permanent deletion* |
| Role and Source Access never change one another | `workspace-memberships`: *role and Source Access mutations never change one another* |

The browser journey asserts the same rule end to end: an Administrator with No
Source Access is refused the Source lifecycle
(`role_alone_grants_no_source_access`) until it is granted access.

## Source Access (All / Specific / None)

| Property | Evidence |
| --- | --- |
| All Sources includes Sources connected after the grant | `workspace-source-access`: *All Sources includes every current and future Source*; `workspace-source-operations`: *All Sources includes Sources connected after the grant for Member and Agent principals* |
| Specific Sources contains only immutable explicit identifiers | `workspace-source-access`: *Specific Sources contains only immutable explicit identifiers* |
| No Source Access is fail-closed and cannot be widened by request | `workspace-source-operations`: *No Source Access is an access-required state and explicit requests cannot widen it*, *No Source Access has one zero-disclosure contract across every Source-sensitive operation* |
| Member, Administrator, and Agent principals share one matrix | `workspace-source-operations`: *Member, Administrator, and Agent principals share the All/Specific/None matrix* |
| Grants are re-read at every operation decision | `workspace-source-operations`: *active Workspace authorization re-reads Source grants at every operation decision* |
| Denied Sources cannot leak through code retrieval or backlink ranking | `workspace-source-operations`: *code definition and reference retrieval cannot reveal denied Sources*, *backlink ranking metadata counts only fully authorized edges* |
| Malformed or missing grants fail the whole resolution closed | `workspace-source-access`: *malformed persisted grants fail the entire remote resolution closed*, *missing or malformed remote principals fail closed without a default Source* |

## Agent Scope

| Property | Evidence |
| --- | --- |
| A new Agent defaults to Read scope and No Source Access | `workspace-agents`: *a new Agent defaults to Read scope and No Source Access with a durable owner-backed identity* |
| Agent Scope is cumulative while Source Access stays independent | `workspace-agents`: *Agent Scope is cumulative while Source Access stays independently evaluated*; `workspace-source-access`: *resolver ignores Workspace role and Agent Scope dimensions* |
| Credential material is revealed once and only its hash is stored | `workspace-agents`: *credential material is returned once and only its hash is stored* |
| Rotation and revocation are auditable and irreversible | `workspace-agents`: *rotation issues new material and revokes the old credential through auditable operations*, *revoking an Agent revokes its active credentials and blocks further rotation* |

## Session, CSRF, and transport

| Property | Evidence |
| --- | --- |
| Cross-origin mutations are rejected; recovery is single-use | `workspace-setup`: *rejects cross-origin mutations and supports single-use recovery for the confirmed Administrator* |
| Role, membership, and revocation changes take effect at the next authorization decision | `workspace-setup`: *active sessions observe role, membership, and revocation changes at the next authorization decision* |
| Invitations are email-bound and single-use | `workspace-memberships`: *an invitation is email-bound, single-use, and establishes its independent role and Source Access*, *invitation redemption rejects a different addressed email without consuming the token* |
| Unauthenticated reads and mutations are refused (401), and a session without the CSRF header cannot mutate (403) | Browser journey: `production_http_auth_boundary`, asserted from a separate anonymous browser context |
| The session cookie is `httpOnly`, `secure`, and `SameSite=Lax` | Browser journey: `production_http_auth_boundary`, read back from the browser's cookie jar with the router mounted in its production configuration |

## Transport

Every Managed Git Source remote is constrained to HTTPS by the `https://.*`
pattern on the Source form and validated server-side during provisioning
(`workspace-source-provisioning`).

The session cookie carries the `secure` flag, which is asserted from the browser
with the router mounted exactly as production mounts it. The journey itself runs
over `http://127.0.0.1` — a browser treats that as a trustworthy origin, so the
production cookie flags are exercised, but TLS termination itself is a
deployment concern and this release does not claim to have tested it.

## Secret redaction and export exclusion

| Property | Evidence |
| --- | --- |
| Every secret class is excluded from export filenames and content | `workspace-export`: *excludes every secret class from filenames and content* |
| Credentials embedded in a Source remote URL are sanitized | `workspace-export`: *sanitizes credentials embedded in a Source remote URL* |
| Exports carry authorization policy without credential material | `workspace-export`: *carries authorization policy without credential material* |
| Audit payloads redact secrets and remain immutable | `workspace-boundary`: *records immutable, redacted Audit Events and Change Events for protected mutations* |
| Unexpected failures never serialize raw diagnostics to a caller | `workspace-boundary`: *never serializes raw diagnostics from an unexpected Workspace failure*, *scrubs diagnostics even when a handler misclassifies them as safe text* |
| A protected artifact cannot be retrieved before completion or after expiry | `workspace-export`: *refuses retrieval before completion and after expiry* |

The browser journey additionally asserts zero console errors across the whole
run, so no refused request or secret-bearing payload reaches the browser
unhandled.

## Citation authorization

Ask answers are re-authorized after synthesis and are not delivered after
revocation, Source archival, or Page deletion — `workspace-ask`: *reauthorizes
citations after synthesis and never delivers an answer after revocation*, *does
not expose an answered result after a cited Page is deleted*, *reauthorizes
shared answered links against current Membership and Source lifecycle*.

## Postgres parity

Every matrix above is re-verified against real Postgres, not only PGLite — see
[2brain-postgres-parity.md](2brain-postgres-parity.md).
