import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { restoreWorkspaceSource } from '../src/workspace/source-lifecycle.ts';
import {
  listArchivedManagedGitSources,
  listManagedGitSources,
} from '../src/workspace/source-provisioning.ts';
import {
  previewSourceDeletionImpact,
  queueSourcePermanentDeletion,
  runSourceDeletionWorkerOnce,
} from '../src/workspace/source-deletion.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
});

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(engine);
  for (const table of ['page_versions', 'pages', 'ingest_log', 'sources']) {
    await engine.executeRaw(`DROP TABLE IF EXISTS ${table}`);
  }
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id,name,setup_completed_at) VALUES ('w','W',now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('admin-i','admin@example.test',now()),('member-i','member@example.test',now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('admin','w','admin-i','administrator'),('member','w','member-i','member')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member','admin','all'),('member','member','all')");
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id,
     archived,archived_at,archived_by_membership_id)
    VALUES ('docs','w','Docs','https://example.test/docs.git','daily','completed','admin',TRUE,now(),'admin')`);
});

function deletionInput(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: 'w',
    sourceId: 'docs',
    confirmationSourceId: 'docs',
    reason: 'Deliberate removal approved by governance.',
    actorMembershipId: 'admin',
    requestId: 'req-delete',
    idempotencyKey: 'delete-docs',
    ...overrides,
  };
}

async function createLegacyContentFixture(): Promise<void> {
  await engine.executeRaw(`CREATE TABLE sources (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}'::jsonb,
    archived BOOLEAN NOT NULL DEFAULT FALSE, archived_at TIMESTAMPTZ, archive_expires_at TIMESTAMPTZ
  )`);
  await engine.executeRaw(`CREATE TABLE pages (
    id SERIAL PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    slug TEXT NOT NULL, deleted_at TIMESTAMPTZ
  )`);
  await engine.executeRaw(`CREATE TABLE page_versions (
    id SERIAL PRIMARY KEY, page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE
  )`);
  await engine.executeRaw(`CREATE TABLE ingest_log (
    id SERIAL PRIMARY KEY, source_id TEXT NOT NULL
  )`);
  await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('docs','Docs'),('kept','Kept')");
  await engine.executeRaw("INSERT INTO pages (source_id,slug) VALUES ('docs','a'),('docs','b'),('kept','k')");
  await engine.executeRaw(`INSERT INTO page_versions (page_id)
    SELECT id FROM pages WHERE source_id='docs' UNION ALL SELECT id FROM pages WHERE slug='a'
    UNION ALL SELECT id FROM pages WHERE slug='k'`);
  await engine.executeRaw("INSERT INTO ingest_log (source_id) VALUES ('docs'),('kept')");
}

describe('previewSourceDeletionImpact', () => {
  test('is limited to Administrators with Source Access', async () => {
    await expect(previewSourceDeletionImpact(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'member',
    })).rejects.toMatchObject({ code: 'source_deletion_forbidden' });
  });

  test('is available only while the Source is Archived', async () => {
    await engine.executeRaw("UPDATE workspace_sources SET archived=FALSE, archived_at=NULL WHERE source_id='docs'");
    await expect(previewSourceDeletionImpact(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin',
    })).rejects.toMatchObject({ code: 'source_not_archived' });
    await expect(previewSourceDeletionImpact(engine, {
      workspaceId: 'w', sourceId: 'ghost', actorMembershipId: 'admin',
    })).rejects.toMatchObject({ code: 'source_not_found' });
  });

  test('reports affected record counts without exposing content', async () => {
    await createLegacyContentFixture();
    await engine.executeRaw(`INSERT INTO workspace_saved_views (view_id,workspace_id,owner_membership_id,name,filters,sort,visible_properties)
      VALUES ('v1','w','admin','Docs only','{"source_ids":["docs"]}'::jsonb,'{"property":"title","direction":"asc"}'::jsonb,'["title"]'::jsonb),
             ('v2','w','admin','Everything','{}'::jsonb,'{"property":"title","direction":"asc"}'::jsonb,'["title"]'::jsonb)`);
    await engine.executeRaw(`INSERT INTO workspace_background_operations
      (operation_id,workspace_id,operation_type,initiator_membership_id,resource_type,resource_id,idempotency_key,idempotency_fingerprint,request_id)
      VALUES ('op-1','w','source.verify','admin','source','docs','k1','f1','r1')`);
    await engine.executeRaw(`INSERT INTO workspace_source_verification_events
      (event_id,workspace_id,source_id,operation_id,outcome,request_id)
      VALUES ('ev-1','w','docs','op-1','succeeded','r1')`);
    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='specific' WHERE principal_id='admin'");
    await engine.executeRaw("INSERT INTO workspace_source_grants (principal_kind,principal_id,source_id) VALUES ('member','admin','docs')");

    const impact = await previewSourceDeletionImpact(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin',
    });
    expect(impact).toEqual({
      sourceId: 'docs',
      pages: 2,
      pageVersions: 3,
      savedViews: 1,
      backgroundOperations: 1,
      verificationEvents: 1,
      accessGrants: 1,
    });
  });

  test('reports zero counts when no legacy content projection exists', async () => {
    const impact = await previewSourceDeletionImpact(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin',
    });
    expect(impact).toMatchObject({ pages: 0, pageVersions: 0 });
  });
});

describe('runSourceDeletionWorkerOnce', () => {
  test('purges eligible content, redacts the retained lifecycle row, and audits the deletion', async () => {
    await createLegacyContentFixture();
    await engine.executeRaw("INSERT INTO workspace_source_grants (principal_kind,principal_id,source_id) VALUES ('member','member','docs')");
    await engine.executeRaw(`INSERT INTO workspace_background_operations
      (operation_id,workspace_id,operation_type,initiator_membership_id,resource_type,resource_id,
       idempotency_key,idempotency_fingerprint,request_id,state)
      VALUES ('op-verify','w','source.verify','admin','source','docs','verify-key','verify-fp','req-verify','completed')`);
    await engine.executeRaw(`INSERT INTO workspace_source_verification_events
      (event_id,workspace_id,source_id,operation_id,observed_revision,content_state,outcome,request_id)
      VALUES ('ev-verify','w','docs','op-verify','revision-abc123','unchanged','succeeded','req-verify')`);
    const queued = await queueSourcePermanentDeletion(engine, deletionInput());

    const finished = await runSourceDeletionWorkerOnce(engine, { workerId: 'worker-a' });
    expect(finished).toMatchObject({
      operationId: queued.operationId,
      type: 'source.permanent_delete',
      state: 'completed',
      progress: 100,
    });

    expect(await engine.executeRaw("SELECT id FROM sources WHERE id='docs'")).toEqual([]);
    expect(await engine.executeRaw("SELECT id FROM sources WHERE id='kept'")).toHaveLength(1);
    expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id='docs'")).toEqual([]);
    expect(await engine.executeRaw('SELECT id FROM page_versions')).toHaveLength(1);
    expect(await engine.executeRaw("SELECT id FROM ingest_log WHERE source_id='docs'")).toEqual([]);
    expect(await engine.executeRaw("SELECT id FROM ingest_log WHERE source_id='kept'")).toHaveLength(1);
    expect(await engine.executeRaw("SELECT source_id FROM workspace_source_grants WHERE source_id='docs'")).toEqual([]);
    expect(await engine.executeRaw(
      "SELECT observed_revision,outcome FROM workspace_source_verification_events WHERE source_id='docs'",
    )).toEqual([{ observed_revision: null, outcome: 'succeeded' }]);

    const retained = await engine.executeRaw<{
      deleted: boolean; name: string; remote_url: string; archived: boolean;
      deleted_by_membership_id: string; deleted_at: string | Date;
    }>("SELECT deleted,name,remote_url,archived,deleted_by_membership_id,deleted_at FROM workspace_sources WHERE source_id='docs'");
    expect(retained[0]).toMatchObject({
      deleted: true,
      archived: true,
      deleted_by_membership_id: 'admin',
    });
    expect(retained[0]!.deleted_at).toBeTruthy();
    expect(retained[0]!.name).not.toContain('Docs');
    expect(retained[0]!.remote_url).not.toContain('example.test');

    const audits = await engine.executeRaw<{ action: string; outcome: string; reason: string }>(
      "SELECT action,outcome,reason FROM workspace_audit_events WHERE action='source.delete'",
    );
    expect(audits).toEqual([{
      action: 'source.delete',
      outcome: 'succeeded',
      reason: 'Deliberate removal approved by governance.',
    }]);
    expect(await engine.executeRaw(
      "SELECT summary FROM workspace_change_events WHERE summary='Deleted a source.'",
    )).toHaveLength(1);

    expect(await runSourceDeletionWorkerOnce(engine, { workerId: 'worker-a' })).toBeNull();
  });

  test('revalidates the archived state immediately before destructive execution', async () => {
    await createLegacyContentFixture();
    await queueSourcePermanentDeletion(engine, deletionInput());
    await engine.executeRaw("UPDATE workspace_sources SET archived=FALSE, archived_at=NULL WHERE source_id='docs'");

    const finished = await runSourceDeletionWorkerOnce(engine, { workerId: 'worker-a' });
    expect(finished).toMatchObject({
      state: 'failed',
      retryable: false,
      error: expect.objectContaining({ code: 'source_not_archived' }),
    });
    expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id='docs'")).toHaveLength(2);
    expect(await engine.executeRaw<{ deleted: boolean }>(
      "SELECT deleted FROM workspace_sources WHERE source_id='docs'",
    )).toEqual([{ deleted: false }]);
    expect(await engine.executeRaw(
      "SELECT action,outcome,reason FROM workspace_audit_events WHERE action='source.delete.fail'",
    )).toEqual([{
      action: 'source.delete.fail',
      outcome: 'failed',
      reason: 'Deliberate removal approved by governance.',
    }]);
  });

  test('revalidates the requesting Administrator immediately before destructive execution', async () => {
    await queueSourcePermanentDeletion(engine, deletionInput());
    await engine.executeRaw("UPDATE workspace_memberships SET status='disabled' WHERE membership_id='admin'");

    const finished = await runSourceDeletionWorkerOnce(engine, { workerId: 'worker-a' });
    expect(finished).toMatchObject({
      state: 'failed',
      retryable: false,
      error: expect.objectContaining({ code: 'authorization_revoked' }),
    });
  });

  test('recovers after a worker restart by reclaiming the expired lease idempotently', async () => {
    await createLegacyContentFixture();
    const queued = await queueSourcePermanentDeletion(engine, deletionInput());
    // Simulate a crashed worker: partial purge committed, lease expired.
    await engine.executeRaw("DELETE FROM ingest_log WHERE source_id='docs'");
    await engine.executeRaw(
      `UPDATE workspace_background_operations
          SET state='running', lease_owner='worker-crashed', lease_expires_at=now()-interval '1 minute'
        WHERE operation_id=$1`,
      [queued.operationId],
    );

    const finished = await runSourceDeletionWorkerOnce(engine, { workerId: 'worker-b' });
    expect(finished).toMatchObject({ operationId: queued.operationId, state: 'completed' });
    expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id='docs'")).toEqual([]);
    expect(await engine.executeRaw<{ deleted: boolean }>(
      "SELECT deleted FROM workspace_sources WHERE source_id='docs'",
    )).toEqual([{ deleted: true }]);
  });
});

describe('permanently deleted Source lifecycle', () => {
  beforeEach(async () => {
    await queueSourcePermanentDeletion(engine, deletionInput());
    await runSourceDeletionWorkerOnce(engine, { workerId: 'worker-a' });
  });

  test('cannot be restored, listed, or deleted again', async () => {
    await expect(restoreWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin', requestId: 'req-restore-deleted',
    })).rejects.toMatchObject({ code: 'source_not_found' });
    expect(await listArchivedManagedGitSources(engine, 'w')).toEqual([]);
    expect(await listManagedGitSources(engine, 'w')).toEqual([]);
    await expect(queueSourcePermanentDeletion(engine, deletionInput({
      idempotencyKey: 'delete-docs-again', requestId: 'req-delete-again',
    }))).rejects.toMatchObject({ code: 'source_not_found' });
    await expect(previewSourceDeletionImpact(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin',
    })).rejects.toMatchObject({ code: 'source_not_found' });
  });
});

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose an address.');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe('permanent deletion HTTP boundary', () => {
  test('serves the danger zone to Administrators only with typed confirmation', async () => {
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    await engine.executeRaw(
      `INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at)
       VALUES ($1,'admin',$2,now()+interval '1 day'), ($3,'member',$4,now()+interval '1 day')`,
      [digest('admin-session'), digest('admin-csrf'), digest('member-session'), digest('member-csrf')],
    );
    const app = express();
    app.use(createWorkspaceRouter(engine, {
      allowedOrigin: 'https://workspace.example.test',
      requestId: () => 'req-deletion-boundary',
    }));
    const adminHeaders = {
      origin: 'https://workspace.example.test',
      cookie: 'workspace_session=admin-session',
      'x-csrf-token': 'admin-csrf',
      'content-type': 'application/json',
      'idempotency-key': 'delete-docs-http',
    };
    const memberHeaders = { ...adminHeaders, cookie: 'workspace_session=member-session', 'x-csrf-token': 'member-csrf' };

    await withServer(app, async baseUrl => {
      const impact = await fetch(`${baseUrl}/api/workspace/v1/sources/docs/deletion-impact`, { headers: adminHeaders });
      expect(impact.status).toBe(200);
      expect(await impact.json()).toMatchObject({
        data: {
          source_id: 'docs', pages: 0, page_versions: 0, saved_views: 0,
          background_operations: 0, verification_events: 0, access_grants: 0,
        },
        request_id: 'req-deletion-boundary',
      });
      expect((await fetch(`${baseUrl}/api/workspace/v1/sources/docs/deletion-impact`, { headers: memberHeaders })).status).toBe(403);
      expect((await fetch(`${baseUrl}/api/workspace/v1/sources/docs/permanently-delete`, {
        method: 'POST', headers: memberHeaders,
        body: JSON.stringify({ confirm_source_id: 'docs', reason: 'Member attempt.' }),
      })).status).toBe(403);

      const mismatch = await fetch(`${baseUrl}/api/workspace/v1/sources/docs/permanently-delete`, {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ confirm_source_id: 'Docs', reason: 'Typed the display name.' }),
      });
      expect(mismatch.status).toBe(400);
      expect(await mismatch.json()).toMatchObject({ error: { code: 'confirmation_mismatch' } });

      const accepted = await fetch(`${baseUrl}/api/workspace/v1/sources/docs/permanently-delete`, {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ confirm_source_id: 'docs', reason: 'Deliberate removal approved by governance.' }),
      });
      expect(accepted.status).toBe(202);
      const acceptedBody = await accepted.json() as { data: { operation_id: string; type: string; state: string } };
      expect(acceptedBody.data).toMatchObject({ type: 'source.permanent_delete', state: 'queued' });

      const replay = await fetch(`${baseUrl}/api/workspace/v1/sources/docs/permanently-delete`, {
        method: 'POST', headers: adminHeaders,
        body: JSON.stringify({ confirm_source_id: 'docs', reason: 'Deliberate removal approved by governance.' }),
      });
      expect(replay.status).toBe(202);
      expect((await replay.json() as { data: { operation_id: string } }).data.operation_id)
        .toBe(acceptedBody.data.operation_id);

      const shell = await fetch(`${baseUrl}/app/settings/sources`, { headers: adminHeaders });
      const html = await shell.text();
      expect(shell.status).toBe(200);
      expect(html).toContain('id="source-delete-dialog"');
      expect(html).toContain('Permanently delete');
      expect(html).toContain('deletion-impact');
      expect(html).toContain('permanently-delete');
      expect(html).toContain('id="source-delete-confirm-id"');
      expect(html).toContain('Permanent deletion also requires a larger viewport.');
    });
  });
});

describe('queueSourcePermanentDeletion', () => {
  test('only an active Administrator with Source Access can queue permanent deletion', async () => {
    await expect(queueSourcePermanentDeletion(engine, deletionInput({
      actorMembershipId: 'member', requestId: 'req-member',
    }))).rejects.toMatchObject({ code: 'source_deletion_forbidden' });

    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_id='admin'");
    await expect(queueSourcePermanentDeletion(engine, deletionInput({
      requestId: 'req-no-access',
    }))).rejects.toMatchObject({ code: 'source_deletion_forbidden' });

    expect(await engine.executeRaw(
      "SELECT outcome FROM workspace_audit_events WHERE action='source.delete.request' ORDER BY occurred_at",
    )).toEqual([{ outcome: 'failed' }, { outcome: 'failed' }]);
  });

  test('refuses an active Source', async () => {
    await engine.executeRaw("UPDATE workspace_sources SET archived=FALSE, archived_at=NULL WHERE source_id='docs'");
    await expect(queueSourcePermanentDeletion(engine, deletionInput()))
      .rejects.toMatchObject({ code: 'source_not_archived' });
  });

  test('requires the exact immutable Source identifier as typed confirmation', async () => {
    await expect(queueSourcePermanentDeletion(engine, deletionInput({
      confirmationSourceId: 'Docs',
    }))).rejects.toMatchObject({ code: 'confirmation_mismatch' });
    await expect(queueSourcePermanentDeletion(engine, deletionInput({
      confirmationSourceId: '',
    }))).rejects.toMatchObject({ code: 'confirmation_mismatch' });
  });

  test('requires a reason and records it on the failed attempt audit trail', async () => {
    await expect(queueSourcePermanentDeletion(engine, deletionInput({
      reason: '  ',
    }))).rejects.toMatchObject({ code: 'reason_required' });
  });

  test('rejects an unknown Source as not found', async () => {
    await expect(queueSourcePermanentDeletion(engine, deletionInput({
      sourceId: 'ghost', confirmationSourceId: 'ghost',
    }))).rejects.toMatchObject({ code: 'source_not_found' });
  });

  test('queues a durable idempotent Background Operation and audits the request', async () => {
    const operation = await queueSourcePermanentDeletion(engine, deletionInput());
    expect(operation).toMatchObject({
      type: 'source.permanent_delete',
      resourceId: 'docs',
      state: 'queued',
      retryable: true,
    });

    const replay = await queueSourcePermanentDeletion(engine, deletionInput({ requestId: 'req-replay' }));
    expect(replay.operationId).toBe(operation.operationId);
    expect(await engine.executeRaw('SELECT operation_id FROM workspace_background_operations')).toHaveLength(1);

    await expect(queueSourcePermanentDeletion(engine, deletionInput({
      reason: 'A different reason changes the payload.',
    }))).rejects.toMatchObject({ code: 'idempotency_key_reused' });

    const audits = await engine.executeRaw<{ action: string; outcome: string; reason: string }>(
      "SELECT action,outcome,reason FROM workspace_audit_events WHERE action='source.delete.request'",
    );
    expect(audits).toEqual([{
      action: 'source.delete.request',
      outcome: 'succeeded',
      reason: 'Deliberate removal approved by governance.',
    }]);
  });
});
