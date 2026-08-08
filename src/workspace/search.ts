import { createHash } from 'node:crypto';
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

export type WorkspaceSearchState =
  | 'empty_workspace'
  | 'access_required'
  | 'no_searchable_sources'
  | 'no_pages'
  | 'no_matches'
  | 'ready';
export type WorkspaceSearchMode = 'workspace_search' | 'explicit_sources';
export type WorkspaceSearchMatchField = 'title' | 'slug' | 'body';

export interface WorkspaceSearchFilters {
  types?: string[];
  evidence_statuses?: WorkspaceKnowledgeEvidenceStatus[];
  freshness_states?: WorkspaceKnowledgeFreshness[];
}

export interface WorkspaceSearchResultRow {
  page: { source_id: string; slug: string };
  title: string;
  type: string;
  source: { source_id: string; name: string };
  evidence_status: WorkspaceKnowledgeEvidenceStatus;
  source_freshness: WorkspaceKnowledgeFreshness;
  last_changed: string;
  match: { field: WorkspaceSearchMatchField; snippet: string };
}

export interface WorkspaceSearchResult {
  state: WorkspaceSearchState;
  mode: WorkspaceSearchMode;
  results: WorkspaceSearchResultRow[];
  next_cursor: string | null;
}

export interface SearchWorkspaceKnowledgeInput {
  workspaceId: string;
  membershipId: string;
  query: string;
  /** Explicit authorized Source selection; bypasses search inclusion only. */
  sourceIds?: string[];
  filters?: WorkspaceSearchFilters;
  limit?: number;
  cursor?: string;
  now?: string;
}

export interface WorkspaceSearchSource {
  source_id: string;
  name: string;
  included_in_workspace_search: boolean;
}

type SearchEngine = Pick<BrainEngine, 'executeRaw'>;
type SearchErrorCode =
  | 'invalid_query'
  | 'invalid_filter'
  | 'invalid_source_selection'
  | 'invalid_cursor'
  | 'invalid_limit';

export class WorkspaceSearchError extends Error {
  constructor(readonly code: SearchErrorCode) {
    super(code);
    this.name = 'WorkspaceSearchError';
  }
}

const EVIDENCE_STATUSES = new Set<WorkspaceKnowledgeEvidenceStatus>(['cited', 'source_backed', 'missing_evidence']);
const FRESHNESS_STATES = new Set<WorkspaceKnowledgeFreshness>(['current', 'due_soon', 'stale', 'unknown']);
const MATCH_FIELDS: WorkspaceSearchMatchField[] = ['title', 'slug', 'body'];
const BODY_SNIPPET_WINDOW = 60;
const BODY_SNIPPET_LENGTH = 160;

interface SearchCursor {
  v: 1;
  query: string;
  as_of: string;
  rank: number;
  value: string;
  source: string;
  slug: string;
}

interface InternalSearchRow {
  source_id: string;
  slug: string;
  title: string;
  type: string;
  source_name: string;
  evidence_status: WorkspaceKnowledgeEvidenceStatus;
  source_freshness: WorkspaceKnowledgeFreshness;
  last_changed: string | Date;
  match_rank: number | string;
  match_snippet: string;
}

function normalizeQuery(query: unknown): string {
  if (typeof query !== 'string' || query.trim().length < 1 || query.length > 200) {
    throw new WorkspaceSearchError('invalid_query');
  }
  return query.trim();
}

function normalizeStringList(values: unknown, code: SearchErrorCode, validator?: (value: string) => boolean): string[] {
  if (!Array.isArray(values) || values.length < 1 || values.length > 50
      || values.some(value => typeof value !== 'string' || value.length < 1 || value.length > 80 || (validator && !validator(value)))) {
    throw new WorkspaceSearchError(code);
  }
  return [...new Set(values)].sort();
}

function normalizeFilters(filters: WorkspaceSearchFilters | undefined): WorkspaceSearchFilters {
  if (filters === undefined) return {};
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new WorkspaceSearchError('invalid_filter');
  if (Object.keys(filters).some(key => !['types', 'evidence_statuses', 'freshness_states'].includes(key))) {
    throw new WorkspaceSearchError('invalid_filter');
  }
  return {
    ...(filters.types !== undefined ? { types: normalizeStringList(filters.types, 'invalid_filter') } : {}),
    ...(filters.evidence_statuses !== undefined ? { evidence_statuses: normalizeStringList(filters.evidence_statuses, 'invalid_filter', value => EVIDENCE_STATUSES.has(value as WorkspaceKnowledgeEvidenceStatus)) as WorkspaceKnowledgeEvidenceStatus[] } : {}),
    ...(filters.freshness_states !== undefined ? { freshness_states: normalizeStringList(filters.freshness_states, 'invalid_filter', value => FRESHNESS_STATES.has(value as WorkspaceKnowledgeFreshness)) as WorkspaceKnowledgeFreshness[] } : {}),
  };
}

function normalizeSourceSelection(sourceIds: string[] | undefined): string[] | undefined {
  if (sourceIds === undefined) return undefined;
  return normalizeStringList(sourceIds, 'invalid_source_selection', isValidSourceId);
}

function queryIdentity(query: string, sourceIds: string[] | undefined, filters: WorkspaceSearchFilters): string {
  return createHash('sha256')
    .update(JSON.stringify({ query, sourceIds: sourceIds ?? null, filters }))
    .digest('base64url').slice(0, 24);
}

function encodeCursor(cursor: SearchCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string, expectedQuery: string): SearchCursor {
  try {
    if (!value || value.length > 2048) throw new Error('invalid');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SearchCursor>;
    if (parsed.v !== 1 || parsed.query !== expectedQuery
        || typeof parsed.as_of !== 'string' || Number.isNaN(Date.parse(parsed.as_of))
        || typeof parsed.rank !== 'number' || ![0, 1, 2].includes(parsed.rank)
        || typeof parsed.value !== 'string' || Number.isNaN(Date.parse(parsed.value))
        || typeof parsed.source !== 'string' || !isValidSourceId(parsed.source)
        || typeof parsed.slug !== 'string' || !parsed.slug || parsed.slug.length > 500) throw new Error('invalid');
    return parsed as SearchCursor;
  } catch {
    throw new WorkspaceSearchError('invalid_cursor');
  }
}

function toIsoTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

interface ActiveSourceRow {
  source_id: string;
  name: string;
  included_in_workspace_search: boolean;
}

/** Active Sources of the Workspace and the subset the caller may currently access. */
async function resolvePermittedActiveSources(
  engine: SearchEngine,
  input: { workspaceId: string; membershipId: string },
): Promise<{ activeCount: number; permitted: ActiveSourceRow[] }> {
  const sources = await engine.executeRaw<ActiveSourceRow>(
    `SELECT source_id, name, included_in_workspace_search
       FROM workspace_sources
      WHERE workspace_id=$1 AND archived=FALSE
      ORDER BY source_id`,
    [input.workspaceId],
  );
  if (sources.length === 0) return { activeCount: 0, permitted: [] };
  const access = await resolvePrincipalSourceAccess(
    engine,
    { remote: true, principal: { kind: 'member', id: input.membershipId } },
    sources.map(source => source.source_id),
  );
  if (access.kind !== 'sources') return { activeCount: sources.length, permitted: sources };
  const permitted = new Set(access.sourceIds);
  return { activeCount: sources.length, permitted: sources.filter(source => permitted.has(source.source_id)) };
}

/**
 * Deterministic authorized Search over permitted Pages. Default eligibility is
 * active Sources marked Included in Workspace Search intersected with the
 * caller's current Source Access; an explicit selection bypasses only the
 * inclusion flag and is silently intersected with the permitted set so an
 * inaccessible selection stays indistinguishable from no matches. Nothing here
 * ever invokes Ask 2Brain or any generated synthesis.
 */
export async function searchWorkspaceKnowledge(
  engine: SearchEngine,
  input: SearchWorkspaceKnowledgeInput,
): Promise<WorkspaceSearchResult> {
  const query = normalizeQuery(input.query);
  const filters = normalizeFilters(input.filters);
  const selection = normalizeSourceSelection(input.sourceIds);
  const mode: WorkspaceSearchMode = selection ? 'explicit_sources' : 'workspace_search';
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new WorkspaceSearchError('invalid_limit');
  const identity = queryIdentity(query, selection, filters);
  const cursor = input.cursor ? decodeCursor(input.cursor, identity) : undefined;
  const requestedEvaluationTime = new Date(input.now ?? Date.now());
  if (Number.isNaN(requestedEvaluationTime.getTime())) throw new WorkspaceSearchError('invalid_query');
  const evaluationTime = cursor?.as_of ?? requestedEvaluationTime.toISOString();

  const empty = (state: WorkspaceSearchState): WorkspaceSearchResult => ({
    state, mode, results: [], next_cursor: null,
  });
  const { activeCount, permitted } = await resolvePermittedActiveSources(engine, input);
  if (activeCount === 0) return empty('empty_workspace');
  if (permitted.length === 0) return empty('access_required');

  const searchableSourceIds = permitted
    .filter(source => selection ? selection.includes(source.source_id) : source.included_in_workspace_search)
    .map(source => source.source_id);
  if (searchableSourceIds.length === 0) {
    return empty(mode === 'workspace_search' ? 'no_searchable_sources' : 'no_matches');
  }
  if (!await tableExists(engine, 'pages')) return empty('no_pages');

  const params: unknown[] = [input.workspaceId, searchableSourceIds, evaluationTime];
  const bind = (value: unknown): string => { params.push(value); return `$${params.length}`; };
  const pattern = bind(`%${query.replace(/([\\%_])/g, '\\$1')}%`);
  const raw = bind(query);
  const rankSql = `CASE
    WHEN p.title ILIKE ${pattern} ESCAPE '\\' THEN 0
    WHEN p.slug ILIKE ${pattern} ESCAPE '\\' THEN 1
    ELSE 2
  END`;
  const snippetSql = `CASE
    WHEN p.title ILIKE ${pattern} ESCAPE '\\' THEN p.title
    WHEN p.slug ILIKE ${pattern} ESCAPE '\\' THEN p.slug
    ELSE substr(p.compiled_truth,
                GREATEST(strpos(lower(p.compiled_truth), lower(${raw})) - ${BODY_SNIPPET_WINDOW}, 1),
                ${BODY_SNIPPET_LENGTH})
  END`;
  const conditions = [
    'p.source_id = ANY($2::text[])',
    'p.deleted_at IS NULL',
    `(p.title ILIKE ${pattern} ESCAPE '\\' OR p.slug ILIKE ${pattern} ESCAPE '\\' OR p.compiled_truth ILIKE ${pattern} ESCAPE '\\')`,
  ];
  if (filters.types) conditions.push(`p.type = ANY(${bind(filters.types)}::text[])`);
  if (filters.evidence_statuses) conditions.push(`(${EVIDENCE_SQL}) = ANY(${bind(filters.evidence_statuses)}::text[])`);
  if (filters.freshness_states) conditions.push(`(${FRESHNESS_SQL}) = ANY(${bind(filters.freshness_states)}::text[])`);
  if (cursor) {
    const rank = bind(cursor.rank);
    const value = bind(cursor.value);
    const source = bind(cursor.source);
    const slug = bind(cursor.slug);
    conditions.push(`((${rankSql}) > ${rank}::integer
      OR ((${rankSql}) = ${rank}::integer AND p.updated_at < ${value}::timestamptz)
      OR ((${rankSql}) = ${rank}::integer AND p.updated_at = ${value}::timestamptz AND (p.source_id, p.slug) > (${source}, ${slug})))`);
  }

  const requested = limit + 1;
  const rows = await engine.executeRaw<InternalSearchRow>(
    `SELECT p.source_id,
            p.slug,
            p.title,
            p.type,
            ws.name AS source_name,
            (${EVIDENCE_SQL}) AS evidence_status,
            (${FRESHNESS_SQL}) AS source_freshness,
            p.updated_at AS last_changed,
            (${rankSql}) AS match_rank,
            (${snippetSql}) AS match_snippet
       FROM pages p
       JOIN workspace_sources ws
         ON ws.workspace_id=$1 AND ws.source_id=p.source_id AND ws.archived=FALSE
       ${VERIFICATION_JOIN_SQL}
      WHERE ${conditions.join('\n        AND ')}
      ORDER BY (${rankSql}) ASC, p.updated_at DESC, p.source_id ASC, p.slug ASC
      LIMIT ${bind(requested)}::integer`,
    params,
  );
  const hasNext = rows.length > limit;
  const page = hasNext ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor = hasNext && last ? encodeCursor({
    v: 1,
    query: identity,
    as_of: evaluationTime,
    rank: Number(last.match_rank),
    value: toIsoTimestamp(last.last_changed),
    source: last.source_id,
    slug: last.slug,
  }) : null;
  return {
    state: page.length > 0 || cursor ? 'ready' : 'no_matches',
    mode,
    results: page.map(row => ({
      page: { source_id: row.source_id, slug: row.slug },
      title: row.title,
      type: row.type,
      source: { source_id: row.source_id, name: row.source_name },
      evidence_status: row.evidence_status,
      source_freshness: row.source_freshness,
      last_changed: toIsoTimestamp(row.last_changed),
      match: { field: MATCH_FIELDS[Number(row.match_rank)]!, snippet: row.match_snippet },
    })),
    next_cursor: nextCursor,
  };
}

/**
 * The caller's currently permitted active Sources for the explicit Source
 * selector. Inaccessible Sources are absent rather than marked, so the
 * selector never discloses restricted Sources.
 */
export async function listWorkspaceSearchSources(
  engine: SearchEngine,
  input: { workspaceId: string; membershipId: string },
): Promise<WorkspaceSearchSource[]> {
  const { permitted } = await resolvePermittedActiveSources(engine, input);
  return permitted.map(source => ({
    source_id: source.source_id,
    name: source.name,
    included_in_workspace_search: source.included_in_workspace_search,
  }));
}
