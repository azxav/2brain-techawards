import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import {
  appendWorkspaceAuditEvent,
  appendWorkspaceChangeEvent,
  runProtectedWorkspaceMutation,
} from './events.ts';

type ExportEngine = Pick<BrainEngine, 'executeRaw' | 'transaction'>;
type ReadEngine = Pick<BrainEngine, 'executeRaw'>;
type SnapshotEngine = Pick<BrainEngine, 'executeRaw' | 'transaction' | 'kind'>;

export const WORKSPACE_EXPORT_FORMAT_VERSION = '2brain-workspace-export/1';

/** Data classes the archive retains, named in the manifest for interpretation. */
export const WORKSPACE_EXPORT_RETAINED_DATA_CLASSES = [
  'pages_markdown',
  'page_metadata',
  'page_versions',
  'sources',
  'members',
  'agents',
  'attention',
  'change_events',
  'manifest',
] as const;

/**
 * Secret classes the archive proves absent. The builder never reads the tables
 * or columns that hold these, so portability cannot become an exfiltration
 * path. The manifest advertises the exclusion and the archive-inspection tests
 * assert planted values of each class never reach a filename or content.
 */
export const WORKSPACE_EXPORT_EXCLUDED_SECRET_CLASSES = [
  'credentials',
  'tokens',
  'sessions',
  'magic_links',
  'invitation_secrets',
  'bootstrap_material',
  'full_request_parameters',
  'provider_secrets',
  'managed_clone_internals',
  'raw_prompts',
] as const;

export type WorkspaceExportState = 'queued' | 'running' | 'completed' | 'failed';

export interface ExportRow {
  export_id: string;
  workspace_id: string;
  requested_by_membership_id: string;
  state: WorkspaceExportState;
  progress: number;
  outcome_summary: string | null;
  error_code: string | null;
  error_summary: string | null;
  retryable: boolean;
  cancel_requested: boolean;
  cancellation_safe: boolean;
  attempt: number;
  max_attempts: number;
  idempotency_key: string;
  idempotency_fingerprint: string;
  request_id: string;
  lease_owner: string | null;
  lease_expires_at: string | Date | null;
  available_at: string | Date | null;
  snapshot_at: string | Date | null;
  manifest: unknown;
  record_counts: unknown;
  artifact_content: string | null;
  artifact_checksum: string | null;
  artifact_byte_size: number | null;
  expires_at: string | Date | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  created_at: string;
  updated_at: string;
}

export interface WorkspaceExportView {
  exportId: string;
  workspaceId: string;
  requestedByMembershipId: string;
  state: WorkspaceExportState;
  progress: number;
  outcome: string | null;
  error: null | { code: string; message: string; requestId: string };
  retryable: boolean;
  cancelRequested: boolean;
  cancellationSafe: boolean;
  attempt: number;
  maxAttempts: number;
  requestId: string;
  checksum: string | null;
  byteSize: number | null;
  recordCounts: Record<string, number> | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceExportEntry {
  path: string;
  content: string;
}

export interface WorkspaceExportManifest {
  format_version: string;
  schema_version: number;
  generated_at: string;
  workspace_id: string;
  export_id: string;
  openclaw_state_included: false;
  openclaw_backup: false;
  retained_data_classes: readonly string[];
  excluded_secret_classes: readonly string[];
  record_counts: Record<string, number>;
  integrity: {
    algorithm: 'sha256';
    archive_checksum: string;
    entries: { path: string; sha256: string; bytes: number }[];
  };
  warnings: string[];
}

export interface WorkspaceExportArchive {
  entries: WorkspaceExportEntry[];
  manifest: WorkspaceExportManifest;
  recordCounts: Record<string, number>;
  content: string;
  checksum: string;
  byteSize: number;
}

export type WorkspaceExportErrorCode =
  | 'workspace_id_required'
  | 'request_id_required'
  | 'idempotency_key_required'
  | 'idempotency_key_reused'
  | 'membership_id_required'
  | 'worker_id_required'
  | 'export_not_found'
  | 'export_not_ready'
  | 'export_expired'
  | 'export_not_retryable'
  | 'export_not_cancellable';

export class WorkspaceExportError extends Error {
  constructor(public readonly code: WorkspaceExportErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceExportError';
  }
}

function requireText(value: string | undefined, code: WorkspaceExportErrorCode, maxLength = 200): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new WorkspaceExportError(code, code);
  }
  return normalized;
}

function isoTimestamp(value: string | Date | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

/**
 * Remove any embedded credential (`https://user:token@host/...`) from a Git
 * remote before it enters the archive. `parseRemoteUrl` already constrains
 * connect-time input to HTTPS, but the export re-sanitizes defensively so a
 * legacy or hand-edited row can never surface userinfo.
 */
function sanitizeRemoteUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^/@\s]*@/, '//');
  }
}

export function exportView(row: ExportRow): WorkspaceExportView {
  return {
    exportId: row.export_id,
    workspaceId: row.workspace_id,
    requestedByMembershipId: row.requested_by_membership_id,
    state: row.state,
    progress: Number(row.progress),
    outcome: row.outcome_summary,
    error: row.error_code && row.error_summary
      ? { code: row.error_code, message: row.error_summary, requestId: row.request_id }
      : null,
    retryable: row.retryable,
    cancelRequested: row.cancel_requested,
    cancellationSafe: row.cancellation_safe,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    requestId: row.request_id,
    checksum: row.artifact_checksum,
    byteSize: row.artifact_byte_size === null || row.artifact_byte_size === undefined
      ? null
      : Number(row.artifact_byte_size),
    recordCounts: parseJson<Record<string, number>>(row.record_counts),
    expiresAt: isoTimestamp(row.expires_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function exportFingerprint(workspaceId: string): string {
  return sha256(JSON.stringify({ kind: 'workspace.export', workspaceId }));
}

async function readExport(
  engine: ReadEngine,
  workspaceId: string,
  exportId: string,
): Promise<ExportRow | null> {
  const rows = await engine.executeRaw<ExportRow>(
    'SELECT * FROM workspace_exports WHERE workspace_id=$1 AND export_id=$2',
    [workspaceId, exportId],
  );
  return rows[0] ?? null;
}

async function readExportByIdempotencyKey(
  engine: ReadEngine,
  workspaceId: string,
  idempotencyKey: string,
): Promise<ExportRow | null> {
  const rows = await engine.executeRaw<ExportRow>(
    'SELECT * FROM workspace_exports WHERE workspace_id=$1 AND idempotency_key=$2',
    [workspaceId, idempotencyKey],
  );
  return rows[0] ?? null;
}

export async function requestWorkspaceExport(
  engine: ExportEngine,
  input: {
    workspaceId: string;
    actorMembershipId: string;
    requestId: string;
    idempotencyKey: string;
  },
): Promise<WorkspaceExportView> {
  const workspaceId = requireText(input.workspaceId, 'workspace_id_required', 128);
  const actorMembershipId = requireText(input.actorMembershipId, 'membership_id_required');
  const requestId = requireText(input.requestId, 'request_id_required');
  const idempotencyKey = requireText(input.idempotencyKey, 'idempotency_key_required');
  const fingerprint = exportFingerprint(workspaceId);

  const existing = await readExportByIdempotencyKey(engine, workspaceId, idempotencyKey);
  if (existing) {
    if (existing.idempotency_fingerprint !== fingerprint) {
      throw new WorkspaceExportError('idempotency_key_reused', 'idempotency_key_reused');
    }
    return exportView(existing);
  }

  const exportId = randomUUID();
  const mutation = await runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: actorMembershipId },
    action: 'export.request',
    target: { type: 'workspace_export', id: exportId },
    requestId,
    after: { state: 'queued' },
  }, async transaction => {
    const inserted = await transaction.executeRaw<ExportRow>(
      `INSERT INTO workspace_exports (
         export_id, workspace_id, requested_by_membership_id,
         idempotency_key, idempotency_fingerprint, request_id
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [exportId, workspaceId, actorMembershipId, idempotencyKey, fingerprint, requestId],
    );
    if (inserted[0]) return { view: exportView(inserted[0]), created: true };
    const duplicate = await readExportByIdempotencyKey(transaction, workspaceId, idempotencyKey);
    if (!duplicate) throw new Error('queued_export_not_found');
    if (duplicate.idempotency_fingerprint !== fingerprint) {
      throw new WorkspaceExportError('idempotency_key_reused', 'idempotency_key_reused');
    }
    return { view: exportView(duplicate), created: false };
  }, { isMaterialChange: result => result.created });
  return mutation.view;
}

export async function getWorkspaceExport(
  engine: ReadEngine,
  workspaceId: string,
  exportId: string,
): Promise<WorkspaceExportView | null> {
  const row = await readExport(engine, workspaceId, exportId);
  return row ? exportView(row) : null;
}

export async function listWorkspaceExports(
  engine: ReadEngine,
  workspaceId: string,
): Promise<WorkspaceExportView[]> {
  const rows = await engine.executeRaw<ExportRow>(
    `SELECT * FROM workspace_exports
      WHERE workspace_id=$1
      ORDER BY created_at DESC, export_id DESC`,
    [workspaceId],
  );
  return rows.map(exportView);
}

export interface WorkspaceExportArtifact {
  manifest: WorkspaceExportManifest | null;
  checksum: string | null;
  byteSize: number | null;
  content: string;
  expiresAt: string | null;
}

/**
 * Read a completed, unexpired archive. Retrieval of a protected artifact is an
 * audited access rather than a state change, so it appends only an Audit Event.
 */
export async function retrieveWorkspaceExportArtifact(
  engine: ReadEngine,
  input: {
    workspaceId: string;
    exportId: string;
    actorMembershipId: string;
    requestId: string;
    now?: string;
  },
): Promise<WorkspaceExportArtifact> {
  const workspaceId = requireText(input.workspaceId, 'workspace_id_required', 128);
  const actorMembershipId = requireText(input.actorMembershipId, 'membership_id_required');
  const requestId = requireText(input.requestId, 'request_id_required');
  const row = await readExport(engine, workspaceId, input.exportId);
  if (!row) throw new WorkspaceExportError('export_not_found', 'export_not_found');
  if (row.state !== 'completed' || !row.artifact_content) {
    throw new WorkspaceExportError('export_not_ready', 'export_not_ready');
  }
  const now = input.now ?? new Date().toISOString();
  if (row.expires_at && new Date(row.expires_at).getTime() <= new Date(now).getTime()) {
    throw new WorkspaceExportError('export_expired', 'export_expired');
  }
  await appendWorkspaceAuditEvent(engine, {
    actor: { kind: 'member', id: actorMembershipId },
    action: 'export.retrieve',
    target: { type: 'workspace_export', id: row.export_id },
    requestId,
    outcome: 'succeeded',
    before: { state: 'completed' },
    after: { state: 'completed' },
  });
  return {
    manifest: parseJson<WorkspaceExportManifest>(row.manifest),
    checksum: row.artifact_checksum,
    byteSize: row.artifact_byte_size === null || row.artifact_byte_size === undefined
      ? null
      : Number(row.artifact_byte_size),
    content: row.artifact_content,
    expiresAt: isoTimestamp(row.expires_at),
  };
}

export async function retryWorkspaceExport(
  engine: ExportEngine,
  input: {
    workspaceId: string;
    exportId: string;
    actorMembershipId: string;
    requestId: string;
  },
): Promise<WorkspaceExportView> {
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'export.retry',
    target: { type: 'workspace_export', id: input.exportId },
    requestId: input.requestId,
    before: { state: 'failed' },
    after: { state: 'queued' },
  }, async transaction => {
    const rows = await transaction.executeRaw<ExportRow>(
      `UPDATE workspace_exports
          SET state='queued', progress=0, outcome_summary=NULL, error_code=NULL, error_summary=NULL,
              cancel_requested=FALSE, cancellation_safe=TRUE, retryable=TRUE, request_id=$3,
              manifest=NULL, record_counts=NULL, artifact_content=NULL, artifact_checksum=NULL,
              artifact_byte_size=NULL, expires_at=NULL, snapshot_at=NULL,
              lease_owner=NULL, lease_expires_at=NULL, available_at=now(), completed_at=NULL, updated_at=now()
        WHERE workspace_id=$1 AND export_id=$2 AND state='failed' AND retryable=TRUE
          AND attempt < max_attempts
        RETURNING *`,
      [input.workspaceId, input.exportId, input.requestId],
    );
    if (!rows[0]) throw new WorkspaceExportError('export_not_retryable', 'export_not_retryable');
    return exportView(rows[0]);
  });
}

export async function cancelWorkspaceExport(
  engine: ExportEngine,
  input: {
    workspaceId: string;
    exportId: string;
    actorMembershipId: string;
    requestId: string;
  },
): Promise<WorkspaceExportView> {
  const current = await readExport(engine, input.workspaceId, input.exportId);
  if (!current) throw new WorkspaceExportError('export_not_found', 'export_not_found');
  if (current.state !== 'queued' && current.state !== 'running') {
    throw new WorkspaceExportError('export_not_cancellable', 'export_not_cancellable');
  }
  return runProtectedWorkspaceMutation(engine, {
    actor: { kind: 'member', id: input.actorMembershipId },
    action: 'export.cancel',
    target: { type: 'workspace_export', id: input.exportId },
    requestId: input.requestId,
    before: { state: current.state },
    after: { state: current.state === 'queued' ? 'failed' : 'running', cancelRequested: true },
  }, async transaction => {
    const queuedRows = await transaction.executeRaw<ExportRow>(
      `UPDATE workspace_exports
          SET state='failed', error_code='operation_cancelled',
              error_summary='The export was cancelled before work began.',
              retryable=FALSE, cancel_requested=TRUE, cancellation_safe=FALSE,
              request_id=$3, completed_at=now(), updated_at=now()
        WHERE workspace_id=$1 AND export_id=$2 AND state='queued'
        RETURNING *`,
      [input.workspaceId, input.exportId, input.requestId],
    );
    if (queuedRows[0]) return exportView(queuedRows[0]);
    const runningRows = await transaction.executeRaw<ExportRow>(
      `UPDATE workspace_exports
          SET cancel_requested=TRUE, request_id=$3, updated_at=now()
        WHERE workspace_id=$1 AND export_id=$2 AND state='running'
        RETURNING *`,
      [input.workspaceId, input.exportId, input.requestId],
    );
    if (!runningRows[0]) throw new WorkspaceExportError('export_not_cancellable', 'export_not_cancellable');
    return exportView(runningRows[0]);
  });
}

// --- Archive construction ---------------------------------------------------

interface SourceExportRow {
  source_id: string;
  name: string;
  remote_url: string;
  expected_cadence: string;
  included_in_workspace_search: boolean;
  provisioning_state: string;
  archived: boolean;
  archived_at: string | Date | null;
  last_verified_at: string | Date | null;
  last_verified_revision: string | null;
  last_sync_at: string | Date | null;
  last_synced_revision: string | null;
  known_unsynchronized_revision: string | null;
  created_at: string | Date;
}

interface PageExportRow {
  source_id: string;
  slug: string;
  title: string;
  type: string;
  page_kind: string;
  compiled_truth: string;
  frontmatter: unknown;
  content_hash: string | null;
  effective_date: string | Date | null;
  effective_date_source: string | null;
  import_filename: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface PageVersionExportRow {
  source_id: string;
  slug: string;
  compiled_truth: string;
  frontmatter: unknown;
  snapshot_at: string | Date;
}

interface MembershipExportRow {
  membership_id: string;
  role: string;
  status: string;
  normalized_email: string;
  email_confirmed_at: string | Date | null;
  created_at: string | Date;
}

interface AgentExportRow {
  agent_id: string;
  name: string;
  purpose: string;
  owner_membership_id: string;
  status: string;
  scope: string;
  created_at: string | Date;
  revoked_at: string | Date | null;
}

interface PolicyRow {
  principal_kind: string;
  principal_id: string;
  access_mode: string;
}

interface GrantRow {
  principal_kind: string;
  principal_id: string;
  source_id: string;
}

interface AttentionItemExportRow {
  item_id: string;
  category: string;
  condition_type: string;
  resource_type: string;
  resource_id: string;
  summary: string;
  evidence: unknown;
  status: string;
  assignee_membership_id: string | null;
  dismiss_reason: string | null;
  detected_at: string | Date;
  last_verified_at: string | Date | null;
  resolved_at: string | Date | null;
  dismissed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface AttentionHistoryExportRow {
  item_id: string;
  event: string;
  actor_kind: string;
  actor_id: string;
  detail: unknown;
  occurred_at: string | Date;
}

interface ChangeEventExportRow {
  event_id: string;
  actor_kind: string;
  actor_id: string;
  resource_type: string;
  resource_id: string;
  summary: string;
  request_id: string;
  occurred_at: string | Date;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function sourceAccessFor(
  kind: string,
  principalId: string,
  policies: Map<string, string>,
  grants: Map<string, string[]>,
): { mode: string; source_ids: string[] } {
  const key = `${kind}:${principalId}`;
  // Absence of a policy row resolves to None, never a fallback to All.
  const mode = policies.get(key) ?? 'none';
  const sourceIds = mode === 'specific' ? (grants.get(key) ?? []).slice().sort() : [];
  return { mode, source_ids: sourceIds };
}

/**
 * Read every retained data class inside one consistent snapshot and assemble
 * the portable archive. On Postgres the read runs at REPEATABLE READ so a
 * concurrent mutation cannot tear the archive across tables; PGLite serializes
 * on its single connection. Only allowlisted tables and columns are read, which
 * is what proves the excluded secret classes absent.
 */
export async function buildWorkspaceExportArchive(
  engine: SnapshotEngine,
  input: { workspaceId: string; exportId: string; generatedAt: string },
): Promise<WorkspaceExportArchive> {
  const workspaceId = input.workspaceId;
  return engine.transaction(async transaction => {
    if (transaction.kind === 'postgres') {
      await transaction.executeRaw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    }

    const sources = await transaction.executeRaw<SourceExportRow>(
      `SELECT source_id, name, remote_url, expected_cadence, included_in_workspace_search,
              provisioning_state, archived, archived_at, last_verified_at, last_verified_revision,
              last_sync_at, last_synced_revision, known_unsynchronized_revision, created_at
         FROM workspace_sources
        WHERE workspace_id=$1 AND deleted=FALSE
        ORDER BY created_at, source_id`,
      [workspaceId],
    );

    const pages = await transaction.executeRaw<PageExportRow>(
      `SELECT p.source_id, p.slug, p.title, p.type, p.page_kind, p.compiled_truth, p.frontmatter,
              p.content_hash, p.effective_date, p.effective_date_source, p.import_filename,
              p.created_at, p.updated_at
         FROM pages p
         JOIN workspace_sources ws
           ON ws.source_id = p.source_id AND ws.workspace_id = $1 AND ws.deleted = FALSE
        WHERE p.deleted_at IS NULL
        ORDER BY p.source_id, p.slug`,
      [workspaceId],
    );

    const pageVersions = await transaction.executeRaw<PageVersionExportRow>(
      `SELECT p.source_id, p.slug, pv.compiled_truth, pv.frontmatter, pv.snapshot_at
         FROM page_versions pv
         JOIN pages p ON p.id = pv.page_id
         JOIN workspace_sources ws
           ON ws.source_id = p.source_id AND ws.workspace_id = $1 AND ws.deleted = FALSE
        WHERE p.deleted_at IS NULL
        ORDER BY p.source_id, p.slug, pv.snapshot_at, pv.id`,
      [workspaceId],
    );

    const memberships = await transaction.executeRaw<MembershipExportRow>(
      `SELECT m.membership_id, m.role, m.status,
              i.normalized_email, i.email_confirmed_at, i.created_at
         FROM workspace_memberships m
         JOIN workspace_identities i ON i.identity_id = m.identity_id
        WHERE m.workspace_id=$1
        ORDER BY i.normalized_email, m.membership_id`,
      [workspaceId],
    );

    const agents = await transaction.executeRaw<AgentExportRow>(
      `SELECT agent_id, name, purpose, owner_membership_id, status, scope, created_at, revoked_at
         FROM workspace_agents
        WHERE workspace_id=$1
        ORDER BY created_at, agent_id`,
      [workspaceId],
    );

    // Source Access policy is authorization, not credential material. Policies
    // and grants are global to the principal; the join keeps only principals
    // that belong to this Workspace's Members and Agents.
    const policyRows = await transaction.executeRaw<PolicyRow>(
      `SELECT p.principal_kind, p.principal_id, p.access_mode
         FROM workspace_principal_source_policies p
         LEFT JOIN workspace_memberships m
           ON p.principal_kind='member' AND m.membership_id = p.principal_id AND m.workspace_id=$1
         LEFT JOIN workspace_agents a
           ON p.principal_kind='agent' AND a.agent_id = p.principal_id AND a.workspace_id=$1
        WHERE m.membership_id IS NOT NULL OR a.agent_id IS NOT NULL`,
      [workspaceId],
    );
    const grantRows = await transaction.executeRaw<GrantRow>(
      `SELECT g.principal_kind, g.principal_id, g.source_id
         FROM workspace_source_grants g
         LEFT JOIN workspace_memberships m
           ON g.principal_kind='member' AND m.membership_id = g.principal_id AND m.workspace_id=$1
         LEFT JOIN workspace_agents a
           ON g.principal_kind='agent' AND a.agent_id = g.principal_id AND a.workspace_id=$1
        WHERE m.membership_id IS NOT NULL OR a.agent_id IS NOT NULL`,
      [workspaceId],
    );
    const policies = new Map<string, string>();
    for (const row of policyRows) policies.set(`${row.principal_kind}:${row.principal_id}`, row.access_mode);
    const grants = new Map<string, string[]>();
    for (const row of grantRows) {
      const key = `${row.principal_kind}:${row.principal_id}`;
      const list = grants.get(key) ?? [];
      list.push(row.source_id);
      grants.set(key, list);
    }

    const attentionItems = await transaction.executeRaw<AttentionItemExportRow>(
      `SELECT item_id, category, condition_type, resource_type, resource_id, summary, evidence,
              status, assignee_membership_id, dismiss_reason, detected_at, last_verified_at,
              resolved_at, dismissed_at, created_at, updated_at
         FROM workspace_attention_items
        WHERE workspace_id=$1
        ORDER BY detected_at, item_id`,
      [workspaceId],
    );
    const attentionHistory = await transaction.executeRaw<AttentionHistoryExportRow>(
      `SELECT h.item_id, h.event, h.actor_kind, h.actor_id, h.detail, h.occurred_at
         FROM workspace_attention_item_history h
         JOIN workspace_attention_items ai ON ai.item_id = h.item_id
        WHERE ai.workspace_id=$1
        ORDER BY h.item_id, h.occurred_at, h.history_id`,
      [workspaceId],
    );

    const changeEvents = await transaction.executeRaw<ChangeEventExportRow>(
      `SELECT event_id, actor_kind, actor_id, resource_type, resource_id, summary, request_id, occurred_at
         FROM workspace_change_events
        WHERE workspace_id=$1
        ORDER BY event_sequence`,
      [workspaceId],
    );

    // --- Assemble entries ---
    const entries: WorkspaceExportEntry[] = [];

    for (const page of pages) {
      const base = `pages/${page.source_id}/${page.slug}`;
      entries.push({ path: `${base}.md`, content: page.compiled_truth ?? '' });
      entries.push({
        path: `${base}.json`,
        content: stableStringify({
          source_id: page.source_id,
          slug: page.slug,
          title: page.title,
          type: page.type,
          page_kind: page.page_kind,
          content_hash: page.content_hash,
          frontmatter: parseJson(page.frontmatter) ?? {},
          effective_date: isoTimestamp(page.effective_date),
          effective_date_source: page.effective_date_source,
          import_filename: page.import_filename,
          created_at: isoTimestamp(page.created_at),
          updated_at: isoTimestamp(page.updated_at),
        }),
      });
    }

    const versionsByPage = new Map<string, PageVersionExportRow[]>();
    for (const version of pageVersions) {
      const key = `${version.source_id}/${version.slug}`;
      const list = versionsByPage.get(key) ?? [];
      list.push(version);
      versionsByPage.set(key, list);
    }
    for (const [key, versions] of versionsByPage) {
      entries.push({
        path: `page-versions/${key}.json`,
        content: stableStringify(versions.map(version => ({
          snapshot_at: isoTimestamp(version.snapshot_at),
          compiled_truth: version.compiled_truth,
          frontmatter: parseJson(version.frontmatter) ?? {},
        }))),
      });
    }

    entries.push({
      path: 'sources.json',
      content: stableStringify(sources.map(source => ({
        source_id: source.source_id,
        name: source.name,
        remote_url: sanitizeRemoteUrl(source.remote_url),
        expected_cadence: source.expected_cadence,
        included_in_workspace_search: source.included_in_workspace_search,
        provisioning_state: source.provisioning_state,
        lifecycle_state: source.archived ? 'archived' : 'active',
        archived_at: isoTimestamp(source.archived_at),
        last_verified_at: isoTimestamp(source.last_verified_at),
        last_verified_revision: source.last_verified_revision,
        last_sync_at: isoTimestamp(source.last_sync_at),
        last_synced_revision: source.last_synced_revision,
        known_unsynchronized_revision: source.known_unsynchronized_revision,
        created_at: isoTimestamp(source.created_at),
      }))),
    });

    entries.push({
      path: 'members.json',
      content: stableStringify(memberships.map(member => ({
        membership_id: member.membership_id,
        email: member.normalized_email,
        email_confirmed: member.email_confirmed_at !== null,
        role: member.role,
        status: member.status,
        source_access: sourceAccessFor('member', member.membership_id, policies, grants),
        created_at: isoTimestamp(member.created_at),
      }))),
    });

    entries.push({
      path: 'agents.json',
      content: stableStringify(agents.map(agent => ({
        agent_id: agent.agent_id,
        name: agent.name,
        purpose: agent.purpose,
        owner_membership_id: agent.owner_membership_id,
        status: agent.status,
        scope: agent.scope,
        source_access: sourceAccessFor('agent', agent.agent_id, policies, grants),
        created_at: isoTimestamp(agent.created_at),
        revoked_at: isoTimestamp(agent.revoked_at),
      }))),
    });

    const historyByItem = new Map<string, AttentionHistoryExportRow[]>();
    for (const event of attentionHistory) {
      const list = historyByItem.get(event.item_id) ?? [];
      list.push(event);
      historyByItem.set(event.item_id, list);
    }
    entries.push({
      path: 'attention.json',
      content: stableStringify(attentionItems.map(item => ({
        item_id: item.item_id,
        category: item.category,
        condition_type: item.condition_type,
        resource_type: item.resource_type,
        resource_id: item.resource_id,
        summary: item.summary,
        evidence: parseJson(item.evidence) ?? {},
        status: item.status,
        assignee_membership_id: item.assignee_membership_id,
        dismiss_reason: item.dismiss_reason,
        detected_at: isoTimestamp(item.detected_at),
        last_verified_at: isoTimestamp(item.last_verified_at),
        resolved_at: isoTimestamp(item.resolved_at),
        dismissed_at: isoTimestamp(item.dismissed_at),
        created_at: isoTimestamp(item.created_at),
        updated_at: isoTimestamp(item.updated_at),
        history: (historyByItem.get(item.item_id) ?? []).map(event => ({
          event: event.event,
          actor_kind: event.actor_kind,
          actor_id: event.actor_id,
          detail: parseJson(event.detail) ?? {},
          occurred_at: isoTimestamp(event.occurred_at),
        })),
      }))),
    });

    entries.push({
      path: 'change-events.json',
      content: stableStringify(changeEvents.map(event => ({
        event_id: event.event_id,
        actor_kind: event.actor_kind,
        actor_id: event.actor_id,
        resource_type: event.resource_type,
        resource_id: event.resource_id,
        summary: event.summary,
        request_id: event.request_id,
        occurred_at: isoTimestamp(event.occurred_at),
      }))),
    });

    entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const recordCounts: Record<string, number> = {
      pages: pages.length,
      page_versions: pageVersions.length,
      sources: sources.length,
      members: memberships.length,
      agents: agents.length,
      attention_items: attentionItems.length,
      change_events: changeEvents.length,
    };

    const integrityEntries = entries.map(entry => ({
      path: entry.path,
      sha256: sha256(entry.content),
      bytes: byteLength(entry.content),
    }));
    const archiveChecksum = sha256(integrityEntries.map(entry => `${entry.path}:${entry.sha256}`).join('\n'));

    const manifest: WorkspaceExportManifest = {
      format_version: WORKSPACE_EXPORT_FORMAT_VERSION,
      schema_version: 1,
      generated_at: input.generatedAt,
      workspace_id: workspaceId,
      export_id: input.exportId,
      openclaw_state_included: false,
      openclaw_backup: false,
      retained_data_classes: WORKSPACE_EXPORT_RETAINED_DATA_CLASSES,
      excluded_secret_classes: WORKSPACE_EXPORT_EXCLUDED_SECRET_CLASSES,
      record_counts: recordCounts,
      integrity: { algorithm: 'sha256', archive_checksum: archiveChecksum, entries: integrityEntries },
      warnings: [],
    };
    const manifestEntry: WorkspaceExportEntry = { path: 'manifest.json', content: stableStringify(manifest) };
    const allEntries = [...entries, manifestEntry];

    const content = stableStringify({ format_version: WORKSPACE_EXPORT_FORMAT_VERSION, entries: allEntries });
    return {
      entries: allEntries,
      manifest,
      recordCounts,
      content,
      checksum: sha256(content),
      byteSize: byteLength(content),
    };
  });
}

// --- Durable worker ---------------------------------------------------------

async function failExhaustedExport(engine: ExportEngine): Promise<WorkspaceExportView | null> {
  return engine.transaction(async transaction => {
    const rows = await transaction.executeRaw<ExportRow>(
      `WITH exhausted AS (
         SELECT export_id FROM workspace_exports
          WHERE state='running' AND lease_expires_at < now() AND attempt >= max_attempts
          ORDER BY lease_expires_at, export_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE workspace_exports e
          SET state='failed', error_code='export_exhausted',
              error_summary='The Workspace Export stopped after repeated interrupted attempts.',
              retryable=FALSE, cancellation_safe=FALSE, lease_owner=NULL, lease_expires_at=NULL,
              completed_at=now(), updated_at=now()
         FROM exhausted
        WHERE e.export_id=exhausted.export_id
       RETURNING e.*`,
    );
    if (!rows[0]) return null;
    await appendWorkspaceAuditEvent(transaction, {
      actor: { kind: 'system', id: 'workspace-export-recovery' },
      action: 'export.fail',
      target: { type: 'workspace_export', id: rows[0].export_id },
      requestId: rows[0].request_id,
      outcome: 'succeeded',
      before: { state: 'running' },
      after: { state: 'failed' },
    });
    await appendWorkspaceChangeEvent(transaction, {
      actor: { kind: 'system', id: 'workspace-export-recovery' },
      action: 'export.fail',
      resource: { type: 'workspace_export', id: rows[0].export_id },
      requestId: rows[0].request_id,
      workspaceId: rows[0].workspace_id,
    });
    return exportView(rows[0]);
  });
}

async function claimExport(
  engine: ExportEngine,
  workerId: string,
  leaseMs: number,
): Promise<ExportRow | null> {
  return engine.transaction(async transaction => {
    const rows = await transaction.executeRaw<ExportRow>(
      `WITH candidate AS (
         SELECT export_id FROM workspace_exports
          WHERE (
            (state='queued' AND available_at <= now())
            OR (state='running' AND lease_expires_at < now())
          )
            AND attempt < max_attempts
          ORDER BY created_at, export_id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE workspace_exports e
          SET state='running', progress=GREATEST(progress, 5),
              lease_owner=$1, lease_expires_at=now() + ($2 * interval '1 millisecond'),
              started_at=COALESCE(started_at, now()), snapshot_at=now(),
              updated_at=now(), attempt=attempt+1, cancellation_safe=TRUE
         FROM candidate
        WHERE e.export_id=candidate.export_id
       RETURNING e.*`,
      [workerId, leaseMs],
    );
    return rows[0] ?? null;
  });
}

type FinishOutcome =
  | { state: 'completed'; archive: WorkspaceExportArchive }
  | { state: 'failed'; code: string; summary: string; retryable: boolean };

async function finishExport(
  engine: ExportEngine,
  claimed: ExportRow,
  workerId: string,
  outcome: FinishOutcome,
): Promise<WorkspaceExportView> {
  return engine.transaction(async transaction => {
    const current = await transaction.executeRaw<{ cancel_requested: boolean }>(
      `SELECT cancel_requested FROM workspace_exports
        WHERE export_id=$1 AND lease_owner=$2 AND state='running' FOR UPDATE`,
      [claimed.export_id, workerId],
    );
    if (!current[0]) throw new Error('workspace_export_lease_lost');
    // A cancellation observed mid-build discards the artifact and records a
    // clean cancelled outcome instead of a partial archive.
    const cancelled = outcome.state === 'completed' && current[0].cancel_requested === true;

    let rows: ExportRow[];
    if (outcome.state === 'completed' && !cancelled) {
      const archive = outcome.archive;
      const summary = `Workspace Export ready (${archive.recordCounts.pages} Pages, ${archive.recordCounts.sources} Sources).`;
      rows = await transaction.executeRaw<ExportRow>(
        `UPDATE workspace_exports
            SET state='completed', progress=100, outcome_summary=$3,
                manifest=$4::jsonb, record_counts=$5::jsonb, artifact_content=$6,
                artifact_checksum=$7, artifact_byte_size=$8, error_code=NULL, error_summary=NULL,
                retryable=FALSE, cancellation_safe=FALSE, cancel_requested=FALSE,
                lease_owner=NULL, lease_expires_at=NULL,
                expires_at=now() + interval '30 days', completed_at=now(), updated_at=now()
          WHERE export_id=$1 AND lease_owner=$2 AND state='running'
          RETURNING *`,
        [
          claimed.export_id, workerId, summary,
          archive.manifest, archive.recordCounts, archive.content,
          archive.checksum, archive.byteSize,
        ],
      );
    } else {
      const effective = cancelled
        ? { code: 'operation_cancelled', summary: 'The export was cancelled before completion.', retryable: false }
        : (outcome as Extract<FinishOutcome, { state: 'failed' }>);
      rows = await transaction.executeRaw<ExportRow>(
        `UPDATE workspace_exports
            SET state='failed', error_code=$3, error_summary=$4, retryable=$5,
                cancellation_safe=FALSE, lease_owner=NULL, lease_expires_at=NULL,
                completed_at=now(), updated_at=now()
          WHERE export_id=$1 AND lease_owner=$2 AND state='running'
          RETURNING *`,
        [claimed.export_id, workerId, effective.code, effective.summary, effective.retryable],
      );
    }
    if (!rows[0]) throw new Error('workspace_export_lease_lost');

    const completed = rows[0].state === 'completed';
    const action = completed ? 'export.complete' as const : 'export.fail' as const;
    await appendWorkspaceAuditEvent(transaction, {
      actor: { kind: 'system', id: workerId },
      action,
      target: { type: 'workspace_export', id: claimed.export_id },
      requestId: claimed.request_id,
      outcome: 'succeeded',
      before: { state: 'running' },
      after: completed ? { state: 'completed' } : { state: 'failed' },
    });
    await appendWorkspaceChangeEvent(transaction, {
      actor: { kind: 'system', id: workerId },
      action,
      resource: { type: 'workspace_export', id: claimed.export_id },
      requestId: claimed.request_id,
      workspaceId: claimed.workspace_id,
    });
    return exportView(rows[0]);
  });
}

/**
 * Process at most one Workspace Export. Mirrors the Source Background Operation
 * worker: recover an attempt-exhausted lease, claim a queued or lease-expired
 * export, build the archive under a renewed lease, and record a durable
 * completion or retryable failure. A replacement worker that reclaims an expired
 * lease resumes cleanly because the finish write is fenced on the lease owner.
 */
export async function runWorkspaceExportWorkerOnce(
  engine: SnapshotEngine,
  options: { workerId: string; leaseMs?: number },
): Promise<WorkspaceExportView | null> {
  const workerId = requireText(options.workerId, 'worker_id_required');
  const leaseMs = Math.max(1_000, options.leaseMs ?? 30 * 60_000);

  const exhausted = await failExhaustedExport(engine);
  if (exhausted) return exhausted;

  const claimed = await claimExport(engine, workerId, leaseMs);
  if (!claimed) return null;

  if (claimed.cancel_requested) {
    return finishExport(engine, claimed, workerId, {
      state: 'failed',
      code: 'operation_cancelled',
      summary: 'The export was cancelled before work began.',
      retryable: false,
    });
  }

  await engine.executeRaw(
    'UPDATE workspace_exports SET progress=15, cancellation_safe=FALSE, updated_at=now() WHERE export_id=$1 AND lease_owner=$2',
    [claimed.export_id, workerId],
  );

  const leaseAbort = new AbortController();
  let leaseFailure: Error | null = null;
  const renewal = setInterval(() => {
    void engine.executeRaw<{ export_id: string }>(
      `UPDATE workspace_exports
          SET lease_expires_at=now() + ($3 * interval '1 millisecond'), updated_at=now()
        WHERE export_id=$1 AND state='running' AND lease_owner=$2
        RETURNING export_id`,
      [claimed.export_id, workerId, leaseMs],
    ).then(rows => {
      if (!rows[0]) throw new Error('workspace_export_lease_lost');
    }).catch(error => {
      leaseFailure = error instanceof Error ? error : new Error('workspace_export_lease_renewal_failed');
      leaseAbort.abort(leaseFailure);
    });
  }, Math.max(250, Math.floor(leaseMs / 3)));
  renewal.unref?.();

  try {
    const generatedAt = isoTimestamp(claimed.snapshot_at) ?? new Date().toISOString();
    const archive = await buildWorkspaceExportArchive(engine, {
      workspaceId: claimed.workspace_id,
      exportId: claimed.export_id,
      generatedAt,
    });
    if (leaseFailure) throw leaseFailure;
    return await finishExport(engine, claimed, workerId, { state: 'completed', archive });
  } catch (error) {
    if (leaseFailure || leaseAbort.signal.aborted) {
      throw leaseFailure ?? error;
    }
    const retryable = Number(claimed.attempt) < Number(claimed.max_attempts);
    return await finishExport(engine, claimed, workerId, {
      state: 'failed',
      code: 'export_failed',
      summary: 'The Workspace Export failed. Retry when the Workspace is reachable.',
      retryable,
    });
  } finally {
    clearInterval(renewal);
  }
}
