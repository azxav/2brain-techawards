import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { appendWorkspaceChangeEvent } from './events.ts';
import { resolvePrincipalSourceAccess } from './source-access.ts';
import { sanitizeWorkspaceText } from './safe-values.ts';

type ActivityEngine = Pick<BrainEngine, 'executeRaw'>;
type ActivityWriteEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;

export type WorkspaceAgentRunOutcome = 'succeeded' | 'failed' | 'cancelled';
export type WorkspaceAgentActivityOutcome = 'succeeded' | 'failed';
export type WorkspaceAgentPageRelationship = 'retrieved' | 'written' | 'cited';

const RUN_OUTCOMES: readonly WorkspaceAgentRunOutcome[] = ['succeeded', 'failed', 'cancelled'];
const ACTIVITY_OUTCOMES: readonly WorkspaceAgentActivityOutcome[] = ['succeeded', 'failed'];
const PAGE_RELATIONSHIPS: readonly WorkspaceAgentPageRelationship[] = ['retrieved', 'written', 'cited'];

/** Full request parameters stay disabled by default and expire after seven days when explicitly enabled. */
const FULL_PARAMETERS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class WorkspaceAgentActivityError extends Error {
  constructor(readonly code:
    | 'agent_not_found'
    | 'run_not_found'
    | 'source_not_found'
    | 'invalid_run_record'
    | 'invalid_activity_record'
    | 'invalid_activity_evidence'
    | 'full_parameters_disabled'
    | 'invalid_activity_viewer') {
    super(code);
    this.name = 'WorkspaceAgentActivityError';
  }
}

/**
 * Prompt-, transcript-, and secret-shaped keys never survive into the durable
 * structured record. Redaction is fail-closed: unknown text runs through the
 * workspace text scrubber and suspicious keys collapse to a marker.
 */
const UNSAFE_DETAIL_KEY = /(?:prompt|instruction|message|completion|transcript|conversation|content|input|output|authorization|cookie|credential|password|private[_-]?key|secret|session|token|api[_-]?key)/i;

function redactStructuredDetail(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return sanitizeWorkspaceText(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redactStructuredDetail(item, seen));
  const safe: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    safe[key] = UNSAFE_DETAIL_KEY.test(key) ? '[REDACTED]' : redactStructuredDetail(nested, seen);
  }
  return safe;
}

function normalizeTimestamp(value: string | undefined, error: WorkspaceAgentActivityError['code']): string | null {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new WorkspaceAgentActivityError(error);
  return parsed.toISOString();
}

async function requireWorkspaceAgent(engine: ActivityEngine, workspaceId: string, agentId: string): Promise<void> {
  const rows = await engine.executeRaw(
    'SELECT agent_id FROM workspace_agents WHERE workspace_id=$1 AND agent_id=$2',
    [workspaceId, agentId],
  );
  if (!rows[0]) throw new WorkspaceAgentActivityError('agent_not_found');
}

export async function recordWorkspaceAgentRun(engine: ActivityEngine, input: {
  workspaceId: string;
  agentId: string;
  correlationId?: string;
  startedAt?: string;
  endedAt?: string;
  outcome?: WorkspaceAgentRunOutcome;
  metadata?: Record<string, unknown>;
}): Promise<{ runId: string }> {
  if (input.outcome !== undefined && !RUN_OUTCOMES.includes(input.outcome)) {
    throw new WorkspaceAgentActivityError('invalid_run_record');
  }
  const correlationId = input.correlationId?.trim() || null;
  if (correlationId !== null && correlationId.length > 200) throw new WorkspaceAgentActivityError('invalid_run_record');
  const startedAt = normalizeTimestamp(input.startedAt, 'invalid_run_record');
  const endedAt = normalizeTimestamp(input.endedAt, 'invalid_run_record');
  await requireWorkspaceAgent(engine, input.workspaceId, input.agentId);
  const runId = randomUUID();
  await engine.executeRaw(
    `INSERT INTO workspace_agent_runs (run_id, agent_id, correlation_id, started_at, ended_at, outcome, metadata)
     VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), $5, $6, $7::jsonb)`,
    [runId, input.agentId, correlationId, startedAt, endedAt, input.outcome ?? null,
      redactStructuredDetail(input.metadata ?? {})],
  );
  return { runId };
}

export async function recordWorkspaceAgentActivity(engine: ActivityWriteEngine, input: {
  workspaceId: string;
  agentId: string;
  runId?: string;
  requestId?: string;
  operation: string;
  outcome: WorkspaceAgentActivityOutcome;
  latencyMs?: number;
  sourceId?: string;
  pageSlug?: string;
  relationship?: WorkspaceAgentPageRelationship;
  requestDetail?: {
    redacted: Record<string, unknown>;
    fullParameters?: Record<string, unknown>;
    fullParametersEnabled?: boolean;
  };
}): Promise<{ activityId: string }> {
  const operation = input.operation?.trim();
  if (!operation || operation.length > 120) throw new WorkspaceAgentActivityError('invalid_activity_record');
  if (!ACTIVITY_OUTCOMES.includes(input.outcome)) throw new WorkspaceAgentActivityError('invalid_activity_record');
  if (input.relationship !== undefined && !PAGE_RELATIONSHIPS.includes(input.relationship)) {
    throw new WorkspaceAgentActivityError('invalid_activity_record');
  }
  if (input.latencyMs !== undefined && (!Number.isInteger(input.latencyMs) || input.latencyMs < 0)) {
    throw new WorkspaceAgentActivityError('invalid_activity_record');
  }
  // Retrieved/Written/Cited are evidence labels: a relationship needs its Page,
  // and Page evidence needs its authorizing Source context.
  if (input.pageSlug !== undefined && input.sourceId === undefined) throw new WorkspaceAgentActivityError('invalid_activity_evidence');
  if (input.relationship !== undefined && input.pageSlug === undefined) throw new WorkspaceAgentActivityError('invalid_activity_evidence');
  if (input.requestDetail?.fullParameters !== undefined && input.requestDetail.fullParametersEnabled !== true) {
    throw new WorkspaceAgentActivityError('full_parameters_disabled');
  }

  await requireWorkspaceAgent(engine, input.workspaceId, input.agentId);
  // Source context must be real at record time: an unknown Source ID would
  // masquerade as authorized context in every later oversight view.
  if (input.sourceId !== undefined) {
    const sources = await engine.executeRaw(
      'SELECT source_id FROM workspace_sources WHERE workspace_id=$1 AND source_id=$2',
      [input.workspaceId, input.sourceId],
    );
    if (!sources[0]) throw new WorkspaceAgentActivityError('source_not_found');
  }
  if (input.runId !== undefined) {
    const runs = await engine.executeRaw(
      'SELECT run_id FROM workspace_agent_runs WHERE run_id=$1 AND agent_id=$2',
      [input.runId, input.agentId],
    );
    if (!runs[0]) throw new WorkspaceAgentActivityError('run_not_found');
  }

  return engine.transaction(async transaction => {
    const activityId = randomUUID();
    await transaction.executeRaw(
      `INSERT INTO workspace_agent_activity
         (activity_id, agent_id, run_id, request_id, operation, outcome, latency_ms, source_id, page_slug, relationship)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [activityId, input.agentId, input.runId ?? null, input.requestId?.trim() || null, operation, input.outcome,
        input.latencyMs ?? null, input.sourceId ?? null, input.pageSlug ?? null, input.relationship ?? null],
    );
    if (input.requestDetail) {
      const storeFullParameters = input.requestDetail.fullParametersEnabled === true
        && input.requestDetail.fullParameters !== undefined;
      const capturedAt = new Date();
      await transaction.executeRaw(
        `INSERT INTO workspace_agent_request_details
           (activity_id, redacted_detail, full_parameters, full_parameters_expire_at, captured_at)
         VALUES ($1, $2::jsonb, $3::jsonb, $4, $5)`,
        [activityId, redactStructuredDetail(input.requestDetail.redacted),
          storeFullParameters ? input.requestDetail.fullParameters : null,
          storeFullParameters ? new Date(capturedAt.getTime() + FULL_PARAMETERS_RETENTION_MS).toISOString() : null,
          capturedAt.toISOString()],
      );
    }
    if (input.outcome === 'succeeded' && input.relationship === 'written') {
      await appendWorkspaceChangeEvent(transaction, {
        actor: { kind: 'agent', id: input.agentId },
        resource: { type: 'page', id: `${input.sourceId!}:${input.pageSlug!}` },
        action: 'knowledge.agent.write',
        requestId: input.requestId?.trim() || `agent-activity:${activityId}`,
        workspaceId: input.workspaceId,
      });
    }
    return { activityId };
  });
}

export interface WorkspaceAgentActivityEntry {
  activityId: string;
  operation: string;
  outcome: WorkspaceAgentActivityOutcome;
  latencyMs: number | null;
  occurredAt: string;
  requestId: string | null;
  source: { sourceId: string } | null;
  page: { sourceId: string; slug: string } | null;
  relationship: WorkspaceAgentPageRelationship | null;
  run: {
    runId: string;
    correlationId: string | null;
    startedAt: string;
    endedAt: string | null;
    outcome: WorkspaceAgentRunOutcome | null;
    metadata: Record<string, unknown>;
  } | null;
  /** Administrator oversight only, and only when request logging captured it. */
  requestDetail?: {
    redacted: Record<string, unknown>;
    capturedAt: string;
    fullParameters?: Record<string, unknown>;
  };
}

export interface WorkspaceAgentActivityView {
  oversight: boolean;
  entries: WorkspaceAgentActivityEntry[];
  /** True when older entries exist beyond the fixed page returned here. */
  truncated: boolean;
}

interface ActivityRow {
  activity_id: string;
  operation: string;
  outcome: WorkspaceAgentActivityOutcome;
  latency_ms: number | string | null;
  occurred_at: string | Date;
  request_id: string | null;
  source_id: string | null;
  page_slug: string | null;
  relationship: WorkspaceAgentPageRelationship | null;
  run_id: string | null;
  run_correlation_id: string | null;
  run_started_at: string | Date | null;
  run_ended_at: string | Date | null;
  run_outcome: WorkspaceAgentRunOutcome | null;
  run_metadata: Record<string, unknown> | string | null;
  detail_redacted: Record<string, unknown> | string | null;
  detail_captured_at: string | Date | null;
  detail_full_parameters: Record<string, unknown> | string | null;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toJsonObject(value: Record<string, unknown> | string): Record<string, unknown> {
  return typeof value === 'string' ? JSON.parse(value) as Record<string, unknown> : value;
}

function entryFromRow(row: ActivityRow, oversight: boolean): WorkspaceAgentActivityEntry {
  const entry: WorkspaceAgentActivityEntry = {
    activityId: row.activity_id,
    operation: row.operation,
    outcome: row.outcome,
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    occurredAt: toIso(row.occurred_at),
    requestId: row.request_id,
    source: row.source_id === null ? null : { sourceId: row.source_id },
    page: row.page_slug === null || row.source_id === null ? null : { sourceId: row.source_id, slug: row.page_slug },
    relationship: row.relationship,
    run: row.run_id === null ? null : {
      runId: row.run_id,
      correlationId: row.run_correlation_id,
      startedAt: toIso(row.run_started_at!),
      endedAt: row.run_ended_at === null ? null : toIso(row.run_ended_at),
      outcome: row.run_outcome,
      metadata: toJsonObject(row.run_metadata ?? {}),
    },
  };
  // A Member payload never carries a Request Detail key; an Administrator sees
  // one only when it was actually captured, without implying raw data exists.
  if (oversight && row.detail_redacted !== null) {
    entry.requestDetail = {
      redacted: toJsonObject(row.detail_redacted),
      capturedAt: toIso(row.detail_captured_at!),
      ...(row.detail_full_parameters === null ? {} : { fullParameters: toJsonObject(row.detail_full_parameters) }),
    };
  }
  return entry;
}

/**
 * Member reads pass through current Source Access, so activity outside the
 * viewer's Sources — including activity with no Source context — stays
 * invisible. The Administrator branch is the documented explicit oversight
 * exception: it never consults Source Access and never widens Knowledge reads,
 * which remain authorized elsewhere per Source.
 */
const ACTIVITY_PAGE_LIMIT = 200;

export async function listWorkspaceAgentActivity(engine: ActivityEngine, request: {
  workspaceId: string;
  agentId: string;
  viewer: { membershipId: string; role: 'administrator' | 'member' };
}): Promise<WorkspaceAgentActivityView> {
  if (!request.viewer?.membershipId || (request.viewer.role !== 'administrator' && request.viewer.role !== 'member')) {
    throw new WorkspaceAgentActivityError('invalid_activity_viewer');
  }
  await requireWorkspaceAgent(engine, request.workspaceId, request.agentId);
  const oversight = request.viewer.role === 'administrator';

  // ADR 0023: explicitly enabled full parameters live seven days. Every read
  // purges expired captures so classification is enforced by deletion, not
  // only by payload filtering.
  await engine.executeRaw(
    `UPDATE workspace_agent_request_details
        SET full_parameters=NULL, full_parameters_expire_at=NULL
      WHERE full_parameters IS NOT NULL AND full_parameters_expire_at <= now()`,
  );

  let accessibleSourceIds: string[] | null = null;
  if (!oversight) {
    const sources = await engine.executeRaw<{ source_id: string }>(
      'SELECT source_id FROM workspace_sources WHERE workspace_id=$1 AND archived=FALSE',
      [request.workspaceId],
    );
    const access = await resolvePrincipalSourceAccess(
      engine,
      { remote: true, principal: { kind: 'member', id: request.viewer.membershipId } },
      sources.map(source => source.source_id),
    );
    accessibleSourceIds = access.kind === 'sources' ? access.sourceIds : sources.map(source => source.source_id);
    if (accessibleSourceIds.length === 0) return { oversight, entries: [], truncated: false };
  }

  const rows = await engine.executeRaw<ActivityRow>(
    `SELECT a.activity_id, a.operation, a.outcome, a.latency_ms, a.occurred_at, a.request_id,
            a.source_id, a.page_slug, a.relationship,
            r.run_id, r.correlation_id AS run_correlation_id, r.started_at AS run_started_at,
            r.ended_at AS run_ended_at, r.outcome AS run_outcome, r.metadata AS run_metadata,
            d.redacted_detail AS detail_redacted, d.captured_at AS detail_captured_at,
            (CASE WHEN d.full_parameters_expire_at > now() THEN d.full_parameters END) AS detail_full_parameters
       FROM workspace_agent_activity a
       LEFT JOIN workspace_agent_runs r ON r.run_id=a.run_id
       LEFT JOIN workspace_agent_request_details d ON d.activity_id=a.activity_id
      WHERE a.agent_id=$1
        ${accessibleSourceIds === null ? '' : 'AND a.source_id = ANY($2::text[])'}
      ORDER BY a.occurred_at DESC, a.activity_id DESC
      LIMIT ${ACTIVITY_PAGE_LIMIT + 1}`,
    accessibleSourceIds === null ? [request.agentId] : [request.agentId, accessibleSourceIds],
  );
  const truncated = rows.length > ACTIVITY_PAGE_LIMIT;
  return {
    oversight,
    entries: rows.slice(0, ACTIVITY_PAGE_LIMIT).map(row => entryFromRow(row, oversight)),
    truncated,
  };
}
