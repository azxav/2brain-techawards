import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { appendWorkspaceChangeEvent } from './events.ts';
import { resolvePrincipalSourceAccess } from './source-access.ts';

type NotificationEngine = Pick<BrainEngine, 'executeRaw'>;

export type WorkspaceNotificationEventType =
  | 'attention_assigned'
  | 'attention_condition_changed'
  | 'attention_verification_outcome'
  | 'background_operation_outcome'
  | 'membership_access_changed';

export type WorkspaceNotificationTargetType = 'attention_item' | 'background_operation' | 'membership';

export interface WorkspaceNotificationView {
  id: string;
  eventType: WorkspaceNotificationEventType;
  recipientMembershipId: string;
  target: { type: WorkspaceNotificationTargetType; id: string };
  summary: string;
  unread: boolean;
  archived: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceNotificationPage {
  items: WorkspaceNotificationView[];
  nextCursor: string | null;
}

export class WorkspaceNotificationError extends Error {
  constructor(readonly code:
    | 'invalid_notification_cursor'
    | 'invalid_notification_limit'
    | 'invalid_notification_read_state'
    | 'notification_not_found'
    | 'unauthorized') {
    super(code);
  }
}

interface NotificationRow {
  notification_sequence: string | number | bigint;
  notification_id: string;
  event_type: WorkspaceNotificationEventType;
  recipient_membership_id: string;
  target_type: WorkspaceNotificationTargetType;
  target_id: string;
  source_id: string | null;
  summary: string;
  read_at: string | Date | null;
  archived_at: string | Date | null;
  created_at: string | Date;
  expires_at: string | Date;
}

const EVENT_SUMMARIES: Record<WorkspaceNotificationEventType, string> = {
  attention_assigned: 'An Attention Item was assigned to you.',
  attention_condition_changed: 'A condition you own changed.',
  attention_verification_outcome: 'A requested verification outcome is ready.',
  background_operation_outcome: 'A Background Operation you initiated finished.',
  membership_access_changed: 'Your Workspace access changed.',
};

function toView(row: NotificationRow): WorkspaceNotificationView {
  return {
    id: row.notification_id,
    eventType: row.event_type,
    recipientMembershipId: row.recipient_membership_id,
    target: { type: row.target_type, id: row.target_id },
    summary: row.summary,
    unread: row.read_at === null,
    archived: row.archived_at !== null,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

async function activeMembership(
  engine: NotificationEngine,
  workspaceId: string,
  membershipId: string,
): Promise<boolean> {
  const rows = await engine.executeRaw<{ membership_id: string }>(
    `SELECT membership_id FROM workspace_memberships
      WHERE workspace_id=$1 AND membership_id=$2 AND status='active'`,
    [workspaceId, membershipId],
  );
  return rows.length === 1;
}

async function canAccessSource(
  engine: NotificationEngine,
  membershipId: string,
  sourceId: string | null,
): Promise<boolean> {
  if (!sourceId) return true;
  const access = await resolvePrincipalSourceAccess(
    engine,
    { remote: true, principal: { kind: 'member', id: membershipId } },
    [sourceId],
  );
  return access.kind === 'sources' && access.sourceIds.includes(sourceId);
}

async function accessibleSourceIds(
  engine: NotificationEngine,
  workspaceId: string,
  membershipId: string,
): Promise<string[]> {
  const sources = await engine.executeRaw<{ source_id: string }>(
    'SELECT source_id FROM workspace_sources WHERE workspace_id=$1 ORDER BY source_id',
    [workspaceId],
  );
  const access = await resolvePrincipalSourceAccess(
    engine,
    { remote: true, principal: { kind: 'member', id: membershipId } },
    sources.map(source => source.source_id),
  );
  return access.kind === 'sources' ? access.sourceIds : [];
}

function sourceIdForResource(resourceType: string, resourceId: string): string | null {
  if (resourceType === 'source') return resourceId;
  if (resourceType === 'page') return resourceId.split(':', 1)[0] || null;
  return null;
}

async function resolveRecipientAndSource(
  engine: NotificationEngine,
  input: {
    workspaceId: string;
    eventType: WorkspaceNotificationEventType;
    target: { type: WorkspaceNotificationTargetType; id: string };
    actorMembershipId?: string;
  },
): Promise<{ recipientMembershipId: string; sourceId: string | null } | null> {
  if (input.target.type === 'attention_item') {
    if (!input.eventType.startsWith('attention_')) return null;
    const rows = await engine.executeRaw<{
      assignee_membership_id: string | null;
      resource_type: string;
      resource_id: string;
    }>(
      `SELECT assignee_membership_id, resource_type, resource_id
         FROM workspace_attention_items WHERE workspace_id=$1 AND item_id=$2`,
      [input.workspaceId, input.target.id],
    );
    const item = rows[0];
    if (!item) return null;
    const recipientMembershipId = input.eventType === 'attention_verification_outcome'
      ? input.actorMembershipId?.trim()
      : item.assignee_membership_id;
    if (!recipientMembershipId) return null;
    return {
      recipientMembershipId,
      sourceId: sourceIdForResource(item.resource_type, item.resource_id),
    };
  }
  if (input.target.type === 'background_operation') {
    if (input.eventType !== 'background_operation_outcome') return null;
    const rows = await engine.executeRaw<{
      initiator_membership_id: string;
      resource_type: string;
      resource_id: string;
    }>(
      `SELECT initiator_membership_id, resource_type, resource_id
         FROM workspace_background_operations WHERE workspace_id=$1 AND operation_id=$2`,
      [input.workspaceId, input.target.id],
    );
    const operation = rows[0];
    if (!operation) return null;
    return {
      recipientMembershipId: operation.initiator_membership_id,
      sourceId: sourceIdForResource(operation.resource_type, operation.resource_id),
    };
  }
  if (input.target.type === 'membership') {
    if (input.eventType !== 'membership_access_changed') return null;
    return { recipientMembershipId: input.target.id, sourceId: null };
  }
  return null;
}

export async function createWorkspaceNotificationForEvent(
  engine: NotificationEngine,
  input: {
    workspaceId: string;
    eventKey: string;
    eventType: WorkspaceNotificationEventType;
    target: { type: WorkspaceNotificationTargetType; id: string };
    actorMembershipId?: string;
  },
): Promise<WorkspaceNotificationView | null> {
  const eventKey = input.eventKey.trim();
  if (!eventKey || eventKey.length > 200) throw new Error('invalid_notification_event_key');
  const eventKeyHash = createHash('sha256').update(eventKey).digest('hex');
  const targetId = input.target.id.trim();
  if (!targetId) throw new Error('invalid_notification_target');
  const resolved = await resolveRecipientAndSource(engine, { ...input, target: { ...input.target, id: targetId } });
  if (!resolved) return null;
  if (!await activeMembership(engine, input.workspaceId, resolved.recipientMembershipId)) return null;
  if (!await canAccessSource(engine, resolved.recipientMembershipId, resolved.sourceId)) return null;

  const notificationId = randomUUID();
  const rows = await engine.executeRaw<NotificationRow>(
    `INSERT INTO workspace_notifications (
       notification_id, workspace_id, recipient_membership_id, event_key,
       event_type, target_type, target_id, source_id, summary
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (workspace_id, recipient_membership_id, event_key)
     DO NOTHING
     RETURNING *`,
    [
      notificationId, input.workspaceId, resolved.recipientMembershipId, eventKeyHash,
      input.eventType, input.target.type, targetId, resolved.sourceId, EVENT_SUMMARIES[input.eventType],
    ],
  );
  if (rows[0]) {
    await appendWorkspaceChangeEvent(engine, {
      actor: { kind: 'system', id: 'workspace-notifications' },
      action: 'notification.create',
      resource: { type: 'notification', id: notificationId },
      requestId: `notification:${notificationId}`,
      workspaceId: input.workspaceId,
    });
    return toView(rows[0]);
  }
  const existing = await engine.executeRaw<NotificationRow>(
    `SELECT * FROM workspace_notifications
      WHERE workspace_id=$1 AND recipient_membership_id=$2 AND event_key=$3`,
    [input.workspaceId, resolved.recipientMembershipId, eventKeyHash],
  );
  return existing[0] ? toView(existing[0]) : null;
}

export function notifyWorkspaceBackgroundOperationOutcome(
  engine: NotificationEngine,
  input: { workspaceId: string; operationId: string; requestId: string },
): Promise<WorkspaceNotificationView | null> {
  return createWorkspaceNotificationForEvent(engine, {
    workspaceId: input.workspaceId,
    eventKey: `background-operation-outcome:${input.operationId}:${input.requestId}`,
    eventType: 'background_operation_outcome',
    target: { type: 'background_operation', id: input.operationId },
  });
}

export async function listWorkspaceNotifications(
  engine: NotificationEngine,
  request: { workspaceId: string; membershipId: string; cursor?: string; limit?: number },
): Promise<WorkspaceNotificationPage> {
  if (!await activeMembership(engine, request.workspaceId, request.membershipId)) {
    throw new WorkspaceNotificationError('unauthorized');
  }
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1)) {
    throw new WorkspaceNotificationError('invalid_notification_limit');
  }
  const limit = Math.min(Math.max(request.limit ?? 50, 1), 100);
  const cursor = request.cursor?.trim();
  if (cursor && !/^\d+$/.test(cursor)) throw new WorkspaceNotificationError('invalid_notification_cursor');
  const sourceIds = await accessibleSourceIds(engine, request.workspaceId, request.membershipId);
  const rows = await engine.executeRaw<NotificationRow>(
    `SELECT * FROM workspace_notifications
      WHERE workspace_id=$1 AND recipient_membership_id=$2
        AND archived_at IS NULL AND expires_at > now()
        AND (source_id IS NULL OR source_id=ANY($3::text[]))
        AND ($4::bigint IS NULL OR notification_sequence < $4::bigint)
      ORDER BY notification_sequence DESC LIMIT $5`,
    [request.workspaceId, request.membershipId, sourceIds, cursor ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  return {
    items: page.map(toView),
    nextCursor: rows.length > limit ? String(page.at(-1)!.notification_sequence) : null,
  };
}

async function requireAuthorizedNotification(
  engine: NotificationEngine,
  request: { workspaceId: string; membershipId: string; notificationId: string },
): Promise<NotificationRow> {
  if (!await activeMembership(engine, request.workspaceId, request.membershipId)) {
    throw new WorkspaceNotificationError('notification_not_found');
  }
  const rows = await engine.executeRaw<NotificationRow>(
    `SELECT * FROM workspace_notifications
      WHERE workspace_id=$1 AND recipient_membership_id=$2 AND notification_id=$3
        AND archived_at IS NULL AND expires_at > now()`,
    [request.workspaceId, request.membershipId, request.notificationId],
  );
  const row = rows[0];
  if (!row || !await canAccessSource(engine, request.membershipId, row.source_id)) {
    throw new WorkspaceNotificationError('notification_not_found');
  }
  return row;
}

export async function countWorkspaceUnreadNotifications(
  engine: NotificationEngine,
  request: { workspaceId: string; membershipId: string },
): Promise<number> {
  if (!await activeMembership(engine, request.workspaceId, request.membershipId)) {
    throw new WorkspaceNotificationError('unauthorized');
  }
  const sourceIds = await accessibleSourceIds(engine, request.workspaceId, request.membershipId);
  const rows = await engine.executeRaw<{ count: string | number | bigint }>(
    `SELECT count(*)::text AS count FROM workspace_notifications
      WHERE workspace_id=$1 AND recipient_membership_id=$2
        AND read_at IS NULL AND archived_at IS NULL AND expires_at > now()
        AND (source_id IS NULL OR source_id=ANY($3::text[]))`,
    [request.workspaceId, request.membershipId, sourceIds],
  );
  return Number(rows[0]?.count ?? 0);
}

export async function setWorkspaceNotificationRead(
  engine: NotificationEngine,
  request: { workspaceId: string; membershipId: string; notificationId: string; read: boolean },
): Promise<WorkspaceNotificationView> {
  await requireAuthorizedNotification(engine, request);
  const rows = await engine.executeRaw<NotificationRow>(
    `UPDATE workspace_notifications SET read_at=$4
      WHERE workspace_id=$1 AND recipient_membership_id=$2 AND notification_id=$3
      RETURNING *`,
    [request.workspaceId, request.membershipId, request.notificationId, request.read ? new Date() : null],
  );
  if (!rows[0]) throw new WorkspaceNotificationError('notification_not_found');
  return toView(rows[0]);
}

export async function archiveWorkspaceNotification(
  engine: NotificationEngine,
  request: { workspaceId: string; membershipId: string; notificationId: string },
): Promise<WorkspaceNotificationView> {
  await requireAuthorizedNotification(engine, request);
  const rows = await engine.executeRaw<NotificationRow>(
    `UPDATE workspace_notifications SET archived_at=now()
      WHERE workspace_id=$1 AND recipient_membership_id=$2 AND notification_id=$3
      RETURNING *`,
    [request.workspaceId, request.membershipId, request.notificationId],
  );
  if (!rows[0]) throw new WorkspaceNotificationError('notification_not_found');
  return toView(rows[0]);
}

export async function purgeExpiredWorkspaceNotifications(
  engine: NotificationEngine,
  request: { limit?: number } = {},
): Promise<number> {
  const limit = Math.min(Math.max(request.limit ?? 500, 1), 1_000);
  const rows = await engine.executeRaw<{ notification_id: string }>(
    `WITH expired AS (
       SELECT notification_id FROM workspace_notifications
        WHERE expires_at <= now()
        ORDER BY expires_at, notification_sequence
        LIMIT $1
     )
     DELETE FROM workspace_notifications notification
      USING expired
      WHERE notification.notification_id=expired.notification_id
      RETURNING notification.notification_id`,
    [limit],
  );
  return rows.length;
}
