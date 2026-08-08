import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, resolveRequestedScope } from '../src/core/operations.ts';
import type { AuthInfo, OperationContext } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { authorizationFromAuthInfo, workspaceMemberAuthorization } from '../src/workspace/authorization-context.ts';
import { hasScope } from '../src/core/scope.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { setPrincipalSourceAccess } from '../src/workspace/source-access.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  restrictedDisclosureMarkers,
  SOURCE_ACCESS_REQUIRED_DENIAL,
  sourceSensitiveDenialCases,
} from './helpers/source-access-contract.ts';

let engine: PGLiteEngine;

const member = { kind: 'member' as const, id: 'member-operations' };
const administrator = { kind: 'member' as const, id: 'administrator-operations' };
const agent = { kind: 'agent' as const, id: 'agent-operations' };

async function call(
  principal: typeof member | typeof administrator | typeof agent,
  name: string,
  params: Record<string, unknown> = {},
  sourceId = 'source-a',
) {
  const result = await dispatchToolCall(engine, name, params, {
    remote: true,
    sourceId,
    sourceAccessPrincipal: principal,
  });
  return {
    ...result,
    body: JSON.parse(result.content[0]!.text) as any,
  };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await initializeWorkspaceFoundation(engine);
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES
      ('source-a', 'Source A', '{}'::jsonb),
      ('source-b', 'Source B', '{}'::jsonb)`,
  );
  await engine.putPage('notes/a', {
    type: 'note', title: 'Allowed A', compiled_truth: 'allowed', frontmatter: {},
  }, { sourceId: 'source-a' });
  await engine.putPage('notes/b', {
    type: 'note', title: 'Denied B', compiled_truth: 'denied', frontmatter: {},
  }, { sourceId: 'source-b' });
  await engine.createVersion('notes/a', { sourceId: 'source-a' });
  await engine.createVersion('notes/b', { sourceId: 'source-b' });
});

describe('canonical Source Access operation contract', () => {
  test('Specific Sources filters Source metadata and Page list/read/version surfaces', async () => {
    await setPrincipalSourceAccess(engine, member, { mode: 'specific', sourceIds: ['source-a'] });

    expect((await call(member, 'sources_list')).body.sources.map((source: any) => source.id)).toEqual(['source-a']);
    expect((await call(member, 'get_brain_identity')).body).toMatchObject({
      engine: 'pglite',
      page_count: 1,
    });
    expect((await call(member, 'list_pages')).body.map((page: any) => page.slug)).toEqual(['notes/a']);
    expect((await call(member, 'get_page', { slug: 'notes/a' })).body.title).toBe('Allowed A');
    const deniedPage = await call(member, 'get_page', { slug: 'notes/b' });
    expect(deniedPage.body.error).toBe('page_not_found');
    expect(JSON.stringify(deniedPage)).not.toContain('notes/b');
    expect(JSON.stringify(deniedPage)).not.toContain('Denied B');
    expect(JSON.stringify(deniedPage)).not.toContain('count');
    expect(JSON.stringify(deniedPage)).not.toContain('latency');
    expect(JSON.stringify(deniedPage)).not.toContain('provenance');
    expect((await call(member, 'get_versions', { slug: 'notes/a' })).body).toHaveLength(1);
    expect((await call(member, 'get_versions', { slug: 'notes/b' })).body).toEqual([]);

    const deniedStatus = await call(member, 'sources_status', { id: 'source-b' });
    expect(deniedStatus.isError).toBe(true);
    expect(JSON.stringify(deniedStatus.body)).not.toContain('source-b');
    expect(JSON.stringify(deniedStatus.body)).not.toContain('Denied B');

    for (const operation of [
      'get_stats',
      'get_health',
      'run_doctor',
      'get_status_snapshot',
      'get_ingest_log',
      'get_recent_salience',
      'find_anomalies',
      'find_contradictions',
    ]) {
      const deniedGlobal = await call(member, operation);
      expect(deniedGlobal.isError, operation).toBe(true);
      expect(deniedGlobal.body.error, operation).toBe('permission_denied');
      const serialized = JSON.stringify(deniedGlobal);
      for (const forbidden of ['source-b', 'notes/b', 'Denied B', 'count', 'latency', 'health', 'provenance']) {
        expect(serialized, `${operation} leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test('No Source Access is an access-required state and explicit requests cannot widen it', async () => {
    await setPrincipalSourceAccess(engine, agent, { mode: 'none' });
    const list = await call(agent, 'sources_list');
    expect(list.isError).toBe(true);
    expect(list.body.error).toBe('permission_denied');

    const ctx = {
      remote: true,
      sourceId: 'source-a',
      sourceAccess: { kind: 'sources', sourceIds: [] },
    } as unknown as OperationContext;
    expect(() => resolveRequestedScope(ctx, 'source-a')).toThrow('outside your Source Access');
    expect(() => resolveRequestedScope(ctx, '__all__')).toThrow('Source access is required');
  });

  test('No Source Access has one zero-disclosure contract across every Source-sensitive operation', async () => {
    await setPrincipalSourceAccess(engine, agent, { mode: 'none' });
    const restrictedFact = await engine.insertFact(
      { fact: 'Restricted fact detail', kind: 'fact', source: 'restricted-provenance' },
      { source_id: 'source-b' },
    );
    const restrictedJobs = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, data, result, progress, error_text, stacktrace)
       VALUES ('sync', $1::jsonb, $2::jsonb, $3::jsonb, 'restricted-job-error', $4::jsonb)
       RETURNING id`,
      [
        { source_id: 'source-b', secret: 'restricted-job-secret' },
        { detail: 'restricted-job-result' },
        { detail: 'restricted-job-progress' },
        ['restricted-job-stacktrace'],
      ],
    );
    const restrictedJobId = restrictedJobs[0]!.id;
    const legacyJobs = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, data) VALUES ('sync', $1::jsonb) RETURNING id`,
      [{ detail: 'restricted-legacy-job' }],
    );
    const legacyJobId = legacyJobs[0]!.id;
    for (const [name, params] of sourceSensitiveDenialCases(restrictedFact.id, restrictedJobId, legacyJobId)) {
      const result = await call(agent, name, params);
      expect(result.isError, name).toBe(true);
      expect(result.body, name).toEqual(SOURCE_ACCESS_REQUIRED_DENIAL);
      const serialized = JSON.stringify(result);
      for (const forbidden of restrictedDisclosureMarkers(restrictedFact.id, restrictedJobId, legacyJobId)) {
        expect(serialized, `${name} leaked ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test('Specific Sources constrain Source-bound Minion reads, writes, replay, and pagination', async () => {
    await setPrincipalSourceAccess(engine, administrator, { mode: 'specific', sourceIds: ['source-a'] });
    const authorization = workspaceMemberAuthorization({
      membership_id: administrator.id,
      role: 'administrator',
    });
    const dispatchJob = async (name: string, params: Record<string, unknown>) => {
      const result = await dispatchToolCall(engine, name, params, { authorization });
      return { ...result, body: JSON.parse(result.content[0]!.text) as any };
    };
    const jobs = await engine.executeRaw<{ id: number; source_id: string }>(
      `INSERT INTO minion_jobs (name, status, data, created_at)
       VALUES
         ('sync', 'waiting', $1::jsonb, now() - interval '2 seconds'),
         ('sync', 'waiting', $2::jsonb, now() - interval '1 second'),
         ('sync', 'completed', $3::jsonb, now())
       RETURNING id, data->>'source_id' AS source_id`,
      [
        { source_id: 'source-a', detail: 'allowed-job' },
        { source_id: 'source-b', detail: 'restricted-job' },
        { source_id: 'source-a', detail: 'allowed-replay-source' },
      ],
    );
    const allowedJob = jobs.find(job => job.source_id === 'source-a')!;
    const deniedJob = jobs.find(job => job.source_id === 'source-b')!;
    const replayJob = jobs.filter(job => job.source_id === 'source-a')[1]!;

    expect((await dispatchJob('get_job', { id: allowedJob.id })).body.data.detail).toBe('allowed-job');
    const deniedRead = await dispatchJob('get_job', { id: deniedJob.id });
    expect(deniedRead.body.error).toBe('permission_denied');
    expect(JSON.stringify(deniedRead)).not.toContain(String(deniedJob.id));
    expect(JSON.stringify(deniedRead)).not.toContain('restricted-job');

    const listed = await dispatchJob('list_jobs', { limit: 1 });
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].id).toBe(replayJob.id);
    expect(JSON.stringify(listed.body)).not.toContain('restricted-job');

    const deniedSubmit = await dispatchJob('submit_job', {
      name: 'sync',
      data: { source_id: 'source-b', detail: 'restricted-submit' },
    });
    expect(deniedSubmit.body.error).toBe('permission_denied');
    expect(JSON.stringify(deniedSubmit)).not.toContain('source-b');

    const malformedSubmit = await dispatchJob('submit_job', {
      name: 'sync',
      data: { source_id: '', detail: 'empty-source-submit' },
    });
    expect(malformedSubmit.body.error).toBe('permission_denied');

    const deniedReplay = await dispatchJob('replay_job', {
      id: replayJob.id,
      data_overrides: { source_id: 'source-b', detail: 'restricted-replay' },
    });
    expect(deniedReplay.body.error).toBe('permission_denied');
    expect(JSON.stringify(deniedReplay)).not.toContain('source-b');
    expect(JSON.stringify(deniedReplay)).not.toContain('restricted-replay');

    const children = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, parent_job_id)
       VALUES ('sync', 'waiting', $1::jsonb, $2)
       RETURNING id`,
      [{ source_id: 'source-b', detail: 'restricted-child' }, allowedJob.id],
    );
    const deniedCancel = await dispatchJob('cancel_job', { id: allowedJob.id });
    expect(deniedCancel.body.error).toBe('permission_denied');
    expect(JSON.stringify(deniedCancel)).not.toContain(String(children[0]!.id));
    expect((await dispatchJob('get_job', { id: allowedJob.id })).body.status).toBe('waiting');

    const legacyJobs = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, data) VALUES ('sync', $1::jsonb) RETURNING id`,
      [{ detail: 'restricted-legacy-job' }],
    );
    const deniedLegacy = await dispatchJob('get_job', { id: legacyJobs[0]!.id });
    expect(deniedLegacy.body.error).toBe('permission_denied');
    expect(JSON.stringify(deniedLegacy)).not.toContain('restricted-legacy-job');
  });

  test('All Sources includes Sources connected after the grant for Member and Agent principals', async () => {
    for (const [index, principal] of [member, administrator, agent].entries()) {
      await setPrincipalSourceAccess(engine, principal, { mode: 'all' });
      const futureSource = `source-future-${index}`;
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`,
        [futureSource],
      );
      const ids = (await call(principal, 'sources_list')).body.sources.map((source: any) => source.id);
      expect(ids).toContain(futureSource);
      expect((await call(principal, 'get_stats')).isError).not.toBe(true);
    }
  });

  test('Specific and All Sources constrain Takes and hot-memory recall without scalar fallback', async () => {
    const pages = await engine.executeRaw<{ id: number; source_id: string }>(
      "SELECT id, source_id FROM pages WHERE slug IN ('notes/a', 'notes/b') ORDER BY source_id",
    );
    await engine.addTakesBatch(pages.map((page, index) => ({
      page_id: page.id,
      row_num: 1,
      claim: index === 0 ? 'Allowed take detail' : 'Restricted take detail',
      kind: 'bet' as const,
      holder: 'world',
      weight: 1,
    })));
    for (const [index, page] of pages.entries()) {
      await engine.resolveTake(page.id, 1, {
        quality: index === 0 ? 'correct' : 'incorrect',
        resolvedBy: 'world',
      });
    }
    await engine.insertFact(
      { fact: 'Allowed recalled detail', kind: 'fact', visibility: 'world', source: 'test' },
      { source_id: 'source-a' },
    );
    await engine.insertFact(
      { fact: 'Restricted recalled detail', kind: 'fact', visibility: 'world', source: 'test' },
      { source_id: 'source-b' },
    );

    await setPrincipalSourceAccess(engine, member, { mode: 'specific', sourceIds: ['source-a'] });
    const specific = await Promise.all([
      call(member, 'takes_list'),
      call(member, 'takes_search', { query: 'take detail' }),
      call(member, 'takes_scorecard'),
      call(member, 'takes_calibration'),
      call(member, 'recall'),
    ]);
    const specificText = JSON.stringify(specific);
    expect(specificText).toContain('Allowed take detail');
    expect(specificText).toContain('Allowed recalled detail');
    expect(specificText).not.toContain('Restricted take detail');
    expect(specificText).not.toContain('Restricted recalled detail');
    expect(specific[2]!.body.total_bets).toBe(1);
    expect(specific[3]!.body.reduce((sum: number, bucket: { n: number }) => sum + bucket.n, 0)).toBe(1);

    await setPrincipalSourceAccess(engine, member, { mode: 'all' });
    const all = await Promise.all([
      call(member, 'takes_list'),
      call(member, 'takes_search', { query: 'take detail' }),
      call(member, 'takes_scorecard'),
      call(member, 'takes_calibration'),
      call(member, 'recall'),
    ]);
    const allText = JSON.stringify(all);
    expect(allText).toContain('Allowed take detail');
    expect(allText).toContain('Restricted take detail');
    expect(allText).toContain('Allowed recalled detail');
    expect(allText).toContain('Restricted recalled detail');
    expect(all[2]!.body.total_bets).toBe(2);
    expect(all[3]!.body.reduce((sum: number, bucket: { n: number }) => sum + bucket.n, 0)).toBe(2);
  });

  test('Member, Administrator, and Agent principals share the All/Specific/None matrix', async () => {
    for (const principal of [member, administrator, agent]) {
      await setPrincipalSourceAccess(engine, principal, { mode: 'specific', sourceIds: ['source-a'] });
      const futureSpecific = `source-specific-future-${principal.id}`;
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`, [futureSpecific]);
      expect((await call(principal, 'sources_status', { id: 'source-a' })).body.id).toBe('source-a');
      expect((await call(principal, 'get_page', { slug: 'notes/b' })).body.error).toBe('page_not_found');
      expect((await call(principal, 'sources_list')).body.sources.map((source: any) => source.id)).not.toContain(futureSpecific);

      await setPrincipalSourceAccess(engine, principal, { mode: 'none' });
      const futureNone = `source-none-future-${principal.id}`;
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`, [futureNone]);
      expect((await call(principal, 'list_pages')).body.error).toBe('permission_denied');

      await setPrincipalSourceAccess(engine, principal, { mode: 'all' });
      expect((await call(principal, 'get_page', { slug: 'notes/b' })).body.title).toBe('Denied B');
    }
  });

  test('production dispatch enforces human roles and Agent capabilities independently from Source Access', async () => {
    await setPrincipalSourceAccess(engine, member, { mode: 'specific', sourceIds: ['source-a'] });
    await setPrincipalSourceAccess(engine, administrator, { mode: 'specific', sourceIds: ['source-a'] });
    await setPrincipalSourceAccess(engine, agent, { mode: 'specific', sourceIds: ['source-a'] });

    const memberAuthorization = workspaceMemberAuthorization({
      membership_id: member.id,
      role: 'member',
    });
    const administratorAuthorization = workspaceMemberAuthorization({
      membership_id: administrator.id,
      role: 'administrator',
    });
    const agentAuthorization = (scopes: AuthInfo['scopes']) => authorizationFromAuthInfo({
      token: 'agent-capability-secret',
      clientId: agent.id,
      scopes,
      sourceId: 'source-a',
      allowedSources: ['source-a'],
    });
    const putParams = {
      slug: 'notes/capability-check',
      content: '---\ntype: note\ntitle: Capability check\n---\nbody',
    };

    const memberRead = await dispatchToolCall(engine, 'list_pages', {}, { authorization: memberAuthorization });
    expect(JSON.parse(memberRead.content[0]!.text).map((page: any) => page.slug)).toEqual(['notes/a']);
    const memberWrite = await dispatchToolCall(engine, 'put_page', putParams, { authorization: memberAuthorization });
    expect(JSON.parse(memberWrite.content[0]!.text).error).toBe('insufficient_scope');

    const administratorWrite = await dispatchToolCall(engine, 'put_page', putParams, {
      authorization: administratorAuthorization,
      sourceId: 'source-a',
    });
    expect(administratorWrite.isError).not.toBe(true);

    const readAgentWrite = await dispatchToolCall(engine, 'put_page', putParams, {
      authorization: agentAuthorization(['read']),
    });
    expect(JSON.parse(readAgentWrite.content[0]!.text).error).toBe('insufficient_scope');
    const writeAgentWrite = await dispatchToolCall(engine, 'put_page', {
      ...putParams,
      slug: 'notes/agent-write',
      content: '---\ntype: note\ntitle: Agent capability check\n---\nagent body',
    }, { authorization: agentAuthorization(['write']) });
    expect(writeAgentWrite.isError).not.toBe(true);

    const denied = JSON.stringify([memberWrite, readAgentWrite]);
    expect(denied).not.toContain('notes/b');
    expect(denied).not.toContain('Denied B');
    expect(denied).not.toContain('count');
    expect(denied).not.toContain('latency');
    expect(denied).not.toContain('provenance');
  });

  test('active Workspace authorization re-reads Source grants at every operation decision', async () => {
    const authorization = workspaceMemberAuthorization({
      membership_id: member.id,
      role: 'member',
    });
    const list = async () => dispatchToolCall(engine, 'list_pages', {}, { authorization });

    await setPrincipalSourceAccess(engine, member, { mode: 'specific', sourceIds: ['source-a'] });
    expect(JSON.parse((await list()).content[0]!.text).map((page: any) => page.slug)).toEqual(['notes/a']);

    await setPrincipalSourceAccess(engine, member, { mode: 'none' });
    const revoked = await list();
    expect(revoked.isError).toBe(true);
    expect(JSON.parse(revoked.content[0]!.text)).toEqual(SOURCE_ACCESS_REQUIRED_DENIAL);
    expect(JSON.stringify(revoked)).not.toContain('notes/a');
    expect(JSON.stringify(revoked)).not.toContain('notes/b');

    await setPrincipalSourceAccess(engine, member, { mode: 'all' });
    expect(JSON.parse((await list()).content[0]!.text).map((page: any) => page.slug).sort())
      .toEqual(['notes/a', 'notes/b']);
  });

  test('Page writes require write capability metadata and access to the target Source', async () => {
    await setPrincipalSourceAccess(engine, agent, { mode: 'specific', sourceIds: ['source-a'] });
    const put = operations.find(operation => operation.name === 'put_page')!;
    expect(put.scope).toBe('write');
    const productionGate = async (scopes: string[], sourceId: string) => {
      if (!hasScope(scopes, put.scope!)) return { error: 'insufficient_scope' };
      return (await call(agent, 'put_page', {
        slug: `notes/${sourceId}-${scopes[0]}`,
        content: `---\ntype: note\ntitle: ${sourceId}\n---\nbody`,
      }, sourceId)).body;
    };
    expect(await productionGate(['read'], 'source-a')).toEqual({ error: 'insufficient_scope' });
    expect((await productionGate(['write'], 'source-a')).error).toBeUndefined();

    const denied = await call(agent, 'put_page', {
      slug: 'notes/new-b',
      content: '---\ntype: note\ntitle: Denied write\n---\nbody',
    }, 'source-b');
    expect(denied.isError).toBe(true);
    expect(denied.body.error).toBe('permission_denied');

    const allowed = await call(agent, 'put_page', {
      slug: 'notes/new-a',
      content: '---\ntype: note\ntitle: Allowed write\n---\nbody',
    }, 'source-a');
    expect(allowed.isError).not.toBe(true);
    expect((await engine.getPage('notes/new-a', { sourceId: 'source-a' }))?.title).toBe('Allowed write');
  });

  test('ID-addressed Knowledge writes cannot mutate a fact in a denied Source', async () => {
    await setPrincipalSourceAccess(engine, agent, { mode: 'specific', sourceIds: ['source-a'] });
    const fact = await engine.insertFact(
      { fact: 'Source B secret', kind: 'fact', source: 'test' },
      { source_id: 'source-b' },
    );

    const denied = await call(agent, 'forget_fact', { id: fact.id }, 'source-a');
    expect(denied.isError).toBe(true);
    expect(denied.body.error).toBe('fact_not_found');
    expect(JSON.stringify(denied.body)).not.toContain(String(fact.id));
    const rows = await engine.executeRaw<{ expired_at: Date | null }>(
      'SELECT expired_at FROM facts WHERE id = $1',
      [fact.id],
    );
    expect(rows[0]!.expired_at).toBeNull();
  });

  test('unmigrated principals retain the legacy compatibility scope', async () => {
    const result = await dispatchToolCall(engine, 'list_pages', {}, {
      authorization: authorizationFromAuthInfo({
        token: 'legacy',
        clientId: 'legacy-without-policy',
        scopes: ['read'],
        sourceId: 'source-b',
        allowedSources: ['source-b'],
      }),
    });
    expect(JSON.parse(result.content[0]!.text).map((page: any) => page.slug)).toEqual(['notes/b']);
  });

  test('code definition and reference retrieval cannot reveal denied Sources', async () => {
    for (const [sourceId, marker] of [['source-a', 'AllowedSymbol'], ['source-b', 'DeniedSymbol']] as const) {
      const page = await engine.executeRaw<{ id: number }>(
        `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter)
         VALUES ($1, $2, $3, 'code', 'code', '', '{}'::jsonb) RETURNING id`,
        [`code/${sourceId}`, sourceId, marker],
      );
      await engine.executeRaw(
        `INSERT INTO content_chunks
          (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified, symbol_type)
         VALUES ($1, 0, $2, 'compiled_truth', 'typescript', 'SharedSymbol', 'SharedSymbol', 'function')`,
        [page[0]!.id, `export function SharedSymbol() { return '${marker}'; }`],
      );
    }
    await setPrincipalSourceAccess(engine, member, { mode: 'specific', sourceIds: ['source-a'] });

    const defs = await call(member, 'code_def', { symbol: 'SharedSymbol' });
    const refs = await call(member, 'code_refs', { symbol: 'SharedSymbol', source_id: '__all__' });
    expect(defs.body.count).toBe(1);
    expect(refs.body.count).toBe(1);
    expect(JSON.stringify([defs.body, refs.body])).toContain('AllowedSymbol');
    expect(JSON.stringify([defs.body, refs.body])).not.toContain('DeniedSymbol');
    const denied = await call(member, 'code_def', { symbol: 'SharedSymbol', source_id: 'source-b' });
    expect(denied.isError).toBe(true);
    expect(denied.body.error).toBe('permission_denied');
    expect(JSON.stringify(denied.body)).not.toContain('source-b');

    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('source-future', 'Future', '{}'::jsonb)`);
    const futurePage = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages (slug, source_id, title, type, page_kind, compiled_truth, frontmatter)
       VALUES ('code/future', 'source-future', 'Future Code', 'code', 'code', '', '{}'::jsonb) RETURNING id`,
    );
    await engine.executeRaw(
      `INSERT INTO content_chunks
        (page_id, chunk_index, chunk_text, chunk_source, language, symbol_name, symbol_name_qualified, symbol_type)
       VALUES ($1, 0, 'FutureSymbol marker', 'compiled_truth', 'typescript', 'SharedSymbol', 'SharedSymbol', 'function')`,
      [futurePage[0]!.id],
    );
    expect((await call(member, 'code_def', { symbol: 'SharedSymbol', source_id: '__all__' })).body.count).toBe(1);

    await setPrincipalSourceAccess(engine, member, { mode: 'none' });
    const revoked = await call(member, 'code_refs', { symbol: 'SharedSymbol', source_id: '__all__' });
    expect(revoked.isError).toBe(true);
    expect(revoked.body.error).toBe('permission_denied');
    expect(JSON.stringify(revoked.body)).not.toContain('DeniedSymbol');

    await setPrincipalSourceAccess(engine, member, { mode: 'all' });
    const all = await call(member, 'code_def', { symbol: 'SharedSymbol', source_id: '__all__' });
    expect(all.body.count).toBe(3);
    expect(JSON.stringify(all.body)).toContain('FutureSymbol marker');
  });

  test('backlink ranking metadata counts only fully authorized edges', async () => {
    await engine.addLinksBatch([
      {
        from_slug: 'notes/a', to_slug: 'notes/a', link_type: 'related', link_source: 'manual',
        from_source_id: 'source-a', to_source_id: 'source-a',
      },
      {
        from_slug: 'notes/b', to_slug: 'notes/a', link_type: 'related', link_source: 'manual',
        from_source_id: 'source-b', to_source_id: 'source-a',
      },
    ]);

    expect((await engine.getBacklinkCounts(['notes/a'])).get('notes/a')).toBe(2);
    expect((await engine.getBacklinkCounts(['notes/a'], { sourceIds: ['source-a'] })).get('notes/a')).toBe(1);
    expect((await engine.getBacklinkCounts(['notes/a'], { sourceIds: [] })).get('notes/a')).toBe(0);
  });
});
