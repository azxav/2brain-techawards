import type { BrainEngine } from '../core/engine.ts';
import { listWorkspaceAttentionItems, type WorkspaceAttentionItemView } from './attention.ts';
import { resolvePrincipalSourceAccess } from './source-access.ts';
import {
  listBackgroundOperations,
  listManagedGitSources,
  type BackgroundOperationView,
  type ManagedGitSourceView,
} from './source-provisioning.ts';

type HomeEngine = Pick<BrainEngine, 'executeRaw'>;

export interface WorkspaceHomeViewer {
  membershipId: string;
  role: 'administrator' | 'member';
}

export interface WorkspaceHomeEvidenceLink {
  href: string;
  label: string;
}

export interface WorkspaceHomeTrustStatement {
  kind: 'source_currentness' | 'attention' | 'operation';
  state: 'current' | 'due_soon' | 'stale' | 'unknown' | 'needs_attention' | 'active';
  summary: string;
  evidence: WorkspaceHomeEvidenceLink;
}

export interface WorkspaceHomeAttentionPreview {
  itemId: string;
  category: WorkspaceAttentionItemView['category'];
  summary: string;
  status: 'open' | 'in_progress';
  assignee: string | null;
  nextAction: string;
  evidence: WorkspaceHomeEvidenceLink;
}

export interface WorkspaceHomeOperationPreview {
  operationId: string;
  type: BackgroundOperationView['type'];
  state: 'queued' | 'running' | 'failed';
  progress: number;
  updatedAt: string;
  evidence: WorkspaceHomeEvidenceLink;
}

export interface WorkspaceHomeRecentChange {
  eventId: string;
  resourceType: 'source' | 'page' | 'knowledge' | 'agent' | 'attention_item' | 'membership';
  summary: string;
  occurredAt: string;
  evidence: WorkspaceHomeEvidenceLink;
}

export interface WorkspaceHomeView {
  generatedAt: string;
  trustSummary: WorkspaceHomeTrustStatement[];
  attention: WorkspaceHomeAttentionPreview[];
  operations: WorkspaceHomeOperationPreview[];
  recentChanges: WorkspaceHomeRecentChange[];
  empty: {
    attention: string | null;
    operations: string | null;
    recentChanges: string | null;
  };
}

interface ChangeEventRow {
  event_id: string;
  resource_type: string;
  resource_id: string;
  summary: string;
  occurred_at: string | Date;
}

const MATERIAL_HOME_RESOURCES = new Set([
  'source', 'page', 'knowledge', 'agent', 'attention_item', 'membership',
]);

const ATTENTION_CATEGORY_PRIORITY: Record<WorkspaceAttentionItemView['category'], number> = {
  agent_access: 0,
  automation_health: 1,
  source_health: 2,
  knowledge_quality: 3,
};

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function sourceEvidence(
  sourceId: string,
  role: WorkspaceHomeViewer['role'],
  archived = false,
): WorkspaceHomeEvidenceLink {
  return role === 'administrator'
    ? {
        href: `/app/settings/sources${archived ? '?state=archived' : ''}#source-${encodeURIComponent(sourceId)}`,
        label: 'View Source evidence',
      }
    : { href: `/app/search?source=${encodeURIComponent(sourceId)}`, label: 'Open permitted Source search' };
}

function freshnessSummary(source: ManagedGitSourceView): string {
  const cadence = source.expectedCadence;
  switch (source.freshness.reason) {
    case 'known_unsynchronized_changes':
      return `${source.name} is stale. Known Source changes have not been synchronized.`;
    case 'requested_verification_failed':
      return `${source.name} is stale. Its latest requested verification failed.`;
    case 'manual_verification_succeeded':
      return `${source.name} is current. Its latest manual verification succeeded.`;
    case 'verification_overdue':
      return `${source.name} is stale. Its verification is overdue for its ${cadence} cadence.`;
    case 'verification_due_soon':
      return `${source.name} is due for verification soon under its ${cadence} cadence.`;
    case 'verified_within_cadence':
      return `${source.name} is current. It was verified within its ${cadence} cadence.`;
    case 'insufficient_verification_evidence':
      return `${source.name} has not supplied enough verification evidence to establish currentness.`;
  }
}

function sourceTrustStatement(
  source: ManagedGitSourceView,
  role: WorkspaceHomeViewer['role'],
): WorkspaceHomeTrustStatement {
  return {
    kind: 'source_currentness',
    state: source.freshness.state,
    summary: freshnessSummary(source),
    evidence: sourceEvidence(source.sourceId, role),
  };
}

function attentionPreview(item: WorkspaceAttentionItemView): WorkspaceHomeAttentionPreview {
  return {
    itemId: item.itemId,
    category: item.category,
    summary: item.summary,
    status: item.status as 'open' | 'in_progress',
    assignee: item.assignee?.email ?? null,
    nextAction: item.status === 'in_progress' ? 'Continue investigation' : 'Review evidence',
    evidence: {
      href: `/app/attention?status=all#attention-${encodeURIComponent(item.itemId)}`,
      label: 'View Attention evidence',
    },
  };
}

function operationPreview(
  operation: BackgroundOperationView,
  role: WorkspaceHomeViewer['role'],
): WorkspaceHomeOperationPreview {
  return {
    operationId: operation.operationId,
    type: operation.type,
    state: operation.state as 'queued' | 'running' | 'failed',
    progress: operation.progress,
    updatedAt: iso(operation.updatedAt),
    evidence: role === 'administrator'
      ? {
          href: `/app/settings/operations#operation-${encodeURIComponent(operation.operationId)}`,
          label: 'View Background Operation',
        }
      : {
          href: `/app#operation-${encodeURIComponent(operation.operationId)}`,
          label: 'View authorized Background Operation',
        },
  };
}

function pageEvidence(resourceId: string): WorkspaceHomeEvidenceLink | null {
  const separator = resourceId.indexOf(':');
  if (separator <= 0 || separator === resourceId.length - 1) return null;
  const sourceId = resourceId.slice(0, separator);
  const slug = resourceId.slice(separator + 1);
  return {
    href: `/app/knowledge/${encodeURIComponent(sourceId)}/${encodeURIComponent(slug)}`,
    label: 'View Page evidence',
  };
}

function recentChangeEvidence(
  row: ChangeEventRow,
  viewer: WorkspaceHomeViewer,
  archivedSourceIds: ReadonlySet<string>,
): WorkspaceHomeEvidenceLink | null {
  if (row.resource_type === 'source') {
    return sourceEvidence(row.resource_id, viewer.role, archivedSourceIds.has(row.resource_id));
  }
  if (row.resource_type === 'page' || row.resource_type === 'knowledge') return pageEvidence(row.resource_id);
  if (row.resource_type === 'agent') {
    return { href: `/app/agents#agent-${encodeURIComponent(row.resource_id)}`, label: 'View Agent evidence' };
  }
  if (row.resource_type === 'attention_item') {
    return {
      href: `/app/attention?status=all#attention-${encodeURIComponent(row.resource_id)}`,
      label: 'View Attention evidence',
    };
  }
  if (row.resource_type === 'membership') {
    return viewer.role === 'administrator'
      ? { href: `/app/settings/members#membership-${encodeURIComponent(row.resource_id)}`, label: 'View access evidence' }
      : { href: '/app/settings/account', label: 'View your access' };
  }
  return null;
}

function recentChangeSourceId(row: ChangeEventRow): string | null {
  if (row.resource_type === 'source') return row.resource_id;
  if (row.resource_type === 'page' || row.resource_type === 'knowledge') {
    const separator = row.resource_id.indexOf(':');
    return separator > 0 ? row.resource_id.slice(0, separator) : null;
  }
  return null;
}

function attentionSourceId(item: WorkspaceAttentionItemView): string | null {
  if (item.resource.type === 'source') return item.resource.id;
  if (item.resource.type !== 'page') return null;
  const separator = item.resource.id.indexOf(':');
  return separator > 0 ? item.resource.id.slice(0, separator) : null;
}

/**
 * Build Home from currently authorized evidence only. The projection resolves
 * Source Access before it constructs summaries or links, so denied identities,
 * counts, and event text cannot enter the returned object.
 */
export async function getWorkspaceHome(
  engine: HomeEngine,
  request: {
    workspaceId: string;
    viewer: WorkspaceHomeViewer;
    now?: string;
    limit?: number;
  },
): Promise<WorkspaceHomeView> {
  const now = request.now ?? new Date().toISOString();
  const limit = Math.min(Math.max(request.limit ?? 10, 1), 25);
  const sources = await listManagedGitSources(engine, request.workspaceId, now);
  const sourceAccess = request.viewer.role === 'administrator'
    ? { kind: 'sources' as const, sourceIds: sources.map(source => source.sourceId) }
    : await resolvePrincipalSourceAccess(
        engine,
        { remote: true, principal: { kind: 'member', id: request.viewer.membershipId } },
        sources.map(source => source.sourceId),
      );
  const permittedSourceIds = new Set(sourceAccess.kind === 'sources' ? sourceAccess.sourceIds : []);
  const permittedSources = sources.filter(source => permittedSourceIds.has(source.sourceId));

  const [allAttention, allOperations, agents, memberships, workspaceSourceRows] = await Promise.all([
    listWorkspaceAttentionItems(engine, { workspaceId: request.workspaceId, viewer: request.viewer }),
    listBackgroundOperations(engine, request.workspaceId),
    engine.executeRaw<{ agent_id: string }>(
      'SELECT agent_id FROM workspace_agents WHERE workspace_id=$1',
      [request.workspaceId],
    ),
    engine.executeRaw<{ membership_id: string }>(
      'SELECT membership_id FROM workspace_memberships WHERE workspace_id=$1',
      [request.workspaceId],
    ),
    engine.executeRaw<{ source_id: string; archived: boolean }>(
      'SELECT source_id, archived FROM workspace_sources WHERE workspace_id=$1 AND deleted=FALSE',
      [request.workspaceId],
    ),
  ]);

  const visibleAttention = allAttention.filter(item => {
    const sourceId = attentionSourceId(item);
    if (sourceId !== null) return permittedSourceIds.has(sourceId);
    return request.viewer.role === 'administrator';
  });
  const activeAttention = visibleAttention
    .filter(item => item.status === 'open' || item.status === 'in_progress');
  const attention = activeAttention
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === 'in_progress' ? -1 : 1;
      const category = ATTENTION_CATEGORY_PRIORITY[left.category] - ATTENTION_CATEGORY_PRIORITY[right.category];
      if (category !== 0) return category;
      const detected = Date.parse(right.detectedAt) - Date.parse(left.detectedAt);
      return detected || right.itemId.localeCompare(left.itemId);
    })
    .slice(0, limit)
    .map(attentionPreview);
  const permittedAttentionIds = new Set(visibleAttention.map(item => item.itemId));

  const failedSince = Date.parse(now) - 7 * 24 * 60 * 60_000;
  const operationSourceIds = request.viewer.role === 'administrator'
    ? new Set(workspaceSourceRows.map(source => source.source_id))
    : permittedSourceIds;
  const visibleOperations = allOperations
    .filter(operation => operationSourceIds.has(operation.resourceId))
    .filter(operation => operation.state === 'queued'
      || operation.state === 'running'
      || (operation.state === 'failed' && Date.parse(operation.updatedAt) >= failedSince));
  const operations = visibleOperations
    .slice(0, limit)
    .map(operation => operationPreview(operation, request.viewer.role));

  const agentIds = new Set(agents.map(agent => agent.agent_id));
  const membershipIds = new Set(memberships.map(membership => membership.membership_id));
  const visibleMembershipIds = request.viewer.role === 'administrator'
    ? membershipIds
    : new Set([request.viewer.membershipId]);
  const changeRows = await engine.executeRaw<ChangeEventRow>(
    `SELECT event_id, resource_type, resource_id, summary, occurred_at
       FROM workspace_change_events
      WHERE workspace_id=$1 AND (
        (resource_type='source' AND resource_id=ANY($2::text[]))
        OR (resource_type IN ('page','knowledge') AND split_part(resource_id, ':', 1)=ANY($2::text[]))
        OR (resource_type='agent' AND resource_id=ANY($3::text[]))
        OR (resource_type='attention_item' AND resource_id=ANY($4::text[]))
        OR (resource_type='membership' AND resource_id=ANY($5::text[]))
      )
      ORDER BY occurred_at DESC, event_sequence DESC
      LIMIT $6`,
    [
      request.workspaceId,
      [...operationSourceIds],
      [...agentIds],
      [...permittedAttentionIds],
      [...visibleMembershipIds],
      limit,
    ],
  );
  const archivedSourceIds = new Set(
    workspaceSourceRows.filter(source => source.archived).map(source => source.source_id),
  );
  const recentChanges: WorkspaceHomeRecentChange[] = [];
  for (const row of changeRows) {
    if (!MATERIAL_HOME_RESOURCES.has(row.resource_type)) continue;
    const sourceId = recentChangeSourceId(row);
    if (sourceId && !operationSourceIds.has(sourceId)) continue;
    if (row.resource_type === 'agent' && !agentIds.has(row.resource_id)) continue;
    if (row.resource_type === 'attention_item' && !permittedAttentionIds.has(row.resource_id)) continue;
    if (row.resource_type === 'membership') {
      if (!membershipIds.has(row.resource_id)) continue;
      if (request.viewer.role !== 'administrator' && row.resource_id !== request.viewer.membershipId) continue;
    }
    const evidence = recentChangeEvidence(row, request.viewer, archivedSourceIds);
    if (!evidence) continue;
    recentChanges.push({
      eventId: row.event_id,
      resourceType: row.resource_type as WorkspaceHomeRecentChange['resourceType'],
      summary: row.summary,
      occurredAt: iso(row.occurred_at),
      evidence,
    });
    if (recentChanges.length === limit) break;
  }

  const trustSummary = permittedSources.map(source => sourceTrustStatement(source, request.viewer.role));
  if (activeAttention.length > 0) {
    trustSummary.push({
      kind: 'attention',
      state: 'needs_attention',
      summary: `${activeAttention.length} active ${plural(activeAttention.length, 'Attention item')} ${activeAttention.length === 1 ? 'needs' : 'need'} review.`,
      evidence: attention[0]!.evidence,
    });
  }
  const activeOperations = visibleOperations.filter(operation => operation.state === 'queued' || operation.state === 'running');
  const failedOperations = visibleOperations.filter(operation => operation.state === 'failed');
  if (visibleOperations.length > 0) {
    const parts: string[] = [];
    if (activeOperations.length > 0) {
      parts.push(`${activeOperations.length} Background ${plural(activeOperations.length, 'Operation')} ${activeOperations.length === 1 ? 'is' : 'are'} active`);
    }
    if (failedOperations.length > 0) {
      parts.push(`${failedOperations.length} recently ${plural(failedOperations.length, 'failed operation')}`);
    }
    trustSummary.push({
      kind: 'operation',
      state: 'active',
      summary: `${parts.join(' and ')}.`,
      evidence: operations[0]!.evidence,
    });
  }

  return {
    generatedAt: now,
    trustSummary,
    attention,
    operations,
    recentChanges,
    empty: {
      attention: attention.length === 0 ? 'No active Attention needs review.' : null,
      operations: operations.length === 0 ? 'No active or recently failed Background Operations.' : null,
      recentChanges: recentChanges.length === 0 ? 'No recent material changes.' : null,
    },
  };
}
