import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { appendWorkspaceAuditEvent } from './events.ts';

type RetentionEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;
type RetentionReadEngine = Pick<BrainEngine, 'executeRaw'>;

export type WorkspaceRetentionState = 'queued' | 'running' | 'completed' | 'failed';

interface RetentionRow {
  retention_id: string;
  workspace_id: string;
  state: WorkspaceRetentionState;
  progress: number | string;
  purged_counts: Record<string, unknown> | string;
  error_code: string | null;
  error_summary: string | null;
  retryable: boolean;
  attempt: number | string;
  max_attempts: number | string;
  idempotency_key: string;
  request_id: string;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  available_at: string | Date;
  cutoff_at: string | Date | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface WorkspaceRetentionCounts {
  fullRequestParameters: number;
  agentActivity: number;
  agentRuns: number;
  changeEvents: number;
  askResults: number;
  backgroundOperationDetails: number;
  workspaceExportDetails: number;
  notifications: number;
  retiredJobs: number;
}

export interface WorkspaceRetentionJob {
  retentionId: string;
  workspaceId: string;
  state: WorkspaceRetentionState;
  progress: number;
  purgedCounts: WorkspaceRetentionCounts;
  error: null | { code: string; message: string; requestId: string };
  retryable: boolean;
  attempt: number;
  maxAttempts: number;
  requestId: string;
  cutoffAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceRetentionErrorCode =
  | 'workspace_id_required'
  | 'request_id_required'
  | 'idempotency_key_required'
  | 'retention_not_found'
  | 'retention_not_retryable'
  | 'worker_id_required';

export class WorkspaceRetentionError extends Error {
  constructor(public readonly code: WorkspaceRetentionErrorCode) {
    super(code);
    this.name = 'WorkspaceRetentionError';
  }
}

const EMPTY_COUNTS: WorkspaceRetentionCounts = {
  fullRequestParameters: 0,
  agentActivity: 0,
  agentRuns: 0,
  changeEvents: 0,
  askResults: 0,
  backgroundOperationDetails: 0,
  workspaceExportDetails: 0,
  notifications: 0,
  retiredJobs: 0,
};

function requireText(
  value: string | undefined,
  code: WorkspaceRetentionErrorCode,
  maxLength = 200,
): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maxLength) throw new WorkspaceRetentionError(code);
  return normalized;
}

function toIso(value: string | Date | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function parseCounts(value: RetentionRow['purged_counts']): WorkspaceRetentionCounts {
  const parsed = typeof value === 'string' ? JSON.parse(value) as Partial<WorkspaceRetentionCounts> : value;
  return { ...EMPTY_COUNTS, ...parsed };
}

function retentionView(row: RetentionRow): WorkspaceRetentionJob {
  return {
    retentionId: row.retention_id,
    workspaceId: row.workspace_id,
    state: row.state,
    progress: Number(row.progress),
    purgedCounts: parseCounts(row.purged_counts),
    error: row.error_code === null ? null : {
      code: row.error_code,
      message: row.error_summary ?? 'Workspace retention failed.',
      requestId: row.request_id,
    },
    retryable: row.retryable,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    requestId: row.request_id,
    cutoffAt: toIso(row.cutoff_at),
    createdAt: toIso(row.created_at)!,
    updatedAt: toIso(row.updated_at)!,
  };
}

async function readRetentionByKey(
  engine: RetentionReadEngine,
  workspaceId: string,
  idempotencyKey: string,
): Promise<RetentionRow | null> {
  const rows = await engine.executeRaw<RetentionRow>(
    'SELECT * FROM workspace_retention_jobs WHERE workspace_id=$1 AND idempotency_key=$2',
    [workspaceId, idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function enqueueWorkspaceRetention(
  engine: RetentionEngine,
  input: { workspaceId: string; requestId: string; idempotencyKey: string },
): Promise<WorkspaceRetentionJob> {
  const workspaceId = requireText(input.workspaceId, 'workspace_id_required', 128);
  const requestId = requireText(input.requestId, 'request_id_required');
  const idempotencyKey = requireText(input.idempotencyKey, 'idempotency_key_required');
  const existing = await readRetentionByKey(engine, workspaceId, idempotencyKey);
  if (existing) return retentionView(existing);

  return engine.transaction(async transaction => {
    const retentionId = randomUUID();
    const rows = await transaction.executeRaw<RetentionRow>(
      `INSERT INTO workspace_retention_jobs
         (retention_id, workspace_id, idempotency_key, request_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [retentionId, workspaceId, idempotencyKey, requestId],
    );
    if (!rows[0]) {
      const replay = await readRetentionByKey(transaction, workspaceId, idempotencyKey);
      if (!replay) throw new Error('queued_retention_not_found');
      return retentionView(replay);
    }
    await appendWorkspaceAuditEvent(transaction, {
      actor: { kind: 'system', id: 'workspace-retention-scheduler' },
      action: 'retention.request',
      target: { type: 'workspace_retention', id: retentionId },
      requestId,
      outcome: 'succeeded',
      before: { state: null },
      after: { state: 'queued' },
    });
    return retentionView(rows[0]);
  });
}

export async function getWorkspaceRetentionJob(
  engine: RetentionReadEngine,
  workspaceId: string,
  retentionId: string,
): Promise<WorkspaceRetentionJob | null> {
  const rows = await engine.executeRaw<RetentionRow>(
    'SELECT * FROM workspace_retention_jobs WHERE workspace_id=$1 AND retention_id=$2',
    [workspaceId, retentionId],
  );
  return rows[0] ? retentionView(rows[0]) : null;
}

export async function retryWorkspaceRetention(
  engine: RetentionEngine,
  input: { workspaceId: string; retentionId: string; requestId: string },
): Promise<WorkspaceRetentionJob> {
  const workspaceId = requireText(input.workspaceId, 'workspace_id_required', 128);
  const requestId = requireText(input.requestId, 'request_id_required');
  return engine.transaction(async transaction => {
    const rows = await transaction.executeRaw<RetentionRow>(
      `UPDATE workspace_retention_jobs
          SET state='queued', progress=0, error_code=NULL, error_summary=NULL,
              retryable=TRUE, request_id=$3, lease_owner=NULL, lease_expires_at=NULL,
              available_at=now(), completed_at=NULL, updated_at=now()
        WHERE workspace_id=$1 AND retention_id=$2 AND state='failed' AND retryable=TRUE
          AND attempt < max_attempts
        RETURNING *`,
      [workspaceId, input.retentionId, requestId],
    );
    if (!rows[0]) throw new WorkspaceRetentionError('retention_not_retryable');
    await appendWorkspaceAuditEvent(transaction, {
      actor: { kind: 'system', id: 'workspace-retention-operator' },
      action: 'retention.retry',
      target: { type: 'workspace_retention', id: input.retentionId },
      requestId,
      outcome: 'succeeded',
      before: { state: 'failed' },
      after: { state: 'queued', cutoffAt: toIso(rows[0].cutoff_at) },
    });
    return retentionView(rows[0]);
  });
}

function retentionCutoffs(cutoffAt: string): { activity: string; detail: string } {
  const cutoff = new Date(cutoffAt);
  if (!Number.isFinite(cutoff.getTime())) throw new Error('invalid_retention_cutoff');
  return {
    activity: new Date(cutoff.getTime() - 90 * 24 * 60 * 60_000).toISOString(),
    detail: new Date(cutoff.getTime() - 30 * 24 * 60 * 60_000).toISOString(),
  };
}

async function failExhaustedRetention(
  engine: RetentionEngine,
  workerId: string,
): Promise<WorkspaceRetentionJob | null> {
  return engine.transaction(async transaction => {
    const rows = await transaction.executeRaw<RetentionRow>(
      `WITH exhausted AS (
         SELECT retention_id FROM workspace_retention_jobs
          WHERE state='running' AND lease_expires_at < now() AND attempt >= max_attempts
          ORDER BY lease_expires_at, retention_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE workspace_retention_jobs job
          SET state='failed', error_code='retention_exhausted',
              error_summary='Workspace retention stopped after repeated interrupted attempts.',
              retryable=FALSE, lease_owner=NULL, lease_expires_at=NULL,
              completed_at=now(), updated_at=now()
         FROM exhausted
        WHERE job.retention_id=exhausted.retention_id
       RETURNING job.*`,
    );
    if (!rows[0]) return null;
    await appendWorkspaceAuditEvent(transaction, {
      actor: { kind: 'system', id: workerId },
      action: 'retention.fail',
      target: { type: 'workspace_retention', id: rows[0].retention_id },
      requestId: rows[0].request_id,
      outcome: 'succeeded',
      before: { state: 'running' },
      after: {
        state: 'failed', cutoffAt: toIso(rows[0].cutoff_at), errorCode: 'retention_exhausted',
      },
    });
    return retentionView(rows[0]);
  });
}

async function claimRetention(
  engine: RetentionEngine,
  workerId: string,
  cutoffAt: string,
  leaseMs: number,
): Promise<RetentionRow | null> {
  return engine.transaction(async transaction => {
    const rows = await transaction.executeRaw<RetentionRow>(
      `WITH candidate AS (
         SELECT retention_id FROM workspace_retention_jobs
          WHERE (
            (state='queued' AND available_at <= now())
            OR (state='running' AND lease_expires_at < now())
          )
            AND attempt < max_attempts
          ORDER BY created_at, retention_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE workspace_retention_jobs job
          SET state='running', progress=GREATEST(progress, 5),
              lease_owner=$1, lease_expires_at=now() + ($2 * interval '1 millisecond'),
              cutoff_at=COALESCE(cutoff_at, $3::timestamptz),
              started_at=COALESCE(started_at, now()), updated_at=now(), attempt=attempt+1
         FROM candidate
        WHERE job.retention_id=candidate.retention_id
       RETURNING job.*`,
      [workerId, leaseMs, cutoffAt],
    );
    return rows[0] ?? null;
  });
}

async function purgeCategory(
  engine: RetentionEngine,
  claimed: RetentionRow,
  workerId: string,
  batchSize: number,
  counts: WorkspaceRetentionCounts,
  key: keyof WorkspaceRetentionCounts,
  progress: number,
  purge: (transaction: RetentionReadEngine, limit: number) => Promise<number>,
): Promise<{ counts: WorkspaceRetentionCounts; saturated: boolean }> {
  return engine.transaction(async transaction => {
    const count = await purge(transaction, batchSize);
    const nextCounts = { ...counts, [key]: counts[key] + count };
    const rows = await transaction.executeRaw<RetentionRow>(
      `UPDATE workspace_retention_jobs
          SET progress=GREATEST(progress, $3), purged_counts=$4::jsonb, updated_at=now()
        WHERE retention_id=$1 AND lease_owner=$2 AND state='running'
        RETURNING *`,
      [claimed.retention_id, workerId, progress, nextCounts],
    );
    if (!rows[0]) throw new Error('workspace_retention_lease_lost');
    return { counts: parseCounts(rows[0].purged_counts), saturated: count === batchSize };
  });
}

async function selectActivityIds(
  transaction: RetentionReadEngine,
  workspaceId: string,
  cutoff: string,
  limit: number,
): Promise<string[]> {
  const rows = await transaction.executeRaw<{ activity_id: string }>(
    `SELECT activity.activity_id
       FROM workspace_agent_activity activity
       JOIN workspace_agents agent ON agent.agent_id=activity.agent_id
      WHERE agent.workspace_id=$1 AND activity.occurred_at <= $2::timestamptz
      ORDER BY activity.occurred_at, activity.activity_id
      FOR UPDATE OF activity SKIP LOCKED
      LIMIT $3`,
    [workspaceId, cutoff, limit],
  );
  return rows.map(row => row.activity_id);
}

async function purgeAgentActivity(
  transaction: RetentionReadEngine,
  workspaceId: string,
  cutoff: string,
  limit: number,
): Promise<number> {
  const activityIds = await selectActivityIds(transaction, workspaceId, cutoff, limit);
  if (activityIds.length === 0) return 0;
  await transaction.executeRaw(
    'DELETE FROM workspace_agent_request_details WHERE activity_id = ANY($1::text[])',
    [activityIds],
  );
  const deleted = await transaction.executeRaw<{ activity_id: string }>(
    'DELETE FROM workspace_agent_activity WHERE activity_id = ANY($1::text[]) RETURNING activity_id',
    [activityIds],
  );
  return deleted.length;
}

async function purgeAgentRuns(
  transaction: RetentionReadEngine,
  workspaceId: string,
  cutoff: string,
  limit: number,
): Promise<number> {
  const deleted = await transaction.executeRaw<{ run_id: string }>(
    `WITH expired AS (
       SELECT run.run_id
         FROM workspace_agent_runs run
        JOIN workspace_agents agent ON agent.agent_id=run.agent_id
        WHERE agent.workspace_id=$1
          AND run.ended_at IS NOT NULL AND run.ended_at <= $2::timestamptz
          AND NOT EXISTS (SELECT 1 FROM workspace_agent_activity activity WHERE activity.run_id=run.run_id)
        ORDER BY run.ended_at, run.run_id
        FOR UPDATE OF run SKIP LOCKED
        LIMIT $3
     )
     DELETE FROM workspace_agent_runs run
      USING expired
      WHERE run.run_id=expired.run_id
     RETURNING run.run_id`,
    [workspaceId, cutoff, limit],
  );
  return deleted.length;
}

async function purgeFullRequestParameters(
  transaction: RetentionReadEngine,
  workspaceId: string,
  cutoff: string,
  limit: number,
): Promise<number> {
  const cleared = await transaction.executeRaw<{ activity_id: string }>(
    `WITH expired AS (
       SELECT detail.activity_id
         FROM workspace_agent_request_details detail
         JOIN workspace_agent_activity activity ON activity.activity_id=detail.activity_id
         JOIN workspace_agents agent ON agent.agent_id=activity.agent_id
        WHERE agent.workspace_id=$1 AND detail.full_parameters IS NOT NULL
          AND detail.full_parameters_expire_at <= $2::timestamptz
        ORDER BY detail.full_parameters_expire_at, detail.activity_id
        FOR UPDATE OF detail SKIP LOCKED
        LIMIT $3
     )
     UPDATE workspace_agent_request_details detail
        SET full_parameters=NULL, full_parameters_expire_at=NULL
       FROM expired
      WHERE detail.activity_id=expired.activity_id
     RETURNING detail.activity_id`,
    [workspaceId, cutoff, limit],
  );
  return cleared.length;
}

async function purgeChangeEvents(
  transaction: RetentionReadEngine,
  workspaceId: string,
  cutoff: string,
  limit: number,
): Promise<number> {
  const deleted = await transaction.executeRaw<{ event_id: string }>(
    `WITH expired AS (
       SELECT event_id FROM workspace_change_events
        WHERE workspace_id=$1 AND occurred_at <= $2::timestamptz
        ORDER BY occurred_at, event_id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     DELETE FROM workspace_change_events event
      USING expired
      WHERE event.event_id=expired.event_id
     RETURNING event.event_id`,
    [workspaceId, cutoff, limit],
  );
  return deleted.length;
}

async function purgeAskResults(
  transaction: RetentionReadEngine,
  workspaceId: string,
  cutoff: string,
  limit: number,
): Promise<number> {
  const deleted = await transaction.executeRaw<{ ask_result_id: string }>(
    `WITH expired AS (
       SELECT ask_result_id FROM workspace_ask_results
        WHERE workspace_id=$1 AND expires_at <= $2::timestamptz
        ORDER BY expires_at, ask_result_id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     DELETE FROM workspace_ask_results result
      USING expired
      WHERE result.ask_result_id=expired.ask_result_id
     RETURNING result.ask_result_id`,
    [workspaceId, cutoff, limit],
  );
  return deleted.length;
}

async function redactBackgroundOperationDetails(
  transaction: RetentionReadEngine,
  workspaceId: string,
  cutoff: string,
  limit: number,
): Promise<number> {
  const redacted = await transaction.executeRaw<{ operation_id: string }>(
    `WITH expired AS (
       SELECT operation_id FROM workspace_background_operations
        WHERE workspace_id=$1 AND state IN ('completed','failed')
          AND completed_at <= $2::timestamptz
          AND (outcome_summary IS NOT NULL OR error_summary IS NOT NULL OR initiator_reason IS NOT NULL)
        ORDER BY completed_at, operation_id
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     UPDATE workspace_background_operations operation
        SET outcome_summary=NULL, error_summary=NULL, initiator_reason=NULL, updated_at=now()
       FROM expired
      WHERE operation.operation_id=expired.operation_id
     RETURNING operation.operation_id`,
    [workspaceId, cutoff, limit],
  );
  return redacted.length;
}

async function purgeWorkspaceExportDetails(
  transaction: RetentionReadEngine,
  workspaceId: string,
  detailCutoff: string,
  cutoffAt: string,
  limit: number,
): Promise<number> {
  const redacted = await transaction.executeRaw<{ export_id: string }>(
    `WITH expired AS (
       SELECT export_id FROM workspace_exports
        WHERE workspace_id=$1 AND state IN ('completed','failed')
          AND (completed_at <= $2::timestamptz OR expires_at <= $3::timestamptz)
          AND (artifact_content IS NOT NULL OR manifest IS NOT NULL
               OR outcome_summary IS NOT NULL OR error_summary IS NOT NULL)
        ORDER BY completed_at, export_id
        FOR UPDATE SKIP LOCKED
        LIMIT $4
     )
     UPDATE workspace_exports export
        SET artifact_content=NULL, manifest=NULL, outcome_summary=NULL, error_summary=NULL, updated_at=now()
       FROM expired
      WHERE export.export_id=expired.export_id
     RETURNING export.export_id`,
    [workspaceId, detailCutoff, cutoffAt, limit],
  );
  return redacted.length;
}

async function purgeNotifications(
  transaction: RetentionReadEngine,
  workspaceId: string,
  cutoff: string,
  limit: number,
): Promise<number> {
  const deleted = await transaction.executeRaw<{ notification_id: string }>(
    `WITH expired AS (
       SELECT notification_id FROM workspace_notifications
        WHERE workspace_id=$1 AND expires_at <= $2::timestamptz
        ORDER BY expires_at, notification_sequence
        FOR UPDATE SKIP LOCKED
        LIMIT $3
     )
     DELETE FROM workspace_notifications notification
      USING expired
      WHERE notification.notification_id=expired.notification_id
     RETURNING notification.notification_id`,
    [workspaceId, cutoff, limit],
  );
  return deleted.length;
}

async function purgeRetiredRetentionJobs(
  transaction: RetentionReadEngine,
  workspaceId: string,
  currentRetentionId: string,
  cutoff: string,
  limit: number,
): Promise<number> {
  const deleted = await transaction.executeRaw<{ retention_id: string }>(
    `WITH expired AS (
       SELECT retention_id FROM workspace_retention_jobs
        WHERE workspace_id=$1 AND retention_id <> $2 AND state IN ('completed','failed')
          AND completed_at <= $3::timestamptz
        ORDER BY completed_at, retention_id
        FOR UPDATE SKIP LOCKED
        LIMIT $4
     )
     DELETE FROM workspace_retention_jobs job
      USING expired
      WHERE job.retention_id=expired.retention_id
     RETURNING job.retention_id`,
    [workspaceId, currentRetentionId, cutoff, limit],
  );
  return deleted.length;
}

async function finishRetention(
  engine: RetentionEngine,
  claimed: RetentionRow,
  workerId: string,
  outcome: { state: 'completed'; counts: WorkspaceRetentionCounts }
    | { state: 'failed'; code: string; summary: string; retryable: boolean },
): Promise<WorkspaceRetentionJob> {
  return engine.transaction(async transaction => {
    const completed = outcome.state === 'completed';
    const rows = completed
      ? await transaction.executeRaw<RetentionRow>(
        `UPDATE workspace_retention_jobs
            SET state='completed', progress=100, purged_counts=$3::jsonb,
                error_code=NULL, error_summary=NULL, retryable=FALSE,
                lease_owner=NULL, lease_expires_at=NULL, completed_at=now(), updated_at=now()
          WHERE retention_id=$1 AND lease_owner=$2 AND state='running'
          RETURNING *`,
        [claimed.retention_id, workerId, outcome.counts],
      )
      : await transaction.executeRaw<RetentionRow>(
        `UPDATE workspace_retention_jobs
            SET state='failed', error_code=$3, error_summary=$4, retryable=$5,
                lease_owner=NULL, lease_expires_at=NULL, completed_at=now(), updated_at=now()
          WHERE retention_id=$1 AND lease_owner=$2 AND state='running'
          RETURNING *`,
        [claimed.retention_id, workerId, outcome.code, outcome.summary, outcome.retryable],
      );
    if (!rows[0]) throw new Error('workspace_retention_lease_lost');
    const row = rows[0];
    await appendWorkspaceAuditEvent(transaction, {
      actor: { kind: 'system', id: workerId },
      action: completed ? 'retention.complete' : 'retention.fail',
      target: { type: 'workspace_retention', id: claimed.retention_id },
      requestId: claimed.request_id,
      outcome: 'succeeded',
      before: { state: 'running' },
      after: completed
        ? { state: 'completed', cutoffAt: toIso(row.cutoff_at), counts: outcome.counts }
        : { state: 'failed', cutoffAt: toIso(row.cutoff_at), errorCode: outcome.code },
    });
    return retentionView(row);
  });
}

async function continueRetention(
  engine: RetentionEngine,
  claimed: RetentionRow,
  workerId: string,
  counts: WorkspaceRetentionCounts,
): Promise<WorkspaceRetentionJob> {
  const rows = await engine.executeRaw<RetentionRow>(
    `UPDATE workspace_retention_jobs
        SET state='queued', progress=95, purged_counts=$3::jsonb,
            lease_owner=NULL, lease_expires_at=NULL, available_at=now(),
            attempt=GREATEST(attempt - 1, 0), updated_at=now()
      WHERE retention_id=$1 AND lease_owner=$2 AND state='running'
      RETURNING *`,
    [claimed.retention_id, workerId, counts],
  );
  if (!rows[0]) throw new Error('workspace_retention_lease_lost');
  return retentionView(rows[0]);
}

/**
 * Claim and execute at most one whole-Workspace retention job. Every destructive
 * statement is ordered and capped; a replacement worker safely repeats those
 * idempotent statements after an expired lease.
 */
export async function runWorkspaceRetentionWorkerOnce(
  engine: RetentionEngine,
  options: { workerId: string; now?: string; batchSize?: number; leaseMs?: number },
): Promise<WorkspaceRetentionJob | null> {
  const workerId = requireText(options.workerId, 'worker_id_required');
  const requestedCutoffAt = options.now ?? new Date().toISOString();
  // Validate the injected clock before changing durable state. A recovered or
  // explicitly retried job continues to use its already-captured cutoff below.
  retentionCutoffs(requestedCutoffAt);
  const batchSize = Math.min(1_000, Math.max(1, Math.floor(options.batchSize ?? 250)));
  const leaseMs = Math.max(1_000, options.leaseMs ?? 30 * 60_000);

  const exhausted = await failExhaustedRetention(engine, workerId);
  if (exhausted) return exhausted;

  const claimed = await claimRetention(engine, workerId, requestedCutoffAt, leaseMs);
  if (!claimed) return null;
  const cutoffAt = toIso(claimed.cutoff_at);
  if (!cutoffAt) throw new Error('workspace_retention_cutoff_missing');
  const cutoffs = retentionCutoffs(cutoffAt);

  let leaseFailure: Error | null = null;
  const renewal = setInterval(() => {
    void engine.executeRaw<{ retention_id: string }>(
      `UPDATE workspace_retention_jobs
          SET lease_expires_at=now() + ($3 * interval '1 millisecond'), updated_at=now()
        WHERE retention_id=$1 AND state='running' AND lease_owner=$2
        RETURNING retention_id`,
      [claimed.retention_id, workerId, leaseMs],
    ).then(rows => {
      if (!rows[0]) throw new Error('workspace_retention_lease_lost');
    }).catch(error => {
      leaseFailure = error instanceof Error ? error : new Error('workspace_retention_lease_renewal_failed');
    });
  }, Math.max(250, Math.floor(leaseMs / 3)));
  renewal.unref?.();

  let counts = parseCounts(claimed.purged_counts);
  try {
    let hasMore = false;
    const runCategory = async (
      key: keyof WorkspaceRetentionCounts,
      progress: number,
      purge: (transaction: RetentionReadEngine, limit: number) => Promise<number>,
    ): Promise<void> => {
      const result = await purgeCategory(
        engine, claimed, workerId, batchSize, counts, key, progress, purge,
      );
      counts = result.counts;
      hasMore ||= result.saturated;
    };

    await runCategory('agentActivity', 15, (transaction, limit) => purgeAgentActivity(
      transaction, claimed.workspace_id, cutoffs.activity, limit,
    ));
    await runCategory('agentRuns', 25, (transaction, limit) => purgeAgentRuns(
      transaction, claimed.workspace_id, cutoffs.activity, limit,
    ));
    await runCategory('fullRequestParameters', 35, (transaction, limit) => purgeFullRequestParameters(
      transaction, claimed.workspace_id, cutoffAt, limit,
    ));
    await runCategory('changeEvents', 50, (transaction, limit) => purgeChangeEvents(
      transaction, claimed.workspace_id, cutoffs.activity, limit,
    ));
    await runCategory('askResults', 60, (transaction, limit) => purgeAskResults(
      transaction, claimed.workspace_id, cutoffAt, limit,
    ));
    await runCategory('backgroundOperationDetails', 70, (transaction, limit) => redactBackgroundOperationDetails(
      transaction, claimed.workspace_id, cutoffs.detail, limit,
    ));
    await runCategory('workspaceExportDetails', 80, (transaction, limit) => purgeWorkspaceExportDetails(
      transaction, claimed.workspace_id, cutoffs.detail, cutoffAt, limit,
    ));
    await runCategory('notifications', 90, (transaction, limit) => purgeNotifications(
      transaction, claimed.workspace_id, cutoffAt, limit,
    ));
    await runCategory('retiredJobs', 95, (transaction, limit) => purgeRetiredRetentionJobs(
      transaction, claimed.workspace_id, claimed.retention_id, cutoffs.detail, limit,
    ));
    if (leaseFailure) throw leaseFailure;
    if (hasMore) return await continueRetention(engine, claimed, workerId, counts);
    return await finishRetention(engine, claimed, workerId, { state: 'completed', counts });
  } catch (error) {
    if (leaseFailure || (error instanceof Error && error.message === 'workspace_retention_lease_lost')) {
      throw leaseFailure ?? error;
    }
    return finishRetention(engine, claimed, workerId, {
      state: 'failed',
      code: 'retention_failed',
      summary: 'Workspace retention failed. Retry when the Workspace is reachable.',
      retryable: Number(claimed.attempt) < Number(claimed.max_attempts),
    });
  } finally {
    clearInterval(renewal);
  }
}
