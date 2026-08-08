import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../core/engine.ts';
import { tableExists } from './knowledge.ts';
import { getWorkspacePage, type WorkspacePageDetail } from './page-detail.ts';
import {
  listWorkspaceSearchSources,
  searchWorkspaceKnowledge,
  type WorkspaceSearchResultRow,
  type WorkspaceSearchSource,
} from './search.ts';

type AskEngine = Pick<BrainEngine, 'executeRaw'>;

export type WorkspaceAskState =
  | 'queued'
  | 'running'
  | 'answered'
  | 'not_enough_evidence'
  | 'cancelled'
  | 'failed';

export interface WorkspaceAskCitation {
  sourceId: string;
  slug: string;
  title: string;
}

export interface WorkspaceAskSourceSummary {
  sourceId: string;
  name: string;
}

export interface WorkspaceAskTrustState {
  sourceId: string;
  freshness: string[];
  evidence: string[];
  condition?: 'no_matching_pages';
}

export interface WorkspaceAskView {
  id: string;
  question: string;
  state: WorkspaceAskState;
  progress: string;
  searchedSources: WorkspaceAskSourceSummary[];
  trustState: WorkspaceAskTrustState[];
  citations: WorkspaceAskCitation[];
  answer: string | null;
  evidenceGap: string | null;
  nextAction: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface WorkspaceAskSynthesisPage {
  sourceId: string;
  slug: string;
  title: string;
  body: string;
  evidenceStatus: string;
  sourceFreshness: string;
}

export type WorkspaceAskSynthesis =
  | { kind: 'answer'; answer: string; citations: { sourceId: string; slug: string }[] }
  | { kind: 'not_enough_evidence'; evidenceGap: string; nextAction: string };

export type WorkspaceAskSynthesizer = (input: {
  question: string;
  pages: WorkspaceAskSynthesisPage[];
  signal: AbortSignal;
  onProgress: (progress: string) => Promise<void>;
}) => Promise<WorkspaceAskSynthesis>;

/** Conservative built-in synthesis: quote only retrieved Page text and cite it. */
export const conservativeWorkspaceAskSynthesizer: WorkspaceAskSynthesizer = async input => {
  if (input.signal.aborted) throw new Error('ask_cancelled');
  const page = input.pages[0];
  if (!page) return {
    kind: 'not_enough_evidence',
    evidenceGap: 'No permitted Page supports this question.',
    nextAction: 'Refine the question or add and verify a Source containing the missing information.',
  };
  await input.onProgress('Preparing a cited answer');
  return {
    kind: 'answer',
    answer: page.body.slice(0, 1200),
    citations: [{ sourceId: page.sourceId, slug: page.slug }],
  };
};

type WorkspaceAskErrorCode = 'invalid_question' | 'ask_result_not_found' | 'ask_not_cancellable';

export class WorkspaceAskError extends Error {
  constructor(readonly code: WorkspaceAskErrorCode) {
    super(code);
    this.name = 'WorkspaceAskError';
  }
}

interface AskRow {
  ask_result_id: string;
  workspace_id: string;
  requester_membership_id: string;
  question: string;
  selected_source_ids: unknown;
  state: WorkspaceAskState;
  progress: string;
  searched_sources: unknown;
  authorization_sources: unknown;
  trust_state: unknown;
  citations: unknown;
  answer: string | null;
  evidence_gap: string | null;
  next_action: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  expires_at: string | Date;
}

const activeRuns = new Map<string, AbortController>();
const safeProgressMessages = new Set([
  'Expanding permitted Page relationships',
  'Synthesizing from permitted Pages',
  'Preparing a cited answer',
]);
const safeSynthesizerRefusal = {
  evidenceGap: 'Permitted Knowledge does not support a cited answer.',
  nextAction: 'Add or verify the missing evidence, then ask again.',
} as const;

function jsonValue<T>(value: unknown, fallback: T): T {
  if (typeof value === 'string') {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return (value ?? fallback) as T;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toView(row: AskRow): WorkspaceAskView {
  return {
    id: row.ask_result_id,
    question: row.question,
    state: row.state,
    progress: row.progress,
    searchedSources: jsonValue(row.searched_sources, []),
    trustState: jsonValue(row.trust_state, []),
    citations: jsonValue(row.citations, []),
    answer: row.answer,
    evidenceGap: row.evidence_gap,
    nextAction: row.next_action,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
  };
}

async function activeMembership(engine: AskEngine, workspaceId: string, membershipId: string): Promise<boolean> {
  const rows = await engine.executeRaw<{ membership_id: string }>(
    `SELECT membership_id FROM workspace_memberships
      WHERE workspace_id=$1 AND membership_id=$2 AND status='active'`,
    [workspaceId, membershipId],
  );
  return rows.length === 1;
}

async function askRow(engine: AskEngine, askResultId: string): Promise<AskRow | undefined> {
  return (await engine.executeRaw<AskRow>(
    `SELECT * FROM workspace_ask_results WHERE ask_result_id=$1 AND expires_at > now()`,
    [askResultId],
  ))[0];
}

function eligibleSources(all: WorkspaceSearchSource[], selected: string[]): WorkspaceAskSourceSummary[] {
  const filtered = selected.length > 0
    ? all.filter(source => selected.includes(source.source_id))
    : all.filter(source => source.included_in_workspace_search);
  return filtered.map(source => ({ sourceId: source.source_id, name: source.name }));
}

function trustState(sources: WorkspaceAskSourceSummary[], rows: WorkspaceSearchResultRow[]): WorkspaceAskTrustState[] {
  return sources.map(source => {
    const matches = rows.filter(row => row.source.source_id === source.sourceId);
    return {
      sourceId: source.sourceId,
      freshness: [...new Set(matches.map(row => row.source_freshness))].sort(),
      evidence: [...new Set(matches.map(row => row.evidence_status))].sort(),
      ...(matches.length === 0 ? { condition: 'no_matching_pages' as const } : {}),
    };
  });
}

async function currentEvidenceSnapshot(
  engine: AskEngine,
  row: AskRow,
  selected: string[],
  searchRows: WorkspaceSearchResultRow[],
): Promise<{
  sources: WorkspaceAskSourceSummary[];
  authorizationSources: string[];
  trust: WorkspaceAskTrustState[];
}> {
  const sources = eligibleSources(await listWorkspaceSearchSources(engine, {
    workspaceId: row.workspace_id,
    membershipId: row.requester_membership_id,
  }), selected);
  const currentIds = new Set(sources.map(source => source.sourceId));
  return {
    sources,
    authorizationSources: [...currentIds].sort(),
    trust: trustState(sources, searchRows.filter(result => currentIds.has(result.source.source_id))),
  };
}

async function expandPermittedPageGraph(
  engine: AskEngine,
  seeds: { source_id: string; slug: string }[],
  allowedSourceIds: string[],
): Promise<{ source_id: string; slug: string }[]> {
  if (seeds.length === 0 || allowedSourceIds.length === 0 || !await tableExists(engine, 'links')) return [];
  const params: unknown[] = [allowedSourceIds];
  const seedConditions = seeds.map(seed => {
    params.push(seed.source_id, seed.slug);
    return `(seed.source_id=$${params.length - 1} AND seed.slug=$${params.length})`;
  });
  return engine.executeRaw<{ source_id: string; slug: string }>(
    `SELECT DISTINCT neighbor.source_id,neighbor.slug
       FROM pages seed
       JOIN links edge ON edge.from_page_id=seed.id OR edge.to_page_id=seed.id
       JOIN pages neighbor ON neighbor.id=CASE
         WHEN edge.from_page_id=seed.id THEN edge.to_page_id ELSE edge.from_page_id END
      WHERE neighbor.source_id=ANY($1::text[]) AND neighbor.deleted_at IS NULL
        AND (${seedConditions.join(' OR ')})
      ORDER BY neighbor.source_id,neighbor.slug
      LIMIT 20`,
    params,
  );
}

function extractivelySupported(answer: string, pages: WorkspacePageDetail[]): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const sentences = answer.split(/(?<=[.!?])\s+/).map(normalize).filter(Boolean);
  const evidence = pages.map(page => normalize(`${page.title}\n${page.body}`));
  return sentences.length > 0 && sentences.every(sentence => evidence.some(text => text.includes(sentence)));
}

async function updateProgress(engine: AskEngine, id: string, progress: string): Promise<void> {
  const safe = safeProgressMessages.has(progress) ? progress : 'Working securely';
  await engine.executeRaw(
    `UPDATE workspace_ask_results SET progress=$2,updated_at=now()
      WHERE ask_result_id=$1 AND state='running' AND cancellation_requested_at IS NULL`,
    [id, safe],
  );
}

async function finishRefusal(
  engine: AskEngine,
  row: AskRow,
  input: {
    sources: WorkspaceAskSourceSummary[];
    authorizationSources: string[];
    trust: WorkspaceAskTrustState[];
    gap: string;
    nextAction: string;
  },
): Promise<void> {
  await engine.executeRaw(
    `UPDATE workspace_ask_results SET state='not_enough_evidence',progress='Not enough evidence',
       searched_sources=$2::jsonb,authorization_sources=$3::jsonb,trust_state=$4::jsonb,
       citations='[]'::jsonb,answer=NULL,evidence_gap=$5,next_action=$6,updated_at=now()
      WHERE ask_result_id=$1 AND state='running' AND cancellation_requested_at IS NULL`,
    [row.ask_result_id, input.sources, input.authorizationSources,
      input.trust, input.gap, input.nextAction],
  );
}

export async function createWorkspaceAsk(
  engine: AskEngine,
  input: { workspaceId: string; membershipId: string; question: string; sourceIds?: string[] },
): Promise<WorkspaceAskView> {
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (!question || question.length > 200) throw new WorkspaceAskError('invalid_question');
  if (!await activeMembership(engine, input.workspaceId, input.membershipId)) {
    throw new WorkspaceAskError('ask_result_not_found');
  }
  const sourceIds = [...new Set((input.sourceIds ?? []).filter(Boolean))].sort();
  const id = randomUUID();
  const row = (await engine.executeRaw<AskRow>(
    `INSERT INTO workspace_ask_results
       (ask_result_id,workspace_id,requester_membership_id,question,selected_source_ids)
     VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING *`,
    [id, input.workspaceId, input.membershipId, question, sourceIds],
  ))[0]!;
  return toView(row);
}

export async function runWorkspaceAsk(
  engine: AskEngine,
  askResultId: string,
  synthesizer: WorkspaceAskSynthesizer,
): Promise<void> {
  const row = await askRow(engine, askResultId);
  if (!row || row.state !== 'queued') return;
  const started = await engine.executeRaw<{ ask_result_id: string }>(
    `UPDATE workspace_ask_results SET state='running',progress='Searching permitted Knowledge',updated_at=now()
      WHERE ask_result_id=$1 AND state='queued' RETURNING ask_result_id`,
    [askResultId],
  );
  if (!started[0]) return;
  const controller = new AbortController();
  activeRuns.set(askResultId, controller);
  try {
    if (!await activeMembership(engine, row.workspace_id, row.requester_membership_id)) {
      await finishRefusal(engine, row, {
        sources: [], authorizationSources: [], trust: [],
        gap: 'Workspace Membership changed before permitted evidence could be verified.',
        nextAction: 'Restore active Membership, then submit the question again.',
      });
      return;
    }
    const selected = jsonValue<string[]>(row.selected_source_ids, []);
    // This deterministic Search is deliberately the first retrieval action.
    const search = await searchWorkspaceKnowledge(engine, {
      workspaceId: row.workspace_id,
      membershipId: row.requester_membership_id,
      query: row.question,
      sourceIds: selected.length > 0 ? selected : undefined,
      limit: 20,
    });
    const sources = eligibleSources(await listWorkspaceSearchSources(engine, {
      workspaceId: row.workspace_id, membershipId: row.requester_membership_id,
    }), selected);
    const trust = trustState(sources, search.results);
    const authorizationSources = sources.map(source => source.sourceId);
    await engine.executeRaw(
      `UPDATE workspace_ask_results SET searched_sources=$2::jsonb,authorization_sources=$3::jsonb,
       trust_state=$4::jsonb,progress='Reading permitted supporting context',updated_at=now()
       WHERE ask_result_id=$1 AND state='running'`,
      [askResultId, sources, authorizationSources, trust],
    );

    await updateProgress(engine, askResultId, 'Expanding permitted Page relationships');
    const graphPages = await expandPermittedPageGraph(
      engine,
      search.results.map(match => match.page),
      authorizationSources,
    );
    const contextPages = [...new Map([
      ...search.results.map(match => match.page),
      ...graphPages,
    ].map(page => [`${page.source_id}:${page.slug}`, page])).values()];
    const details: WorkspacePageDetail[] = [];
    for (const page of contextPages) {
      if (controller.signal.aborted) return;
      try {
        details.push(await getWorkspacePage(engine, {
          workspaceId: row.workspace_id,
          membershipId: row.requester_membership_id,
          sourceId: page.source_id,
          slug: page.slug,
        }));
      } catch { /* An access change removes this Page from supporting context. */ }
    }
    if (details.length === 0) {
      await finishRefusal(engine, row, {
        sources, authorizationSources, trust,
        gap: 'No currently permitted Page matched the question closely enough to support a cited answer.',
        nextAction: 'Refine the question or add and verify a Source containing the missing information.',
      });
      return;
    }

    await updateProgress(engine, askResultId, 'Synthesizing from permitted Pages');
    const synthesis = await synthesizer({
      question: row.question,
      pages: details.map(page => ({
        sourceId: page.page.source_id,
        slug: page.page.slug,
        title: page.title,
        body: page.body,
        evidenceStatus: page.evidence_status.state,
        sourceFreshness: page.source_freshness.state,
      })),
      signal: controller.signal,
      onProgress: progress => updateProgress(engine, askResultId, progress),
    });
    if (controller.signal.aborted) return;
    if (synthesis.kind === 'not_enough_evidence') {
      await finishRefusal(engine, row, {
        ...await currentEvidenceSnapshot(engine, row, selected, search.results),
        gap: safeSynthesizerRefusal.evidenceGap,
        nextAction: safeSynthesizerRefusal.nextAction,
      });
      return;
    }

    const supporting = new Map(details.map(page => [`${page.page.source_id}:${page.page.slug}`, page]));
    const requested = [...new Map(synthesis.citations.map(citation => [
      `${citation.sourceId}:${citation.slug}`, citation,
    ])).values()];
    const structurallySupported = synthesis.answer.trim().length > 0
      && requested.length > 0
      && requested.every(citation => supporting.has(`${citation.sourceId}:${citation.slug}`));
    const finalPages: WorkspacePageDetail[] = [];
    if (structurallySupported && await activeMembership(engine, row.workspace_id, row.requester_membership_id)) {
      for (const citation of requested) {
        try {
          finalPages.push(await getWorkspacePage(engine, {
            workspaceId: row.workspace_id,
            membershipId: row.requester_membership_id,
            sourceId: citation.sourceId,
            slug: citation.slug,
          }));
        } catch { break; }
      }
    }
    if (!structurallySupported || finalPages.length !== requested.length
        || !extractivelySupported(synthesis.answer, finalPages)) {
      await finishRefusal(engine, row, {
        ...await currentEvidenceSnapshot(engine, row, selected, search.results),
        gap: 'The proposed answer could not be verified against all cited Pages under current access.',
        nextAction: 'Restore access or add support in an active Source, then submit the question again.',
      });
      return;
    }

    const citations: WorkspaceAskCitation[] = finalPages.map(page => ({
      sourceId: page.page.source_id, slug: page.page.slug, title: page.title,
    }));
    const citationSourceIds = [...new Set(citations.map(citation => citation.sourceId))].sort();
    await engine.executeRaw(
      `UPDATE workspace_ask_results SET state='answered',progress='Answer ready',answer=$2,
       citations=$3::jsonb,authorization_sources=$4::jsonb,evidence_gap=NULL,next_action=NULL,updated_at=now()
       WHERE ask_result_id=$1 AND state='running' AND cancellation_requested_at IS NULL`,
      [askResultId, synthesis.answer.trim(), citations, citationSourceIds],
    );
  } catch (error) {
    if (!controller.signal.aborted) {
      await engine.executeRaw(
        `UPDATE workspace_ask_results SET state='failed',progress='Ask failed safely',answer=NULL,
         searched_sources='[]'::jsonb,authorization_sources='[]'::jsonb,trust_state='[]'::jsonb,
         citations='[]'::jsonb,error_code='synthesis_failed',updated_at=now()
         WHERE ask_result_id=$1 AND state='running' AND cancellation_requested_at IS NULL`,
        [askResultId],
      );
    }
  } finally {
    activeRuns.delete(askResultId);
  }
}

export async function getWorkspaceAsk(
  engine: AskEngine,
  input: { workspaceId: string; membershipId: string; askResultId: string },
): Promise<WorkspaceAskView> {
  const row = await askRow(engine, input.askResultId);
  if (!row || row.workspace_id !== input.workspaceId
      || !await activeMembership(engine, input.workspaceId, input.membershipId)) {
    throw new WorkspaceAskError('ask_result_not_found');
  }
  if (['queued', 'running', 'not_enough_evidence', 'cancelled', 'failed'].includes(row.state)
      && row.requester_membership_id !== input.membershipId) {
    throw new WorkspaceAskError('ask_result_not_found');
  }
  const required = jsonValue<string[]>(row.authorization_sources, []);
  if (required.length > 0) {
    const permitted = new Set((await listWorkspaceSearchSources(engine, {
      workspaceId: input.workspaceId, membershipId: input.membershipId,
    })).map(source => source.source_id));
    if (required.some(sourceId => !permitted.has(sourceId))) {
      throw new WorkspaceAskError('ask_result_not_found');
    }
  }
  if (row.state === 'answered') {
    const citations = jsonValue<WorkspaceAskCitation[]>(row.citations, []);
    try {
      await Promise.all(citations.map(citation => getWorkspacePage(engine, {
        workspaceId: input.workspaceId,
        membershipId: input.membershipId,
        sourceId: citation.sourceId,
        slug: citation.slug,
      })));
    } catch {
      throw new WorkspaceAskError('ask_result_not_found');
    }
  }
  return toView(row);
}

export async function cancelWorkspaceAsk(
  engine: AskEngine,
  input: { workspaceId: string; membershipId: string; askResultId: string },
): Promise<WorkspaceAskView> {
  const row = await askRow(engine, input.askResultId);
  if (!row || row.workspace_id !== input.workspaceId || row.requester_membership_id !== input.membershipId
      || !await activeMembership(engine, input.workspaceId, input.membershipId)) {
    throw new WorkspaceAskError('ask_result_not_found');
  }
  if (!['queued', 'running'].includes(row.state)) throw new WorkspaceAskError('ask_not_cancellable');
  const cancelled = (await engine.executeRaw<AskRow>(
    `UPDATE workspace_ask_results SET state='cancelled',progress='Cancelled safely',answer=NULL,
       searched_sources='[]'::jsonb,authorization_sources='[]'::jsonb,trust_state='[]'::jsonb,
       citations='[]'::jsonb,cancellation_requested_at=now(),updated_at=now()
      WHERE ask_result_id=$1 AND state IN ('queued','running') RETURNING *`,
    [input.askResultId],
  ))[0];
  if (!cancelled) throw new WorkspaceAskError('ask_not_cancellable');
  activeRuns.get(input.askResultId)?.abort();
  return toView(cancelled);
}

export async function purgeExpiredWorkspaceAskResults(
  engine: AskEngine,
  request: { limit?: number } = {},
): Promise<number> {
  const limit = Math.min(Math.max(request.limit ?? 500, 1), 1_000);
  const rows = await engine.executeRaw<{ ask_result_id: string }>(
    `WITH expired AS (
       SELECT ask_result_id FROM workspace_ask_results
        WHERE expires_at <= now()
        ORDER BY expires_at, ask_result_id
        LIMIT $1
     )
     DELETE FROM workspace_ask_results ask_result
      USING expired
      WHERE ask_result.ask_result_id=expired.ask_result_id
      RETURNING ask_result.ask_result_id`,
    [limit],
  );
  return rows.length;
}
