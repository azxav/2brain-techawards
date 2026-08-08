# 2Brain v1 export inspection

Verified on 2026-07-14. Verdict: **pass**.

A Workspace Export is the one surface that deliberately carries the Workspace's
data out of the product, so it is inspected against two gates at once: it must
contain every retained data class (Operations), and it must contain no secret
(Security).

## Contents and integrity

| Property | Evidence |
| --- | --- |
| Every retained data class is present, with an integrity manifest | `workspace-export`: *produces every retained data class and an integrity manifest* |
| The archive assembles deterministically for an unchanged snapshot | `workspace-export`: *assembles deterministically for an unchanged snapshot* |
| Authorization policy is exported without credential material | `workspace-export`: *carries authorization policy without credential material* |
| Exports are produced under a consistent Postgres snapshot | Postgres parity: *produces a secret-free Workspace Export under a consistent Postgres snapshot* |

## Secret exclusion

| Property | Evidence |
| --- | --- |
| Every secret class is excluded from filenames **and** content | `workspace-export`: *excludes every secret class from filenames and content* |
| Credentials embedded in a Source remote URL are sanitized | `workspace-export`: *sanitizes credentials embedded in a Source remote URL* |
| A protected artifact cannot be retrieved before completion or after expiry | `workspace-export`: *refuses retrieval before completion and after expiry* |
| Completion and retrieval of a protected artifact are audited | `workspace-export`: *audits completion and retrieval of a protected artifact* |

Secret exclusion is asserted over the produced archive's filenames and bytes, not
over a redaction helper in isolation, so a new data class cannot quietly ship a
credential into an export.

## Lifecycle under failure

Exports are durable Background Operations and are verified against the same
failure modes as every other operation: idempotent for a repeated request key,
cancellable while queued without requeue, retryable back to completion, able to
reclaim an expired running lease and complete after a worker restart, and
durably failed once attempts are exhausted (`workspace-export`).

## End to end

The browser journey queues a real export, waits for the always-on worker to
complete it, and retrieves the archive through the production HTTP boundary
(`export_completion`), with the completed Settings surface audited for WCAG
compliance.
