import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  listWorkspaceSearchSources,
  searchWorkspaceKnowledge,
  WorkspaceSearchError,
  type SearchWorkspaceKnowledgeInput,
} from '../src/workspace/search.ts';
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
    VALUES ('member', 'member-1', 'included-source'), ('member', 'member-1', 'excluded-source')`);
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id, archived, included_in_workspace_search)
    VALUES
      ('included-source', 'workspace-1', 'Included', 'https://example.test/included.git', 'daily', 'completed', 'member-1', FALSE, TRUE),
      ('excluded-source', 'workspace-1', 'Excluded', 'https://example.test/excluded.git', 'daily', 'completed', 'member-1', FALSE, FALSE),
      ('denied-source', 'workspace-1', 'Denied', 'https://example.test/denied.git', 'daily', 'completed', 'member-1', FALSE, TRUE),
      ('archived-source', 'workspace-1', 'Archived', 'https://example.test/archived.git', 'daily', 'completed', 'member-1', TRUE, TRUE)`);

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
    effective_date TIMESTAMPTZ,
    effective_date_source TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (source_id, slug)
  )`);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES
    ('included-source', 'Included'), ('excluded-source', 'Excluded'),
    ('denied-source', 'Denied'), ('archived-source', 'Archived')`);
  await engine.executeRaw(`INSERT INTO pages
    (source_id, slug, type, title, compiled_truth, import_filename, deleted_at)
    VALUES
      ('included-source', 'onboarding-handbook', 'document', 'Onboarding handbook', 'Welcome. Read the handbook before the first standup.', 'handbook.md', NULL),
      ('included-source', 'deleted-note', 'document', 'Deleted handbook note', 'Handbook content that was removed.', 'deleted.md', now()),
      ('excluded-source', 'private-handbook', 'document', 'Private team handbook', 'Excluded handbook body.', 'private.md', NULL),
      ('denied-source', 'secret-handbook', 'document', 'Secret handbook plan', 'Restricted handbook body.', 'secret.md', NULL),
      ('archived-source', 'old-handbook', 'document', 'Old handbook', 'Archived handbook body.', 'old.md', NULL)`);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  scaleEngine = new PGLiteEngine();
  await scaleEngine.connect({ engine: 'pglite' });
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  await scaleEngine.disconnect();
}, 30_000);

beforeEach(async () => {
  await engine.executeRaw('DROP TABLE IF EXISTS pages');
  await engine.executeRaw('DROP TABLE IF EXISTS sources');
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await seedWorkspace();
}, 30_000);

describe('Workspace Search', () => {
  test('defaults to active, included, permitted Sources without disclosing anything else', async () => {
    const result = await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1',
      membershipId: 'member-1',
      query: 'handbook',
    });

    expect(result.state).toBe('ready');
    expect(result.mode).toBe('workspace_search');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      page: { source_id: 'included-source', slug: 'onboarding-handbook' },
      title: 'Onboarding handbook',
      type: 'document',
      source: { source_id: 'included-source', name: 'Included' },
      evidence_status: 'source_backed',
      match: { field: 'title', snippet: 'Onboarding handbook' },
    });
    expect(result.results[0].source_freshness).toBeString();
    expect(result.results[0].last_changed).toBeString();

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('Secret handbook plan');
    expect(serialized).not.toContain('Private team handbook');
    expect(serialized).not.toContain('Old handbook');
    expect(serialized).not.toContain('Deleted handbook note');
  });

  test('inclusion changes eligibility only and never grants Source Access', async () => {
    // Excluding the permitted Source removes it from the default search.
    await engine.executeRaw(
      "UPDATE workspace_sources SET included_in_workspace_search=FALSE WHERE source_id='included-source'",
    );
    const excludedAll = await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
    });
    expect(excludedAll.state).toBe('no_searchable_sources');
    expect(excludedAll.results).toEqual([]);

    // Including the denied Source never makes its Pages visible.
    await engine.executeRaw(
      "UPDATE workspace_sources SET included_in_workspace_search=TRUE WHERE source_id IN ('included-source','denied-source')",
    );
    const included = await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
    });
    expect(included.results.map(row => row.page.source_id)).toEqual(['included-source']);
    expect(JSON.stringify(included)).not.toContain('Secret');
  });

  test('an authorized caller can explicitly select an accessible Source excluded from default search', async () => {
    const explicit = await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
      sourceIds: ['excluded-source'],
    });
    expect(explicit.state).toBe('ready');
    expect(explicit.mode).toBe('explicit_sources');
    expect(explicit.results.map(row => row.page.slug)).toEqual(['private-handbook']);

    // Selecting an inaccessible Source is indistinguishable from no matches.
    const denied = await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
      sourceIds: ['denied-source'],
    });
    expect(denied.state).toBe('no_matches');
    expect(denied.results).toEqual([]);
    const archived = await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
      sourceIds: ['archived-source'],
    });
    expect(archived.state).toBe('no_matches');
  });

  test('ranks title before slug before body and exposes inspectable matching evidence', async () => {
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, updated_at)
      VALUES
        ('included-source', 'roadmap-quarter', 'plan', 'Quarterly roadmap', 'The roadmap covers hiring.', '2026-07-10T10:00:00Z'),
        ('included-source', 'hiring-notes', 'document', 'Interview notes', 'Slug misses, but hiring appears in this body text somewhere in the middle of a longer paragraph so the snippet must window around the match.', '2026-07-11T10:00:00Z')`);

    const result = await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'hiring',
    });
    expect(result.results.map(row => ({ slug: row.page.slug, field: row.match.field }))).toEqual([
      { slug: 'hiring-notes', field: 'slug' },
      { slug: 'roadmap-quarter', field: 'body' },
    ]);
    expect(result.results[1].match.snippet).toContain('hiring');
    expect(result.results[1].match.snippet.length).toBeLessThanOrEqual(160);
  });

  test('supports trust-context filters and rejects invalid input', async () => {
    const filtered = await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
      filters: { evidence_statuses: ['missing_evidence'] },
    });
    expect(filtered.state).toBe('no_matches');

    await expect(searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: '   ',
    })).rejects.toMatchObject({ code: 'invalid_query' });
    await expect(searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'x'.repeat(201),
    })).rejects.toMatchObject({ code: 'invalid_query' });
    await expect(searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
      sourceIds: ['Not A Source Id!'],
    })).rejects.toMatchObject({ code: 'invalid_source_selection' });
    await expect(searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
      filters: { evidence_statuses: ['fabricated'] as never },
    })).rejects.toMatchObject({ code: 'invalid_filter' });
    await expect(searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook', limit: 0,
    })).rejects.toMatchObject({ code: 'invalid_limit' });
  });

  test('paginates with a stable query-bound cursor', async () => {
    await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth, updated_at)
      SELECT 'included-source', 'guide-' || value, 'document', 'Guide ' || value, 'Body', '2026-07-01T00:00:00Z'::timestamptz + value * interval '1 hour'
        FROM generate_series(1, 3) value`);

    const first = await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'guide', limit: 2,
    });
    expect(first.results).toHaveLength(2);
    expect(first.next_cursor).toBeString();

    const second = await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'guide', limit: 2,
      cursor: first.next_cursor!,
    });
    expect(second.results).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    const seen = [...first.results, ...second.results].map(row => row.page.slug);
    expect(new Set(seen).size).toBe(3);

    await expect(searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'different', cursor: first.next_cursor!,
    })).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'guide',
      sourceIds: ['excluded-source'], cursor: first.next_cursor!,
    })).rejects.toMatchObject({ code: 'invalid_cursor' });
  });

  test('distinguishes empty Workspace, access required, and missing Pages without disclosure', async () => {
    await engine.executeRaw(
      "UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id='member-1'",
    );
    expect((await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
    })).state).toBe('access_required');

    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='all' WHERE principal_kind='member' AND principal_id='member-1'");
    await engine.executeRaw('DROP TABLE pages');
    expect((await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
    })).state).toBe('no_pages');

    await engine.executeRaw('DELETE FROM workspace_sources');
    expect((await searchWorkspaceKnowledge(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1', query: 'handbook',
    })).state).toBe('empty_workspace');
  });

  test('lists only the caller\'s permitted active Sources for explicit selection', async () => {
    const sources = await listWorkspaceSearchSources(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1',
    });
    expect(sources).toEqual([
      { source_id: 'excluded-source', name: 'Excluded', included_in_workspace_search: false },
      { source_id: 'included-source', name: 'Included', included_in_workspace_search: true },
    ]);

    await engine.executeRaw(
      "UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id='member-1'",
    );
    expect(await listWorkspaceSearchSources(engine, {
      workspaceId: 'workspace-1', membershipId: 'member-1',
    })).toEqual([]);
  });

  test('exposes member-gated Search APIs and rechecks internal Page links after revocation', async () => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    await engine.executeRaw(`INSERT INTO workspace_sessions
      (session_hash, membership_id, csrf_hash, expires_at)
      VALUES ($1, 'member-1', $2, now() + interval '1 day')`, [digest('member-session'), digest('member-csrf')]);
    const app = express();
    app.use(createWorkspaceRouter(engine, {
      allowedOrigin: 'https://workspace.example.test',
      requestId: () => 'req-search-api',
    }));
    const headers = {
      origin: 'https://workspace.example.test',
      cookie: 'workspace_session=member-session',
      'content-type': 'application/json',
    };

    await withServer(app, async baseUrl => {
      const unauthenticated = await fetch(`${baseUrl}/api/workspace/v1/search?q=handbook`);
      expect(unauthenticated.status).toBe(401);

      const searched = await fetch(`${baseUrl}/api/workspace/v1/search?q=handbook`, { headers });
      expect(searched.status).toBe(200);
      const searchedBody = await searched.json() as {
        data: { state: string; results: { page: { source_id: string; slug: string } }[] };
        request_id: string;
      };
      expect(searchedBody.request_id).toBe('req-search-api');
      expect(searchedBody.data.state).toBe('ready');
      const [match] = searchedBody.data.results;
      expect(match.page).toEqual({ source_id: 'included-source', slug: 'onboarding-handbook' });

      const selector = await fetch(`${baseUrl}/api/workspace/v1/search/sources`, { headers });
      expect(selector.status).toBe(200);
      expect(await selector.json()).toMatchObject({
        data: [{ source_id: 'excluded-source' }, { source_id: 'included-source' }],
      });

      const invalid = await fetch(`${baseUrl}/api/workspace/v1/search?q=`, { headers });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_query', request_id: 'req-search-api' } });

      // The internal Page link from the search result opens while access holds.
      const pagePath = `/api/workspace/v1/knowledge/pages/${match.page.source_id}/${match.page.slug}`;
      const opened = await fetch(`${baseUrl}${pagePath}`, { headers });
      expect(opened.status).toBe(200);

      // Revocation applies to the same link immediately, and Search agrees.
      await engine.executeRaw(
        "UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id='member-1'",
      );
      const reopened = await fetch(`${baseUrl}${pagePath}`, { headers });
      expect(reopened.status).toBe(404);
      expect(await reopened.json()).toMatchObject({ error: { code: 'page_not_found' } });
      const revokedSearch = await fetch(`${baseUrl}/api/workspace/v1/search?q=handbook`, { headers });
      expect((await revokedSearch.json() as { data: { state: string } }).data.state).toBe('access_required');

      // The Search shell renders every declared visible state from one document.
      const shell = await fetch(`${baseUrl}/app/search`, { headers });
      const html = await shell.text();
      expect(shell.status).toBe(200);
      expect(html).toContain('href="/app/search" aria-current="page"');
      expect(html).toContain('id="search-input"');
      expect(html).toContain('id="search-source"');
      expect(html).toContain('id="search-results"');
      expect(html).toContain('Ask 2Brain');
      expect(html).toContain('no_searchable_sources');
      expect(html).toContain('access_required');
      expect(html).toContain('no_matches');
      expect(html).toContain('@media(max-width:720px)');
      expect(html).toContain('prefers-color-scheme:dark');
    });
  });

  test('keeps the indexed 100-Source / 100,000-Page search within the one-second budget', async () => {
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
             'document', 'markdown', 'Page ' || lpad(value::text, 6, '0'),
             CASE WHEN value % 500 = 0 THEN 'This body mentions the quarterly budget review.' ELSE 'Routine body text.' END,
             '{}'::jsonb, 'page-' || value || '.md',
             '2026-01-01T00:00:00Z'::timestamptz + value * interval '1 second'
        FROM generate_series(1, 100000) value`);

    await scaleEngine.executeRaw('ANALYZE pages');
    const indexes = await scaleEngine.executeRaw<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname='public' AND indexname IN ('idx_pages_trgm', 'idx_pages_slug_trgm', 'idx_pages_body_trgm')
        ORDER BY indexname`,
    );
    expect(indexes.map(row => row.indexname)).toEqual(['idx_pages_body_trgm', 'idx_pages_slug_trgm', 'idx_pages_trgm']);

    const request: SearchWorkspaceKnowledgeInput = {
      workspaceId: 'scale-workspace', membershipId: 'scale-member', query: 'quarterly budget', limit: 50,
    };
    await searchWorkspaceKnowledge(scaleEngine, request);
    const durations: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = performance.now();
      const result = await searchWorkspaceKnowledge(scaleEngine, request);
      durations.push(performance.now() - started);
      expect(result.state).toBe('ready');
      expect(result.results.length).toBeGreaterThan(0);
    }
    expect(Math.max(...durations)).toBeLessThan(1000);
  }, 60_000);
});
