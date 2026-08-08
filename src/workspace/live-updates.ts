import type { BrainEngine } from '../core/engine.ts';
import { resolvePrincipalSourceAccess } from './source-access.ts';

type LiveUpdateEngine = Pick<BrainEngine, 'executeRaw'>;

export type WorkspaceLiveUpdateResource =
  | 'access'
  | 'agents'
  | 'attention'
  | 'members'
  | 'notifications'
  | 'operations'
  | 'sources'
  | 'workspace';

export interface WorkspaceLiveUpdate {
  id: string;
  cursor: string;
  resource: WorkspaceLiveUpdateResource;
  occurred_at: string;
}

export interface WorkspaceLiveUpdateBatch {
  cursor: string;
  events: WorkspaceLiveUpdate[];
}

interface ChangeEventRow {
  event_sequence: string | number | bigint;
  event_id: string;
  resource_type: string;
  resource_id: string;
  occurred_at: string | Date;
}

interface Viewer {
  workspaceId: string;
  membershipId: string;
  role: 'administrator' | 'member';
}

export class WorkspaceLiveUpdateError extends Error {
  constructor(readonly code: 'invalid_live_update_cursor' | 'unauthorized') {
    super(code);
  }
}

const MAX_EVENT_SEQUENCE = 9_223_372_036_854_775_807n;

function parseCursor(cursor: string | undefined): string | 'latest' {
  if (cursor === undefined || cursor === '') return '0';
  if (cursor === 'latest') return cursor;
  if (!/^\d+$/.test(cursor)) throw new WorkspaceLiveUpdateError('invalid_live_update_cursor');
  const normalized = cursor.replace(/^0+(?=\d)/, '');
  if (normalized.length > 19 || BigInt(normalized) > MAX_EVENT_SEQUENCE) {
    throw new WorkspaceLiveUpdateError('invalid_live_update_cursor');
  }
  return normalized;
}

async function currentViewer(engine: LiveUpdateEngine, request: Viewer): Promise<Viewer> {
  const rows = await engine.executeRaw<{ workspace_id: string; role: string }>(
    `SELECT workspace_id, role FROM workspace_memberships
      WHERE membership_id=$1 AND workspace_id=$2 AND status='active'`,
    [request.membershipId, request.workspaceId],
  );
  if (!rows[0] || (rows[0].role !== 'administrator' && rows[0].role !== 'member')) {
    throw new WorkspaceLiveUpdateError('unauthorized');
  }
  return {
    workspaceId: rows[0].workspace_id,
    membershipId: request.membershipId,
    role: rows[0].role,
  };
}

async function sourceIdsForViewer(
  engine: LiveUpdateEngine,
  viewer: Viewer,
  eventSourceIds: string[],
): Promise<Set<string>> {
  const sources = await engine.executeRaw<{ source_id: string }>(
    'SELECT source_id FROM workspace_sources WHERE workspace_id=$1 ORDER BY source_id',
    [viewer.workspaceId],
  );
  const candidateSourceIds = [...new Set([
    ...sources.map(source => source.source_id),
    ...eventSourceIds,
  ])];
  const access = await resolvePrincipalSourceAccess(
    engine,
    { remote: true, principal: { kind: 'member', id: viewer.membershipId } },
    candidateSourceIds,
  );
  return new Set(access.kind === 'sources' ? access.sourceIds : []);
}

interface ProjectionContext {
  memberships: Set<string>;
  attentionItems: Map<string, { resource_type: string; resource_id: string }>;
  agents: Set<string>;
  invitations: Set<string>;
  notifications: Map<string, { source_id: string | null }>;
  operations: Set<string>;
}

const resourceIds = (rows: ChangeEventRow[], type: string): string[] => [
  ...new Set(rows.filter(row => row.resource_type === type).map(row => row.resource_id)),
];

async function loadProjectionContext(
  engine: LiveUpdateEngine,
  viewer: Viewer,
  rows: ChangeEventRow[],
): Promise<ProjectionContext> {
  const membershipIds = resourceIds(rows, 'membership');
  const attentionIds = resourceIds(rows, 'attention_item');
  const agentIds = resourceIds(rows, 'agent');
  const invitationIds = viewer.role === 'administrator' ? resourceIds(rows, 'invitation') : [];
  const notificationIds = resourceIds(rows, 'notification');
  const operationIds = viewer.role === 'administrator' ? resourceIds(rows, 'background_operation') : [];
  const [memberships, attentionItems, agents, invitations, notifications, operations] = await Promise.all([
    membershipIds.length === 0 ? [] : engine.executeRaw<{ membership_id: string }>(
      'SELECT membership_id FROM workspace_memberships WHERE workspace_id=$1 AND membership_id=ANY($2::text[])',
      [viewer.workspaceId, membershipIds],
    ),
    attentionIds.length === 0 ? [] : engine.executeRaw<{ item_id: string; resource_type: string; resource_id: string }>(
      `SELECT item_id, resource_type, resource_id FROM workspace_attention_items
        WHERE workspace_id=$1 AND item_id=ANY($2::text[])`,
      [viewer.workspaceId, attentionIds],
    ),
    agentIds.length === 0 ? [] : engine.executeRaw<{ agent_id: string }>(
      'SELECT agent_id FROM workspace_agents WHERE workspace_id=$1 AND agent_id=ANY($2::text[])',
      [viewer.workspaceId, agentIds],
    ),
    invitationIds.length === 0 ? [] : engine.executeRaw<{ invitation_id: string }>(
      'SELECT invitation_id FROM workspace_invitations WHERE workspace_id=$1 AND invitation_id=ANY($2::text[])',
      [viewer.workspaceId, invitationIds],
    ),
    notificationIds.length === 0 ? [] : engine.executeRaw<{ notification_id: string; source_id: string | null }>(
      `SELECT notification_id, source_id FROM workspace_notifications
        WHERE workspace_id=$1 AND recipient_membership_id=$2
          AND notification_id=ANY($3::text[]) AND archived_at IS NULL AND expires_at > now()`,
      [viewer.workspaceId, viewer.membershipId, notificationIds],
    ),
    operationIds.length === 0 ? [] : engine.executeRaw<{ operation_id: string }>(
      'SELECT operation_id FROM workspace_background_operations WHERE workspace_id=$1 AND operation_id=ANY($2::text[])',
      [viewer.workspaceId, operationIds],
    ),
  ]);
  return {
    memberships: new Set(memberships.map(row => row.membership_id)),
    attentionItems: new Map(attentionItems.map(row => [row.item_id, row])),
    agents: new Set(agents.map(row => row.agent_id)),
    invitations: new Set(invitations.map(row => row.invitation_id)),
    notifications: new Map(notifications.map(row => [row.notification_id, row])),
    operations: new Set(operations.map(row => row.operation_id)),
  };
}

function projectEvent(
  viewer: Viewer,
  accessibleSourceIds: Set<string>,
  context: ProjectionContext,
  row: ChangeEventRow,
): WorkspaceLiveUpdateResource | null {
  if (row.resource_type === 'source') {
    // A deletion removes the Source before its immutable event is appended.
    // Event Source IDs are included in the access-policy candidates, so an
    // All policy can still receive the safe invalidation while Specific/None
    // remain fail-closed once their grant has gone.
    return accessibleSourceIds.has(row.resource_id) ? 'sources' : null;
  }
  if (row.resource_type === 'membership') {
    if (!context.memberships.has(row.resource_id)) return null;
    if (row.resource_id === viewer.membershipId) return 'access';
    return viewer.role === 'administrator' ? 'members' : null;
  }
  if (row.resource_type === 'attention_item') {
    const item = context.attentionItems.get(row.resource_id);
    if (!item) return null;
    const sourceId = item.resource_type === 'source'
      ? item.resource_id
      : item.resource_type === 'page'
        ? item.resource_id.split(':', 1)[0]
        : null;
    if (sourceId) return accessibleSourceIds.has(sourceId) ? 'attention' : null;
    return viewer.role === 'administrator' ? 'attention' : null;
  }
  if (row.resource_type === 'agent') {
    return context.agents.has(row.resource_id) ? 'agents' : null;
  }
  if (row.resource_type === 'workspace') {
    return viewer.role === 'administrator' && row.resource_id === viewer.workspaceId ? 'workspace' : null;
  }
  if (row.resource_type === 'invitation') {
    return viewer.role === 'administrator' && context.invitations.has(row.resource_id) ? 'members' : null;
  }
  if (row.resource_type === 'background_operation') {
    return viewer.role === 'administrator' && context.operations.has(row.resource_id) ? 'operations' : null;
  }
  if (row.resource_type === 'notification') {
    const notification = context.notifications.get(row.resource_id);
    if (!notification) return null;
    return !notification.source_id || accessibleSourceIds.has(notification.source_id) ? 'notifications' : null;
  }
  return null;
}

/**
 * Return the safe invalidation projection for one currently authenticated
 * Member. The response cursor advances over denied rows so a hidden event can
 * neither leak through repeated polling nor prevent later authorized events.
 */
export async function listWorkspaceLiveUpdates(
  engine: LiveUpdateEngine,
  request: Viewer & { cursor?: string; limit?: number },
): Promise<WorkspaceLiveUpdateBatch> {
  const cursor = parseCursor(request.cursor);
  const viewer = await currentViewer(engine, request);
  if (cursor === 'latest') {
    const latest = await engine.executeRaw<{ cursor: string }>(
      `SELECT COALESCE(MAX(event_sequence),0)::text AS cursor
         FROM workspace_change_events WHERE workspace_id=$1`,
      [viewer.workspaceId],
    );
    return { cursor: latest[0]?.cursor ?? '0', events: [] };
  }
  const limit = Math.min(Math.max(request.limit ?? 100, 1), 200);
  const rows = await engine.executeRaw<ChangeEventRow>(
    `SELECT event_sequence, event_id, resource_type, resource_id, occurred_at
       FROM workspace_change_events
      WHERE workspace_id=$1 AND event_sequence > $2::bigint
      ORDER BY event_sequence
      LIMIT $3`,
    [viewer.workspaceId, cursor, limit],
  );
  if (rows.length === 0) return { cursor, events: [] };

  const accessibleSourceIds = await sourceIdsForViewer(
    engine,
    viewer,
    rows.filter(row => row.resource_type === 'source').map(row => row.resource_id),
  );
  const context = await loadProjectionContext(engine, viewer, rows);
  const events: WorkspaceLiveUpdate[] = [];
  for (const row of rows) {
    const resource = projectEvent(viewer, accessibleSourceIds, context, row);
    if (!resource) continue;
    events.push({
      id: row.event_id,
      cursor: String(row.event_sequence),
      resource,
      occurred_at: new Date(row.occurred_at).toISOString(),
    });
  }
  return { cursor: String(rows.at(-1)!.event_sequence), events };
}
