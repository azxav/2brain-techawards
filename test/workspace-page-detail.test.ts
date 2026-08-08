import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  getWorkspacePage,
  listWorkspacePageVersions,
  WorkspacePageError,
} from '../src/workspace/page-detail.ts';
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
    (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id, archived, last_verified_at)
    VALUES
      ('allowed-source', 'workspace-1', 'Allowed', 'https://example.test/allowed.git', 'daily', 'completed', 'member-1', FALSE, '2026-07-13T08:00:00Z'),
      ('denied-source', 'workspace-1', 'Denied', 'https://example.test/denied.git', 'daily', 'completed', 'member-1', FALSE, NULL),
      ('archived-source', 'workspace-1', 'Archived', 'https://example.test/archived.git', 'daily', 'completed', 'member-1', TRUE, NULL)`);

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
  await engine.executeRaw(`CREATE TABLE page_versions (
    id SERIAL PRIMARY KEY,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    compiled_truth TEXT NOT NULL,
    frontmatter JSONB NOT NULL DEFAULT '{}',
    snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await engine.executeRaw(`CREATE TABLE ingest_log (
    id SERIAL PRIMARY KEY,
    source_id TEXT NOT NULL DEFAULT 'default',
    source_type TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    pages_updated JSONB NOT NULL DEFAULT '[]',
    summary TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES
    ('allowed-source', 'Allowed'), ('denied-source', 'Denied'), ('archived-source', 'Archived')`);
  await engine.executeRaw(`INSERT INTO pages
    (source_id, slug, type, title, compiled_truth, frontmatter, import_filename, effective_date, effective_date_source, created_at, updated_at, deleted_at)
    VALUES
      ('allowed-source', 'handbook', 'document', 'Team handbook', 'Current truth', '{}', 'handbook.md', '2026-06-01T00:00:00Z', 'date', '2026-07-01T09:00:00Z', '2026-07-12T09:00:00Z', NULL),
      ('allowed-source', 'cited', 'reference', 'Cited page', 'Cited body', '{"citations":["ADR-1","ADR-2"]}', 'cited.md', NULL, NULL, '2026-07-01T09:00:00Z', '2026-07-12T09:00:00Z', NULL),
      ('allowed-source', 'uncited', 'note', 'Uncited page', 'No trace', '{}', NULL, NULL, NULL, '2026-07-01T09:00:00Z', '2026-07-12T09:00:00Z', NULL),
      ('allowed-source', 'deleted', 'document', 'Deleted page', 'Gone', '{}', 'deleted.md', NULL, NULL, '2026-07-01T09:00:00Z', '2026-07-12T09:00:00Z', now()),
      ('denied-source', 'private', 'document', 'Private plan', 'Secret', '{}', 'private.md', NULL, NULL, '2026-07-01T09:00:00Z', '2026-07-12T09:00:00Z', NULL),
      ('archived-source', 'old', 'document', 'Old guide', 'Old', '{}', 'old.md', NULL, NULL, '2026-07-01T09:00:00Z', '2026-07-12T09:00:00Z', NULL)`);
}

const detailInput = (overrides: Partial<Parameters<typeof getWorkspacePage>[1]> = {}) => ({
  workspaceId: 'workspace-1',
  membershipId: 'member-1',
  sourceId: 'allowed-source',
  slug: 'handbook',
  now: '2026-07-13T10:00:00Z',
  ...overrides,
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DROP TABLE IF EXISTS ingest_log');
  await engine.executeRaw('DROP TABLE IF EXISTS page_versions');
  await engine.executeRaw('DROP TABLE IF EXISTS pages');
  await engine.executeRaw('DROP TABLE IF EXISTS sources');
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await seedWorkspace();
});

describe('Workspace Page detail', () => {
  test('exposes Source, provenance, freshness, evidence, and composite identity for a permitted Page', async () => {
    await engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, created_at)
      VALUES ('allowed-source', 'import', 'docs/handbook.md', '["handbook"]', '2026-07-12T08:59:00Z')`);

    const detail = await getWorkspacePage(engine, detailInput());

    expect(detail).toMatchObject({
      page: { source_id: 'allowed-source', slug: 'handbook' },
      title: 'Team handbook',
      type: 'document',
      source: { source_id: 'allowed-source', name: 'Allowed' },
      provenance: {
        original_location: 'handbook.md',
        ingestion: { path: 'import', reference: 'docs/handbook.md' },
        effective_date_source: 'date',
      },
      source_freshness: {
        state: 'current',
        evidence: { expected_cadence: 'daily', known_unsynchronized_revision: null },
      },
      evidence_status: {
        state: 'source_backed',
        explanation: { citation_count: 0, has_traceable_original: true },
      },
      body: 'Current truth',
    });
    expect(detail.provenance.created_at).toBe('2026-07-01T09:00:00.000Z');
    expect(detail.provenance.last_changed_at).toBe('2026-07-12T09:00:00.000Z');
    expect(detail.provenance.effective_date).toBe('2026-06-01T00:00:00.000Z');
    expect(detail.source_freshness.evidence.last_verified_at).toBe('2026-07-13T08:00:00.000Z');
    expect(detail.provenance.ingestion?.recorded_at).toBe('2026-07-12T08:59:00.000Z');
  });

  test('classifies Evidence Status deterministically with explainable inputs', async () => {
    const cited = await getWorkspacePage(engine, detailInput({ slug: 'cited' }));
    expect(cited.evidence_status).toEqual({
      state: 'cited',
      explanation: { citation_count: 2, has_traceable_original: true },
    });

    const missing = await getWorkspacePage(engine, detailInput({ slug: 'uncited' }));
    expect(missing.evidence_status).toEqual({
      state: 'missing_evidence',
      explanation: { citation_count: 0, has_traceable_original: false },
    });
  });

  test('reports ingestion only when evidence exists; otherwise Unknown', async () => {
    const detail = await getWorkspacePage(engine, detailInput());
    expect(detail.provenance.ingestion).toBeNull();

    await engine.executeRaw('DROP TABLE ingest_log');
    const withoutLog = await getWorkspacePage(engine, detailInput());
    expect(withoutLog.provenance.ingestion).toBeNull();
  });

  test('denies denied, archived, deleted, and unknown Pages without disclosure', async () => {
    for (const input of [
      detailInput({ sourceId: 'denied-source', slug: 'private' }),
      detailInput({ sourceId: 'archived-source', slug: 'old' }),
      detailInput({ slug: 'deleted' }),
      detailInput({ slug: 'absent' }),
      detailInput({ sourceId: 'ghost-source', slug: 'handbook' }),
    ]) {
      let failure: unknown;
      try { await getWorkspacePage(engine, input); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(WorkspacePageError);
      expect((failure as WorkspacePageError).code).toBe('page_not_found');
      expect(JSON.stringify(failure)).not.toContain('Private plan');
      expect(JSON.stringify(failure)).not.toContain('Secret');
    }

    await expect(getWorkspacePage(engine, detailInput({ sourceId: 'Bad Source!' })))
      .rejects.toMatchObject({ code: 'invalid_page_reference' });
    await expect(getWorkspacePage(engine, detailInput({ slug: '' })))
      .rejects.toMatchObject({ code: 'invalid_page_reference' });
  });

  test('rechecks Membership, active Source state, and Source Access on every direct request', async () => {
    await getWorkspacePage(engine, detailInput());

    await engine.executeRaw(
      "UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id='member-1'",
    );
    await expect(getWorkspacePage(engine, detailInput())).rejects.toMatchObject({ code: 'page_not_found' });
    await expect(listWorkspacePageVersions(engine, detailInput())).rejects.toMatchObject({ code: 'page_not_found' });

    await engine.executeRaw(
      "UPDATE workspace_principal_source_policies SET access_mode='all' WHERE principal_kind='member' AND principal_id='member-1'",
    );
    await engine.executeRaw("UPDATE workspace_sources SET archived=TRUE WHERE source_id='allowed-source'");
    await expect(getWorkspacePage(engine, detailInput())).rejects.toMatchObject({ code: 'page_not_found' });
    await expect(listWorkspacePageVersions(engine, detailInput())).rejects.toMatchObject({ code: 'page_not_found' });
  });

  test('lists Page Versions newest first with content and metadata snapshots and evidenced cause only', async () => {
    await engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, frontmatter, snapshot_at)
      SELECT id, 'First truth', '{"revision":1}', '2026-07-05T09:00:00Z' FROM pages WHERE source_id='allowed-source' AND slug='handbook'`);
    await engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, frontmatter, snapshot_at)
      SELECT id, 'Second truth', '{"revision":2}', '2026-07-10T09:00:00Z' FROM pages WHERE source_id='allowed-source' AND slug='handbook'`);
    await engine.executeRaw(`INSERT INTO ingest_log (source_id, source_type, source_ref, pages_updated, created_at)
      VALUES ('allowed-source', 'sync', 'revision-abc', '["handbook"]', '2026-07-08T09:00:00Z')`);

    const versions = await listWorkspacePageVersions(engine, detailInput());
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      snapshot_at: '2026-07-10T09:00:00.000Z',
      actor: null,
      cause: { path: 'sync', reference: 'revision-abc', recorded_at: '2026-07-08T09:00:00.000Z' },
      content: 'Second truth',
      metadata: { revision: 2 },
    });
    expect(versions[1]).toMatchObject({
      snapshot_at: '2026-07-05T09:00:00.000Z',
      actor: null,
      cause: null,
      content: 'First truth',
      metadata: { revision: 1 },
    });

    await engine.executeRaw('DROP TABLE page_versions');
    expect(await listWorkspacePageVersions(engine, detailInput())).toEqual([]);
  });

  test('exposes member-gated Page detail and history APIs without leaking denied Source data', async () => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    await engine.executeRaw(`INSERT INTO workspace_sessions
      (session_hash, membership_id, csrf_hash, expires_at)
      VALUES ($1, 'member-1', $2, now() + interval '1 day')`, [digest('member-session'), digest('member-csrf')]);
    const app = express();
    app.use(createWorkspaceRouter(engine, {
      allowedOrigin: 'https://workspace.example.test',
      requestId: () => 'req-page-api',
    }));
    const headers = {
      origin: 'https://workspace.example.test',
      cookie: 'workspace_session=member-session',
      'content-type': 'application/json',
    };

    await withServer(app, async baseUrl => {
      const detail = await fetch(`${baseUrl}/api/workspace/v1/knowledge/pages/allowed-source/handbook`, { headers });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        data: {
          page: { source_id: 'allowed-source', slug: 'handbook' },
          title: 'Team handbook',
          evidence_status: { state: 'source_backed' },
        },
        request_id: 'req-page-api',
      });

      const denied = await fetch(`${baseUrl}/api/workspace/v1/knowledge/pages/denied-source/private`, { headers });
      expect(denied.status).toBe(404);
      const deniedText = await denied.text();
      expect(deniedText).toContain('page_not_found');
      expect(deniedText).not.toContain('Private plan');
      expect(deniedText).not.toContain('Secret');

      const invalid = await fetch(`${baseUrl}/api/workspace/v1/knowledge/pages/Bad%20Source!/handbook`, { headers });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: { code: 'invalid_page_reference' } });

      const versions = await fetch(`${baseUrl}/api/workspace/v1/knowledge/pages/allowed-source/handbook/versions`, { headers });
      expect(versions.status).toBe(200);
      expect(await versions.json()).toMatchObject({ data: { versions: [] }, request_id: 'req-page-api' });

      const unauthenticated = await fetch(`${baseUrl}/api/workspace/v1/knowledge/pages/allowed-source/handbook`);
      expect(unauthenticated.status).toBe(401);

      const shell = await fetch(`${baseUrl}/app/knowledge/allowed-source/handbook`, { headers });
      const html = await shell.text();
      expect(shell.status).toBe(200);
      expect(html).toContain('id="page-peek"');
      expect(html).toContain('id="page-history"');
      expect(html).toContain('id="page-copy-link"');
      expect(html).toContain('Unknown');
      expect(html).toContain('@media(max-width:720px)');
      expect(html).toContain('prefers-color-scheme:dark');
      expect(html).not.toContain('contenteditable');
      expect(html.toLowerCase()).not.toContain('revert');
      expect(html.toLowerCase()).not.toContain('rich edit');
    });
  });
});
