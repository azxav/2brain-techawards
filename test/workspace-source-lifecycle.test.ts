import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  archiveWorkspaceSource,
  restoreWorkspaceSource,
} from '../src/workspace/source-lifecycle.ts';
import {
  listArchivedManagedGitSources,
  listManagedGitSources,
} from '../src/workspace/source-provisioning.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
});

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id,name,setup_completed_at) VALUES ('w','W',now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('admin-i','admin@example.test',now()),('member-i','member@example.test',now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('admin','w','admin-i','administrator'),('member','w','member-i','member')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member','admin','all'),('member','member','all')");
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,
     created_by_membership_id,last_verified_at,last_verified_revision,last_sync_at,last_synced_revision)
    VALUES ('docs','w','Docs','https://example.test/docs.git','daily','completed','admin',
      '2026-07-12T08:00:00Z','verified-revision','2026-07-12T08:05:00Z','synced-revision')`);
});

describe('Workspace Source lifecycle', () => {
  test('only an active Administrator with Source Access can archive or restore', async () => {
    await expect(archiveWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'member', requestId: 'req-member',
    })).rejects.toMatchObject({ code: 'source_lifecycle_forbidden' });

    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_id='admin'");
    await expect(archiveWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin', requestId: 'req-no-access',
    })).rejects.toMatchObject({ code: 'source_lifecycle_forbidden' });

    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='all' WHERE principal_id='admin'");
    expect(await archiveWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin', requestId: 'req-archive',
    })).toMatchObject({ sourceId: 'docs', lifecycleState: 'archived', changed: true });
  });

  test('round-trips without changing verification evidence and audits idempotent replays safely', async () => {
    await archiveWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin', requestId: 'req-archive',
    });
    expect(await listManagedGitSources(engine, 'w')).toEqual([]);
    expect(await listArchivedManagedGitSources(engine, 'w')).toMatchObject([
      { sourceId: 'docs', lifecycleState: 'archived' },
    ]);

    expect(await archiveWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin', requestId: 'req-archive-replay',
    })).toMatchObject({ lifecycleState: 'archived', changed: false });

    expect(await restoreWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin', requestId: 'req-restore',
    })).toMatchObject({ sourceId: 'docs', lifecycleState: 'active', changed: true });
    expect(await restoreWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin', requestId: 'req-restore-replay',
    })).toMatchObject({ lifecycleState: 'active', changed: false });

    const source = await engine.executeRaw<{
      last_verified_at: string | Date; last_verified_revision: string;
      last_sync_at: string | Date; last_synced_revision: string;
    }>("SELECT last_verified_at,last_verified_revision,last_sync_at,last_synced_revision FROM workspace_sources WHERE source_id='docs'");
    expect({
      lastVerifiedAt: new Date(source[0].last_verified_at).toISOString(),
      lastVerifiedRevision: source[0].last_verified_revision,
      lastSyncAt: new Date(source[0].last_sync_at).toISOString(),
      lastSyncedRevision: source[0].last_synced_revision,
    }).toEqual({
      lastVerifiedAt: '2026-07-12T08:00:00.000Z', lastVerifiedRevision: 'verified-revision',
      lastSyncAt: '2026-07-12T08:05:00.000Z', lastSyncedRevision: 'synced-revision',
    });
    expect(await engine.executeRaw("SELECT action,outcome FROM workspace_audit_events WHERE action IN ('source.archive','source.restore') ORDER BY occurred_at,event_id")).toHaveLength(4);
    expect(await engine.executeRaw("SELECT summary FROM workspace_change_events WHERE summary IN ('Archived a Source.','Restored a Source.') ORDER BY occurred_at,event_id")).toEqual([
      { summary: 'Archived a Source.' },
      { summary: 'Restored a Source.' },
    ]);
    const audits = await engine.executeRaw<{ request_id: string; before_state: any; after_state: any }>(
      "SELECT request_id,before_state,after_state FROM workspace_audit_events WHERE action IN ('source.archive','source.restore')",
    );
    const states = Object.fromEntries(audits.map(audit => [audit.request_id, {
      before: audit.before_state.value.lifecycle_state,
      after: audit.after_state.value.lifecycle_state,
    }]));
    expect(states).toEqual({
      'req-archive': { before: 'active', after: 'archived' },
      'req-archive-replay': { before: 'archived', after: 'archived' },
      'req-restore': { before: 'archived', after: 'active' },
      'req-restore-replay': { before: 'active', after: 'active' },
    });
  });

  test('repairs a drifted legacy archive projection once', async () => {
    await engine.executeRaw(`CREATE TABLE sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, config JSONB NOT NULL DEFAULT '{}'::jsonb,
      archived BOOLEAN NOT NULL DEFAULT FALSE, archived_at TIMESTAMPTZ,
      archive_expires_at TIMESTAMPTZ
    )`);
    await engine.executeRaw("INSERT INTO sources (id,name,config) VALUES ('docs','Docs','{}'::jsonb)");
    await engine.executeRaw("UPDATE workspace_sources SET archived=TRUE,archived_at='2026-07-12T09:00:00Z' WHERE source_id='docs'");

    expect(await archiveWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin', requestId: 'req-repair',
    })).toMatchObject({ lifecycleState: 'archived', changed: true });
    const repaired = await engine.executeRaw<{ archived: boolean; archived_at: string | Date }>(
      "SELECT archived,archived_at FROM sources WHERE id='docs'",
    );
    expect(repaired[0]?.archived).toBe(true);

    expect(await archiveWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'admin', requestId: 'req-repair-replay',
    })).toMatchObject({ lifecycleState: 'archived', changed: false });
    const replayed = await engine.executeRaw<{ archived_at: string | Date }>(
      "SELECT archived_at FROM sources WHERE id='docs'",
    );
    expect(new Date(replayed[0]!.archived_at).toISOString())
      .toBe(new Date(repaired[0]!.archived_at).toISOString());
  });
});
