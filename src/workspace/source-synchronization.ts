import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { appendWorkspaceAuditEvent, appendWorkspaceChangeEvent, runProtectedWorkspaceMutation } from './events.ts';
import { notifyWorkspaceBackgroundOperationOutcome } from './notifications.ts';
import type { BackgroundOperationView, OperationRow } from './source-provisioning.ts';

type Engine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;
export type SourceMaintenanceType = 'source.verify' | 'source.sync';

export interface SourceMaintenanceResult {
  observedRevision: string;
  changed: boolean;
  applied?: boolean;
}

export interface SourceMaintenanceJob {
  operationId: string;
  workspaceId: string;
  sourceId: string;
  type: SourceMaintenanceType;
  requestId: string;
  attempt: number;
  signal: AbortSignal;
}

interface Claimed extends OperationRow {
  workspace_id: string;
  initiator_membership_id: string;
  lease_owner: string;
}

function view(row: OperationRow): BackgroundOperationView {
  return {
    operationId: row.operation_id, type: row.operation_type, resourceId: row.resource_id,
    state: row.state, progress: Number(row.progress), outcome: row.outcome_summary,
    error: row.error_code && row.error_summary
      ? { code: row.error_code, message: row.error_summary, requestId: row.request_id } : null,
    retryable: row.retryable, cancelRequested: row.cancel_requested,
    cancellationSafe: row.cancellation_safe, attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts), requestId: row.request_id,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function hasSourceAccess(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  membershipId: string,
  sourceId: string,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ role: string; status: string; access_mode: string | null; granted: boolean }>(
    `SELECT m.role, m.status, p.access_mode,
            EXISTS (SELECT 1 FROM workspace_source_grants g
                     WHERE g.principal_kind='member' AND g.principal_id=m.membership_id AND g.source_id=$2) AS granted
       FROM workspace_memberships m
       LEFT JOIN workspace_principal_source_policies p
         ON p.principal_kind='member' AND p.principal_id=m.membership_id
      WHERE m.membership_id=$1 AND m.workspace_id=$3
        AND EXISTS (SELECT 1 FROM workspace_sources s WHERE s.workspace_id=$3 AND s.source_id=$2)`,
    [membershipId, sourceId, workspaceId],
  );
  const row = rows[0];
  return !!row && row.role === 'administrator' && row.status === 'active'
    && (row.access_mode === 'all' || (row.access_mode === 'specific' && row.granted));
}

export async function queueSourceMaintenance(
  engine: Engine,
  input: {
    workspaceId: string; sourceId: string; type: SourceMaintenanceType;
    actorMembershipId: string; requestId: string; idempotencyKey: string;
  },
): Promise<BackgroundOperationView> {
  if (!input.idempotencyKey.trim()) throw new Error('idempotency_key_required');
  if (!await hasSourceAccess(engine, input.workspaceId, input.actorMembershipId, input.sourceId)) throw new Error('source_access_denied');
  const source = await engine.executeRaw<{ source_id: string; archived: boolean }>(
    'SELECT source_id,archived FROM workspace_sources WHERE workspace_id=$1 AND source_id=$2 AND provisioning_state=\'completed\'',
    [input.workspaceId, input.sourceId],
  );
  if (!source[0]) throw new Error('source_not_found');
  if (source[0].archived) throw new Error('source_archived');
  const payloadFingerprint = fingerprint({ workspaceId: input.workspaceId, sourceId: input.sourceId, type: input.type });
  const existing = await engine.executeRaw<OperationRow>(
    'SELECT * FROM workspace_background_operations WHERE workspace_id=$1 AND operation_type=$2 AND idempotency_key=$3',
    [input.workspaceId, input.type, input.idempotencyKey],
  );
  if (existing[0]) {
    if (existing[0].idempotency_fingerprint !== payloadFingerprint) throw new Error('idempotency_key_reused');
    return view(existing[0]);
  }
  const operationId = randomUUID();
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId }, action: 'source.maintenance.request',
    target: { type: 'source', id: input.sourceId }, requestId: input.requestId,
    after: { operationId, type: input.type, state: 'queued' },
  }, async tx => {
    const rows = await tx.executeRaw<OperationRow>(
      `INSERT INTO workspace_background_operations (
         operation_id, workspace_id, operation_type, initiator_membership_id, resource_type,
         resource_id, idempotency_key, idempotency_fingerprint, request_id
       ) VALUES ($1,$2,$3,$4,'source',$5,$6,$7,$8)
       ON CONFLICT (workspace_id, operation_type, idempotency_key) DO NOTHING RETURNING *`,
      [operationId, input.workspaceId, input.type, input.actorMembershipId, input.sourceId,
        input.idempotencyKey, payloadFingerprint, input.requestId],
    );
    if (rows[0]) return view(rows[0]);
    const replay = await tx.executeRaw<OperationRow>(
      'SELECT * FROM workspace_background_operations WHERE workspace_id=$1 AND operation_type=$2 AND idempotency_key=$3',
      [input.workspaceId, input.type, input.idempotencyKey],
    );
    if (!replay[0] || replay[0].idempotency_fingerprint !== payloadFingerprint) throw new Error('idempotency_key_reused');
    return view(replay[0]);
  });
}

async function claim(engine: Engine, workerId: string, leaseMs: number): Promise<Claimed | null> {
  return engine.transaction(async tx => {
    const rows = await tx.executeRaw<Claimed>(
      `WITH candidate AS (
         SELECT o.operation_id FROM workspace_background_operations o
         JOIN workspace_sources s ON s.workspace_id=o.workspace_id AND s.source_id=o.resource_id
          WHERE o.operation_type IN ('source.verify','source.sync') AND s.archived=FALSE
            AND ((o.state='queued' AND o.available_at <= now()) OR (o.state='running' AND o.lease_expires_at < now()))
            AND o.attempt < o.max_attempts ORDER BY o.created_at, o.operation_id FOR UPDATE OF o SKIP LOCKED LIMIT 1
       )
       UPDATE workspace_background_operations o
          SET state='running', progress=15, attempt=attempt+1, lease_owner=$1,
              lease_expires_at=now()+($2*interval '1 millisecond'), started_at=COALESCE(started_at,now()),
              cancellation_safe=FALSE, updated_at=now()
         FROM candidate WHERE o.operation_id=candidate.operation_id RETURNING o.*`,
      [workerId, leaseMs],
    );
    return rows[0] ?? null;
  });
}

export async function runSourceMaintenanceWorkerOnce(
  engine: Engine,
  options: {
    workerId: string;
    execute: (job: SourceMaintenanceJob) => Promise<SourceMaintenanceResult>;
    leaseMs?: number;
  },
): Promise<BackgroundOperationView | null> {
  const claimed = await claim(engine, options.workerId, Math.max(1_000, options.leaseMs ?? 30 * 60_000));
  if (!claimed) return null;
  const lifecycle = await engine.executeRaw<{ archived: boolean }>(
    'SELECT archived FROM workspace_sources WHERE workspace_id=$1 AND source_id=$2',
    [claimed.workspace_id, claimed.resource_id],
  );
  if (lifecycle[0]?.archived) return finish(engine, claimed, { error: 'source_archived' });
  if (!await hasSourceAccess(engine, claimed.workspace_id, claimed.initiator_membership_id, claimed.resource_id)) {
    return finish(engine, claimed, { error: 'authorization_revoked' });
  }
  const abort = new AbortController();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 30 * 60_000);
  const lockRows = await engine.executeRaw<{ owner: string }>(
    `INSERT INTO workspace_source_operation_locks (workspace_id,source_id,owner,expires_at)
     VALUES ($1,$2,$3,now()+($4*interval '1 millisecond'))
     ON CONFLICT (workspace_id,source_id) DO UPDATE SET owner=EXCLUDED.owner,expires_at=EXCLUDED.expires_at
       WHERE workspace_source_operation_locks.expires_at < now()
     RETURNING owner`,
    [claimed.workspace_id, claimed.resource_id, options.workerId, leaseMs],
  );
  if (!lockRows[0]) return defer(engine, claimed);
  let leaseFailure: Error | null = null;
  const renewal = setInterval(() => {
    void engine.executeRaw<{ operation_id: string }>(
      `UPDATE workspace_background_operations
          SET lease_expires_at=now()+($3*interval '1 millisecond'),updated_at=now()
        WHERE operation_id=$1 AND state='running' AND lease_owner=$2 RETURNING operation_id`,
      [claimed.operation_id, options.workerId, leaseMs],
    ).then(async rows => {
      if (!rows[0]) throw new Error('background_operation_lease_lost');
      const locks = await engine.executeRaw<{ owner: string }>(
        `UPDATE workspace_source_operation_locks SET expires_at=now()+($4*interval '1 millisecond')
          WHERE workspace_id=$1 AND source_id=$2 AND owner=$3 RETURNING owner`,
        [claimed.workspace_id, claimed.resource_id, options.workerId, leaseMs],
      );
      if (!locks[0]) throw new Error('source_operation_lock_lost');
    }).catch(error => {
      leaseFailure = error instanceof Error ? error : new Error('background_operation_lease_renewal_failed');
      abort.abort(leaseFailure);
    });
  }, Math.max(250, Math.floor(leaseMs / 3)));
  renewal.unref?.();
  try {
    const result = await options.execute({
        operationId: claimed.operation_id, workspaceId: claimed.workspace_id, sourceId: claimed.resource_id,
        type: claimed.operation_type as SourceMaintenanceType, requestId: claimed.request_id,
        attempt: Number(claimed.attempt), signal: abort.signal,
      });
    if (leaseFailure) throw leaseFailure;
    return finish(engine, claimed, { result });
  } catch (error) {
    if (leaseFailure) throw leaseFailure;
    return finish(engine, claimed, { error: 'source_maintenance_failed' });
  } finally {
    clearInterval(renewal);
    await engine.executeRaw(
      'DELETE FROM workspace_source_operation_locks WHERE workspace_id=$1 AND source_id=$2 AND owner=$3',
      [claimed.workspace_id, claimed.resource_id, options.workerId],
    );
  }
}

async function defer(engine: Engine, claimed: Claimed): Promise<BackgroundOperationView> {
  const rows = await engine.executeRaw<OperationRow>(
    `UPDATE workspace_background_operations SET state='queued',progress=5,attempt=GREATEST(0,attempt-1),
       available_at=now()+interval '5 seconds',cancellation_safe=TRUE,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
     WHERE operation_id=$1 AND state='running' AND lease_owner=$2 RETURNING *`,
    [claimed.operation_id, claimed.lease_owner],
  );
  if (!rows[0]) throw new Error('background_operation_lease_lost');
  return view(rows[0]);
}

async function finish(
  engine: Engine,
  claimed: Claimed,
  outcome: { result: SourceMaintenanceResult } | { error: string },
): Promise<BackgroundOperationView> {
  return engine.transaction(async tx => {
    const lifecycle = await tx.executeRaw<{ archived: boolean }>(
      `SELECT archived FROM workspace_sources
        WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE`,
      [claimed.workspace_id, claimed.resource_id],
    );
    const archived = lifecycle[0]?.archived === true;
    const effectiveOutcome = archived ? { error: 'source_archived' } as const : outcome;
    const effectiveFailed = 'error' in effectiveOutcome;
    const effectiveResult = effectiveFailed ? null : effectiveOutcome.result;
    const rows = await tx.executeRaw<OperationRow>(
      `UPDATE workspace_background_operations
          SET state=$2, progress=$3, outcome_summary=$4, error_code=$5, error_summary=$6,
              retryable=$7, cancellation_safe=FALSE, lease_owner=NULL, lease_expires_at=NULL,
              completed_at=now(), updated_at=now()
        WHERE operation_id=$1 AND state='running' AND lease_owner=$8 RETURNING *`,
      [claimed.operation_id, effectiveFailed ? 'failed' : 'completed', effectiveFailed ? claimed.progress : 100,
        effectiveFailed ? null : (claimed.operation_type === 'source.verify' ? 'Source verified.' : effectiveResult!.applied ? 'Source synchronized.' : 'Source already synchronized.'),
        effectiveFailed ? effectiveOutcome.error : null,
        effectiveFailed ? (archived ? 'The Source was archived before maintenance completed.' : 'Source maintenance failed safely.') : null,
        effectiveFailed && !archived && Number(claimed.attempt) < Number(claimed.max_attempts), claimed.lease_owner],
    );
    if (!rows[0]) throw new Error('background_operation_lease_lost');
    if (effectiveFailed && !archived && claimed.operation_type === 'source.verify') {
      await tx.executeRaw(
        `INSERT INTO workspace_source_verification_events (
           event_id,workspace_id,source_id,operation_id,outcome,error_code,request_id,started_at
         ) VALUES ($1,$2,$3,$4,'failed',$5,$6,$7)
         ON CONFLICT (operation_id) DO UPDATE SET
           observed_revision=NULL,content_state=NULL,outcome='failed',error_code=EXCLUDED.error_code,
           request_id=EXCLUDED.request_id,started_at=EXCLUDED.started_at,completed_at=now(),
           event_sequence=nextval(pg_get_serial_sequence('workspace_source_verification_events','event_sequence'))`,
        [randomUUID(), claimed.workspace_id, claimed.resource_id, claimed.operation_id,
          effectiveOutcome.error, claimed.request_id, claimed.started_at],
      );
    } else if (effectiveResult && claimed.operation_type === 'source.verify') {
      await tx.executeRaw(
        `INSERT INTO workspace_source_verification_events (
           event_id,workspace_id,source_id,operation_id,observed_revision,content_state,outcome,request_id,started_at
         ) VALUES ($1,$2,$3,$4,$5,$6,'succeeded',$7,$8)
         ON CONFLICT (operation_id) DO UPDATE SET
           observed_revision=EXCLUDED.observed_revision,content_state=EXCLUDED.content_state,
           outcome='succeeded',error_code=NULL,request_id=EXCLUDED.request_id,
           started_at=EXCLUDED.started_at,completed_at=now(),
           event_sequence=nextval(pg_get_serial_sequence('workspace_source_verification_events','event_sequence'))`,
        [randomUUID(), claimed.workspace_id, claimed.resource_id, claimed.operation_id, effectiveResult.observedRevision,
          effectiveResult.changed ? 'changed' : 'unchanged', claimed.request_id, claimed.started_at],
      );
      await tx.executeRaw(
        `UPDATE workspace_sources SET last_verified_at=now(), last_verified_revision=$3,
            known_unsynchronized_revision=CASE WHEN $4 THEN $3 ELSE known_unsynchronized_revision END, updated_at=now()
          WHERE workspace_id=$1 AND source_id=$2`,
        [claimed.workspace_id, claimed.resource_id, effectiveResult.observedRevision, effectiveResult.changed],
      );
    } else if (effectiveResult && claimed.operation_type === 'source.sync' && effectiveResult.applied) {
      await tx.executeRaw(
        `UPDATE workspace_sources SET last_sync_at=now(), last_synced_revision=$3,
            known_unsynchronized_revision=NULL, updated_at=now() WHERE workspace_id=$1 AND source_id=$2`,
        [claimed.workspace_id, claimed.resource_id, effectiveResult.observedRevision],
      );
    }
    const action = effectiveFailed ? 'source.maintenance.fail' : claimed.operation_type === 'source.verify'
      ? 'source.verify.complete' : 'source.sync.complete';
    await appendWorkspaceAuditEvent(tx, {
      actor: { kind: 'system', id: claimed.lease_owner }, action, target: { type: 'source', id: claimed.resource_id },
      requestId: claimed.request_id, outcome: effectiveFailed ? 'failed' : 'succeeded',
    });
    if (!effectiveFailed && (claimed.operation_type === 'source.verify' || effectiveResult?.applied)) {
      await appendWorkspaceChangeEvent(tx, {
        actor: { kind: 'system', id: claimed.lease_owner }, action,
        resource: { type: 'source', id: claimed.resource_id }, requestId: claimed.request_id,
      });
    }
    await notifyWorkspaceBackgroundOperationOutcome(tx, {
      workspaceId: claimed.workspace_id,
      operationId: claimed.operation_id,
      requestId: claimed.request_id,
    });
    return view(rows[0]);
  });
}
