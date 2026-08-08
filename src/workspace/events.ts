import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { sanitizeWorkspaceSnapshot, sanitizeWorkspaceText } from './safe-values.ts';

type WorkspaceEventEngine = Pick<BrainEngine, 'executeRaw'>;
type WorkspaceMutationEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;
type WorkspaceActorKind = 'member' | 'agent' | 'operator' | 'system';

export interface WorkspaceProtectedMutation {
  actor: { kind: WorkspaceActorKind; id: string };
  action: WorkspaceProtectedAction;
  target: { type: string; id: string };
  requestId: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
}

export interface WorkspaceAuditEvent extends WorkspaceProtectedMutation {
  outcome: 'succeeded' | 'failed';
}

const WORKSPACE_MUTATION_POLICIES = {
  'agent.register': { reasonRequired: false, changeSummary: 'Registered an Agent.' },
  'agent.access.initialize': { reasonRequired: false, changeSummary: 'Created the shared runtime Agent.' },
  'agent.access.grant': { reasonRequired: true, changeSummary: 'Changed the shared runtime Agent grant.' },
  'agent.access.confirm': { reasonRequired: true, changeSummary: 'Confirmed the shared runtime Agent grant.' },
  'agent.native_password.rotate': { reasonRequired: true, changeSummary: 'Rotated the shared runtime native password.' },
  // Provider setup names the PROVIDER and nothing else. No setup token, API key,
  // or upstream message is ever an argument to these mutations, so none can reach
  // the Audit Events or the Change Events they emit.
  //
  // The two are deliberately separate actions because they happen at different
  // moments and only one of them is a claim about the outside world. Clearing the
  // proofs is a local, already-committed fact recorded BEFORE the credential is
  // sent; "connected" is recorded only AFTER OpenClaw has accepted it, and a
  // failed import appends `agent.provider.import` with outcome `failed` instead.
  'agent.provider.invalidate': {
    reasonRequired: false,
    changeSummary: 'Invalidated the shared runtime model proofs.',
  },
  'agent.provider.import': { reasonRequired: false, changeSummary: 'Connected a shared runtime model provider.' },
  'agent.owner.change': { reasonRequired: true, changeSummary: 'Changed an Agent Owner.' },
  'agent.purpose.change': { reasonRequired: true, changeSummary: 'Changed an Agent purpose.' },
  'agent.scope.change': { reasonRequired: true, changeSummary: 'Changed an Agent Scope.' },
  'agent.scope.reduce': { reasonRequired: true, changeSummary: 'Reduced an Agent scope.' },
  'agent.source_access.change': { reasonRequired: true, changeSummary: 'Changed Agent Source Access.' },
  'agent.status.change': { reasonRequired: true, changeSummary: 'Changed an Agent status.' },
  'knowledge.agent.write': { reasonRequired: false, changeSummary: 'An Agent updated Knowledge.' },
  'attention.assign': { reasonRequired: false, changeSummary: 'Assigned an Attention Item.' },
  'attention.detect': { reasonRequired: false, changeSummary: 'Opened an Attention Item.' },
  'attention.dismiss': { reasonRequired: true, changeSummary: 'Dismissed an Attention Item.' },
  'attention.resolve': { reasonRequired: false, changeSummary: 'Resolved an Attention Item after verified recovery.' },
  'attention.resolve.request': { reasonRequired: false, changeSummary: 'Requested Attention resolution verification.' },
  'attention.status.change': { reasonRequired: false, changeSummary: 'Moved an Attention Item to In progress.' },
  'credential.revoke': { reasonRequired: true, changeSummary: 'Revoked a credential.' },
  'credential.rotate': { reasonRequired: true, changeSummary: 'Rotated a credential.' },
  'connected_app.access_level.change': { reasonRequired: false, changeSummary: 'Changed Connected App access.' },
  'connected_app.revoke': { reasonRequired: false, changeSummary: 'Revoked a Connected App.' },
  'membership.role.reduce': { reasonRequired: true, changeSummary: 'Reduced a Workspace Membership role.' },
  'membership.invite': { reasonRequired: false, changeSummary: 'Invited a Workspace Member.' },
  'membership.role.change': { reasonRequired: true, changeSummary: 'Changed a Workspace Membership role.' },
  'membership.source_access.change': { reasonRequired: true, changeSummary: 'Changed Workspace Membership Source Access.' },
  'membership.status.change': { reasonRequired: true, changeSummary: 'Changed a Workspace Membership status.' },
  'source.archive': { reasonRequired: false, changeSummary: 'Archived a Source.' },
  'source.create': { reasonRequired: false, changeSummary: 'Queued a Managed Git Source.' },
  'source.restore': { reasonRequired: false, changeSummary: 'Restored a Source.' },
  'source.delete': { reasonRequired: true, changeSummary: 'Deleted a source.' },
  'source.delete.request': { reasonRequired: true, changeSummary: 'Requested permanent Source deletion.' },
  'source.delete.fail': { reasonRequired: false, changeSummary: 'Permanent Source deletion failed.' },
  'source.provision.complete': { reasonRequired: false, changeSummary: 'Connected a Managed Git Source.' },
  'source.provision.fail': { reasonRequired: false, changeSummary: 'Managed Git Source provisioning failed.' },
  'source.maintenance.request': { reasonRequired: false, changeSummary: 'Queued Source maintenance.' },
  'source.verify.complete': { reasonRequired: false, changeSummary: 'Verified a Source.' },
  'source.sync.complete': { reasonRequired: false, changeSummary: 'Synchronized a Source.' },
  'source.maintenance.fail': { reasonRequired: false, changeSummary: 'Source maintenance failed.' },
  'operation.cancel': { reasonRequired: false, changeSummary: 'Cancelled a Background Operation.' },
  'operation.retry': { reasonRequired: false, changeSummary: 'Retried a Background Operation.' },
  'export.request': { reasonRequired: false, changeSummary: 'Requested a Workspace Export.' },
  'export.complete': { reasonRequired: false, changeSummary: 'Completed a Workspace Export.' },
  'export.fail': { reasonRequired: false, changeSummary: 'Workspace Export failed.' },
  'export.retrieve': { reasonRequired: false, changeSummary: 'Retrieved a Workspace Export.' },
  'export.retry': { reasonRequired: false, changeSummary: 'Retried a Workspace Export.' },
  'export.cancel': { reasonRequired: false, changeSummary: 'Cancelled a Workspace Export.' },
  'retention.request': { reasonRequired: false, changeSummary: 'Queued Workspace retention.' },
  'retention.complete': { reasonRequired: false, changeSummary: 'Completed Workspace retention.' },
  'retention.fail': { reasonRequired: false, changeSummary: 'Workspace retention failed.' },
  'retention.retry': { reasonRequired: false, changeSummary: 'Retried Workspace retention.' },
  'source_access.reduce': { reasonRequired: true, changeSummary: 'Reduced Source Access.' },
  'workspace.delete': { reasonRequired: true, changeSummary: 'Deleted a Workspace.' },
  'workspace.setup': { reasonRequired: false, changeSummary: 'Started Workspace setup.' },
  'workspace.setup.confirm': { reasonRequired: false, changeSummary: 'Completed Workspace setup.' },
  'workspace.recovery': { reasonRequired: false, changeSummary: 'Recovered Workspace access.' },
  'workspace.login': { reasonRequired: false, changeSummary: 'Signed in to a Workspace.' },
  'notification.create': { reasonRequired: false, changeSummary: 'Created a personal Notification.' },
} as const;

export type WorkspaceProtectedAction = keyof typeof WORKSPACE_MUTATION_POLICIES;

export function workspaceMutationRequiresReason(action: WorkspaceProtectedAction): boolean {
  return WORKSPACE_MUTATION_POLICIES[action].reasonRequired;
}

function snapshotEnvelope(value: unknown): Record<string, unknown> {
  return { value: sanitizeWorkspaceSnapshot(value ?? null) };
}

function requireText(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required for a Workspace event.`);
  return normalized;
}

export async function appendWorkspaceAuditEvent(
  engine: WorkspaceEventEngine,
  event: WorkspaceAuditEvent,
): Promise<string> {
  const eventId = randomUUID();
  const reason = event.reason?.trim() ? sanitizeWorkspaceText(event.reason.trim()) : null;
  const reasonRequired = workspaceMutationRequiresReason(event.action);
  if (event.outcome === 'succeeded' && reasonRequired && !reason) {
    throw new Error('A reason is required for this protected Workspace mutation.');
  }

  // Raw JS objects are bound directly to ::jsonb. Never stringify them: the
  // Postgres engine would persist a JSON string scalar instead of an object.
  await engine.executeRaw(
    `INSERT INTO workspace_audit_events (
       event_id, actor_kind, actor_id, action, target_type, target_id,
       outcome, reason, before_state, after_state, request_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11)`,
    [
      eventId,
      event.actor.kind,
      requireText(event.actor.id, 'Audit actor ID'),
      requireText(event.action, 'Audit action'),
      requireText(event.target.type, 'Audit target type'),
      requireText(event.target.id, 'Audit target ID'),
      event.outcome,
      reason,
      snapshotEnvelope(event.before),
      snapshotEnvelope(event.after),
      requireText(event.requestId, 'Audit request ID'),
    ],
  );
  return eventId;
}

export async function appendWorkspaceChangeEvent(
  engine: WorkspaceEventEngine,
  event: {
    actor: { kind: WorkspaceActorKind | 'system'; id: string };
    resource: { type: string; id: string };
    action: WorkspaceProtectedAction;
    requestId: string;
    workspaceId?: string;
  },
): Promise<string> {
  const eventId = randomUUID();
  let workspaceId = event.workspaceId?.trim() || null;
  if (!workspaceId && event.resource.type === 'workspace') workspaceId = event.resource.id;
  const resourceScopeQueries: Record<string, string> = {
    source: 'SELECT workspace_id FROM workspace_sources WHERE source_id=$1',
    attention_item: 'SELECT workspace_id FROM workspace_attention_items WHERE item_id=$1',
    agent: 'SELECT workspace_id FROM workspace_agents WHERE agent_id=$1',
    background_operation: 'SELECT workspace_id FROM workspace_background_operations WHERE operation_id=$1',
    workspace_export: 'SELECT workspace_id FROM workspace_exports WHERE export_id=$1',
    membership: 'SELECT workspace_id FROM workspace_memberships WHERE membership_id=$1',
    invitation: 'SELECT workspace_id FROM workspace_invitations WHERE invitation_id=$1',
  };
  const scopeQuery = resourceScopeQueries[event.resource.type];
  if (!workspaceId && scopeQuery) {
    const rows = await engine.executeRaw<{ workspace_id: string }>(scopeQuery, [event.resource.id]);
    workspaceId = rows[0]?.workspace_id ?? null;
  }
  if (!workspaceId && event.actor.kind === 'member') {
    const rows = await engine.executeRaw<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_memberships WHERE membership_id=$1',
      [event.actor.id],
    );
    workspaceId = rows[0]?.workspace_id ?? null;
  }
  if (!workspaceId) {
    const workspaces = await engine.executeRaw<{ workspace_id: string }>(
      'SELECT workspace_id FROM workspace_workspaces ORDER BY workspace_id LIMIT 2',
    );
    // A missing or ambiguous scope remains null, which makes live delivery
    // fail closed while retaining the immutable diagnostic record.
    workspaceId = workspaces.length === 1 ? workspaces[0]!.workspace_id : null;
  }
  const values = [
    eventId,
    workspaceId,
    event.actor.kind,
    requireText(event.actor.id, 'Change actor ID'),
    requireText(event.resource.type, 'Change resource type'),
    requireText(event.resource.id, 'Change resource ID'),
    WORKSPACE_MUTATION_POLICIES[event.action].changeSummary,
    requireText(event.requestId, 'Change request ID'),
  ];
  if (workspaceId) {
    const inserted = await engine.executeRaw<{ event_id: string }>(
      `WITH locked_workspace AS (
         SELECT workspace_id FROM workspace_workspaces WHERE workspace_id=$2 FOR UPDATE
       )
       INSERT INTO workspace_change_events (
         event_id, workspace_id, actor_kind, actor_id, resource_type, resource_id, summary, request_id
       )
       SELECT $1, workspace_id, $3, $4, $5, $6, $7, $8 FROM locked_workspace
       RETURNING event_id`,
      values,
    );
    if (!inserted[0]) throw new Error('workspace_change_event_scope_missing');
  } else {
    await engine.executeRaw(
      `INSERT INTO workspace_change_events (
         event_id, workspace_id, actor_kind, actor_id, resource_type, resource_id, summary, request_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      values,
    );
  }
  return eventId;
}

/**
 * Execute one protected mutation and append evidence for either outcome.
 * Change Events are emitted only after successful material product changes;
 * ordinary reads never pass through this seam.
 */
export async function runProtectedWorkspaceMutation<T>(
  engine: WorkspaceMutationEngine,
  event: WorkspaceProtectedMutation,
  mutate: (transaction: WorkspaceEventEngine) => Promise<T>,
  options: {
    isMaterialChange?: (result: T) => boolean;
    auditNonMaterial?: boolean;
    eventForResult?: (result: T) => Pick<WorkspaceProtectedMutation, 'before' | 'after'>;
  } = {},
): Promise<T> {
  try {
    return await engine.transaction(async transaction => {
      if (workspaceMutationRequiresReason(event.action) && !event.reason?.trim()) {
        throw new Error('A reason is required for this protected Workspace mutation.');
      }
      const result = await mutate(transaction);
      const auditEvent = options.eventForResult ? { ...event, ...options.eventForResult(result) } : event;
      if (options.isMaterialChange && !options.isMaterialChange(result)) {
        if (options.auditNonMaterial) {
          await appendWorkspaceAuditEvent(transaction, { ...auditEvent, outcome: 'succeeded' });
        }
        return result;
      }
      await appendWorkspaceAuditEvent(transaction, { ...auditEvent, outcome: 'succeeded' });
      await appendWorkspaceChangeEvent(transaction, {
        actor: event.actor,
        resource: event.target,
        action: event.action,
        requestId: event.requestId,
      });
      return result;
    });
  } catch (error) {
    // Missing-reason attempts are still evidence. Failed Audit Events may
    // omit the reason because the protected mutation never committed.
    await appendWorkspaceAuditEvent(engine, { ...event, outcome: 'failed' });
    throw error;
  }
}
