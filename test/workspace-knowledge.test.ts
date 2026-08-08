import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  createWorkspaceSavedView,
  deleteWorkspaceSavedView,
  listWorkspaceKnowledge,
  listWorkspaceSavedViews,
  openWorkspaceSavedView,
  updateWorkspaceSavedView,
  WorkspaceKnowledgeError,
  type ListWorkspaceKnowledgeInput,
} from '../src/workspace/knowledge.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;
let scaleEngine: PGLiteEngine;

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
  await engine.executeRaw(
    "INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Workspace', now())",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-1', 'member@example.test', now())",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-1', 'member')",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'member-1', 'specific')",
  );
  await engine.executeRaw(`INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id)
    VALUES ('member', 'member-1', 'allowed-source')`);
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id, archived)
    VALUES
      ('allowed-source', 'workspace-1', 'Allowed', 'https://example.test/allowed.git', 'daily', 'completed', 'member-1', FALSE),
      ('denied-source', 'workspace-1', 'Denied', 'https://example.test/denied.git', 'daily', 'completed', 'member-1', FALSE),
      ('archived-source', 'workspace-1', 'Archived', 'https://example.test/archived.git', 'daily', 'completed', 'member-1', TRUE)`);

  await engine.executeRaw(`CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    archived BOOLEAN NOT NULL DEFAULT FALSE
  )`);
  await engine.executeRaw(`CREATE TABLE pages (
    id SERIAL PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id),
    slug TEXT NOT NULL,
    type TEXT NOT NULL,
    page_kind TEXT NOT NULL DEFAULT 'markdown',
    title TEXT NOT NULL,
    compiled_truth TEXT NOT NULL DEFAULT '',
    frontmatter JSONB NOT NULL DEFAULT '{}',
    content_hash TEXT,
    import_filename TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (source_id, slug)
  )`);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES
    ('allowed-source', 'Allowed'), ('denied-source', 'Denied'), ('archived-source', 'Archived')`);
  await engine.executeRaw(`INSERT INTO pages
    (source_id, slug, type, title, compiled_truth, import_filename, deleted_at)
    VALUES
      ('allowed-source', 'handbook', 'document', 'Team handbook', 'Trusted text', 'handbook.md', NULL),
      ('allowed-source', 'deleted', 'document', 'Deleted page', 'Gone', 'deleted.md', now()),
      ('denied-source', 'private', 'document', 'Private plan', 'Secret', 'private.md', NULL),
      ('archived-source', 'old', 'document', 'Old guide', 'Old', 'old.md', NULL)`);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  scaleEngine = new PGLiteEngine();
  await scaleEngine.connect({ engine: 'pglite' });
});

afterAll(async () => {
  await engine.disconnect();
  await scaleEngine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DROP TABLE IF EXISTS pages');
  await engine.executeRaw('DROP TABLE IF EXISTS sources');
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await seedWorkspace();
});

describe('Workspace Knowledge', () => {
  test('projects only non-deleted Pages from currently active permitted Sources', async () => {
    const result = await listWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1',
      membershipId: 'member-1',
    });

    expect(result).toMatchObject({
      state: 'ready',
      rows: [{ source_id: 'allowed-source', slug: 'handbook', title: 'Team handbook' }],
      next_cursor: null,
    });
    expect(JSON.stringify(result)).not.toContain('Private plan');
    expect(JSON.stringify(result)).not.toContain('Trusted text');
  });

  test('distinguishes empty Workspace, Access required, no compiled Pages, and no matches without Source disclosure', async () => {
    await engine.executeRaw(
      "UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id='member-1'",
    );
    expect(await listWorkspaceKnowledge(engine, { workspaceId: 'workspace-1', membershipId: 'member-1' }))
      .toMatchObject({ state: 'access_required', rows: [] });

    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='all' WHERE principal_kind='member' AND principal_id='member-1'");
    await engine.executeRaw('DROP TABLE pages');
    expect(await listWorkspaceKnowledge(engine, { workspaceId: 'workspace-1', membershipId: 'member-1' }))
      .toMatchObject({ state: 'no_pages', rows: [] });

    await engine.executeRaw(`CREATE TABLE pages (
      id SERIAL PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), slug TEXT NOT NULL,
      type TEXT NOT NULL, page_kind TEXT NOT NULL DEFAULT 'markdown', title TEXT NOT NULL,
      compiled_truth TEXT NOT NULL DEFAULT '', frontmatter JSONB NOT NULL DEFAULT '{}', content_hash TEXT,
      import_filename TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      deleted_at TIMESTAMPTZ, UNIQUE (source_id, slug)
    )`);
    expect(await listWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', filters: { search: 'absent' },
    })).toMatchObject({ state: 'no_matches', rows: [] });

    await engine.executeRaw('DELETE FROM workspace_sources');
    expect(await listWorkspaceKnowledge(engine, { workspaceId: 'workspace-1', membershipId: 'member-1' }))
      .toMatchObject({ state: 'empty_workspace', rows: [] });
  });

  test('filters, sorts, selects properties, and paginates with a query-bound stable cursor', async () => {
    await engine.executeRaw(`INSERT INTO pages
      (source_id, slug, type, title, compiled_truth, frontmatter, import_filename, updated_at)
      VALUES
        ('allowed-source', 'architecture', 'reference', 'Architecture', 'Body', '{"citations":["ADR-1"]}', 'architecture.md', '2026-07-12T10:00:00Z'),
        ('allowed-source', 'roadmap', 'plan', 'Roadmap', 'Body', '{}', NULL, '2026-07-13T10:00:00Z')`);

    const first = await listWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1',
      membershipId: 'member-1',
      filters: { search: 'a', types: ['reference', 'plan'] },
      sort: { property: 'title', direction: 'asc' },
      visibleProperties: ['title', 'source', 'evidence_status'],
      limit: 1,
    });

    expect(first).toMatchObject({
      state: 'ready',
      rows: [{
        source_id: 'allowed-source',
        slug: 'architecture',
        title: 'Architecture',
        source: 'Allowed',
        evidence_status: 'cited',
      }],
    });
    expect(first.next_cursor).toBeString();
    expect(first.rows[0]).not.toHaveProperty('type');
    expect(first.rows[0]).not.toHaveProperty('last_changed');

    const second = await listWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1',
      membershipId: 'member-1',
      filters: { search: 'a', types: ['reference', 'plan'] },
      sort: { property: 'title', direction: 'asc' },
      visibleProperties: ['title', 'source', 'evidence_status'],
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.rows).toEqual([{
      source_id: 'allowed-source',
      slug: 'roadmap',
      title: 'Roadmap',
      source: 'Allowed',
      evidence_status: 'missing_evidence',
    }]);
    expect(second.next_cursor).toBeNull();

    await expect(listWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1',
      membershipId: 'member-1',
      filters: { search: 'different' },
      cursor: first.next_cursor!,
    })).rejects.toBeInstanceOf(WorkspaceKnowledgeError);
  });

  test('keeps freshness pagination pinned to the first page evaluation time', async () => {
    await engine.executeRaw(
      "UPDATE workspace_principal_source_policies SET access_mode='all' WHERE principal_kind='member' AND principal_id='member-1'",
    );
    await engine.executeRaw(`UPDATE workspace_sources SET last_verified_at=CASE source_id
      WHEN 'allowed-source' THEN '2026-07-13T08:00:00Z'::timestamptz
      WHEN 'denied-source' THEN '2026-07-12T12:00:00Z'::timestamptz
      ELSE last_verified_at END`);

    const first = await listWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1',
      sort: { property: 'source_freshness', direction: 'asc' },
      visibleProperties: ['title', 'source_freshness'], limit: 1,
      now: '2026-07-13T10:00:00Z',
    });
    expect(first.rows).toEqual([{
      source_id: 'allowed-source', slug: 'handbook', title: 'Team handbook', source_freshness: 'current',
    }]);

    const second = await listWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1',
      sort: { property: 'source_freshness', direction: 'asc' },
      visibleProperties: ['title', 'source_freshness'], limit: 1,
      cursor: first.next_cursor!, now: '2026-07-14T10:00:00Z',
    });
    expect(second.rows).toEqual([{
      source_id: 'denied-source', slug: 'private', title: 'Private plan', source_freshness: 'due_soon',
    }]);
  });

  test('persists personal Saved Views without persisting access and reauthorizes every open', async () => {
    const saved = await createWorkspaceSavedView(engine, {
      workspaceId: 'workspace-1',
      membershipId: 'member-1',
      name: 'My documents',
      filters: { types: ['document'] },
      sort: { property: 'title', direction: 'asc' },
      visibleProperties: ['title', 'type', 'source'],
    });
    expect(saved).toMatchObject({
      name: 'My documents',
      target_collection: 'knowledge',
      filters: { types: ['document'] },
      sort: { property: 'title', direction: 'asc' },
      visible_properties: ['title', 'type', 'source'],
    });
    expect(await listWorkspaceSavedViews(engine, 'workspace-1', 'member-1')).toHaveLength(1);

    const opened = await openWorkspaceSavedView(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', viewId: saved.view_id,
    });
    expect(opened.knowledge).toMatchObject({
      state: 'ready', rows: [{ source_id: 'allowed-source', slug: 'handbook' }],
    });

    const renamed = await updateWorkspaceSavedView(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', viewId: saved.view_id,
      name: 'Current documents',
    });
    expect(renamed.name).toBe('Current documents');

    await engine.executeRaw(
      "UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id='member-1'",
    );
    expect((await openWorkspaceSavedView(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', viewId: saved.view_id,
    })).knowledge.state).toBe('access_required');

    await deleteWorkspaceSavedView(engine, 'workspace-1', 'member-1', saved.view_id);
    expect(await listWorkspaceSavedViews(engine, 'workspace-1', 'member-1')).toEqual([]);
  });

  test('exposes member-gated Knowledge and personal Saved View APIs with safe request metadata', async () => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    await engine.executeRaw(`INSERT INTO workspace_sessions
      (session_hash, membership_id, csrf_hash, expires_at)
      VALUES ($1, 'member-1', $2, now() + interval '1 day')`, [digest('member-session'), digest('member-csrf')]);
    const app = express();
    app.use(createWorkspaceRouter(engine, {
      allowedOrigin: 'https://workspace.example.test',
      requestId: () => 'req-knowledge-api',
    }));
    const headers = {
      origin: 'https://workspace.example.test',
      cookie: 'workspace_session=member-session',
      'x-csrf-token': 'member-csrf',
      'content-type': 'application/json',
    };

    await withServer(app, async baseUrl => {
      const listed = await fetch(`${baseUrl}/api/workspace/v1/knowledge?visible=title,source&sort=title&direction=asc`, { headers });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        data: { state: 'ready', rows: [{ title: 'Team handbook', source: 'Allowed' }] },
        request_id: 'req-knowledge-api',
      });

      const created = await fetch(`${baseUrl}/api/workspace/v1/knowledge/saved-views`, {
        method: 'POST', headers,
        body: JSON.stringify({
          name: 'Team docs', filters: { types: ['document'] },
          sort: { property: 'title', direction: 'asc' }, visible_properties: ['title', 'source'],
        }),
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json() as { data: { view_id: string } };

      const opened = await fetch(`${baseUrl}/api/workspace/v1/knowledge/saved-views/${createdBody.data.view_id}/results`, { headers });
      expect(opened.status).toBe(200);
      expect(await opened.json()).toMatchObject({ data: { knowledge: { state: 'ready' } }, request_id: 'req-knowledge-api' });

      const shell = await fetch(`${baseUrl}/app/knowledge`, { headers });
      const html = await shell.text();
      expect(shell.status).toBe(200);
      expect(html).toContain('href="/app/knowledge" aria-current="page"');
      expect(html).toContain('id="knowledge-table"');
      expect(html).toContain('aria-label="Knowledge filters and sorting"');
      expect(html).toContain('id="knowledge-properties"');
      expect(html).toContain('id="saved-view-dialog"');
      expect(html).toContain('Last Trustworthy State');
      expect(html).toContain('potentially outdated');
      expect(html).toContain('empty_workspace');
      expect(html).toContain('access_required');
      expect(html).toContain('no_matches');
      expect(html).toContain('@media(max-width:720px)');
      expect(html).toContain('prefers-color-scheme:dark');
      expect(html).toContain('knowledgeTrustworthyConfig');
      expect(html).toContain('applyKnowledgeConfig(knowledgeTrustworthyConfig.config)');
      expect(html).not.toContain("link.href='/app/knowledge/'");

      const malformed = await fetch(`${baseUrl}/api/workspace/v1/knowledge?cursor=not-a-cursor`, { headers });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({
        error: { code: 'invalid_cursor', request_id: 'req-knowledge-api' },
      });
    });
  });

  test('keeps the indexed 100-Source / 100,000-Page list and filter projection within budget', async () => {
    await initializeWorkspaceFoundation(scaleEngine);
      await scaleEngine.initSchema();
      await scaleEngine.executeRaw(
        "INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('scale-workspace', 'Scale', now())",
      );
      await scaleEngine.executeRaw(
        "INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('scale-identity', 'scale@example.test', now())",
      );
      await scaleEngine.executeRaw(
        "INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('scale-member', 'scale-workspace', 'scale-identity', 'member')",
      );
      await scaleEngine.executeRaw(
        "INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'scale-member', 'all')",
      );
      await scaleEngine.executeRaw(`INSERT INTO sources (id, name, config)
        SELECT 'source-' || lpad(value::text, 3, '0'), 'Source ' || value, '{}'::jsonb
          FROM generate_series(1, 100) value
        ON CONFLICT (id) DO NOTHING`);
      await scaleEngine.executeRaw(`INSERT INTO workspace_sources
        (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id)
        SELECT 'source-' || lpad(value::text, 3, '0'), 'scale-workspace', 'Source ' || value,
               'https://example.test/source-' || value || '.git', 'daily', 'completed', 'scale-member'
          FROM generate_series(1, 100) value`);
      await scaleEngine.executeRaw(`INSERT INTO pages
        (source_id, slug, type, page_kind, title, compiled_truth, frontmatter, import_filename, updated_at)
        SELECT 'source-' || lpad((((value - 1) % 100) + 1)::text, 3, '0'),
               'page-' || lpad(value::text, 6, '0'),
               CASE WHEN value % 5 = 0 THEN 'reference' ELSE 'document' END,
               'markdown', 'Page ' || lpad(value::text, 6, '0'), 'Body', '{}'::jsonb,
               'page-' || value || '.md', '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 second'
          FROM generate_series(1, 100000) value`);

      const indexes = await scaleEngine.executeRaw<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
          WHERE schemaname='public' AND indexname IN
            ('pages_knowledge_changed_idx','pages_knowledge_title_idx','pages_knowledge_type_changed_idx','idx_pages_type','idx_pages_trgm')
          ORDER BY indexname`,
      );
      expect(indexes.map(row => row.indexname)).toEqual([
        'idx_pages_trgm', 'idx_pages_type', 'pages_knowledge_changed_idx', 'pages_knowledge_title_idx',
        'pages_knowledge_type_changed_idx',
      ]);

      const filteredRequest: ListWorkspaceKnowledgeInput = {
        workspaceId: 'scale-workspace', membershipId: 'scale-member',
        filters: { types: ['document'] },
        sort: { property: 'last_changed', direction: 'desc' },
        visibleProperties: ['title', 'source', 'last_changed'],
        limit: 50,
      };
      const defaultRequest: ListWorkspaceKnowledgeInput = {
        workspaceId: 'scale-workspace', membershipId: 'scale-member',
        sort: { property: 'last_changed', direction: 'desc' },
        visibleProperties: ['title', 'source', 'last_changed'],
        limit: 50,
      };
      const measure = async (request: ListWorkspaceKnowledgeInput): Promise<number[]> => {
        await listWorkspaceKnowledge(scaleEngine, request);
        const durations: number[] = [];
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const started = performance.now();
          const result = await listWorkspaceKnowledge(scaleEngine, request);
          durations.push(performance.now() - started);
          expect(result.rows).toHaveLength(50);
          expect(result.next_cursor).toBeString();
        }
        return durations;
      };
      const defaultDurations = await measure(defaultRequest);
      const filteredDurations = await measure(filteredRequest);
      expect(Math.max(...defaultDurations)).toBeLessThan(1000);
      expect(Math.max(...filteredDurations)).toBeLessThan(1000);
  }, 30_000);
});
