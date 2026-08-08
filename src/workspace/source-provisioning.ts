import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { parseRemoteUrl, RemoteUrlError } from '../core/git-remote.ts';
import { LockUnavailableError, withRefreshingLock } from '../core/db-lock.ts';
import { addSource } from '../core/sources-ops.ts';
import { performSync } from '../commands/sync.ts';
import {
  appendWorkspaceAuditEvent,
  appendWorkspaceChangeEvent,
  runProtectedWorkspaceMutation,
} from './events.ts';
import { setLegacySourceArchiveProjection } from './source-lifecycle.ts';
import { notifyWorkspaceBackgroundOperationOutcome } from './notifications.ts';
import {
  evaluateSourceFreshness,
  type ExpectedSourceCadence,
  type SourceFreshnessAssessment,
} from './source-freshness.ts';

type ProvisioningEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;

export type BackgroundOperationState = 'queued' | 'running' | 'completed' | 'failed';

interface SourceRow {
  source_id: string;
  name: string;
  remote_url: string;
  expected_cadence: ExpectedSourceCadence;
  included_in_workspace_search: boolean;
  provisioning_state: BackgroundOperationState;
  last_verified_at: string | Date | null;
  last_verified_revision: string | null;
  last_sync_at: string | Date | null;
  last_synced_revision: string | null;
  known_unsynchronized_revision: string | null;
  archived: boolean;
  archived_at: string | Date | null;
  latest_verification_outcome?: 'succeeded' | 'failed' | null;
  latest_verification_error_code?: string | null;
  latest_verification_request_id?: string | null;
  latest_verification_completed_at?: string | Date | null;
}

export type BackgroundOperationType =
  | 'source.provision'
  | 'source.verify'
  | 'source.sync'
  | 'source.permanent_delete';

export interface OperationRow {
  operation_id: string;
  operation_type: BackgroundOperationType;
  resource_id: string;
  state: BackgroundOperationState;
  progress: number;
  outcome_summary: string | null;
  error_code: string | null;
  error_summary: string | null;
  retryable: boolean;
  cancel_requested: boolean;
  cancellation_safe: boolean;
  attempt: number;
  max_attempts: number;
  idempotency_fingerprint: string;
  request_id: string;
  started_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ClaimedOperationRow extends OperationRow {
  workspace_id: string;
  lease_owner: string;
  remote_url: string;
  name: string;
  expected_cadence: ExpectedSourceCadence;
  included_in_workspace_search: boolean;
}

export interface ManagedGitSourceView {
  sourceId: string;
  name: string;
  remoteUrl: string;
  expectedCadence: ExpectedSourceCadence;
  includedInWorkspaceSearch: boolean;
  provisioningState: BackgroundOperationState;
  lastVerifiedAt: string | null;
  lastVerifiedRevision: string | null;
  lastSyncAt: string | null;
  lastSyncedRevision: string | null;
  knownUnsynchronizedRevision: string | null;
  lifecycleState: 'active' | 'archived';
  archivedAt: string | null;
  freshness: SourceFreshnessAssessment;
  latestVerification: null | {
    outcome: 'succeeded' | 'failed';
    errorCode: string | null;
    requestId: string;
    completedAt: string;
  };
}

export interface BackgroundOperationView {
  operationId: string;
  type: BackgroundOperationType;
  resourceId: string;
  state: BackgroundOperationState;
  progress: number;
  outcome: string | null;
  error: null | { code: string; message: string; requestId: string };
  retryable: boolean;
  cancelRequested: boolean;
  cancellationSafe: boolean;
  attempt: number;
  maxAttempts: number;
  requestId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceProvisioningJob {
  operationId: string;
  workspaceId: string;
  source: Pick<ManagedGitSourceView,
    'sourceId' | 'name' | 'remoteUrl' | 'expectedCadence'
    | 'includedInWorkspaceSearch' | 'provisioningState'>;
  attempt: number;
  requestId: string;
  signal: AbortSignal;
}

export type WorkspaceSourceProvisioningErrorCode =
  | 'expected_cadence_required'
  | 'filesystem_path_not_allowed'
  | 'idempotency_key_required'
  | 'idempotency_key_reused'
  | 'invalid_remote_url'
  | 'invalid_expected_cadence'
  | 'invalid_source_id'
  | 'operation_not_cancellable'
  | 'operation_not_found'
  | 'operation_not_retryable'
  | 'request_id_required'
  | 'source_id_taken'
  | 'source_name_required'
  | 'worker_id_required'
  | 'workspace_id_required';

export class WorkspaceSourceProvisioningError extends Error {
  constructor(public readonly code: WorkspaceSourceProvisioningErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceSourceProvisioningError';
  }
}

function isoTimestamp(value: string | Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function sourceView(row: SourceRow, now = new Date().toISOString()): ManagedGitSourceView {
  const lastVerifiedAt = isoTimestamp(row.last_verified_at);
  return {
    sourceId: row.source_id,
    name: row.name,
    remoteUrl: row.remote_url,
    expectedCadence: row.expected_cadence,
    includedInWorkspaceSearch: row.included_in_workspace_search,
    provisioningState: row.provisioning_state,
    lastVerifiedAt,
    lastVerifiedRevision: row.last_verified_revision,
    lastSyncAt: isoTimestamp(row.last_sync_at),
    lastSyncedRevision: row.last_synced_revision,
    knownUnsynchronizedRevision: row.known_unsynchronized_revision,
    lifecycleState: row.archived ? 'archived' : 'active',
    archivedAt: isoTimestamp(row.archived_at),
    freshness: evaluateSourceFreshness({
      expectedCadence: row.expected_cadence,
      lastVerifiedAt,
      knownUnsynchronizedRevision: row.known_unsynchronized_revision,
      latestVerificationOutcome: row.latest_verification_outcome ?? null,
      now,
    }),
    latestVerification: row.latest_verification_outcome && row.latest_verification_request_id
      && row.latest_verification_completed_at
      ? {
          outcome: row.latest_verification_outcome,
          errorCode: row.latest_verification_error_code ?? null,
          requestId: row.latest_verification_request_id,
          completedAt: isoTimestamp(row.latest_verification_completed_at)!,
        }
      : null,
  };
}

export function operationView(row: OperationRow): BackgroundOperationView {
  return {
    operationId: row.operation_id,
    type: row.operation_type,
    resourceId: row.resource_id,
    state: row.state,
    progress: Number(row.progress),
    outcome: row.outcome_summary,
    error: row.error_code && row.error_summary
      ? { code: row.error_code, message: row.error_summary, requestId: row.request_id }
      : null,
    retryable: row.retryable,
    cancelRequested: row.cancel_requested,
    cancellationSafe: row.cancellation_safe,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    requestId: row.request_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireText(value: string, code: WorkspaceSourceProvisioningErrorCode, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new WorkspaceSourceProvisioningError(code, code);
  }
  return normalized;
}

function validateSourceId(value: string): string {
  const sourceId = value.trim();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(sourceId)) {
    throw new WorkspaceSourceProvisioningError('invalid_source_id', 'invalid_source_id');
  }
  return sourceId;
}

function validateExpectedCadence(value: string): ExpectedSourceCadence {
  const cadence = requireText(value, 'expected_cadence_required', 80).toLowerCase();
  if (!['hourly', 'daily', 'weekly', 'manual'].includes(cadence)) {
    throw new WorkspaceSourceProvisioningError('invalid_expected_cadence', 'invalid_expected_cadence');
  }
  return cadence as ExpectedSourceCadence;
}

function idempotencyFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertIdempotencyFingerprint(row: OperationRow, expected: string): void {
  if (row.idempotency_fingerprint !== expected) {
    throw new WorkspaceSourceProvisioningError('idempotency_key_reused', 'idempotency_key_reused');
  }
}

async function readIdempotentProvisioning(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  idempotencyKey: string,
): Promise<{ source: ManagedGitSourceView; operation: BackgroundOperationView } | null> {
  const rows = await engine.executeRaw<SourceRow & OperationRow>(
    `SELECT s.*, o.*
       FROM workspace_background_operations o
       JOIN workspace_sources s
         ON s.workspace_id=o.workspace_id AND s.source_id=o.resource_id
      WHERE o.workspace_id=$1 AND o.operation_type='source.provision' AND o.idempotency_key=$2`,
    [workspaceId, idempotencyKey],
  );
  return rows[0] ? { source: sourceView(rows[0]), operation: operationView(rows[0]) } : null;
}

async function readOperation(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  operationId: string,
): Promise<OperationRow | null> {
  const rows = await engine.executeRaw<OperationRow>(
    'SELECT * FROM workspace_background_operations WHERE workspace_id=$1 AND operation_id=$2',
    [workspaceId, operationId],
  );
  return rows[0] ?? null;
}

export async function queueManagedGitSource(
  engine: ProvisioningEngine,
  input: {
    workspaceId: string;
    sourceId: string;
    name: string;
    remoteUrl: string;
    expectedCadence: string;
    includedInWorkspaceSearch?: boolean;
    actorMembershipId: string;
    requestId: string;
    idempotencyKey: string;
  },
): Promise<{ source: ManagedGitSourceView; operation: BackgroundOperationView }> {
  const workspaceId = requireText(input.workspaceId, 'workspace_id_required', 128);
  const sourceId = validateSourceId(input.sourceId);
  const name = requireText(input.name, 'source_name_required', 80);
  const cadence = validateExpectedCadence(input.expectedCadence);
  const requestId = requireText(input.requestId, 'request_id_required', 200);
  const idempotencyKey = requireText(input.idempotencyKey, 'idempotency_key_required', 200);
  let remoteUrl: string;
  try {
    remoteUrl = parseRemoteUrl(input.remoteUrl).url;
  } catch (error) {
    if (error instanceof RemoteUrlError) {
      throw new WorkspaceSourceProvisioningError('invalid_remote_url', 'invalid_remote_url');
    }
    throw error;
  }

  const existing = await readIdempotentProvisioning(engine, workspaceId, idempotencyKey);
  const fingerprint = idempotencyFingerprint({
    workspaceId, sourceId, name, remoteUrl, cadence,
    includedInWorkspaceSearch: input.includedInWorkspaceSearch ?? true,
  });
  if (existing) {
    const row = await readOperation(engine, workspaceId, existing.operation.operationId);
    if (!row) throw new Error('queued_source_not_found');
    assertIdempotencyFingerprint(row, fingerprint);
    return existing;
  }

  const operationId = randomUUID();
  const mutation = await runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'source.create',
    target: { type: 'source', id: sourceId },
    requestId,
    after: {
      sourceId,
      kind: 'managed_git',
      includedInWorkspaceSearch: input.includedInWorkspaceSearch ?? true,
      provisioningState: 'queued',
    },
  }, async transaction => {
    const reservations = await transaction.executeRaw<{ operation_id: string }>(
      `INSERT INTO workspace_idempotency_keys (
         workspace_id, scope, idempotency_key, idempotency_fingerprint, resource_id, operation_id
       ) VALUES ($1, 'source.provision', $2, $3, $4, $5)
       ON CONFLICT (workspace_id, scope, idempotency_key) DO NOTHING
       RETURNING operation_id`,
      [workspaceId, idempotencyKey, fingerprint, sourceId, operationId],
    );
    if (!reservations[0]) {
      const reserved = await transaction.executeRaw<{
        idempotency_fingerprint: string;
        resource_id: string;
        operation_id: string;
      }>(
        `SELECT idempotency_fingerprint, resource_id, operation_id
           FROM workspace_idempotency_keys
          WHERE workspace_id=$1 AND scope='source.provision' AND idempotency_key=$2`,
        [workspaceId, idempotencyKey],
      );
      if (!reserved[0]
        || reserved[0].idempotency_fingerprint !== fingerprint
        || reserved[0].resource_id !== sourceId) {
        throw new WorkspaceSourceProvisioningError('idempotency_key_reused', 'idempotency_key_reused');
      }
      const duplicate = await readIdempotentProvisioning(transaction, workspaceId, idempotencyKey);
      if (!duplicate || duplicate.operation.operationId !== reserved[0].operation_id) {
        throw new Error('queued_source_not_found');
      }
      return { value: duplicate, created: false };
    }
    const insertedSources = await transaction.executeRaw<{ source_id: string }>(
      `INSERT INTO workspace_sources (
         source_id, workspace_id, name, remote_url, expected_cadence,
         included_in_workspace_search, created_by_membership_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (source_id) DO NOTHING
       RETURNING source_id`,
      [sourceId, workspaceId, name, remoteUrl, cadence, input.includedInWorkspaceSearch ?? true, input.actorMembershipId],
    );
    if (!insertedSources[0]) {
      throw new WorkspaceSourceProvisioningError('source_id_taken', 'source_id_taken');
    }
    await transaction.executeRaw(
      `INSERT INTO workspace_background_operations (
         operation_id, workspace_id, operation_type, initiator_membership_id,
         resource_type, resource_id, idempotency_key, idempotency_fingerprint, request_id
       ) VALUES ($1, $2, 'source.provision', $3, 'source', $4, $5, $6, $7)`,
      [operationId, workspaceId, input.actorMembershipId, sourceId, idempotencyKey, fingerprint, requestId],
    );
    const queued = await readIdempotentProvisioning(transaction, workspaceId, idempotencyKey);
    if (!queued) throw new Error('queued_source_not_found');
    return { value: queued, created: true };
  }, { isMaterialChange: result => result.created });
  return mutation.value;
}

export async function retryBackgroundOperation(
  engine: ProvisioningEngine,
  input: {
    workspaceId: string;
    operationId: string;
    actorMembershipId: string;
    requestId: string;
  },
): Promise<BackgroundOperationView> {
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'operation.retry',
    target: { type: 'background_operation', id: input.operationId },
    requestId: input.requestId,
    before: { state: 'failed' },
    after: { state: 'queued' },
  }, async transaction => {
    const rows = await transaction.executeRaw<OperationRow>(
      `UPDATE workspace_background_operations
          SET state='queued', progress=0, outcome_summary=NULL, error_code=NULL, error_summary=NULL,
              cancel_requested=FALSE, cancellation_safe=TRUE, request_id=$3,
              lease_owner=NULL, lease_expires_at=NULL, available_at=now(), completed_at=NULL, updated_at=now()
        WHERE workspace_id=$1 AND operation_id=$2 AND state='failed' AND retryable=TRUE
          AND attempt < max_attempts
        RETURNING *`,
      [input.workspaceId, input.operationId, input.requestId],
    );
    if (!rows[0]) throw new WorkspaceSourceProvisioningError('operation_not_retryable', 'operation_not_retryable');
    if (rows[0].operation_type === 'source.provision') await transaction.executeRaw(
      "UPDATE workspace_sources SET provisioning_state='queued', updated_at=now() WHERE workspace_id=$1 AND source_id=$2",
      [input.workspaceId, rows[0].resource_id],
    );
    return operationView(rows[0]);
  });
}

export async function cancelBackgroundOperation(
  engine: ProvisioningEngine,
  input: {
    workspaceId: string;
    operationId: string;
    actorMembershipId: string;
    requestId: string;
  },
): Promise<BackgroundOperationView> {
  const current = await readOperation(engine, input.workspaceId, input.operationId);
  if (!current) throw new WorkspaceSourceProvisioningError('operation_not_found', 'operation_not_found');
  if (current.state !== 'queued' && current.state !== 'running') {
    throw new WorkspaceSourceProvisioningError('operation_not_cancellable', 'operation_not_cancellable');
  }
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'operation.cancel',
    target: { type: 'background_operation', id: input.operationId },
    requestId: input.requestId,
    before: { state: current.state },
    after: { state: current.state === 'queued' ? 'failed' : 'running', cancelRequested: true },
  }, async transaction => {
    const queuedRows = await transaction.executeRaw<OperationRow>(
      `UPDATE workspace_background_operations
          SET state='failed', error_code='operation_cancelled',
              error_summary='The operation was cancelled before external work began.',
              retryable=FALSE, cancel_requested=TRUE, cancellation_safe=FALSE,
              request_id=$3, completed_at=now(), updated_at=now()
        WHERE workspace_id=$1 AND operation_id=$2 AND state='queued'
        RETURNING *`,
      [input.workspaceId, input.operationId, input.requestId],
    );
    if (queuedRows[0]) {
      if (queuedRows[0].operation_type === 'source.provision') await transaction.executeRaw(
        "UPDATE workspace_sources SET provisioning_state='failed', updated_at=now() WHERE workspace_id=$1 AND source_id=$2",
        [input.workspaceId, queuedRows[0].resource_id],
      );
      await notifyWorkspaceBackgroundOperationOutcome(transaction, {
        workspaceId: input.workspaceId,
        operationId: input.operationId,
        requestId: input.requestId,
      });
      return operationView(queuedRows[0]);
    }
    const runningRows = await transaction.executeRaw<OperationRow>(
      `UPDATE workspace_background_operations
          SET cancel_requested=TRUE, request_id=$3, updated_at=now()
        WHERE workspace_id=$1 AND operation_id=$2 AND state='running'
        RETURNING *`,
      [input.workspaceId, input.operationId, input.requestId],
    );
    if (!runningRows[0]) throw new WorkspaceSourceProvisioningError('operation_not_cancellable', 'operation_not_cancellable');
    return operationView(runningRows[0]);
  });
}

export async function getBackgroundOperation(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  operationId: string,
): Promise<BackgroundOperationView | null> {
  const row = await readOperation(engine, workspaceId, operationId);
  return row ? operationView(row) : null;
}

export async function listBackgroundOperations(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
): Promise<BackgroundOperationView[]> {
  const rows = await engine.executeRaw<OperationRow>(
    `SELECT * FROM workspace_background_operations
      WHERE workspace_id=$1
      ORDER BY created_at DESC, operation_id DESC`,
    [workspaceId],
  );
  return rows.map(operationView);
}

export async function listManagedGitSources(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  now = new Date().toISOString(),
): Promise<ManagedGitSourceView[]> {
  const rows = await engine.executeRaw<SourceRow>(
    `SELECT s.*,
            v.outcome AS latest_verification_outcome,
            v.error_code AS latest_verification_error_code,
            v.request_id AS latest_verification_request_id,
            v.completed_at AS latest_verification_completed_at
       FROM workspace_sources s
       LEFT JOIN LATERAL (
         SELECT v.outcome,v.error_code,v.request_id,v.completed_at
           FROM workspace_source_verification_events v
           JOIN workspace_background_operations o ON o.operation_id=v.operation_id
          WHERE v.workspace_id=s.workspace_id AND v.source_id=s.source_id
          ORDER BY o.created_at DESC,v.completed_at DESC,v.event_id DESC LIMIT 1
       ) v ON TRUE
      WHERE s.workspace_id=$1 AND s.archived=$2 AND s.deleted=FALSE ORDER BY s.created_at,s.source_id`,
    [workspaceId, false],
  );
  return rows.map(row => sourceView(row, now));
}

export async function listArchivedManagedGitSources(
  engine: Pick<BrainEngine, 'executeRaw'>,
  workspaceId: string,
  now = new Date().toISOString(),
): Promise<ManagedGitSourceView[]> {
  const rows = await engine.executeRaw<SourceRow>(
    `SELECT s.*,
            v.outcome AS latest_verification_outcome,
            v.error_code AS latest_verification_error_code,
            v.request_id AS latest_verification_request_id,
            v.completed_at AS latest_verification_completed_at
       FROM workspace_sources s
       LEFT JOIN LATERAL (
         SELECT v.outcome,v.error_code,v.request_id,v.completed_at
           FROM workspace_source_verification_events v
           JOIN workspace_background_operations o ON o.operation_id=v.operation_id
          WHERE v.workspace_id=s.workspace_id AND v.source_id=s.source_id
          ORDER BY o.created_at DESC,v.completed_at DESC,v.event_id DESC LIMIT 1
       ) v ON TRUE
      WHERE s.workspace_id=$1 AND s.archived=$2 AND s.deleted=FALSE ORDER BY s.archived_at DESC,s.source_id`,
    [workspaceId, true],
  );
  return rows.map(row => sourceView(row, now));
}

async function claimBackgroundOperation(
  engine: ProvisioningEngine,
  workerId: string,
  leaseMs: number,
): Promise<ClaimedOperationRow | null> {
  return engine.transaction(async transaction => {
    const rows = await transaction.executeRaw<OperationRow>(
      `WITH candidate AS (
         SELECT o.operation_id
           FROM workspace_background_operations o
           JOIN workspace_sources s ON s.workspace_id=o.workspace_id AND s.source_id=o.resource_id
          WHERE (
            (o.state='queued' AND o.available_at <= now())
            OR (o.state='running' AND o.lease_expires_at < now())
          )
            AND o.operation_type='source.provision' AND s.archived=FALSE
            AND o.attempt < o.max_attempts
          ORDER BY o.created_at, o.operation_id
          FOR UPDATE OF o SKIP LOCKED
          LIMIT 1
       )
       UPDATE workspace_background_operations operation
          SET state='running', progress=GREATEST(progress, 5),
              lease_owner=$1, lease_expires_at=now() + ($2 * interval '1 millisecond'),
              started_at=COALESCE(started_at, now()), updated_at=now(), attempt=attempt+1,
              cancellation_safe=TRUE
         FROM candidate
        WHERE operation.operation_id=candidate.operation_id
       RETURNING operation.*`,
      [workerId, leaseMs],
    );
    const claimed = rows[0];
    if (!claimed) return null;
    await transaction.executeRaw(
      "UPDATE workspace_sources SET provisioning_state='running', updated_at=now() WHERE workspace_id=$1 AND source_id=$2",
      [await operationWorkspaceId(transaction, claimed.operation_id), claimed.resource_id],
    );
    const joined = await transaction.executeRaw<ClaimedOperationRow>(
      `SELECT o.*, s.remote_url, s.name, s.expected_cadence, s.included_in_workspace_search
         FROM workspace_background_operations o
         JOIN workspace_sources s ON s.workspace_id=o.workspace_id AND s.source_id=o.resource_id
        WHERE o.operation_id=$1`,
      [claimed.operation_id],
    );
    return joined[0] ?? null;
  });
}

async function failExhaustedBackgroundOperation(
  engine: ProvisioningEngine,
): Promise<BackgroundOperationView | null> {
  return engine.transaction(async transaction => {
    const rows = await transaction.executeRaw<OperationRow>(
      `WITH exhausted AS (
         SELECT operation_id
           FROM workspace_background_operations
          WHERE state='running' AND lease_expires_at < now() AND attempt >= max_attempts
            AND operation_type <> 'source.permanent_delete'
          ORDER BY lease_expires_at, operation_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE workspace_background_operations operation
          SET state='failed', error_code='source_provisioning_exhausted',
              error_summary='Source provisioning stopped after repeated interrupted attempts.',
              retryable=FALSE, cancellation_safe=FALSE, lease_owner=NULL, lease_expires_at=NULL,
              completed_at=now(), updated_at=now()
         FROM exhausted
        WHERE operation.operation_id=exhausted.operation_id
       RETURNING operation.*`,
    );
    if (!rows[0]) return null;
    await transaction.executeRaw(
      "UPDATE workspace_sources SET provisioning_state='failed', updated_at=now() WHERE workspace_id=$1 AND source_id=$2",
      [await operationWorkspaceId(transaction, rows[0].operation_id), rows[0].resource_id],
    );
    const event = {
      actor: { kind: 'system' as const, id: 'workspace-worker-recovery' },
      action: 'source.provision.fail' as const,
      target: { type: 'source', id: rows[0].resource_id },
      requestId: rows[0].request_id,
      before: { provisioningState: 'running', attempt: rows[0].attempt },
      after: { provisioningState: 'failed', errorCode: 'source_provisioning_exhausted', retryable: false },
    };
    await appendWorkspaceAuditEvent(transaction, { ...event, outcome: 'succeeded' });
    await appendWorkspaceChangeEvent(transaction, {
      actor: event.actor, action: event.action, resource: event.target, requestId: event.requestId,
    });
    const workspaceId = await operationWorkspaceId(transaction, rows[0].operation_id);
    await notifyWorkspaceBackgroundOperationOutcome(transaction, {
      workspaceId,
      operationId: rows[0].operation_id,
      requestId: rows[0].request_id,
    });
    return operationView(rows[0]);
  });
}

async function operationWorkspaceId(
  engine: Pick<BrainEngine, 'executeRaw'>,
  operationId: string,
): Promise<string> {
  const rows = await engine.executeRaw<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_background_operations WHERE operation_id=$1',
    [operationId],
  );
  if (!rows[0]) throw new Error('background_operation_not_found');
  return rows[0].workspace_id;
}

async function finishOperation(
  engine: ProvisioningEngine,
  claimed: ClaimedOperationRow,
  outcome: { state: 'completed'; summary: string } | { state: 'failed'; code: string; summary: string; retryable: boolean },
): Promise<BackgroundOperationView> {
  return engine.transaction(async transaction => {
    const lifecycle = await transaction.executeRaw<{ archived: boolean }>(
      `SELECT archived FROM workspace_sources
        WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE`,
      [claimed.workspace_id, claimed.resource_id],
    );
    const archived = lifecycle[0]?.archived === true;
    const effectiveOutcome = archived
      ? { state: 'failed' as const, code: 'source_archived', summary: 'The Source was archived before provisioning completed.', retryable: false }
      : outcome;
    if (archived) await setLegacySourceArchiveProjection(transaction, claimed.resource_id, true);
    const completed = effectiveOutcome.state === 'completed';
    const rows = await transaction.executeRaw<OperationRow>(
      `UPDATE workspace_background_operations
          SET state=$2, progress=$3, outcome_summary=$4, error_code=$5, error_summary=$6,
              retryable=$7, cancellation_safe=FALSE, lease_owner=NULL, lease_expires_at=NULL,
              completed_at=now(), updated_at=now()
        WHERE operation_id=$1 AND state='running' AND lease_owner=$8
        RETURNING *`,
      [
        claimed.operation_id,
        effectiveOutcome.state,
        completed ? 100 : claimed.progress,
        completed ? effectiveOutcome.summary : null,
        completed ? null : effectiveOutcome.code,
        completed ? null : effectiveOutcome.summary,
        completed ? false : effectiveOutcome.retryable,
        claimed.lease_owner,
      ],
    );
    if (!rows[0]) throw new Error('background_operation_lease_lost');
    await transaction.executeRaw(
      'UPDATE workspace_sources SET provisioning_state=$3, updated_at=now() WHERE workspace_id=$1 AND source_id=$2',
      [claimed.workspace_id, claimed.resource_id, effectiveOutcome.state],
    );
    const action = completed ? 'source.provision.complete' as const : 'source.provision.fail' as const;
    const event = {
      actor: { kind: 'system' as const, id: claimed.lease_owner },
      action,
      target: { type: 'source', id: claimed.resource_id },
      requestId: claimed.request_id,
      before: { provisioningState: 'running', attempt: claimed.attempt },
      after: completed
        ? { provisioningState: 'completed' }
        : { provisioningState: 'failed', errorCode: effectiveOutcome.code, retryable: effectiveOutcome.retryable },
    };
    await appendWorkspaceAuditEvent(transaction, { ...event, outcome: 'succeeded' });
    await appendWorkspaceChangeEvent(transaction, {
      actor: event.actor,
      action,
      resource: event.target,
      requestId: event.requestId,
    });
    await notifyWorkspaceBackgroundOperationOutcome(transaction, {
      workspaceId: claimed.workspace_id,
      operationId: claimed.operation_id,
      requestId: claimed.request_id,
    });
    return operationView(rows[0]);
  });
}

async function deferOperationAfterProvisioningLockContention(
  engine: ProvisioningEngine,
  claimed: ClaimedOperationRow,
): Promise<BackgroundOperationView> {
  return engine.transaction(async transaction => {
    const rows = await transaction.executeRaw<OperationRow>(
      `UPDATE workspace_background_operations
          SET state='queued', progress=5, attempt=GREATEST(0, attempt - 1),
              available_at=now() + interval '5 seconds', cancellation_safe=TRUE,
              lease_owner=NULL, lease_expires_at=NULL, updated_at=now()
        WHERE operation_id=$1 AND state='running' AND lease_owner=$2
        RETURNING *`,
      [claimed.operation_id, claimed.lease_owner],
    );
    if (!rows[0]) throw new Error('background_operation_lease_lost');
    await transaction.executeRaw(
      "UPDATE workspace_sources SET provisioning_state='queued', updated_at=now() WHERE workspace_id=$1 AND source_id=$2",
      [claimed.workspace_id, claimed.resource_id],
    );
    return operationView(rows[0]);
  });
}

export async function runBackgroundOperationWorkerOnce(
  engine: ProvisioningEngine,
  options: {
    workerId: string;
    executeSourceProvisioning: (job: SourceProvisioningJob) => Promise<void>;
    leaseMs?: number;
  },
): Promise<BackgroundOperationView | null> {
  const workerId = requireText(options.workerId, 'worker_id_required', 200);
  const leaseMs = Math.max(1_000, options.leaseMs ?? 30 * 60_000);
  const exhausted = await failExhaustedBackgroundOperation(engine);
  if (exhausted) return exhausted;
  const claimed = await claimBackgroundOperation(engine, workerId, leaseMs);
  if (!claimed) return null;

  const lifecycle = await engine.executeRaw<{ archived: boolean }>(
    'SELECT archived FROM workspace_sources WHERE workspace_id=$1 AND source_id=$2',
    [claimed.workspace_id, claimed.resource_id],
  );
  if (lifecycle[0]?.archived) {
    return finishOperation(engine, claimed, {
      state: 'failed', code: 'source_archived',
      summary: 'The Source was archived before provisioning began.', retryable: false,
    });
  }

  if (claimed.cancel_requested) {
    return finishOperation(engine, claimed, {
      state: 'failed',
      code: 'operation_cancelled',
      summary: 'The operation was cancelled before external work began.',
      retryable: false,
    });
  }

  await engine.executeRaw(
    'UPDATE workspace_background_operations SET progress=15, cancellation_safe=FALSE, updated_at=now() WHERE operation_id=$1 AND lease_owner=$2',
    [claimed.operation_id, workerId],
  );
  const leaseAbort = new AbortController();
  let leaseFailure: Error | null = null;
  const renewal = setInterval(() => {
    void engine.executeRaw<{ operation_id: string }>(
      `UPDATE workspace_background_operations
          SET lease_expires_at=now() + ($3 * interval '1 millisecond'), updated_at=now()
        WHERE operation_id=$1 AND state='running' AND lease_owner=$2
        RETURNING operation_id`,
      [claimed.operation_id, workerId, leaseMs],
    ).then(rows => {
      if (!rows[0]) throw new Error('background_operation_lease_lost');
    }).catch(error => {
      leaseFailure = error instanceof Error ? error : new Error('background_operation_lease_renewal_failed');
      leaseAbort.abort(leaseFailure);
    });
  }, Math.max(250, Math.floor(leaseMs / 3)));
  renewal.unref?.();
  try {
    await options.executeSourceProvisioning({
      operationId: claimed.operation_id,
      workspaceId: claimed.workspace_id,
      source: {
        sourceId: claimed.resource_id,
        name: claimed.name,
        remoteUrl: claimed.remote_url,
        expectedCadence: claimed.expected_cadence,
        includedInWorkspaceSearch: claimed.included_in_workspace_search,
        provisioningState: 'running',
      },
      attempt: Number(claimed.attempt),
      requestId: claimed.request_id,
      signal: leaseAbort.signal,
    });
    if (leaseFailure) throw leaseFailure;
    return await finishOperation(engine, { ...claimed, progress: 100 }, {
      state: 'completed',
      summary: 'Managed Git Source connected.',
    });
  } catch (error) {
    if (leaseFailure || leaseAbort.signal.aborted) {
      throw leaseFailure ?? error;
    }
    if (error instanceof LockUnavailableError) {
      return await deferOperationAfterProvisioningLockContention(engine, claimed);
    }
    const retryable = Number(claimed.attempt) < Number(claimed.max_attempts);
    return await finishOperation(engine, claimed, {
      state: 'failed',
      code: 'source_provisioning_failed',
      summary: 'Source provisioning failed. Retry when the Git remote is available.',
      retryable,
    });
  } finally {
    clearInterval(renewal);
  }
}

/**
 * Execute the external part of Source provisioning. The legacy Source row is
 * an idempotency checkpoint: after a process restart, an existing matching row
 * skips clone/registration and resumes initial ingestion.
 */
export async function provisionManagedGitSource(
  engine: BrainEngine,
  job: SourceProvisioningJob,
): Promise<void> {
  // This lock outlives the operation lease heartbeat and fences clone + sync.
  // If a replacement worker reclaims an expired operation, it cannot overlap
  // filesystem or ingestion effects with the original worker.
  await withRefreshingLock(engine, `source-provision:${job.source.sourceId}`, async () => {
    job.signal.throwIfAborted();
    const shouldSynchronize = await engine.transaction(async transaction => {
      const lifecycle = await transaction.executeRaw<{ archived: boolean }>(
        `SELECT archived FROM workspace_sources
          WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE`,
        [job.workspaceId, job.source.sourceId],
      );
      if (!lifecycle[0]) throw new Error('workspace_source_not_found');
      if (lifecycle[0].archived) {
        await setLegacySourceArchiveProjection(transaction, job.source.sourceId, true);
        return false;
      }

      const existing = await transaction.executeRaw<{ config: Record<string, unknown> | string }>(
        'SELECT config FROM sources WHERE id=$1',
        [job.source.sourceId],
      );
      if (existing[0]) {
        const config = typeof existing[0].config === 'string'
          ? JSON.parse(existing[0].config) as Record<string, unknown>
          : existing[0].config;
        if (config.remote_url !== job.source.remoteUrl || config.managed_clone !== true) {
          throw new WorkspaceSourceProvisioningError('source_id_taken', 'source_id_taken');
        }
      } else {
        job.signal.throwIfAborted();
        await addSource(transaction, {
          id: job.source.sourceId,
          name: job.source.name,
          remoteUrl: job.source.remoteUrl,
        });
      }
      return true;
    });
    if (!shouldSynchronize) return;
    job.signal.throwIfAborted();
    await performSync(engine, { sourceId: job.source.sourceId, skipLock: true });
  });
}
