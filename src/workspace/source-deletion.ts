import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { appendWorkspaceAuditEvent, appendWorkspaceChangeEvent, runProtectedWorkspaceMutation } from './events.ts';
import { notifyWorkspaceBackgroundOperationOutcome } from './notifications.ts';
import { tableExists } from './knowledge.ts';
import { operationView, type BackgroundOperationView, type OperationRow } from './source-provisioning.ts';

type Engine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;
type ReadEngine = Pick<BrainEngine, 'executeRaw'>;

export type WorkspaceSourceDeletionErrorCode =
  | 'confirmation_mismatch'
  | 'idempotency_key_required'
  | 'idempotency_key_reused'
  | 'reason_required'
  | 'source_deletion_forbidden'
  | 'source_not_archived'
  | 'source_not_found';

export class WorkspaceSourceDeletionError extends Error {
  constructor(public readonly code: WorkspaceSourceDeletionErrorCode) {
    super(code);
    this.name = 'WorkspaceSourceDeletionError';
  }
}

export interface SourceDeletionImpact {
  sourceId: string;
  pages: number;
  pageVersions: number;
  savedViews: number;
  backgroundOperations: number;
  verificationEvents: number;
  accessGrants: number;
}

interface DeletionRequestInput {
  workspaceId: string;
  sourceId: string;
  confirmationSourceId: string;
  reason: string;
  actorMembershipId: string;
  requestId: string;
  idempotencyKey: string;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Administrator + Source Access check for permanent deletion. Locked variants
 * run inside the destructive transaction so a concurrent role or access
 * reduction cannot race past the revalidation.
 */
async function requireAdministratorSourceAccess(
  engine: ReadEngine,
  input: { workspaceId: string; sourceId: string; actorMembershipId: string },
  lock: boolean,
): Promise<void> {
  const rows = await engine.executeRaw<{ access_mode: string }>(
    `SELECT p.access_mode
       FROM workspace_memberships m
       JOIN workspace_principal_source_policies p
         ON p.principal_kind='member' AND p.principal_id=m.membership_id
      WHERE m.workspace_id=$1 AND m.membership_id=$2
        AND m.role='administrator' AND m.status='active'
      ${lock ? 'FOR UPDATE OF m,p' : ''}`,
    [input.workspaceId, input.actorMembershipId],
  );
  if (!rows[0] || (rows[0].access_mode !== 'all' && rows[0].access_mode !== 'specific')) {
    throw new WorkspaceSourceDeletionError('source_deletion_forbidden');
  }
  if (rows[0].access_mode === 'specific') {
    const grants = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM workspace_source_grants
        WHERE principal_kind='member' AND principal_id=$1 AND source_id=$2
        ${lock ? 'FOR UPDATE' : ''}`,
      [input.actorMembershipId, input.sourceId],
    );
    if (!grants[0]) throw new WorkspaceSourceDeletionError('source_deletion_forbidden');
  }
}

async function requireArchivedSource(
  engine: ReadEngine,
  workspaceId: string,
  sourceId: string,
  lock: boolean,
): Promise<void> {
  const rows = await engine.executeRaw<{ archived: boolean; deleted: boolean }>(
    `SELECT archived,deleted FROM workspace_sources
      WHERE workspace_id=$1 AND source_id=$2 ${lock ? 'FOR UPDATE' : ''}`,
    [workspaceId, sourceId],
  );
  if (!rows[0] || rows[0].deleted) throw new WorkspaceSourceDeletionError('source_not_found');
  if (!rows[0].archived) throw new WorkspaceSourceDeletionError('source_not_archived');
}

async function readDeletionOperation(
  engine: ReadEngine,
  workspaceId: string,
  idempotencyKey: string,
): Promise<OperationRow | null> {
  const rows = await engine.executeRaw<OperationRow>(
    `SELECT * FROM workspace_background_operations
      WHERE workspace_id=$1 AND operation_type='source.permanent_delete' AND idempotency_key=$2`,
    [workspaceId, idempotencyKey],
  );
  return rows[0] ?? null;
}

/**
 * Queue the durable permanent deletion of an Archived Source. The destructive
 * work itself runs in the Background Operation worker, which revalidates the
 * archived state and the requester's authorization immediately before purging.
 */
export async function queueSourcePermanentDeletion(
  engine: Engine,
  input: DeletionRequestInput,
): Promise<BackgroundOperationView> {
  if (!input.idempotencyKey.trim()) throw new WorkspaceSourceDeletionError('idempotency_key_required');
  // Forbidden and missing-reason attempts are still evidence even though the
  // protected mutation seam is never entered.
  const auditFailedAttempt = () => appendWorkspaceAuditEvent(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'source.delete.request',
    target: { type: 'source', id: input.sourceId },
    requestId: input.requestId,
    outcome: 'failed',
  });
  try {
    await requireAdministratorSourceAccess(engine, input, false);
  } catch (error) {
    await auditFailedAttempt();
    throw error;
  }

  const reason = input.reason?.trim();
  if (!reason) {
    await auditFailedAttempt();
    throw new WorkspaceSourceDeletionError('reason_required');
  }

  const payloadFingerprint = fingerprint({
    workspaceId: input.workspaceId,
    sourceId: input.sourceId,
    reason,
  });
  const existing = await readDeletionOperation(engine, input.workspaceId, input.idempotencyKey);
  if (existing) {
    if (existing.idempotency_fingerprint !== payloadFingerprint) {
      throw new WorkspaceSourceDeletionError('idempotency_key_reused');
    }
    return operationView(existing);
  }

  const operationId = randomUUID();
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'source.delete.request',
    target: { type: 'source', id: input.sourceId },
    requestId: input.requestId,
    reason,
    after: { operationId, type: 'source.permanent_delete', state: 'queued' },
  }, async transaction => {
    if (input.confirmationSourceId !== input.sourceId) {
      throw new WorkspaceSourceDeletionError('confirmation_mismatch');
    }
    await requireAdministratorSourceAccess(transaction, input, true);
    await requireArchivedSource(transaction, input.workspaceId, input.sourceId, true);
    const rows = await transaction.executeRaw<OperationRow>(
      `INSERT INTO workspace_background_operations (
         operation_id, workspace_id, operation_type, initiator_membership_id, resource_type,
         resource_id, idempotency_key, idempotency_fingerprint, request_id, initiator_reason
       ) VALUES ($1,$2,'source.permanent_delete',$3,'source',$4,$5,$6,$7,$8)
       ON CONFLICT (workspace_id, operation_type, idempotency_key) DO NOTHING RETURNING *`,
      [operationId, input.workspaceId, input.actorMembershipId, input.sourceId,
        input.idempotencyKey, payloadFingerprint, input.requestId, reason],
    );
    if (rows[0]) return operationView(rows[0]);
    const replay = await readDeletionOperation(transaction, input.workspaceId, input.idempotencyKey);
    if (!replay || replay.idempotency_fingerprint !== payloadFingerprint) {
      throw new WorkspaceSourceDeletionError('idempotency_key_reused');
    }
    return operationView(replay);
  });
}

/**
 * Count the records a permanent deletion would purge or affect. Counts only:
 * the preview never returns titles, bodies, or other Source content, so an
 * Administrator without content access learns nothing beyond scale.
 */
export async function previewSourceDeletionImpact(
  engine: ReadEngine,
  input: { workspaceId: string; sourceId: string; actorMembershipId: string },
): Promise<SourceDeletionImpact> {
  await requireAdministratorSourceAccess(engine, input, false);
  await requireArchivedSource(engine, input.workspaceId, input.sourceId, false);

  const count = async (sql: string, params: unknown[]): Promise<number> => {
    const rows = await engine.executeRaw<{ n: string | number }>(sql, params);
    return Number(rows[0]?.n ?? 0);
  };
  const pages = await tableExists(engine, 'pages')
    ? await count('SELECT count(*) AS n FROM pages WHERE source_id=$1', [input.sourceId])
    : 0;
  const pageVersions = pages > 0 && await tableExists(engine, 'page_versions')
    ? await count(
      `SELECT count(*) AS n FROM page_versions v
        JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1`,
      [input.sourceId],
    )
    : 0;
  return {
    sourceId: input.sourceId,
    pages,
    pageVersions,
    savedViews: await count(
      `SELECT count(*) AS n FROM workspace_saved_views
        WHERE workspace_id=$1 AND COALESCE(filters->'source_ids','[]'::jsonb) @> to_jsonb($2::text)`,
      [input.workspaceId, input.sourceId],
    ),
    backgroundOperations: await count(
      `SELECT count(*) AS n FROM workspace_background_operations
        WHERE workspace_id=$1 AND resource_type='source' AND resource_id=$2`,
      [input.workspaceId, input.sourceId],
    ),
    verificationEvents: await count(
      `SELECT count(*) AS n FROM workspace_source_verification_events
        WHERE workspace_id=$1 AND source_id=$2`,
      [input.workspaceId, input.sourceId],
    ),
    accessGrants: await count(
      'SELECT count(*) AS n FROM workspace_source_grants WHERE source_id=$1',
      [input.sourceId],
    ),
  };
}

interface ClaimedDeletion extends OperationRow {
  workspace_id: string;
  initiator_membership_id: string;
  initiator_reason: string | null;
  lease_owner: string;
}

class SourceDeletionRevalidationError extends Error {
  constructor(public readonly code: 'source_not_archived' | 'authorization_revoked' | 'source_not_found') {
    super(code);
    this.name = 'SourceDeletionRevalidationError';
  }
}

async function claimDeletionOperation(
  engine: Engine,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedDeletion | null> {
  const rows = await engine.executeRaw<ClaimedDeletion>(
    `WITH candidate AS (
       SELECT operation_id FROM workspace_background_operations
        WHERE operation_type='source.permanent_delete'
          AND ((state='queued' AND available_at <= now()) OR (state='running' AND lease_expires_at < now()))
          AND attempt < max_attempts
        ORDER BY created_at, operation_id FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE workspace_background_operations o
        SET state='running', progress=GREATEST(progress,15), attempt=attempt+1, lease_owner=$1,
            lease_expires_at=now()+($2*interval '1 millisecond'), started_at=COALESCE(started_at,now()),
            cancellation_safe=FALSE, updated_at=now()
       FROM candidate WHERE o.operation_id=candidate.operation_id RETURNING o.*`,
    [workerId, leaseMs],
  );
  return rows[0] ?? null;
}

async function failExhaustedDeletionOperation(engine: Engine): Promise<BackgroundOperationView | null> {
  return engine.transaction(async transaction => {
    const rows = await transaction.executeRaw<ClaimedDeletion>(
      `WITH exhausted AS (
         SELECT operation_id FROM workspace_background_operations
          WHERE operation_type='source.permanent_delete'
            AND state='running' AND lease_expires_at < now() AND attempt >= max_attempts
          ORDER BY lease_expires_at, operation_id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE workspace_background_operations o
          SET state='failed', error_code='source_deletion_exhausted',
              error_summary='Permanent Source deletion stopped after repeated interrupted attempts.',
              retryable=FALSE, cancellation_safe=FALSE, lease_owner=NULL, lease_expires_at=NULL,
              completed_at=now(), updated_at=now()
         FROM exhausted WHERE o.operation_id=exhausted.operation_id RETURNING o.*`,
    );
    if (!rows[0]) return null;
    await appendWorkspaceAuditEvent(transaction, {
      actor: { kind: 'system', id: 'workspace-worker-recovery' },
      action: 'source.delete.fail',
      target: { type: 'source', id: rows[0].resource_id },
      requestId: rows[0].request_id,
      reason: rows[0].initiator_reason ?? undefined,
      outcome: 'failed',
      before: { state: 'running', attempt: rows[0].attempt },
      after: { state: 'failed', errorCode: 'source_deletion_exhausted', retryable: false },
    });
    await notifyWorkspaceBackgroundOperationOutcome(transaction, {
      workspaceId: rows[0].workspace_id,
      operationId: rows[0].operation_id,
      requestId: rows[0].request_id,
    });
    return operationView(rows[0]);
  });
}

/**
 * Revalidate the deletion assumptions with row locks held, then purge inside
 * the same transaction so a concurrent restore or access reduction can never
 * interleave with the destructive statements. Every purge statement is
 * idempotent: a reclaimed lease after a crash simply repeats the deletes.
 */
async function executeSourceDeletion(engine: Engine, claimed: ClaimedDeletion): Promise<void> {
  await engine.transaction(async transaction => {
    const sources = await transaction.executeRaw<{ archived: boolean; deleted: boolean }>(
      `SELECT archived,deleted FROM workspace_sources
        WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE`,
      [claimed.workspace_id, claimed.resource_id],
    );
    if (!sources[0]) throw new SourceDeletionRevalidationError('source_not_found');
    if (sources[0].deleted) return;
    if (!sources[0].archived) throw new SourceDeletionRevalidationError('source_not_archived');
    const initiators = await transaction.executeRaw<{ access_mode: string | null; granted: boolean }>(
      `SELECT p.access_mode,
              EXISTS (SELECT 1 FROM workspace_source_grants g
                       WHERE g.principal_kind='member' AND g.principal_id=m.membership_id AND g.source_id=$3) AS granted
         FROM workspace_memberships m
         LEFT JOIN workspace_principal_source_policies p
           ON p.principal_kind='member' AND p.principal_id=m.membership_id
        WHERE m.workspace_id=$1 AND m.membership_id=$2
          AND m.role='administrator' AND m.status='active'`,
      [claimed.workspace_id, claimed.initiator_membership_id, claimed.resource_id],
    );
    const initiator = initiators[0];
    if (!initiator || !(initiator.access_mode === 'all' || (initiator.access_mode === 'specific' && initiator.granted))) {
      throw new SourceDeletionRevalidationError('authorization_revoked');
    }

    // Legacy content projections cascade from the legacy Source row; tables
    // without a foreign key are purged explicitly. All are optional because a
    // Workspace-only database has no legacy projection at all.
    if (await tableExists(transaction, 'sources')) {
      await transaction.executeRaw('DELETE FROM sources WHERE id=$1', [claimed.resource_id]);
    }
    if (await tableExists(transaction, 'pages')) {
      await transaction.executeRaw('DELETE FROM pages WHERE source_id=$1', [claimed.resource_id]);
    }
    for (const orphanTable of ['ingest_log', 'facts'] as const) {
      if (await tableExists(transaction, orphanTable)) {
        await transaction.executeRaw(`DELETE FROM ${orphanTable} WHERE source_id=$1`, [claimed.resource_id]);
      }
    }
    await transaction.executeRaw(
      'DELETE FROM workspace_source_grants WHERE source_id=$1',
      [claimed.resource_id],
    );
    // Verification events stay as retained operation detail, but their
    // revision identifiers describe purged content and are redacted with it.
    await transaction.executeRaw(
      `UPDATE workspace_source_verification_events SET observed_revision=NULL
        WHERE workspace_id=$1 AND source_id=$2`,
      [claimed.workspace_id, claimed.resource_id],
    );
    await transaction.executeRaw(
      'DELETE FROM workspace_invitation_source_grants WHERE source_id=$1',
      [claimed.resource_id],
    );
    // The redacted lifecycle row is the retained record: identifiers and
    // lifecycle facts stay, content-bearing fields are overwritten.
    await transaction.executeRaw(
      `UPDATE workspace_sources
          SET deleted=TRUE, deleted_at=now(), deleted_by_membership_id=$3,
              name='Permanently deleted Source', remote_url='redacted',
              included_in_workspace_search=FALSE,
              last_verified_revision=NULL, last_synced_revision=NULL,
              known_unsynchronized_revision=NULL, updated_at=now()
        WHERE workspace_id=$1 AND source_id=$2`,
      [claimed.workspace_id, claimed.resource_id, claimed.initiator_membership_id],
    );
  });
}

async function finishDeletionOperation(
  engine: Engine,
  claimed: ClaimedDeletion,
  outcome: { state: 'completed'; summary: string }
    | { state: 'failed'; code: string; summary: string; retryable: boolean },
): Promise<BackgroundOperationView> {
  return engine.transaction(async transaction => {
    const completed = outcome.state === 'completed';
    const rows = await transaction.executeRaw<OperationRow>(
      `UPDATE workspace_background_operations
          SET state=$2, progress=$3, outcome_summary=$4, error_code=$5, error_summary=$6,
              retryable=$7, cancellation_safe=FALSE, lease_owner=NULL, lease_expires_at=NULL,
              completed_at=now(), updated_at=now()
        WHERE operation_id=$1 AND state='running' AND lease_owner=$8
        RETURNING *`,
      [claimed.operation_id, outcome.state, completed ? 100 : claimed.progress,
        completed ? outcome.summary : null, completed ? null : outcome.code,
        completed ? null : outcome.summary, completed ? false : outcome.retryable,
        claimed.lease_owner],
    );
    if (!rows[0]) throw new Error('background_operation_lease_lost');
    if (completed) {
      const event = {
        actor: { kind: 'system' as const, id: claimed.lease_owner },
        action: 'source.delete' as const,
        target: { type: 'source', id: claimed.resource_id },
        requestId: claimed.request_id,
        reason: claimed.initiator_reason ?? undefined,
        before: { lifecycle_state: 'archived' },
        after: { lifecycle_state: 'deleted' },
      };
      await appendWorkspaceAuditEvent(transaction, { ...event, outcome: 'succeeded' });
      await appendWorkspaceChangeEvent(transaction, {
        actor: event.actor, action: event.action, resource: event.target,
        requestId: event.requestId, workspaceId: claimed.workspace_id,
      });
    } else {
      await appendWorkspaceAuditEvent(transaction, {
        actor: { kind: 'system', id: claimed.lease_owner },
        action: 'source.delete.fail',
        target: { type: 'source', id: claimed.resource_id },
        requestId: claimed.request_id,
        reason: claimed.initiator_reason ?? undefined,
        outcome: 'failed',
        before: { state: 'running', attempt: claimed.attempt },
        after: { state: 'failed', errorCode: outcome.code, retryable: outcome.retryable },
      });
    }
    await notifyWorkspaceBackgroundOperationOutcome(transaction, {
      workspaceId: claimed.workspace_id,
      operationId: claimed.operation_id,
      requestId: claimed.request_id,
    });
    return operationView(rows[0]);
  });
}

/**
 * Claim and execute one queued permanent deletion. The purge itself is a
 * bounded set of database statements, so the claim lease is not renewed; a
 * crashed worker's lease simply expires and the operation is reclaimed.
 */
export async function runSourceDeletionWorkerOnce(
  engine: Engine,
  options: { workerId: string; leaseMs?: number },
): Promise<BackgroundOperationView | null> {
  const leaseMs = Math.max(1_000, options.leaseMs ?? 30 * 60_000);
  const exhausted = await failExhaustedDeletionOperation(engine);
  if (exhausted) return exhausted;
  const claimed = await claimDeletionOperation(engine, options.workerId, leaseMs);
  if (!claimed) return null;

  if (claimed.cancel_requested) {
    return finishDeletionOperation(engine, claimed, {
      state: 'failed', code: 'operation_cancelled',
      summary: 'The deletion was cancelled before destructive work began.', retryable: false,
    });
  }
  try {
    await executeSourceDeletion(engine, claimed);
    return await finishDeletionOperation(engine, claimed, {
      state: 'completed', summary: 'Source permanently deleted. Redacted lifecycle history and Audit Events are retained.',
    });
  } catch (error) {
    if (error instanceof SourceDeletionRevalidationError) {
      // A stale impact or authorization assumption invalidates the typed
      // confirmation. A fresh deliberate request is required, never a retry.
      return await finishDeletionOperation(engine, claimed, {
        state: 'failed', code: error.code,
        summary: 'The deletion assumptions changed before destructive execution. Request permanent deletion again.',
        retryable: false,
      });
    }
    return await finishDeletionOperation(engine, claimed, {
      state: 'failed', code: 'source_deletion_failed',
      summary: 'Permanent Source deletion failed safely before completing. Retry when the cause is resolved.',
      retryable: Number(claimed.attempt) < Number(claimed.max_attempts),
    });
  }
}
