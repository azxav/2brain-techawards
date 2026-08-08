import type { BrainEngine } from '../core/engine.ts';
import { isValidSourceId } from '../core/source-id.ts';
import {
  EVIDENCE_SQL,
  FRESHNESS_SQL,
  tableExists,
  VERIFICATION_JOIN_SQL,
  type WorkspaceKnowledgeEvidenceStatus,
  type WorkspaceKnowledgeFreshness,
} from './knowledge.ts';
import { resolvePrincipalSourceAccess } from './source-access.ts';

type PageDetailEngine = Pick<BrainEngine, 'executeRaw'>;
type WorkspacePageErrorCode = 'invalid_page_reference' | 'page_not_found';

/**
 * Denied, archived, deleted, and absent Pages all fail as `page_not_found` so
 * a direct request cannot distinguish restricted Sources from missing Pages.
 */
export class WorkspacePageError extends Error {
  constructor(readonly code: WorkspacePageErrorCode) {
    super(code);
    this.name = 'WorkspacePageError';
  }
}

export interface WorkspacePageIdentity {
  source_id: string;
  slug: string;
}

/** Ingestion evidence recorded by the ingest log; absent evidence stays null (`Unknown`). */
export interface WorkspacePageIngestion {
  path: string;
  reference: string;
  recorded_at: string;
}

export interface WorkspacePageDetail {
  page: WorkspacePageIdentity;
  title: string;
  type: string;
  source: { source_id: string; name: string };
  provenance: {
    original_location: string | null;
    ingestion: WorkspacePageIngestion | null;
    created_at: string;
    last_changed_at: string;
    effective_date: string | null;
    effective_date_source: string | null;
  };
  source_freshness: {
    state: WorkspaceKnowledgeFreshness;
    evidence: {
      expected_cadence: string;
      last_verified_at: string | null;
      latest_verification_outcome: string | null;
      known_unsynchronized_revision: string | null;
    };
  };
  evidence_status: {
    state: WorkspaceKnowledgeEvidenceStatus;
    explanation: { citation_count: number; has_traceable_original: boolean };
  };
  body: string;
}

export interface WorkspacePageVersion {
  version_id: number;
  snapshot_at: string;
  /** Never recorded in v1; stays null so the product says Unknown instead of fabricating authorship. */
  actor: null;
  cause: WorkspacePageIngestion | null;
  content: string;
  metadata: Record<string, unknown>;
}

export interface WorkspacePageRequest {
  workspaceId: string;
  membershipId: string;
  sourceId: string;
  slug: string;
  now?: string;
}

interface PageDetailRow {
  page_id: number;
  source_id: string;
  slug: string;
  title: string;
  type: string;
  compiled_truth: string;
  source_name: string;
  import_filename: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  effective_date: string | Date | null;
  effective_date_source: string | null;
  expected_cadence: string;
  last_verified_at: string | Date | null;
  known_unsynchronized_revision: string | null;
  latest_verification_outcome: string | null;
  evidence_status: WorkspaceKnowledgeEvidenceStatus;
  source_freshness: WorkspaceKnowledgeFreshness;
  citation_count: number | string;
}

interface IngestEvidenceRow {
  source_type: string;
  source_ref: string;
  created_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toNullableIso(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

function normalizeRequest(request: WorkspacePageRequest): { evaluationTime: string } {
  if (!isValidSourceId(request.sourceId)
      || typeof request.slug !== 'string' || request.slug.length < 1 || request.slug.length > 500) {
    throw new WorkspacePageError('invalid_page_reference');
  }
  const evaluationTime = new Date(request.now ?? Date.now());
  if (Number.isNaN(evaluationTime.getTime())) throw new WorkspacePageError('invalid_page_reference');
  return { evaluationTime: evaluationTime.toISOString() };
}

/**
 * Recheck current Membership grants, active Source state, and Source Access
 * for this direct request; every failure mode is an undisclosed not-found.
 */
async function authorizeWorkspacePage(engine: PageDetailEngine, request: WorkspacePageRequest): Promise<void> {
  const sources = await engine.executeRaw<{ source_id: string }>(
    `SELECT source_id
       FROM workspace_sources
      WHERE workspace_id=$1 AND source_id=$2 AND archived=FALSE`,
    [request.workspaceId, request.sourceId],
  );
  if (sources.length === 0) throw new WorkspacePageError('page_not_found');

  const access = await resolvePrincipalSourceAccess(
    engine,
    { remote: true, principal: { kind: 'member', id: request.membershipId } },
    [request.sourceId],
  );
  if (access.kind === 'sources' && !access.sourceIds.includes(request.sourceId)) {
    throw new WorkspacePageError('page_not_found');
  }
  if (!await tableExists(engine, 'pages')) throw new WorkspacePageError('page_not_found');
}

/** Ingest-log evidence for this Page, newest first; missing log means no evidence. */
async function listIngestEvidence(engine: PageDetailEngine, request: WorkspacePageRequest): Promise<WorkspacePageIngestion[]> {
  if (!await tableExists(engine, 'ingest_log')) return [];
  const rows = await engine.executeRaw<IngestEvidenceRow>(
    `SELECT source_type, source_ref, created_at
       FROM ingest_log
      WHERE source_id=$1 AND pages_updated @> jsonb_build_array($2::text)
      ORDER BY created_at DESC, id DESC`,
    [request.sourceId, request.slug],
  );
  return rows.map(row => ({
    path: row.source_type,
    reference: row.source_ref,
    recorded_at: toIso(row.created_at),
  }));
}

/** Resolve one permitted Page's trust header and read-only body server-side. */
export async function getWorkspacePage(
  engine: PageDetailEngine,
  request: WorkspacePageRequest,
): Promise<WorkspacePageDetail> {
  const { evaluationTime } = normalizeRequest(request);
  await authorizeWorkspacePage(engine, request);

  const rows = await engine.executeRaw<PageDetailRow>(
    `SELECT p.id AS page_id,
            p.source_id,
            p.slug,
            p.title,
            p.type,
            p.compiled_truth,
            p.import_filename,
            p.created_at,
            p.updated_at,
            p.effective_date,
            p.effective_date_source,
            ws.name AS source_name,
            ws.expected_cadence,
            ws.last_verified_at,
            ws.known_unsynchronized_revision,
            verification.outcome AS latest_verification_outcome,
            (${EVIDENCE_SQL}) AS evidence_status,
            (${FRESHNESS_SQL}) AS source_freshness,
            (CASE WHEN jsonb_typeof(p.frontmatter->'citations')='array'
                  THEN jsonb_array_length(p.frontmatter->'citations') ELSE 0 END) AS citation_count
       FROM pages p
       JOIN workspace_sources ws
         ON ws.workspace_id=$1 AND ws.source_id=p.source_id AND ws.archived=FALSE
       ${VERIFICATION_JOIN_SQL}
      WHERE p.source_id=$2 AND p.slug=$4 AND p.deleted_at IS NULL`,
    [request.workspaceId, request.sourceId, evaluationTime, request.slug],
  );
  const row = rows[0];
  if (!row) throw new WorkspacePageError('page_not_found');

  const ingestEvidence = await listIngestEvidence(engine, request);
  return {
    page: { source_id: row.source_id, slug: row.slug },
    title: row.title,
    type: row.type,
    source: { source_id: row.source_id, name: row.source_name },
    provenance: {
      original_location: row.import_filename,
      ingestion: ingestEvidence[0] ?? null,
      created_at: toIso(row.created_at),
      last_changed_at: toIso(row.updated_at),
      effective_date: toNullableIso(row.effective_date),
      effective_date_source: row.effective_date_source,
    },
    source_freshness: {
      state: row.source_freshness,
      evidence: {
        expected_cadence: row.expected_cadence,
        last_verified_at: toNullableIso(row.last_verified_at),
        latest_verification_outcome: row.latest_verification_outcome,
        known_unsynchronized_revision: row.known_unsynchronized_revision,
      },
    },
    evidence_status: {
      state: row.evidence_status,
      explanation: {
        citation_count: Number(row.citation_count),
        has_traceable_original: row.import_filename !== null,
      },
    },
    body: row.compiled_truth,
  };
}

/**
 * Page Versions newest first. A version's cause is the latest ingest evidence
 * inside the interval since the adjacent older snapshot; anything less stays
 * null so the history panel says Unknown rather than inventing attribution.
 */
export async function listWorkspacePageVersions(
  engine: PageDetailEngine,
  request: WorkspacePageRequest,
): Promise<WorkspacePageVersion[]> {
  normalizeRequest(request);
  await authorizeWorkspacePage(engine, request);

  const pages = await engine.executeRaw<{ id: number }>(
    'SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL',
    [request.sourceId, request.slug],
  );
  if (!pages[0]) throw new WorkspacePageError('page_not_found');
  if (!await tableExists(engine, 'page_versions')) return [];

  const rows = await engine.executeRaw<{
    id: number;
    compiled_truth: string;
    frontmatter: Record<string, unknown> | string;
    snapshot_at: string | Date;
  }>(
    `SELECT id, compiled_truth, frontmatter, snapshot_at
       FROM page_versions
      WHERE page_id=$1
      ORDER BY snapshot_at DESC, id DESC`,
    [pages[0].id],
  );
  const ingestEvidence = await listIngestEvidence(engine, request);

  return rows.map((row, index) => {
    const snapshotAt = toIso(row.snapshot_at);
    const older = rows[index + 1];
    const windowStart = older ? toIso(older.snapshot_at) : null;
    const cause = ingestEvidence.find(evidence =>
      evidence.recorded_at <= snapshotAt && (windowStart === null || evidence.recorded_at > windowStart)) ?? null;
    return {
      version_id: row.id,
      snapshot_at: snapshotAt,
      actor: null,
      cause,
      content: row.compiled_truth,
      metadata: typeof row.frontmatter === 'string'
        ? JSON.parse(row.frontmatter) as Record<string, unknown>
        : row.frontmatter,
    };
  });
}
