import type { BrainEngine } from '../core/engine.ts';
import { runProtectedWorkspaceMutation } from './events.ts';

type Engine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;

export type WorkspaceSourceLifecycleErrorCode =
  | 'source_lifecycle_forbidden'
  | 'source_not_found';

export class WorkspaceSourceLifecycleError extends Error {
  constructor(public readonly code: WorkspaceSourceLifecycleErrorCode) {
    super(code);
    this.name = 'WorkspaceSourceLifecycleError';
  }
}

export interface WorkspaceSourceLifecycleResult {
  sourceId: string;
  lifecycleState: 'active' | 'archived';
  archivedAt: string | null;
  changed: boolean;
}

interface LifecycleInput {
  workspaceId: string;
  sourceId: string;
  actorMembershipId: string;
  requestId: string;
  reason?: string;
}

async function requireAdministratorSourceAccess(engine: Pick<BrainEngine, 'executeRaw'>, input: LifecycleInput): Promise<void> {
  const rows = await engine.executeRaw<{ access_mode: string }>(
    `SELECT p.access_mode
       FROM workspace_memberships m
       JOIN workspace_principal_source_policies p
         ON p.principal_kind='member' AND p.principal_id=m.membership_id
      WHERE m.workspace_id=$1 AND m.membership_id=$2
        AND m.role='administrator' AND m.status='active'
      FOR UPDATE OF m,p`,
    [input.workspaceId, input.actorMembershipId],
  );
  if (!rows[0] || (rows[0].access_mode !== 'all' && rows[0].access_mode !== 'specific')) {
    throw new WorkspaceSourceLifecycleError('source_lifecycle_forbidden');
  }
  if (rows[0].access_mode === 'specific') {
    const grants = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM workspace_source_grants
        WHERE principal_kind='member' AND principal_id=$1 AND source_id=$2
        FOR UPDATE`,
      [input.actorMembershipId, input.sourceId],
    );
    if (!grants[0]) throw new WorkspaceSourceLifecycleError('source_lifecycle_forbidden');
  }
}

export async function setLegacySourceArchiveProjection(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  archived: boolean,
): Promise<boolean> {
  const tables = await engine.executeRaw<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='sources'
     ) AS present`,
  );
  if (!tables[0]?.present) return false;
  const rows = await engine.executeRaw<{ id: string }>(
    `UPDATE sources SET archived=$2,
        archived_at=CASE WHEN $2 THEN COALESCE(archived_at,now()) ELSE NULL END,
        archive_expires_at=NULL
      WHERE id=$1 AND (
        archived IS DISTINCT FROM $2 OR
        ($2 AND (archived_at IS NULL OR archive_expires_at IS NOT NULL)) OR
        (NOT $2 AND (archived_at IS NOT NULL OR archive_expires_at IS NOT NULL))
      )
      RETURNING id`,
    [sourceId, archived],
  );
  return rows.length > 0;
}

async function setArchived(engine: Engine, input: LifecycleInput, archived: boolean): Promise<WorkspaceSourceLifecycleResult> {
  const action = archived ? 'source.archive' as const : 'source.restore' as const;
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action,
    target: { type: 'source', id: input.sourceId },
    requestId: input.requestId,
    reason: input.reason,
    before: { lifecycle_state: archived ? 'active' : 'archived' },
    after: { lifecycle_state: archived ? 'archived' : 'active' },
  }, async transaction => {
    await requireAdministratorSourceAccess(transaction, input);
    const existing = await transaction.executeRaw<{ archived: boolean; archived_at: string | Date | null; deleted: boolean }>(
      `SELECT archived,archived_at,deleted FROM workspace_sources
        WHERE workspace_id=$1 AND source_id=$2 FOR UPDATE`,
      [input.workspaceId, input.sourceId],
    );
    // A permanently deleted Source keeps only its redacted lifecycle row; it
    // can never re-enter the archive/restore lifecycle.
    if (!existing[0] || existing[0].deleted) throw new WorkspaceSourceLifecycleError('source_not_found');
    if (existing[0].archived === archived) {
      const projectionChanged = await setLegacySourceArchiveProjection(transaction, input.sourceId, archived);
      return {
        sourceId: input.sourceId,
        lifecycleState: archived ? 'archived' : 'active',
        archivedAt: existing[0].archived_at ? new Date(existing[0].archived_at).toISOString() : null,
        changed: projectionChanged,
      };
    }
    const rows = await transaction.executeRaw<{ archived_at: string | Date | null }>(
      `UPDATE workspace_sources
          SET archived=$3,
              archived_at=CASE WHEN $3 THEN now() ELSE NULL END,
              archived_by_membership_id=CASE WHEN $3 THEN $4 ELSE NULL END,
              updated_at=now()
        WHERE workspace_id=$1 AND source_id=$2
        RETURNING archived_at`,
      [input.workspaceId, input.sourceId, archived, input.actorMembershipId],
    );
    await setLegacySourceArchiveProjection(transaction, input.sourceId, archived);
    if (archived) {
      await transaction.executeRaw(
        `UPDATE workspace_background_operations
            SET state='failed', error_code='source_archived',
                error_summary='The Source was archived before maintenance began.',
                retryable=FALSE, cancellation_safe=FALSE, cancel_requested=TRUE,
                completed_at=now(), updated_at=now()
          WHERE workspace_id=$1 AND resource_id=$2 AND state='queued'`,
        [input.workspaceId, input.sourceId],
      );
      await transaction.executeRaw(
        `UPDATE workspace_sources SET provisioning_state='failed',updated_at=now()
          WHERE workspace_id=$1 AND source_id=$2 AND provisioning_state='queued'`,
        [input.workspaceId, input.sourceId],
      );
      await transaction.executeRaw(
        `UPDATE workspace_background_operations SET cancel_requested=TRUE,updated_at=now()
          WHERE workspace_id=$1 AND resource_id=$2 AND state='running'`,
        [input.workspaceId, input.sourceId],
      );
    } else {
      const requeued = await transaction.executeRaw<{ operation_id: string }>(
        `UPDATE workspace_background_operations
            SET state='queued', progress=0, outcome_summary=NULL,
                error_code=NULL, error_summary=NULL, retryable=TRUE,
                cancel_requested=FALSE, cancellation_safe=TRUE,
                lease_owner=NULL, lease_expires_at=NULL, available_at=now(),
                completed_at=NULL, updated_at=now(),
                attempt=GREATEST(attempt-1,0)
          WHERE workspace_id=$1 AND resource_id=$2
            AND operation_type='source.provision'
            AND state='failed' AND error_code='source_archived'
          RETURNING operation_id`,
        [input.workspaceId, input.sourceId],
      );
      if (requeued.length > 0) {
        await transaction.executeRaw(
          `UPDATE workspace_sources SET provisioning_state='queued',updated_at=now()
            WHERE workspace_id=$1 AND source_id=$2`,
          [input.workspaceId, input.sourceId],
        );
      }
    }
    return {
      sourceId: input.sourceId,
      lifecycleState: archived ? 'archived' : 'active',
      archivedAt: rows[0]?.archived_at ? new Date(rows[0].archived_at).toISOString() : null,
      changed: true,
    };
  }, {
    isMaterialChange: result => result.changed,
    auditNonMaterial: true,
    eventForResult: result => ({
      before: { lifecycle_state: result.changed ? (archived ? 'active' : 'archived') : result.lifecycleState },
      after: { lifecycle_state: result.lifecycleState },
    }),
  });
}

export function archiveWorkspaceSource(engine: Engine, input: LifecycleInput): Promise<WorkspaceSourceLifecycleResult> {
  return setArchived(engine, input, true);
}

export function restoreWorkspaceSource(engine: Engine, input: LifecycleInput): Promise<WorkspaceSourceLifecycleResult> {
  return setArchived(engine, input, false);
}
