import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { appendWorkspaceAuditEvent, appendWorkspaceChangeEvent, runProtectedWorkspaceMutation } from './events.ts';
import { createWorkspaceNotificationForEvent } from './notifications.ts';
import { resolvePrincipalSourceAccess } from './source-access.ts';
import { sanitizeWorkspaceText } from './safe-values.ts';
import { EVIDENCE_SQL } from './knowledge.ts';

type Engine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;
type ReadEngine = Pick<BrainEngine, 'executeRaw'>;

export type WorkspaceAttentionCategory =
  | 'source_health'
  | 'knowledge_quality'
  | 'agent_access'
  | 'automation_health';
export type WorkspaceAttentionConditionType =
  | 'source.verification_failure'
  | 'source.synchronization_failure'
  | 'knowledge.missing_evidence'
  | 'agent.repeated_authorization_failure'
  | 'agent.admin_scope_review'
  | 'automation.runtime_stalled'
  | 'automation.operation_failure';
export type WorkspaceAttentionResourceType = 'source' | 'page' | 'agent' | 'runtime' | 'orchestration';
export type WorkspaceAttentionStatus = 'open' | 'in_progress' | 'resolved' | 'dismissed';
export type WorkspaceAttentionAction = 'assign' | 'start_progress' | 'request_resolution' | 'dismiss';

export interface WorkspaceAttentionViewer {
  membershipId: string;
  role: 'administrator' | 'member';
}

export class WorkspaceAttentionError extends Error {
  constructor(readonly code:
    | 'attention_item_not_found'
    | 'attention_status_invalid'
    | 'attention_assignee_not_found'
    | 'attention_viewer_invalid'
    | 'reason_required') {
    super(code);
    this.name = 'WorkspaceAttentionError';
  }
}

/**
 * The pure detection policy: every condition type declares its category, the
 * resource type its Condition Episode dedupes on, and the item summary. The
 * map is closed, so a detector cannot invent a category and Source-specific
 * verification/synchronization failures stay Source health while Automation
 * health remains reserved for orchestration not owned by one Source.
 */
export const WORKSPACE_ATTENTION_CONDITION_POLICY: Record<WorkspaceAttentionConditionType, {
  category: WorkspaceAttentionCategory;
  resourceType: WorkspaceAttentionResourceType;
  summary: string;
}> = {
  'source.verification_failure': { category: 'source_health', resourceType: 'source', summary: 'Source verification is failing.' },
  'source.synchronization_failure': { category: 'source_health', resourceType: 'source', summary: 'Source synchronization is failing.' },
  'knowledge.missing_evidence': { category: 'knowledge_quality', resourceType: 'page', summary: 'Knowledge is missing evidence.' },
  'agent.repeated_authorization_failure': { category: 'agent_access', resourceType: 'agent', summary: 'An Agent is repeatedly failing authorization.' },
  'agent.admin_scope_review': { category: 'agent_access', resourceType: 'agent', summary: 'An Admin-scope Agent requires Administrator review.' },
  'automation.runtime_stalled': { category: 'automation_health', resourceType: 'runtime', summary: 'A workspace runtime role has stalled.' },
  'automation.operation_failure': { category: 'automation_health', resourceType: 'orchestration', summary: 'A background orchestration operation is failing.' },
};

export function workspaceAttentionCategoryFor(conditionType: WorkspaceAttentionConditionType): WorkspaceAttentionCategory {
  return WORKSPACE_ATTENTION_CONDITION_POLICY[conditionType].category;
}

export type WorkspaceAttentionMemberVisibility = 'by_source' | 'by_page_source' | 'administrator_only';

/**
 * Member visibility follows the affected resource: Source-scoped items pass
 * through Source Access, Page-scoped items pass through their Page's Source,
 * and everything else (Agent, runtime, orchestration) fails closed to the
 * Administrator oversight exception so denied metadata never leaks.
 */
export function workspaceAttentionMemberVisibility(resourceType: string): WorkspaceAttentionMemberVisibility {
  if (resourceType === 'source') return 'by_source';
  if (resourceType === 'page') return 'by_page_source';
  return 'administrator_only';
}

/** Pure lifecycle policy: which Member actions each status admits. */
export function workspaceAttentionActionAllowed(status: WorkspaceAttentionStatus, action: WorkspaceAttentionAction): boolean {
  if (action === 'start_progress') return status === 'open';
  return status === 'open' || status === 'in_progress';
}

const CATEGORY_DETECTOR_IDS: Record<WorkspaceAttentionCategory, string> = {
  source_health: 'source-health-detector',
  knowledge_quality: 'knowledge-quality-detector',
  agent_access: 'agent-access-detector',
  automation_health: 'automation-health-detector',
};

/** Page items dedupe on `<source_id>:<slug>`; source ids never contain ':'. */
function pageResourceParts(resourceId: string): { sourceId: string; slug: string } {
  const separator = resourceId.indexOf(':');
  return { sourceId: resourceId.slice(0, separator), slug: resourceId.slice(separator + 1) };
}

/**
 * Why an active episode ended: the detector verified the condition absent,
 * or the affected resource left the active lifecycle (archived or deleted
 * Source, deleted Page, revoked Agent), which is not a verified recovery
 * and is recorded distinctly.
 */
type EpisodeClearanceCause =
  | 'condition_absent'
  | 'source_left_active_lifecycle'
  | 'page_left_active_lifecycle'
  | 'agent_left_active_lifecycle';

async function episodeClearanceCause(
  engine: ReadEngine,
  workspaceId: string,
  resourceType: string,
  resourceId: string,
): Promise<EpisodeClearanceCause> {
  if (resourceType === 'source') {
    const rows = await engine.executeRaw<{ archived: boolean; deleted: boolean }>(
      'SELECT archived, deleted FROM workspace_sources WHERE workspace_id=$1 AND source_id=$2',
      [workspaceId, resourceId],
    );
    return !rows[0] || rows[0].archived || rows[0].deleted ? 'source_left_active_lifecycle' : 'condition_absent';
  }
  if (resourceType === 'page') {
    const page = pageResourceParts(resourceId);
    const rows = await engine.executeRaw(
      `SELECT 1 AS present
         FROM pages p
         JOIN workspace_sources ws
           ON ws.workspace_id=$1 AND ws.source_id=p.source_id AND ws.archived=FALSE AND ws.deleted=FALSE
        WHERE p.source_id=$2 AND p.slug=$3 AND p.deleted_at IS NULL`,
      [workspaceId, page.sourceId, page.slug],
    );
    return rows[0] ? 'condition_absent' : 'page_left_active_lifecycle';
  }
  if (resourceType === 'agent') {
    const rows = await engine.executeRaw<{ status: string }>(
      'SELECT status FROM workspace_agents WHERE workspace_id=$1 AND agent_id=$2',
      [workspaceId, resourceId],
    );
    return rows[0]?.status === 'active' ? 'condition_absent' : 'agent_left_active_lifecycle';
  }
  if (resourceType === 'orchestration') {
    // Orchestration dedupes on `<operation_type>:<source_id>`. A permanently
    // deleted Source ends the episode without claiming verified recovery; an
    // archived Source does not, because permanent-deletion orchestration
    // legitimately runs against archived Sources.
    const sourceId = resourceId.slice(resourceId.indexOf(':') + 1);
    const rows = await engine.executeRaw<{ deleted: boolean }>(
      'SELECT deleted FROM workspace_sources WHERE workspace_id=$1 AND source_id=$2',
      [workspaceId, sourceId],
    );
    return !rows[0] || rows[0].deleted ? 'source_left_active_lifecycle' : 'condition_absent';
  }
  return 'condition_absent';
}

interface ActiveAttentionCondition {
  conditionType: WorkspaceAttentionConditionType;
  resourceId: string;
  evidence: Record<string, unknown>;
}

function toIso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeEvidence(row: { error_code: string | null; request_id: string; operation_id: string; completed_at: string | Date | null }): Record<string, unknown> {
  // Evidence stays safe by construction: identifiers, an error code, and a
  // timestamp — never operator output, remote URLs, or free-form summaries.
  return {
    error_code: row.error_code ? sanitizeWorkspaceText(row.error_code) : null,
    request_id: sanitizeWorkspaceText(row.request_id),
    operation_id: row.operation_id,
    observed_at: toIso(row.completed_at),
  };
}

/**
 * Evaluate the current qualifying Source health conditions from durable
 * verification and synchronization evidence. Archived and permanently deleted
 * Sources never qualify, so they stop producing active Source health work.
 */
async function evaluateSourceHealthConditions(
  engine: ReadEngine,
  workspaceId: string,
  sourceId: string | null = null,
): Promise<ActiveAttentionCondition[]> {
  const verificationFailures = await engine.executeRaw<{
    source_id: string; error_code: string | null; request_id: string; operation_id: string; completed_at: string | Date;
  }>(
    `SELECT s.source_id, e.error_code, e.request_id, e.operation_id, e.completed_at
       FROM workspace_sources s
       JOIN LATERAL (
         SELECT v.outcome, v.error_code, v.request_id, v.operation_id, v.completed_at
           FROM workspace_source_verification_events v
          WHERE v.workspace_id = s.workspace_id AND v.source_id = s.source_id
          ORDER BY v.event_sequence DESC LIMIT 1
       ) e ON TRUE
      WHERE s.workspace_id = $1 AND s.archived = FALSE AND s.deleted = FALSE
        AND e.outcome = 'failed'
        AND ($2::text IS NULL OR s.source_id = $2)`,
    [workspaceId, sourceId],
  );
  const synchronizationFailures = await engine.executeRaw<{
    source_id: string; error_code: string | null; request_id: string; operation_id: string; completed_at: string | Date;
  }>(
    `SELECT s.source_id, o.error_code, o.request_id, o.operation_id, o.completed_at
       FROM workspace_sources s
       JOIN LATERAL (
         SELECT b.state, b.error_code, b.request_id, b.operation_id, b.completed_at
           FROM workspace_background_operations b
          WHERE b.workspace_id = s.workspace_id AND b.resource_id = s.source_id
            AND b.operation_type = 'source.sync' AND b.state IN ('completed', 'failed')
          ORDER BY b.completed_at DESC, b.operation_id DESC LIMIT 1
       ) o ON TRUE
      WHERE s.workspace_id = $1 AND s.archived = FALSE AND s.deleted = FALSE
        AND o.state = 'failed' AND COALESCE(o.error_code, '') <> 'source_archived'
        AND ($2::text IS NULL OR s.source_id = $2)`,
    [workspaceId, sourceId],
  );
  return [
    ...verificationFailures.map(row => ({
      conditionType: 'source.verification_failure' as const, resourceId: row.source_id, evidence: safeEvidence(row),
    })),
    ...synchronizationFailures.map(row => ({
      conditionType: 'source.synchronization_failure' as const, resourceId: row.source_id, evidence: safeEvidence(row),
    })),
  ];
}

/**
 * Missing evidence over live Pages of active Sources, using the same
 * deterministic Evidence Status projection the Knowledge views serve.
 * Deleted Pages and archived or deleted Sources never qualify.
 */
async function evaluateKnowledgeQualityConditions(
  engine: ReadEngine,
  workspaceId: string,
  resourceId: string | null = null,
): Promise<ActiveAttentionCondition[]> {
  const rows = await engine.executeRaw<{ source_id: string; slug: string; updated_at: string | Date }>(
    `SELECT p.source_id, p.slug, p.updated_at
       FROM pages p
       JOIN workspace_sources ws
         ON ws.workspace_id=$1 AND ws.source_id=p.source_id AND ws.archived=FALSE AND ws.deleted=FALSE
      WHERE p.deleted_at IS NULL AND (${EVIDENCE_SQL}) = 'missing_evidence'
        AND ($2::text IS NULL OR (p.source_id || ':' || p.slug) = $2)`,
    [workspaceId, resourceId],
  );
  return rows.map(row => ({
    conditionType: 'knowledge.missing_evidence' as const,
    resourceId: `${row.source_id}:${row.slug}`,
    evidence: {
      source_id: row.source_id,
      slug: sanitizeWorkspaceText(row.slug),
      evidence_status: 'missing_evidence',
      observed_at: toIso(row.updated_at),
    },
  }));
}

/**
 * Defined risky Agent authorization conditions: an active Agent whose three
 * most recent structured activity events all failed, and an active Agent
 * holding Admin scope (an access decision that requires an Administrator).
 * Evidence carries identifiers and counts only — never credential material.
 */
async function evaluateAgentAccessConditions(
  engine: ReadEngine,
  workspaceId: string,
  resourceId: string | null = null,
): Promise<ActiveAttentionCondition[]> {
  const repeatedFailures = await engine.executeRaw<{
    agent_id: string; failures: string | number; observed_at: string | Date;
  }>(
    // "The three most recent events" is a question about recorded order, not
    // about wall clock. Ordering by `occurred_at` lets a backwards clock step
    // (NTP correction, VM suspend/resume) hide a recovery behind the failure
    // streak it superseded, stranding the episode open forever.
    `SELECT a.agent_id, count(*) AS failures, max(recent.occurred_at) AS observed_at
       FROM workspace_agents a
       JOIN LATERAL (
         SELECT act.outcome, act.occurred_at
           FROM workspace_agent_activity act
          WHERE act.agent_id = a.agent_id
          ORDER BY act.activity_sequence DESC LIMIT 3
       ) recent ON TRUE
      WHERE a.workspace_id = $1 AND a.status = 'active'
        AND ($2::text IS NULL OR a.agent_id = $2)
      GROUP BY a.agent_id
      HAVING count(*) >= 3 AND bool_and(recent.outcome = 'failed')`,
    [workspaceId, resourceId],
  );
  const adminScope = await engine.executeRaw<{ agent_id: string; updated_at: string | Date }>(
    `SELECT agent_id, updated_at FROM workspace_agents
      WHERE workspace_id = $1 AND status = 'active' AND scope = 'admin'
        AND ($2::text IS NULL OR agent_id = $2)`,
    [workspaceId, resourceId],
  );
  return [
    ...repeatedFailures.map(row => ({
      conditionType: 'agent.repeated_authorization_failure' as const,
      resourceId: row.agent_id,
      evidence: {
        agent_id: row.agent_id,
        consecutive_failures: Number(row.failures),
        observed_at: toIso(row.observed_at),
      },
    })),
    ...adminScope.map(row => ({
      conditionType: 'agent.admin_scope_review' as const,
      resourceId: row.agent_id,
      evidence: { agent_id: row.agent_id, scope: 'admin', observed_at: toIso(row.updated_at) },
    })),
  ];
}

/** Heartbeats arrive every 15 seconds; twenty missed beats is a stall. */
const RUNTIME_STALL_SQL = "now() - interval '5 minutes'";

/**
 * Automation health covers orchestration not owned by one Source's
 * verification/synchronization evidence: stalled worker/scheduler heartbeats
 * and the latest terminal outcome of non-maintenance Background Operations
 * (provisioning, permanent deletion) per operation type and resource.
 */
async function evaluateAutomationHealthConditions(
  engine: ReadEngine,
  workspaceId: string,
  resourceId: string | null = null,
): Promise<ActiveAttentionCondition[]> {
  const stalled = await engine.executeRaw<{ role: string; last_heartbeat_at: string | Date }>(
    `SELECT role, last_heartbeat_at FROM workspace_runtime_heartbeats
      WHERE last_heartbeat_at < ${RUNTIME_STALL_SQL}
        AND ($1::text IS NULL OR role = $1)`,
    [resourceId],
  );
  const failedOperations = await engine.executeRaw<{
    operation_type: string; resource_id: string; operation_id: string;
    error_code: string | null; request_id: string; completed_at: string | Date;
  }>(
    `SELECT latest.operation_type, latest.resource_id, latest.operation_id,
            latest.error_code, latest.request_id, latest.completed_at
       FROM (
         SELECT DISTINCT ON (b.operation_type, b.resource_id)
                b.operation_type, b.resource_id, b.operation_id, b.error_code,
                b.request_id, b.completed_at, b.state
           FROM workspace_background_operations b
           JOIN workspace_sources s ON s.workspace_id=b.workspace_id AND s.source_id=b.resource_id
          WHERE b.workspace_id = $1 AND b.state IN ('completed', 'failed')
            AND b.operation_type NOT IN ('source.verify', 'source.sync')
            AND s.deleted = FALSE
          ORDER BY b.operation_type, b.resource_id, b.completed_at DESC, b.operation_id DESC
       ) latest
      WHERE latest.state = 'failed'
        AND ($2::text IS NULL OR latest.operation_type || ':' || latest.resource_id = $2)`,
    [workspaceId, resourceId],
  );
  return [
    ...stalled.map(row => ({
      conditionType: 'automation.runtime_stalled' as const,
      resourceId: row.role,
      evidence: { role: row.role, last_heartbeat_at: toIso(row.last_heartbeat_at), observed_at: toIso(row.last_heartbeat_at) },
    })),
    ...failedOperations.map(row => ({
      conditionType: 'automation.operation_failure' as const,
      resourceId: `${row.operation_type}:${row.resource_id}`,
      evidence: {
        operation_id: row.operation_id,
        operation_type: row.operation_type,
        error_code: row.error_code ? sanitizeWorkspaceText(row.error_code) : null,
        request_id: sanitizeWorkspaceText(row.request_id),
        observed_at: toIso(row.completed_at),
      },
    })),
  ];
}

const CATEGORY_EVALUATORS: Record<
  WorkspaceAttentionCategory,
  (engine: ReadEngine, workspaceId: string, resourceId?: string | null) => Promise<ActiveAttentionCondition[]>
> = {
  source_health: evaluateSourceHealthConditions,
  knowledge_quality: evaluateKnowledgeQualityConditions,
  agent_access: evaluateAgentAccessConditions,
  automation_health: evaluateAutomationHealthConditions,
};

async function appendHistory(
  engine: ReadEngine,
  itemId: string,
  event: string,
  actor: { kind: 'member' | 'system'; id: string },
  detail: Record<string, unknown> = {},
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO workspace_attention_item_history (history_id, item_id, event, actor_kind, actor_id, detail, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, clock_timestamp())`,
    [randomUUID(), itemId, event, actor.kind, actor.id, detail],
  );
}

/**
 * End an episode and resolve its still-active item after the detector's
 * verification. Shared by the reconciliation pass and Member-requested
 * resolution so history, Audit Events, and Change Events never diverge.
 */
async function resolveVerifiedAttentionItem(
  tx: ReadEngine,
  input: {
    workspaceId: string;
    itemId: string;
    episodeId: string;
    priorStatus: WorkspaceAttentionStatus;
    cause: EpisodeClearanceCause;
    detector: { kind: 'system'; id: string };
    requestId: string;
    notifyOwner?: boolean;
  },
): Promise<void> {
  await tx.executeRaw(
    `UPDATE workspace_condition_episodes SET state = 'cleared', cleared_at = now(), last_observed_at = now()
      WHERE episode_id = $1`,
    [input.episodeId],
  );
  await tx.executeRaw(
    `UPDATE workspace_attention_items
        SET status = 'resolved', resolved_at = now(), last_verified_at = now(), updated_at = now()
      WHERE item_id = $1`,
    [input.itemId],
  );
  await appendHistory(tx, input.itemId, 'resolved', input.detector, { cause: input.cause });
  await appendWorkspaceAuditEvent(tx, {
    actor: input.detector, action: 'attention.resolve', target: { type: 'attention_item', id: input.itemId },
    requestId: input.requestId, outcome: 'succeeded',
    before: { status: input.priorStatus }, after: { status: 'resolved', cause: input.cause },
  });
  await appendWorkspaceChangeEvent(tx, {
    actor: input.detector, action: 'attention.resolve',
    resource: { type: 'attention_item', id: input.itemId }, requestId: input.requestId,
  });
  if (input.notifyOwner !== false) {
    await createWorkspaceNotificationForEvent(tx, {
      workspaceId: input.workspaceId,
      eventKey: `attention-condition-changed:${input.itemId}:${input.requestId}`,
      eventType: 'attention_condition_changed',
      target: { type: 'attention_item', id: input.itemId },
    });
  }
}

interface EpisodeItemRow {
  episode_id: string;
  condition_type: WorkspaceAttentionConditionType;
  resource_type: string;
  resource_id: string;
  item_id: string;
  status: WorkspaceAttentionStatus;
}

export interface WorkspaceAttentionDetectorRun {
  detectedItemIds: string[];
  observedItemIds: string[];
  resolvedItemIds: string[];
}

/** Kept as the historical name for the run result of any category detector. */
export type WorkspaceSourceHealthDetectorRun = WorkspaceAttentionDetectorRun;

const ATTENTION_CATEGORIES: readonly WorkspaceAttentionCategory[] =
  ['source_health', 'knowledge_quality', 'agent_access', 'automation_health'];

/**
 * Detector execution (design §13.2): upsert the current Condition Episode
 * rather than inserting duplicates, verify continuing conditions, resolve
 * items whose condition is verified absent, and clear episodes for resources
 * that left the active lifecycle. Runs after relevant events and as the
 * reconciliation pass. One category runs in one transaction; the partial
 * unique active-episode index makes retries, concurrent evaluation, and
 * worker restarts unable to duplicate active items.
 */
export async function runWorkspaceAttentionDetector(
  engine: Engine,
  input: { workspaceId: string; requestId: string; category: WorkspaceAttentionCategory; detectorId?: string },
): Promise<WorkspaceAttentionDetectorRun> {
  const detector = { kind: 'system' as const, id: input.detectorId ?? CATEGORY_DETECTOR_IDS[input.category] };
  return engine.transaction(async tx => {
    const run: WorkspaceAttentionDetectorRun = { detectedItemIds: [], observedItemIds: [], resolvedItemIds: [] };
    const conditions = await CATEGORY_EVALUATORS[input.category](tx, input.workspaceId);
    const episodes = await tx.executeRaw<EpisodeItemRow>(
      `SELECT e.episode_id, e.condition_type, e.resource_type, e.resource_id, i.item_id, i.status
         FROM workspace_condition_episodes e
         JOIN workspace_attention_items i ON i.episode_id = e.episode_id
        WHERE e.workspace_id = $1 AND e.state = 'active' AND e.category = $2
        ORDER BY e.detected_at, e.episode_id
        FOR UPDATE OF e, i`,
      [input.workspaceId, input.category],
    );
    const key = (conditionType: string, resourceId: string) => `${conditionType} ${resourceId}`;
    const activeByKey = new Map(conditions.map(condition => [key(condition.conditionType, condition.resourceId), condition]));
    const episodeByKey = new Map(episodes.map(row => [key(row.condition_type, row.resource_id), row]));

    for (const condition of conditions) {
      const existing = episodeByKey.get(key(condition.conditionType, condition.resourceId));
      if (existing) {
        // One active item per condition type and resource during an
        // uninterrupted episode: observe, never duplicate. A dismissed item
        // keeps suppressing the same continuing episode.
        await tx.executeRaw(
          `UPDATE workspace_condition_episodes SET last_observed_at = now() WHERE episode_id = $1`,
          [existing.episode_id],
        );
        // Evidence keeps tracking the latest observation only while the item
        // is still active; a dismissed item retains the evidence it was
        // dismissed against.
        await tx.executeRaw(
          `UPDATE workspace_attention_items
              SET last_verified_at = now(),
                  evidence = CASE WHEN status IN ('open', 'in_progress') THEN $2::jsonb ELSE evidence END,
                  updated_at = now()
            WHERE item_id = $1`,
          [existing.item_id, condition.evidence],
        );
        run.observedItemIds.push(existing.item_id);
        continue;
      }
      const policy = WORKSPACE_ATTENTION_CONDITION_POLICY[condition.conditionType];
      const episodeId = randomUUID();
      const itemId = randomUUID();
      await tx.executeRaw(
        `INSERT INTO workspace_condition_episodes (episode_id, workspace_id, category, condition_type, resource_type, resource_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [episodeId, input.workspaceId, policy.category, condition.conditionType, policy.resourceType, condition.resourceId],
      );
      await tx.executeRaw(
        `INSERT INTO workspace_attention_items (
           item_id, workspace_id, episode_id, category, condition_type, resource_type, resource_id,
           summary, evidence, last_verified_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())`,
        [itemId, input.workspaceId, episodeId, policy.category, condition.conditionType, policy.resourceType,
          condition.resourceId, policy.summary, condition.evidence],
      );
      await appendHistory(tx, itemId, 'detected', detector, { condition_type: condition.conditionType });
      await appendWorkspaceAuditEvent(tx, {
        actor: detector, action: 'attention.detect', target: { type: 'attention_item', id: itemId },
        requestId: input.requestId, outcome: 'succeeded',
        after: { status: 'open', condition_type: condition.conditionType, resource_id: condition.resourceId },
      });
      await appendWorkspaceChangeEvent(tx, {
        actor: detector, action: 'attention.detect',
        resource: { type: 'attention_item', id: itemId }, requestId: input.requestId,
      });
      run.detectedItemIds.push(itemId);
    }

    for (const episode of episodes) {
      if (activeByKey.has(key(episode.condition_type, episode.resource_id))) continue;
      // The episode ends; recurrence later starts a new one. The recorded
      // cause distinguishes a verified recovery from a resource that merely
      // left the active lifecycle.
      const cause = await episodeClearanceCause(tx, input.workspaceId, episode.resource_type, episode.resource_id);
      if (episode.status === 'open' || episode.status === 'in_progress') {
        await resolveVerifiedAttentionItem(tx, {
          workspaceId: input.workspaceId, itemId: episode.item_id, episodeId: episode.episode_id, priorStatus: episode.status,
          cause, detector, requestId: input.requestId,
        });
        run.resolvedItemIds.push(episode.item_id);
      } else {
        await tx.executeRaw(
          `UPDATE workspace_condition_episodes SET state = 'cleared', cleared_at = now(), last_observed_at = now()
            WHERE episode_id = $1`,
          [episode.episode_id],
        );
        await tx.executeRaw(
          `UPDATE workspace_attention_items SET last_verified_at = now(), updated_at = now() WHERE item_id = $1`,
          [episode.item_id],
        );
        await appendHistory(tx, episode.item_id, 'episode_cleared', detector, { cause });
      }
    }
    return run;
  });
}

/** The Source health detector, kept under its established name. */
export async function runWorkspaceSourceHealthDetector(
  engine: Engine,
  input: { workspaceId: string; requestId: string; detectorId?: string },
): Promise<WorkspaceAttentionDetectorRun> {
  return runWorkspaceAttentionDetector(engine, { ...input, category: 'source_health' });
}

/**
 * Run every category detector as one reconciliation pass. Each category
 * commits in its own transaction so one failing detector cannot roll back
 * another's durable outcome; the first failure is rethrown after every
 * category had its chance to reconcile.
 */
export async function runWorkspaceAttentionDetectors(
  engine: Engine,
  input: { workspaceId: string; requestId: string; detectorId?: string },
): Promise<WorkspaceAttentionDetectorRun> {
  const merged: WorkspaceAttentionDetectorRun = { detectedItemIds: [], observedItemIds: [], resolvedItemIds: [] };
  let firstFailure: unknown;
  for (const category of ATTENTION_CATEGORIES) {
    try {
      const run = await runWorkspaceAttentionDetector(engine, { ...input, category });
      merged.detectedItemIds.push(...run.detectedItemIds);
      merged.observedItemIds.push(...run.observedItemIds);
      merged.resolvedItemIds.push(...run.resolvedItemIds);
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
  return merged;
}

interface ItemRow {
  item_id: string;
  episode_id: string;
  category: string;
  condition_type: WorkspaceAttentionConditionType;
  resource_type: string;
  resource_id: string;
  summary: string;
  evidence: Record<string, unknown> | string;
  status: WorkspaceAttentionStatus;
  assignee_membership_id: string | null;
  assignee_email: string | null;
  dismiss_reason: string | null;
  detected_at: string | Date;
  last_verified_at: string | Date | null;
  resolved_at: string | Date | null;
  dismissed_at: string | Date | null;
  episode_state: 'active' | 'cleared';
  episode_detected_at: string | Date;
  episode_cleared_at: string | Date | null;
}

const ITEM_SELECT = `
  SELECT i.item_id, i.episode_id, i.category, i.condition_type, i.resource_type, i.resource_id,
         i.summary, i.evidence, i.status, i.assignee_membership_id, i.dismiss_reason,
         i.detected_at, i.last_verified_at, i.resolved_at, i.dismissed_at,
         e.state AS episode_state, e.detected_at AS episode_detected_at, e.cleared_at AS episode_cleared_at,
         a.normalized_email AS assignee_email
    FROM workspace_attention_items i
    JOIN workspace_condition_episodes e ON e.episode_id = i.episode_id
    LEFT JOIN workspace_memberships m ON m.membership_id = i.assignee_membership_id
    LEFT JOIN workspace_identities a ON a.identity_id = m.identity_id`;

export interface WorkspaceAttentionItemView {
  itemId: string;
  category: string;
  conditionType: WorkspaceAttentionConditionType;
  summary: string;
  resource: { type: string; id: string };
  status: WorkspaceAttentionStatus;
  assignee: { membershipId: string; email: string | null } | null;
  dismissReason: string | null;
  detectedAt: string;
  lastVerifiedAt: string | null;
  resolvedAt: string | null;
  dismissedAt: string | null;
  evidence: Record<string, unknown>;
  episode: { episodeId: string; state: 'active' | 'cleared'; detectedAt: string; clearedAt: string | null };
}

function itemView(row: ItemRow): WorkspaceAttentionItemView {
  return {
    itemId: row.item_id,
    category: row.category,
    conditionType: row.condition_type,
    summary: row.summary,
    resource: { type: row.resource_type, id: row.resource_id },
    status: row.status,
    assignee: row.assignee_membership_id === null ? null
      : { membershipId: row.assignee_membership_id, email: row.assignee_email },
    dismissReason: row.dismiss_reason,
    detectedAt: toIso(row.detected_at)!,
    lastVerifiedAt: toIso(row.last_verified_at),
    resolvedAt: toIso(row.resolved_at),
    dismissedAt: toIso(row.dismissed_at),
    evidence: typeof row.evidence === 'string' ? JSON.parse(row.evidence) as Record<string, unknown> : row.evidence,
    episode: {
      episodeId: row.episode_id,
      state: row.episode_state,
      detectedAt: toIso(row.episode_detected_at)!,
      clearedAt: toIso(row.episode_cleared_at),
    },
  };
}

function requireViewer(viewer: WorkspaceAttentionViewer): void {
  if (!viewer?.membershipId || (viewer.role !== 'administrator' && viewer.role !== 'member')) {
    throw new WorkspaceAttentionError('attention_viewer_invalid');
  }
}

/**
 * Member reads pass through current Source Access, so Source- and Page-scoped
 * work outside the viewer's Sources stays invisible without disclosure, and
 * Agent access / Automation health work is Administrator-only oversight.
 * Administrators see the complete shared queue.
 */
async function accessibleSourceIdsFor(
  engine: ReadEngine,
  workspaceId: string,
  viewer: WorkspaceAttentionViewer,
): Promise<string[] | null> {
  if (viewer.role === 'administrator') return null;
  const sources = await engine.executeRaw<{ source_id: string }>(
    'SELECT source_id FROM workspace_sources WHERE workspace_id=$1',
    [workspaceId],
  );
  const access = await resolvePrincipalSourceAccess(
    engine,
    { remote: true, principal: { kind: 'member', id: viewer.membershipId } },
    sources.map(source => source.source_id),
  );
  return access.kind === 'sources' ? access.sourceIds : sources.map(source => source.source_id);
}

export async function listWorkspaceAttentionItems(
  engine: ReadEngine,
  request: { workspaceId: string; viewer: WorkspaceAttentionViewer },
): Promise<WorkspaceAttentionItemView[]> {
  requireViewer(request.viewer);
  const accessible = await accessibleSourceIdsFor(engine, request.workspaceId, request.viewer);
  if (accessible !== null && accessible.length === 0) return [];
  // The SQL mirrors workspaceAttentionMemberVisibility: Source items pass
  // through Source Access, Page items through their Page's Source, and every
  // other resource type stays Administrator-only.
  const memberVisibilitySql = `AND (
          (i.resource_type = 'source' AND i.resource_id = ANY($2::text[]))
          OR (i.resource_type = 'page' AND split_part(i.resource_id, ':', 1) = ANY($2::text[]))
        )`;
  const rows = await engine.executeRaw<ItemRow>(
    `${ITEM_SELECT}
      WHERE i.workspace_id = $1
        ${accessible === null ? '' : memberVisibilitySql}
      ORDER BY (i.status IN ('open', 'in_progress')) DESC, i.detected_at DESC, i.item_id DESC`,
    accessible === null ? [request.workspaceId] : [request.workspaceId, accessible],
  );
  return rows.map(itemView);
}

export interface WorkspaceAttentionHistoryEntry {
  event: string;
  actorKind: 'member' | 'system';
  actorId: string;
  detail: Record<string, unknown>;
  occurredAt: string;
}

async function requireAttentionItem(
  engine: ReadEngine,
  workspaceId: string,
  itemId: string,
  viewer: WorkspaceAttentionViewer,
  options: { forUpdate?: boolean } = {},
): Promise<ItemRow> {
  requireViewer(viewer);
  const rows = await engine.executeRaw<ItemRow>(
    `${ITEM_SELECT}
      WHERE i.workspace_id = $1 AND i.item_id = $2
      ${options.forUpdate ? 'FOR UPDATE OF i, e' : ''}`,
    [workspaceId, itemId],
  );
  const row = rows[0];
  if (!row) throw new WorkspaceAttentionError('attention_item_not_found');
  if (viewer.role !== 'administrator') {
    const visibility = workspaceAttentionMemberVisibility(row.resource_type);
    const accessible = visibility === 'administrator_only'
      ? []
      : await accessibleSourceIdsFor(engine, workspaceId, viewer) ?? [];
    const scopeSourceId = visibility === 'by_page_source'
      ? pageResourceParts(row.resource_id).sourceId
      : row.resource_id;
    if (visibility === 'administrator_only' || !accessible.includes(scopeSourceId)) {
      // Non-disclosure: an inaccessible item is indistinguishable from a
      // missing one.
      throw new WorkspaceAttentionError('attention_item_not_found');
    }
  }
  return row;
}

export async function getWorkspaceAttentionItem(
  engine: ReadEngine,
  request: { workspaceId: string; itemId: string; viewer: WorkspaceAttentionViewer },
): Promise<WorkspaceAttentionItemView & { history: WorkspaceAttentionHistoryEntry[] }> {
  const row = await requireAttentionItem(engine, request.workspaceId, request.itemId, request.viewer);
  const history = await engine.executeRaw<{
    event: string; actor_kind: 'member' | 'system'; actor_id: string;
    detail: Record<string, unknown> | string; occurred_at: string | Date;
  }>(
    `SELECT event, actor_kind, actor_id, detail, occurred_at
       FROM workspace_attention_item_history
      WHERE item_id = $1 ORDER BY occurred_at, history_id`,
    [request.itemId],
  );
  return {
    ...itemView(row),
    history: history.map(entry => ({
      event: entry.event,
      actorKind: entry.actor_kind,
      actorId: entry.actor_id,
      detail: typeof entry.detail === 'string' ? JSON.parse(entry.detail) as Record<string, unknown> : entry.detail,
      occurredAt: toIso(entry.occurred_at)!,
    })),
  };
}

export async function assignWorkspaceAttentionItem(
  engine: Engine,
  input: {
    workspaceId: string;
    itemId: string;
    assigneeMembershipId?: string;
    viewer: WorkspaceAttentionViewer;
    requestId: string;
  },
): Promise<WorkspaceAttentionItemView> {
  requireViewer(input.viewer);
  const assigneeMembershipId = input.assigneeMembershipId?.trim() || input.viewer.membershipId;
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.viewer.membershipId }, action: 'attention.assign',
    target: { type: 'attention_item', id: input.itemId }, requestId: input.requestId,
    after: { assignee_membership_id: assigneeMembershipId },
  }, async tx => {
    const item = await requireAttentionItem(tx, input.workspaceId, input.itemId, input.viewer, { forUpdate: true });
    if (!workspaceAttentionActionAllowed(item.status, 'assign')) throw new WorkspaceAttentionError('attention_status_invalid');
    const assignee = await tx.executeRaw<{ membership_id: string }>(
      `SELECT membership_id FROM workspace_memberships
        WHERE workspace_id = $1 AND membership_id = $2 AND status = 'active'`,
      [input.workspaceId, assigneeMembershipId],
    );
    if (!assignee[0]) throw new WorkspaceAttentionError('attention_assignee_not_found');
    const rows = await tx.executeRaw<{ item_id: string }>(
      `UPDATE workspace_attention_items SET assignee_membership_id = $2, updated_at = now()
        WHERE item_id = $1 RETURNING item_id`,
      [input.itemId, assigneeMembershipId],
    );
    if (!rows[0]) throw new WorkspaceAttentionError('attention_item_not_found');
    await appendHistory(tx, input.itemId, 'assigned', { kind: 'member', id: input.viewer.membershipId },
      { assignee_membership_id: assigneeMembershipId });
    await createWorkspaceNotificationForEvent(tx, {
      workspaceId: input.workspaceId,
      eventKey: `attention-assigned:${input.itemId}:${assigneeMembershipId}:${input.requestId}`,
      eventType: 'attention_assigned',
      target: { type: 'attention_item', id: input.itemId },
    });
    const updated = await requireAttentionItem(tx, input.workspaceId, input.itemId, input.viewer);
    return itemView(updated);
  });
}

export async function startWorkspaceAttentionProgress(
  engine: Engine,
  input: { workspaceId: string; itemId: string; viewer: WorkspaceAttentionViewer; requestId: string },
): Promise<WorkspaceAttentionItemView> {
  requireViewer(input.viewer);
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.viewer.membershipId }, action: 'attention.status.change',
    target: { type: 'attention_item', id: input.itemId }, requestId: input.requestId,
    before: { status: 'open' }, after: { status: 'in_progress' },
  }, async tx => {
    const item = await requireAttentionItem(tx, input.workspaceId, input.itemId, input.viewer, { forUpdate: true });
    if (!workspaceAttentionActionAllowed(item.status, 'start_progress')) throw new WorkspaceAttentionError('attention_status_invalid');
    await tx.executeRaw(
      `UPDATE workspace_attention_items SET status = 'in_progress', updated_at = now() WHERE item_id = $1`,
      [input.itemId],
    );
    await appendHistory(tx, input.itemId, 'status_changed', { kind: 'member', id: input.viewer.membershipId },
      { from: 'open', to: 'in_progress' });
    const updated = await requireAttentionItem(tx, input.workspaceId, input.itemId, input.viewer);
    return itemView(updated);
  });
}

export interface WorkspaceAttentionResolutionOutcome {
  item: WorkspaceAttentionItemView;
  conditionPresent: boolean;
}

/**
 * A Member requests resolution; Resolved is recorded only after the detector
 * verifies the condition is absent (ADR 0004). A remediation attempt that did
 * not fix the problem leaves the item active with verification history.
 */
export async function requestWorkspaceAttentionResolution(
  engine: Engine,
  input: { workspaceId: string; itemId: string; viewer: WorkspaceAttentionViewer; requestId: string; detectorId?: string },
): Promise<WorkspaceAttentionResolutionOutcome> {
  requireViewer(input.viewer);
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.viewer.membershipId }, action: 'attention.resolve.request',
    target: { type: 'attention_item', id: input.itemId }, requestId: input.requestId,
  }, async tx => {
    const item = await requireAttentionItem(tx, input.workspaceId, input.itemId, input.viewer, { forUpdate: true });
    if (!workspaceAttentionActionAllowed(item.status, 'request_resolution')) throw new WorkspaceAttentionError('attention_status_invalid');
    // Verification always re-runs the detector's own evaluation for the
    // item's category, scoped to the affected resource (design §13.2).
    const category = workspaceAttentionCategoryFor(item.condition_type);
    const detector = { kind: 'system' as const, id: input.detectorId ?? CATEGORY_DETECTOR_IDS[category] };
    await appendHistory(tx, input.itemId, 'resolution_requested', { kind: 'member', id: input.viewer.membershipId });
    const conditions = await CATEGORY_EVALUATORS[category](tx, input.workspaceId, item.resource_id);
    const present = conditions.some(condition => condition.conditionType === item.condition_type);
    if (present) {
      await tx.executeRaw(
        `UPDATE workspace_attention_items SET last_verified_at = now(), updated_at = now() WHERE item_id = $1`,
        [input.itemId],
      );
      await tx.executeRaw(
        `UPDATE workspace_condition_episodes SET last_observed_at = now() WHERE episode_id = $1`,
        [item.episode_id],
      );
      await appendHistory(tx, input.itemId, 'verification_condition_present', detector);
      await createWorkspaceNotificationForEvent(tx, {
        workspaceId: input.workspaceId,
        eventKey: `attention-verification:${input.itemId}:${input.requestId}`,
        eventType: 'attention_verification_outcome',
        target: { type: 'attention_item', id: input.itemId },
        actorMembershipId: input.viewer.membershipId,
      });
      const unresolved = await requireAttentionItem(tx, input.workspaceId, input.itemId, input.viewer);
      return { item: itemView(unresolved), conditionPresent: true };
    }
    await resolveVerifiedAttentionItem(tx, {
      workspaceId: input.workspaceId, itemId: input.itemId, episodeId: item.episode_id, priorStatus: item.status,
      cause: await episodeClearanceCause(tx, input.workspaceId, item.resource_type, item.resource_id),
      detector, requestId: input.requestId, notifyOwner: false,
    });
    await createWorkspaceNotificationForEvent(tx, {
      workspaceId: input.workspaceId,
      eventKey: `attention-verification:${input.itemId}:${input.requestId}`,
      eventType: 'attention_verification_outcome',
      target: { type: 'attention_item', id: input.itemId },
      actorMembershipId: input.viewer.membershipId,
    });
    const resolved = await requireAttentionItem(tx, input.workspaceId, input.itemId, input.viewer);
    return { item: itemView(resolved), conditionPresent: false };
  });
}

export async function dismissWorkspaceAttentionItem(
  engine: Engine,
  input: { workspaceId: string; itemId: string; reason: string; viewer: WorkspaceAttentionViewer; requestId: string },
): Promise<WorkspaceAttentionItemView> {
  requireViewer(input.viewer);
  const reason = input.reason?.trim();
  if (!reason) throw new WorkspaceAttentionError('reason_required');
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.viewer.membershipId }, action: 'attention.dismiss',
    target: { type: 'attention_item', id: input.itemId }, requestId: input.requestId, reason,
    after: { status: 'dismissed' },
  }, async tx => {
    const item = await requireAttentionItem(tx, input.workspaceId, input.itemId, input.viewer, { forUpdate: true });
    if (!workspaceAttentionActionAllowed(item.status, 'dismiss')) throw new WorkspaceAttentionError('attention_status_invalid');
    // Dismissal suppresses the continuing episode: the episode stays active,
    // so the detector observes it instead of opening a duplicate item until
    // the condition clears.
    await tx.executeRaw(
      `UPDATE workspace_attention_items
          SET status = 'dismissed', dismissed_at = now(), dismiss_reason = $2, updated_at = now()
        WHERE item_id = $1`,
      [input.itemId, sanitizeWorkspaceText(reason)],
    );
    await appendHistory(tx, input.itemId, 'dismissed', { kind: 'member', id: input.viewer.membershipId },
      { reason: sanitizeWorkspaceText(reason) });
    const updated = await requireAttentionItem(tx, input.workspaceId, input.itemId, input.viewer);
    return itemView(updated);
  });
}
