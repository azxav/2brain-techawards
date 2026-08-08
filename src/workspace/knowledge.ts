import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { isValidSourceId } from '../core/source-id.ts';
import { resolvePrincipalSourceAccess } from './source-access.ts';

export const WORKSPACE_KNOWLEDGE_PROPERTIES = [
  'title', 'type', 'source', 'evidence_status', 'source_freshness', 'last_changed',
] as const;
export type WorkspaceKnowledgeProperty = typeof WORKSPACE_KNOWLEDGE_PROPERTIES[number];
export type WorkspaceKnowledgeSortProperty = WorkspaceKnowledgeProperty;
export type WorkspaceKnowledgeSortDirection = 'asc' | 'desc';
export type WorkspaceKnowledgeEvidenceStatus = 'cited' | 'source_backed' | 'missing_evidence';
export type WorkspaceKnowledgeFreshness = 'current' | 'due_soon' | 'stale' | 'unknown';
export type WorkspaceKnowledgeState =
  | 'empty_workspace'
  | 'access_required'
  | 'no_pages'
  | 'no_matches'
  | 'ready';

export interface WorkspaceKnowledgeFilters {
  search?: string;
  source_ids?: string[];
  types?: string[];
  evidence_statuses?: WorkspaceKnowledgeEvidenceStatus[];
  freshness_states?: WorkspaceKnowledgeFreshness[];
}

export interface WorkspaceKnowledgeSort {
  property: WorkspaceKnowledgeSortProperty;
  direction: WorkspaceKnowledgeSortDirection;
}

export interface WorkspaceKnowledgeRow {
  source_id: string;
  slug: string;
  title?: string;
  type?: string;
  source?: string;
  evidence_status?: WorkspaceKnowledgeEvidenceStatus;
  source_freshness?: WorkspaceKnowledgeFreshness;
  last_changed?: string;
}

export interface WorkspaceKnowledgeResult {
  state: WorkspaceKnowledgeState;
  rows: WorkspaceKnowledgeRow[];
  next_cursor: string | null;
  visible_properties: WorkspaceKnowledgeProperty[];
  sort: WorkspaceKnowledgeSort;
}

export interface ListWorkspaceKnowledgeInput {
  workspaceId: string;
  membershipId: string;
  filters?: WorkspaceKnowledgeFilters;
  sort?: WorkspaceKnowledgeSort;
  visibleProperties?: WorkspaceKnowledgeProperty[];
  limit?: number;
  cursor?: string;
  now?: string;
}

type KnowledgeEngine = Pick<BrainEngine, 'executeRaw'>;
type KnowledgeErrorCode =
  | 'invalid_filter'
  | 'invalid_sort'
  | 'invalid_property'
  | 'invalid_cursor'
  | 'invalid_limit'
  | 'invalid_saved_view_name'
  | 'saved_view_not_found';

export class WorkspaceKnowledgeError extends Error {
  constructor(readonly code: KnowledgeErrorCode) {
    super(code);
    this.name = 'WorkspaceKnowledgeError';
  }
}

const DEFAULT_PROPERTIES: WorkspaceKnowledgeProperty[] = [...WORKSPACE_KNOWLEDGE_PROPERTIES];
const DEFAULT_SORT: WorkspaceKnowledgeSort = { property: 'last_changed', direction: 'desc' };
const EVIDENCE_STATUSES = new Set<WorkspaceKnowledgeEvidenceStatus>(['cited', 'source_backed', 'missing_evidence']);
const FRESHNESS_STATES = new Set<WorkspaceKnowledgeFreshness>(['current', 'due_soon', 'stale', 'unknown']);
const PROPERTY_SET = new Set<WorkspaceKnowledgeProperty>(WORKSPACE_KNOWLEDGE_PROPERTIES);

/** Deterministic Evidence Status over `pages p`; shared with the Page detail projection. */
export const EVIDENCE_SQL = `CASE
  WHEN jsonb_typeof(p.frontmatter->'citations')='array'
       AND jsonb_array_length(p.frontmatter->'citations') > 0 THEN 'cited'
  WHEN p.import_filename IS NOT NULL THEN 'source_backed'
  ELSE 'missing_evidence'
END`;

const CADENCE_SQL = `CASE ws.expected_cadence
  WHEN 'hourly' THEN interval '1 hour'
  WHEN 'daily' THEN interval '1 day'
  WHEN 'weekly' THEN interval '7 days'
  ELSE NULL
END`;

/** Source Freshness over `workspace_sources ws` + `verification`; $3 is the evaluation time. */
export const FRESHNESS_SQL = `CASE
  WHEN ws.known_unsynchronized_revision IS NOT NULL THEN 'stale'
  WHEN verification.outcome='failed' THEN 'stale'
  WHEN ws.expected_cadence='manual' AND verification.outcome='succeeded' THEN 'current'
  WHEN ws.expected_cadence<>'manual' AND ws.last_verified_at IS NOT NULL
       AND ws.last_verified_at + (${CADENCE_SQL}) <= $3::timestamptz THEN 'stale'
  WHEN ws.expected_cadence<>'manual' AND ws.last_verified_at IS NOT NULL
       AND ws.last_verified_at + ((${CADENCE_SQL}) * 0.8) <= $3::timestamptz THEN 'due_soon'
  WHEN ws.expected_cadence<>'manual' AND ws.last_verified_at IS NOT NULL THEN 'current'
  ELSE 'unknown'
END`;

interface InternalKnowledgeRow {
  source_id: string;
  slug: string;
  title: string;
  type: string;
  source: string;
  evidence_status: WorkspaceKnowledgeEvidenceStatus;
  source_freshness: WorkspaceKnowledgeFreshness;
  last_changed: string | Date;
  sort_value: string | Date;
}

interface KnowledgeCursor {
  v: 1;
  query: string;
  as_of: string;
  value: string;
  source: string;
  slug: string;
}

function normalizeStringList(values: unknown, code: KnowledgeErrorCode, validator?: (value: string) => boolean): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > 50 || values.some(value => typeof value !== 'string' || value.length < 1 || value.length > 80 || (validator && !validator(value)))) {
    throw new WorkspaceKnowledgeError(code);
  }
  return [...new Set(values)].sort();
}

function normalizeFilters(filters: WorkspaceKnowledgeFilters | undefined): WorkspaceKnowledgeFilters {
  if (filters === undefined) return {};
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new WorkspaceKnowledgeError('invalid_filter');
  const keys = Object.keys(filters);
  if (keys.some(key => !['search', 'source_ids', 'types', 'evidence_statuses', 'freshness_states'].includes(key))) {
    throw new WorkspaceKnowledgeError('invalid_filter');
  }
  if (filters.search !== undefined && (typeof filters.search !== 'string' || filters.search.length > 200)) {
    throw new WorkspaceKnowledgeError('invalid_filter');
  }
  return {
    ...(filters.search?.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.source_ids !== undefined ? { source_ids: normalizeStringList(filters.source_ids, 'invalid_filter', isValidSourceId) } : {}),
    ...(filters.types !== undefined ? { types: normalizeStringList(filters.types, 'invalid_filter') } : {}),
    ...(filters.evidence_statuses !== undefined ? { evidence_statuses: normalizeStringList(filters.evidence_statuses, 'invalid_filter', value => EVIDENCE_STATUSES.has(value as WorkspaceKnowledgeEvidenceStatus)) as WorkspaceKnowledgeEvidenceStatus[] } : {}),
    ...(filters.freshness_states !== undefined ? { freshness_states: normalizeStringList(filters.freshness_states, 'invalid_filter', value => FRESHNESS_STATES.has(value as WorkspaceKnowledgeFreshness)) as WorkspaceKnowledgeFreshness[] } : {}),
  };
}

function normalizeSort(sort: WorkspaceKnowledgeSort | undefined): WorkspaceKnowledgeSort {
  if (sort === undefined) return { ...DEFAULT_SORT };
  if (!sort || typeof sort !== 'object' || !PROPERTY_SET.has(sort.property) || !['asc', 'desc'].includes(sort.direction)) {
    throw new WorkspaceKnowledgeError('invalid_sort');
  }
  return { property: sort.property, direction: sort.direction };
}

function normalizeProperties(properties: WorkspaceKnowledgeProperty[] | undefined): WorkspaceKnowledgeProperty[] {
  if (properties === undefined) return [...DEFAULT_PROPERTIES];
  if (!Array.isArray(properties) || properties.length < 1 || properties.length > WORKSPACE_KNOWLEDGE_PROPERTIES.length
      || properties.some(property => !PROPERTY_SET.has(property)) || !properties.includes('title')) {
    throw new WorkspaceKnowledgeError('invalid_property');
  }
  return [...new Set(properties)];
}

function queryIdentity(filters: WorkspaceKnowledgeFilters, sort: WorkspaceKnowledgeSort, properties: WorkspaceKnowledgeProperty[]): string {
  return createHash('sha256').update(JSON.stringify({ filters, sort, properties })).digest('base64url').slice(0, 24);
}

function encodeCursor(cursor: KnowledgeCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(value: string, expectedQuery: string): KnowledgeCursor {
  try {
    if (!value || value.length > 2048) throw new Error('invalid');
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<KnowledgeCursor>;
    if (parsed.v !== 1 || parsed.query !== expectedQuery || typeof parsed.value !== 'string'
        || typeof parsed.as_of !== 'string' || Number.isNaN(Date.parse(parsed.as_of))
        || typeof parsed.source !== 'string' || typeof parsed.slug !== 'string'
        || !isValidSourceId(parsed.source) || !parsed.slug || parsed.slug.length > 500) throw new Error('invalid');
    return parsed as KnowledgeCursor;
  } catch {
    throw new WorkspaceKnowledgeError('invalid_cursor');
  }
}

function toIsoTimestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function projectRow(row: InternalKnowledgeRow, properties: WorkspaceKnowledgeProperty[]): WorkspaceKnowledgeRow {
  const result: WorkspaceKnowledgeRow = { source_id: row.source_id, slug: row.slug };
  for (const property of properties) {
    if (property === 'last_changed') result.last_changed = toIsoTimestamp(row.last_changed);
    else result[property] = row[property] as never;
  }
  return result;
}

/** Latest verification outcome per Source; pairs with FRESHNESS_SQL's `verification` alias. */
export const VERIFICATION_JOIN_SQL = `LEFT JOIN (
         SELECT DISTINCT ON (workspace_id, source_id) workspace_id, source_id, outcome
           FROM workspace_source_verification_events
          ORDER BY workspace_id, source_id, completed_at DESC, event_id DESC
       ) verification ON verification.workspace_id=ws.workspace_id AND verification.source_id=ws.source_id`;

export async function tableExists(engine: KnowledgeEngine, tableName: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name=$1
     ) AS exists`,
    [tableName],
  );
  return rows[0]?.exists === true;
}

/** Resolve and execute the Workspace Knowledge projection entirely server-side. */
export async function listWorkspaceKnowledge(
  engine: KnowledgeEngine,
  input: ListWorkspaceKnowledgeInput,
): Promise<WorkspaceKnowledgeResult> {
  const filters = normalizeFilters(input.filters);
  const sort = normalizeSort(input.sort);
  const visibleProperties = normalizeProperties(input.visibleProperties);
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new WorkspaceKnowledgeError('invalid_limit');
  const query = queryIdentity(filters, sort, visibleProperties);
  const cursor = input.cursor ? decodeCursor(input.cursor, query) : undefined;
  const requestedEvaluationTime = new Date(input.now ?? Date.now());
  if (Number.isNaN(requestedEvaluationTime.getTime())) throw new WorkspaceKnowledgeError('invalid_filter');
  const evaluationTime = cursor?.as_of ?? requestedEvaluationTime.toISOString();

  const sources = await engine.executeRaw<{ source_id: string }>(
    `SELECT source_id
       FROM workspace_sources
      WHERE workspace_id=$1 AND archived=FALSE
      ORDER BY source_id`,
    [input.workspaceId],
  );
  const currentSourceIds = sources.map(source => source.source_id);
  const empty = (state: WorkspaceKnowledgeState): WorkspaceKnowledgeResult => ({
    state, rows: [], next_cursor: null, visible_properties: visibleProperties, sort,
  });
  if (currentSourceIds.length === 0) return empty('empty_workspace');

  const access = await resolvePrincipalSourceAccess(
    engine,
    { remote: true, principal: { kind: 'member', id: input.membershipId } },
    currentSourceIds,
  );
  const permittedSourceIds = access.kind === 'sources' ? access.sourceIds : currentSourceIds;
  if (permittedSourceIds.length === 0) return empty('access_required');
  if (!await tableExists(engine, 'pages')) return empty('no_pages');

  const sortExpressions: Record<WorkspaceKnowledgeSortProperty, string> = {
    title: 'lower(p.title)',
    type: 'lower(p.type)',
    source: 'lower(ws.name)',
    evidence_status: EVIDENCE_SQL,
    source_freshness: FRESHNESS_SQL,
    last_changed: 'p.updated_at',
  };
  const sortExpression = sortExpressions[sort.property];
  const params: unknown[] = [input.workspaceId, permittedSourceIds, evaluationTime];
  const permittedIsEveryActiveSource = permittedSourceIds.length === currentSourceIds.length
    && permittedSourceIds.every((sourceId, index) => sourceId === currentSourceIds[index]);
  const conditions = [
    ...(!permittedIsEveryActiveSource ? ['p.source_id = ANY($2::text[])'] : ['$2::text[] IS NOT NULL']),
    'p.deleted_at IS NULL',
  ];
  const bind = (value: unknown): string => { params.push(value); return `$${params.length}`; };

  if (filters.search) {
    const search = `%${filters.search.replace(/([\\%_])/g, '\\$1')}%`;
    const parameter = bind(search);
    conditions.push(`(p.title ILIKE ${parameter} ESCAPE '\\' OR p.slug ILIKE ${parameter} ESCAPE '\\')`);
  }
  if (filters.source_ids) conditions.push(`p.source_id = ANY(${bind(filters.source_ids)}::text[])`);
  if (filters.types) conditions.push(`p.type = ANY(${bind(filters.types)}::text[])`);
  if (filters.evidence_statuses) conditions.push(`(${EVIDENCE_SQL}) = ANY(${bind(filters.evidence_statuses)}::text[])`);
  if (filters.freshness_states) conditions.push(`(${FRESHNESS_SQL}) = ANY(${bind(filters.freshness_states)}::text[])`);
  if (cursor) {
    const value = bind(cursor.value);
    const source = bind(cursor.source);
    const slug = bind(cursor.slug);
    const cast = sort.property === 'last_changed' ? '::timestamptz' : '::text';
    conditions.push(`(${sortExpression}, p.source_id, p.slug) ${sort.direction === 'asc' ? '>' : '<'} (${value}${cast}, ${source}, ${slug})`);
  }
  const requested = limit + 1;
  const direction = sort.direction.toUpperCase();
  const rows = await engine.executeRaw<InternalKnowledgeRow>(
    `SELECT p.source_id,
            p.slug,
            p.title,
            p.type,
            ws.name AS source,
            (${EVIDENCE_SQL}) AS evidence_status,
            (${FRESHNESS_SQL}) AS source_freshness,
            p.updated_at AS last_changed,
            (${sortExpression}) AS sort_value
       FROM pages p
       JOIN workspace_sources ws
         ON ws.workspace_id=$1 AND ws.source_id=p.source_id AND ws.archived=FALSE
       ${VERIFICATION_JOIN_SQL}
      WHERE ${conditions.join('\n        AND ')}
      ORDER BY ${sortExpression} ${direction}, p.source_id ${direction}, p.slug ${direction}
      LIMIT ${bind(requested)}::integer`,
    params,
  );
  const hasNext = rows.length > limit;
  const page = hasNext ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor = hasNext && last ? encodeCursor({
    v: 1,
    query,
    as_of: evaluationTime,
    value: toIsoTimestamp(last.sort_value),
    source: last.source_id,
    slug: last.slug,
  }) : null;
  const filtered = Object.keys(filters).length > 0;
  return {
    state: page.length > 0 || cursor ? 'ready' : filtered ? 'no_matches' : 'no_pages',
    rows: page.map(row => projectRow(row, visibleProperties)),
    next_cursor: nextCursor,
    visible_properties: visibleProperties,
    sort,
  };
}

export interface WorkspaceSavedView {
  view_id: string;
  target_collection: 'knowledge';
  name: string;
  filters: WorkspaceKnowledgeFilters;
  sort: WorkspaceKnowledgeSort;
  visible_properties: WorkspaceKnowledgeProperty[];
  created_at: string;
  updated_at: string;
}

export interface CreateWorkspaceSavedViewInput {
  workspaceId: string;
  membershipId: string;
  name: string;
  filters?: WorkspaceKnowledgeFilters;
  sort?: WorkspaceKnowledgeSort;
  visibleProperties?: WorkspaceKnowledgeProperty[];
}

export interface UpdateWorkspaceSavedViewInput {
  workspaceId: string;
  membershipId: string;
  viewId: string;
  name?: string;
  filters?: WorkspaceKnowledgeFilters;
  sort?: WorkspaceKnowledgeSort;
  visibleProperties?: WorkspaceKnowledgeProperty[];
}

interface SavedViewRow {
  view_id: string;
  target_collection: 'knowledge';
  name: string;
  filters: WorkspaceKnowledgeFilters | string;
  sort: WorkspaceKnowledgeSort | string;
  visible_properties: WorkspaceKnowledgeProperty[] | string;
  created_at: string | Date;
  updated_at: string | Date;
}

function normalizeSavedViewName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > 80) {
    throw new WorkspaceKnowledgeError('invalid_saved_view_name');
  }
  return name.trim();
}

function jsonValue<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function savedView(row: SavedViewRow): WorkspaceSavedView {
  return {
    view_id: row.view_id,
    target_collection: row.target_collection,
    name: row.name,
    filters: normalizeFilters(jsonValue(row.filters)),
    sort: normalizeSort(jsonValue(row.sort)),
    visible_properties: normalizeProperties(jsonValue(row.visible_properties)),
    created_at: toIsoTimestamp(row.created_at),
    updated_at: toIsoTimestamp(row.updated_at),
  };
}

async function getWorkspaceSavedView(
  engine: KnowledgeEngine,
  workspaceId: string,
  membershipId: string,
  viewId: string,
): Promise<WorkspaceSavedView> {
  const rows = await engine.executeRaw<SavedViewRow>(
    `SELECT view_id, target_collection, name, filters, sort, visible_properties, created_at, updated_at
       FROM workspace_saved_views
      WHERE workspace_id=$1 AND owner_membership_id=$2 AND view_id=$3`,
    [workspaceId, membershipId, viewId],
  );
  if (!rows[0]) throw new WorkspaceKnowledgeError('saved_view_not_found');
  return savedView(rows[0]);
}

export async function createWorkspaceSavedView(
  engine: KnowledgeEngine,
  input: CreateWorkspaceSavedViewInput,
): Promise<WorkspaceSavedView> {
  const name = normalizeSavedViewName(input.name);
  const filters = normalizeFilters(input.filters);
  const sort = normalizeSort(input.sort);
  const properties = normalizeProperties(input.visibleProperties);
  const rows = await engine.executeRaw<SavedViewRow>(
    `INSERT INTO workspace_saved_views
      (view_id, workspace_id, owner_membership_id, target_collection, name, filters, sort, visible_properties)
     VALUES ($1, $2, $3, 'knowledge', $4, $5::text::jsonb, $6::text::jsonb, $7::text::jsonb)
     RETURNING view_id, target_collection, name, filters, sort, visible_properties, created_at, updated_at`,
    [randomUUID(), input.workspaceId, input.membershipId, name, JSON.stringify(filters), JSON.stringify(sort), JSON.stringify(properties)],
  );
  return savedView(rows[0]);
}

export async function listWorkspaceSavedViews(
  engine: KnowledgeEngine,
  workspaceId: string,
  membershipId: string,
): Promise<WorkspaceSavedView[]> {
  const rows = await engine.executeRaw<SavedViewRow>(
    `SELECT view_id, target_collection, name, filters, sort, visible_properties, created_at, updated_at
       FROM workspace_saved_views
      WHERE workspace_id=$1 AND owner_membership_id=$2 AND target_collection='knowledge'
      ORDER BY updated_at DESC, view_id DESC`,
    [workspaceId, membershipId],
  );
  return rows.map(savedView);
}

export async function updateWorkspaceSavedView(
  engine: KnowledgeEngine,
  input: UpdateWorkspaceSavedViewInput,
): Promise<WorkspaceSavedView> {
  const existing = await getWorkspaceSavedView(engine, input.workspaceId, input.membershipId, input.viewId);
  const name = input.name === undefined ? existing.name : normalizeSavedViewName(input.name);
  const filters = input.filters === undefined ? existing.filters : normalizeFilters(input.filters);
  const sort = input.sort === undefined ? existing.sort : normalizeSort(input.sort);
  const properties = input.visibleProperties === undefined ? existing.visible_properties : normalizeProperties(input.visibleProperties);
  const rows = await engine.executeRaw<SavedViewRow>(
    `UPDATE workspace_saved_views
        SET name=$4, filters=$5::text::jsonb, sort=$6::text::jsonb, visible_properties=$7::text::jsonb, updated_at=now()
      WHERE workspace_id=$1 AND owner_membership_id=$2 AND view_id=$3
      RETURNING view_id, target_collection, name, filters, sort, visible_properties, created_at, updated_at`,
    [input.workspaceId, input.membershipId, input.viewId, name, JSON.stringify(filters), JSON.stringify(sort), JSON.stringify(properties)],
  );
  if (!rows[0]) throw new WorkspaceKnowledgeError('saved_view_not_found');
  return savedView(rows[0]);
}

export async function deleteWorkspaceSavedView(
  engine: KnowledgeEngine,
  workspaceId: string,
  membershipId: string,
  viewId: string,
): Promise<void> {
  const rows = await engine.executeRaw<{ view_id: string }>(
    `DELETE FROM workspace_saved_views
      WHERE workspace_id=$1 AND owner_membership_id=$2 AND view_id=$3
      RETURNING view_id`,
    [workspaceId, membershipId, viewId],
  );
  if (!rows[0]) throw new WorkspaceKnowledgeError('saved_view_not_found');
}

export async function openWorkspaceSavedView(
  engine: KnowledgeEngine,
  input: {
    workspaceId: string;
    membershipId: string;
    viewId: string;
    cursor?: string;
    limit?: number;
    now?: string;
  },
): Promise<{ view: WorkspaceSavedView; knowledge: WorkspaceKnowledgeResult }> {
  const view = await getWorkspaceSavedView(engine, input.workspaceId, input.membershipId, input.viewId);
  const knowledge = await listWorkspaceKnowledge(engine, {
    workspaceId: input.workspaceId,
    membershipId: input.membershipId,
    filters: view.filters,
    sort: view.sort,
    visibleProperties: view.visible_properties,
    cursor: input.cursor,
    limit: input.limit,
    now: input.now,
  });
  return { view, knowledge };
}
