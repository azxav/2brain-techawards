import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import {
  cancelWorkspaceAsk,
  createWorkspaceAsk,
  getWorkspaceAsk,
  purgeExpiredWorkspaceAskResults,
  runWorkspaceAsk,
  type WorkspaceAskSynthesizer,
} from '../src/workspace/ask.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose an address.');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function seedWorkspace(): Promise<void> {
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id,name,setup_completed_at) VALUES ('workspace-1','Workspace',now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('identity-1','member@example.test',now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('member-1','workspace-1','identity-1','member')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member','member-1','specific')");
  await engine.executeRaw("INSERT INTO workspace_source_grants (principal_kind,principal_id,source_id) VALUES ('member','member-1','handbook')");
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id,included_in_workspace_search,last_verified_at)
    VALUES
      ('handbook','workspace-1','Team handbook','https://example.test/handbook.git','daily','completed','member-1',TRUE,now()),
      ('denied-source','workspace-1','Restricted','https://example.test/restricted.git','daily','completed','member-1',TRUE,now())`);
  await engine.executeRaw(`CREATE TABLE sources (id TEXT PRIMARY KEY,name TEXT NOT NULL,archived BOOLEAN NOT NULL DEFAULT FALSE)`);
  await engine.executeRaw(`CREATE TABLE pages (
    id SERIAL PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),slug TEXT NOT NULL,type TEXT NOT NULL,
    page_kind TEXT NOT NULL DEFAULT 'markdown',title TEXT NOT NULL,compiled_truth TEXT NOT NULL DEFAULT '',
    frontmatter JSONB NOT NULL DEFAULT '{}',import_filename TEXT,effective_date TIMESTAMPTZ,effective_date_source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),deleted_at TIMESTAMPTZ,
    UNIQUE(source_id,slug))`);
  await engine.executeRaw(`CREATE TABLE links (
    id SERIAL PRIMARY KEY,from_page_id INTEGER NOT NULL REFERENCES pages(id),to_page_id INTEGER NOT NULL REFERENCES pages(id),
    link_type TEXT NOT NULL DEFAULT '',context TEXT NOT NULL DEFAULT '')`);
  await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('handbook','Team handbook'),('denied-source','Restricted')");
  await engine.executeRaw(`INSERT INTO pages (source_id,slug,type,title,compiled_truth,import_filename)
    VALUES
      ('handbook','leave-policy','document','Leave policy','The leave policy provides 20 days of annual leave.','leave.md'),
      ('handbook','benefits-guide','document','Benefits guide','Benefits requests go to People Operations.','benefits.md'),
      ('denied-source','restricted-benefits','document','Restricted benefits','Executive benefits are confidential.','restricted.md')`);
  await engine.executeRaw(`INSERT INTO links (from_page_id,to_page_id,link_type)
    SELECT a.id,b.id,'related' FROM pages a,pages b
     WHERE a.source_id='handbook' AND a.slug='leave-policy'
       AND ((b.source_id='handbook' AND b.slug='benefits-guide') OR (b.source_id='denied-source' AND b.slug='restricted-benefits'))`);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
});

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await engine.executeRaw('DROP TABLE IF EXISTS links');
  await engine.executeRaw('DROP TABLE IF EXISTS pages');
  await engine.executeRaw('DROP TABLE IF EXISTS sources');
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await seedWorkspace();
});

describe('Workspace Ask 2Brain', () => {
  test('searches first and persists only a supported cited answer', async () => {
    const observed: string[] = [];
    const synthesizer: WorkspaceAskSynthesizer = async input => {
      observed.push(...input.pages.map(page => `${page.sourceId}:${page.slug}`));
      input.onProgress('Synthesizing from permitted Pages');
      return {
        kind: 'answer',
        answer: 'The leave policy provides 20 days of annual leave.',
        citations: [{ sourceId: 'handbook', slug: 'leave-policy' }],
      };
    };
    const created = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'leave policy',
    });
    expect(created.state).toBe('queued');

    await runWorkspaceAsk(engine, created.id, synthesizer);
    const result = await getWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', askResultId: created.id,
    });

    expect(observed).toEqual(['handbook:leave-policy', 'handbook:benefits-guide']);
    expect(result).toMatchObject({
      state: 'answered',
      answer: 'The leave policy provides 20 days of annual leave.',
      citations: [{ sourceId: 'handbook', slug: 'leave-policy', title: 'Leave policy' }],
      searchedSources: [{ sourceId: 'handbook', name: 'Team handbook' }],
    });
    const stored = await engine.executeRaw<Record<string, unknown>>(
      'SELECT * FROM workspace_ask_results WHERE ask_result_id=$1', [created.id],
    );
    expect(JSON.stringify(stored)).not.toContain('provider');
    expect(JSON.stringify(stored)).not.toContain('temperature');
    expect(stored[0]!.expires_at).toBeTruthy();

    await engine.executeRaw(
      "UPDATE workspace_ask_results SET expires_at=now() - interval '1 second' WHERE ask_result_id=$1",
      [created.id],
    );
    await expect(getWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', askResultId: created.id,
    })).rejects.toThrow('ask_result_not_found');
  });

  test('refuses citation syntax and unsupported Page references with an evidence gap', async () => {
    const created = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'leave policy',
    });
    await runWorkspaceAsk(engine, created.id, async () => ({
      kind: 'answer',
      answer: 'The policy is unlimited [made-up:page].',
      citations: [{ sourceId: 'handbook', slug: 'missing-page' }],
    }));
    const result = await getWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', askResultId: created.id,
    });
    expect(result.state).toBe('not_enough_evidence');
    expect(result.answer).toBeNull();
    expect(result.evidenceGap).toContain('cited Pages');
    expect(result.nextAction).toBeTruthy();
    expect(result.trustState.length).toBeGreaterThan(0);
  });

  test('refuses an unsupported claim even when it cites a real retrieved Page', async () => {
    const created = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'leave policy',
    });
    await runWorkspaceAsk(engine, created.id, async () => ({
      kind: 'answer',
      answer: 'The leave policy provides unlimited leave.',
      citations: [{ sourceId: 'handbook', slug: 'leave-policy' }],
    }));
    expect(await getWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', askResultId: created.id,
    })).toMatchObject({ state: 'not_enough_evidence', answer: null });
  });

  test('stores only product-owned safe execution evidence from synthesizer callbacks', async () => {
    const created = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'leave policy',
    });
    let progressDuringSynthesis = '';
    await runWorkspaceAsk(engine, created.id, async input => {
      await input.onProgress('provider_secret=sk-unsafe raw_prompt=confidential temperature=0.9');
      progressDuringSynthesis = (await engine.executeRaw<{ progress: string }>(
        'SELECT progress FROM workspace_ask_results WHERE ask_result_id=$1', [created.id],
      ))[0]!.progress;
      return {
        kind: 'not_enough_evidence',
        evidenceGap: 'raw_prompt=confidential',
        nextAction: 'retry with provider_secret=sk-unsafe and temperature=0.9',
      };
    });

    expect(progressDuringSynthesis).toBe('Working securely');
    const stored = await engine.executeRaw<Record<string, unknown>>(
      'SELECT * FROM workspace_ask_results WHERE ask_result_id=$1', [created.id],
    );
    expect(JSON.stringify(stored)).not.toContain('sk-unsafe');
    expect(JSON.stringify(stored)).not.toContain('raw_prompt');
    expect(JSON.stringify(stored)).not.toContain('temperature');
  });

  test('reauthorizes citations after synthesis and never delivers an answer after revocation', async () => {
    const created = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'leave policy',
    });
    await runWorkspaceAsk(engine, created.id, async () => {
      await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id='member-1'");
      return {
        kind: 'answer', answer: 'Members receive 20 days.',
        citations: [{ sourceId: 'handbook', slug: 'leave-policy' }],
      };
    });
    const stored = await engine.executeRaw<{ state: string; answer: string | null; searched_sources: unknown }>(
      'SELECT state,answer,searched_sources FROM workspace_ask_results WHERE ask_result_id=$1', [created.id],
    );
    expect(stored[0]).toMatchObject({ state: 'not_enough_evidence', answer: null });
    expect(JSON.stringify(stored[0]!.searched_sources)).not.toContain('Team handbook');
    await expect(getWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', askResultId: created.id,
    })).resolves.toMatchObject({
      state: 'not_enough_evidence',
      searchedSources: [],
      evidenceGap: 'The proposed answer could not be verified against all cited Pages under current access.',
    });
  });

  test('does not expose an answered result after a cited Page is deleted', async () => {
    const created = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'leave policy',
    });
    await runWorkspaceAsk(engine, created.id, async () => ({
      kind: 'answer',
      answer: 'The leave policy provides 20 days of annual leave.',
      citations: [{ sourceId: 'handbook', slug: 'leave-policy' }],
    }));

    await engine.executeRaw(
      "UPDATE pages SET deleted_at=now() WHERE source_id='handbook' AND slug='leave-policy'",
    );

    await expect(getWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', askResultId: created.id,
    })).rejects.toThrow('ask_result_not_found');
  });

  test('reauthorizes shared answered links against current Membership and Source lifecycle', async () => {
    await engine.executeRaw(
      "INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('identity-2','viewer@example.test',now())",
    );
    await engine.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('member-2','workspace-1','identity-2','member')",
    );
    await engine.executeRaw(
      "INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member','member-2','specific')",
    );
    await engine.executeRaw(
      "INSERT INTO workspace_source_grants (principal_kind,principal_id,source_id) VALUES ('member','member-2','handbook')",
    );
    const created = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'leave policy',
    });
    await runWorkspaceAsk(engine, created.id, async () => ({
      kind: 'answer',
      answer: 'The leave policy provides 20 days of annual leave.',
      citations: [{ sourceId: 'handbook', slug: 'leave-policy' }],
    }));

    await expect(getWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-2', askResultId: created.id,
    })).resolves.toMatchObject({ state: 'answered' });

    await engine.executeRaw("UPDATE workspace_memberships SET status='disabled' WHERE membership_id='member-2'");
    await expect(getWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-2', askResultId: created.id,
    })).rejects.toThrow('ask_result_not_found');

    await engine.executeRaw("UPDATE workspace_memberships SET status='active' WHERE membership_id='member-2'");
    await engine.executeRaw("UPDATE workspace_sources SET archived=TRUE WHERE source_id='handbook'");
    await expect(getWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-2', askResultId: created.id,
    })).rejects.toThrow('ask_result_not_found');
  });

  test('purges expired Ask Results in bounded retention batches', async () => {
    const oldest = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'oldest result',
    });
    const newerExpired = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'newer expired result',
    });
    const current = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'current result',
    });
    await engine.executeRaw(
      `UPDATE workspace_ask_results
          SET expires_at=CASE ask_result_id
            WHEN $1 THEN now() - interval '2 days'
            WHEN $2 THEN now() - interval '1 day'
            ELSE expires_at END
        WHERE ask_result_id IN ($1,$2)`,
      [oldest.id, newerExpired.id],
    );

    expect(await purgeExpiredWorkspaceAskResults(engine, { limit: 1 })).toBe(1);
    const remaining = await engine.executeRaw<{ ask_result_id: string }>(
      'SELECT ask_result_id FROM workspace_ask_results ORDER BY ask_result_id',
    );
    expect(remaining.map(row => row.ask_result_id)).toContain(newerExpired.id);
    expect(remaining.map(row => row.ask_result_id)).toContain(current.id);
    expect(remaining.map(row => row.ask_result_id)).not.toContain(oldest.id);
  });

  test('cancellation aborts synthesis and cannot be overwritten by delayed completion', async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const created = await createWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', question: 'leave policy',
    });
    const run = runWorkspaceAsk(engine, created.id, async input => {
      await waiting;
      expect(input.signal.aborted).toBe(true);
      return {
        kind: 'answer', answer: 'This must never be delivered.',
        citations: [{ sourceId: 'handbook', slug: 'leave-policy' }],
      };
    });
    while ((await engine.executeRaw<{ state: string }>(
      'SELECT state FROM workspace_ask_results WHERE ask_result_id=$1', [created.id],
    ))[0]?.state !== 'running') await Bun.sleep(1);

    const cancelled = await cancelWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', askResultId: created.id,
    });
    expect(cancelled.state).toBe('cancelled');
    release();
    await run;
    const result = await getWorkspaceAsk(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', askResultId: created.id,
    });
    expect(result).toMatchObject({
      state: 'cancelled', answer: null, progress: 'Cancelled safely', searchedSources: [], trustState: [],
    });
  });

  test('exposes acknowledged Member APIs and a single-question non-chat UI', async () => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    await engine.executeRaw(`INSERT INTO workspace_sessions
      (session_hash,membership_id,csrf_hash,expires_at)
      VALUES ($1,'member-1',$2,now() + interval '1 day')`, [digest('ask-session'), digest('ask-csrf')]);
    const app = express();
    app.use(createWorkspaceRouter(engine, {
      allowedOrigin: 'https://workspace.example.test',
      requestId: () => 'req-ask-api',
      askSynthesizer: async () => ({
        kind: 'answer', answer: 'The leave policy provides 20 days of annual leave.',
        citations: [{ sourceId: 'handbook', slug: 'leave-policy' }],
      }),
    }));
    const headers = {
      origin: 'https://workspace.example.test',
      cookie: 'workspace_session=ask-session',
      'x-csrf-token': 'ask-csrf',
      'content-type': 'application/json',
    };
    await withServer(app, async baseUrl => {
      const acknowledgedAt = performance.now();
      const submitted = await fetch(`${baseUrl}/api/workspace/v1/ask`, {
        method: 'POST', headers, body: JSON.stringify({ question: 'leave policy' }),
      });
      expect(performance.now() - acknowledgedAt).toBeLessThan(1_000);
      expect(submitted.status).toBe(202);
      const submittedBody = await submitted.json() as { data: { id: string; state: string } };
      expect(submittedBody.data.state).toBe('queued');

      let result: { state: string; answer: string | null } | undefined;
      let firstProgressAt: number | undefined;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fetch(`${baseUrl}/api/workspace/v1/ask/${submittedBody.data.id}`, { headers });
        expect(response.status).toBe(200);
        const polled = (await response.json() as { data: typeof result & { progress?: string } }).data;
        result = polled;
        if (!firstProgressAt && polled?.progress && polled.progress !== 'Question acknowledged') {
          firstProgressAt = performance.now();
        }
        if (result?.state === 'answered') break;
        await Bun.sleep(5);
      }
      expect(firstProgressAt! - acknowledgedAt).toBeLessThan(3_000);
      expect(result).toMatchObject({ state: 'answered', answer: 'The leave policy provides 20 days of annual leave.' });

      const searchShell = await fetch(`${baseUrl}/app/search`, { headers });
      const searchHtml = await searchShell.text();
      expect(searchHtml).toContain('id="ask-question"');
      expect(searchHtml).toContain('maxlength="200"');
      expect(searchHtml).not.toContain('conversation history');
      const resultShell = await fetch(`${baseUrl}/app/ask/${submittedBody.data.id}`, { headers });
      const resultHtml = await resultShell.text();
      expect(resultHtml).toContain('id="ask-result"');
      expect(resultHtml).toContain('id="cancel-ask"');
      expect(resultHtml).toContain('Not enough evidence');
      expect(resultHtml).toContain('Array.isArray(item.freshness)');
      expect(resultHtml).toContain("citation.title+' / '+citation.sourceId");
      expect(resultHtml).toContain('.ask-actions [hidden]{display:none}');
      expect(resultHtml).toContain('aria-live="polite"');

      await engine.executeRaw(
        "UPDATE workspace_ask_results SET expires_at=now() - interval '1 second' WHERE ask_result_id=$1",
        [submittedBody.data.id],
      );
      const unavailable = await fetch(
        `${baseUrl}/api/workspace/v1/ask/${submittedBody.data.id}`,
        { headers },
      );
      expect(unavailable.status).toBe(404);
      const unavailableBody = JSON.stringify(await unavailable.json());
      expect(unavailableBody).toContain('ask_result_not_found');
      expect(unavailableBody).not.toContain('annual leave');
      expect(unavailableBody).not.toContain('leave-policy');
      expect(unavailableBody).not.toContain('Team handbook');
    });
  });
});
