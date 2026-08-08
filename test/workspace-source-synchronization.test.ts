import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { listManagedGitSources, retryBackgroundOperation } from '../src/workspace/source-provisioning.ts';
import { queueSourceMaintenance, runSourceMaintenanceWorkerOnce } from '../src/workspace/source-synchronization.ts';
import { archiveWorkspaceSource } from '../src/workspace/source-lifecycle.ts';
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
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('i','a@example.test',now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('m','w','i','administrator')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member','m','all')");
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id)
    VALUES ('docs','w','Docs','https://example.test/docs.git','daily','completed','m')`);
});

describe('durable Source verification and synchronization', () => {
  test('records unchanged verification evidence without advancing synchronization', async () => {
    const queued = await queueSourceMaintenance(engine, {
      workspaceId: 'w', sourceId: 'docs', type: 'source.verify', actorMembershipId: 'm',
      requestId: 'req-v', idempotencyKey: 'verify-1',
    });
    expect((await queueSourceMaintenance(engine, {
      workspaceId: 'w', sourceId: 'docs', type: 'source.verify', actorMembershipId: 'm',
      requestId: 'req-v-replay', idempotencyKey: 'verify-1',
    })).operationId).toBe(queued.operationId);
    const completed = await runSourceMaintenanceWorkerOnce(engine, {
      workerId: 'worker', execute: async () => ({ observedRevision: 'abc', changed: false }),
    });
    expect(completed).toMatchObject({ state: 'completed', outcome: 'Source verified.' });
    expect(await engine.executeRaw(
      'SELECT observed_revision,content_state,outcome,request_id FROM workspace_source_verification_events',
    )).toEqual([{ observed_revision: 'abc', content_state: 'unchanged', outcome: 'succeeded', request_id: 'req-v' }]);
    const source = await engine.executeRaw<{ last_verified_at: string | null; last_sync_at: string | null }>(
      "SELECT last_verified_at,last_sync_at FROM workspace_sources WHERE source_id='docs'",
    );
    expect(source[0].last_verified_at).not.toBeNull();
    expect(source[0].last_sync_at).toBeNull();
  });

  test('represents discovered changes without overwriting Last Trustworthy State', async () => {
    await engine.executeRaw("UPDATE workspace_sources SET last_synced_revision='old',last_sync_at=now() WHERE source_id='docs'");
    await queueSourceMaintenance(engine, {
      workspaceId: 'w', sourceId: 'docs', type: 'source.verify', actorMembershipId: 'm',
      requestId: 'req-changed', idempotencyKey: 'verify-changed',
    });
    await runSourceMaintenanceWorkerOnce(engine, {
      workerId: 'worker', execute: async () => ({ observedRevision: 'new', changed: true }),
    });
    expect(await engine.executeRaw(
      "SELECT last_synced_revision,known_unsynchronized_revision FROM workspace_sources WHERE source_id='docs'",
    )).toEqual([{ last_synced_revision: 'old', known_unsynchronized_revision: 'new' }]);
  });

  test('records a failed requested verification without overwriting Last Trustworthy State', async () => {
    await engine.executeRaw(`UPDATE workspace_sources
      SET last_verified_at='2026-07-12T08:00:00.000Z',last_verified_revision='trusted',
          last_sync_at='2026-07-12T08:05:00.000Z',last_synced_revision='trusted'
      WHERE source_id='docs'`);
    await queueSourceMaintenance(engine, {
      workspaceId: 'w', sourceId: 'docs', type: 'source.verify', actorMembershipId: 'm',
      requestId: 'req-failed-verify', idempotencyKey: 'verify-failed',
    });

    const failed = await runSourceMaintenanceWorkerOnce(engine, {
      workerId: 'worker-failed', execute: async () => { throw new Error('provider unavailable'); },
    });

    expect(failed).toMatchObject({
      state: 'failed', retryable: true,
      error: { code: 'source_maintenance_failed', requestId: 'req-failed-verify' },
    });
    expect(await engine.executeRaw(
      `SELECT observed_revision,content_state,outcome,error_code,request_id
         FROM workspace_source_verification_events WHERE source_id='docs'`,
    )).toEqual([{
      observed_revision: null, content_state: null, outcome: 'failed',
      error_code: 'source_maintenance_failed', request_id: 'req-failed-verify',
    }]);
    const trustworthy = await engine.executeRaw<{
      last_verified_at: string | Date; last_verified_revision: string;
      last_sync_at: string | Date; last_synced_revision: string;
    }>(
      `SELECT last_verified_at,last_verified_revision,last_sync_at,last_synced_revision
         FROM workspace_sources WHERE source_id='docs'`,
    );
    expect({
      lastVerifiedAt: new Date(trustworthy[0].last_verified_at).toISOString(),
      lastVerifiedRevision: trustworthy[0].last_verified_revision,
      lastSyncAt: new Date(trustworthy[0].last_sync_at).toISOString(),
      lastSyncedRevision: trustworthy[0].last_synced_revision,
    }).toEqual({
      lastVerifiedAt: '2026-07-12T08:00:00.000Z', lastVerifiedRevision: 'trusted',
      lastSyncAt: '2026-07-12T08:05:00.000Z', lastSyncedRevision: 'trusted',
    });
    expect(await listManagedGitSources(engine, 'w', '2026-07-12T09:00:00.000Z')).toMatchObject([{
      sourceId: 'docs',
      lastVerifiedAt: '2026-07-12T08:00:00.000Z',
      lastVerifiedRevision: 'trusted',
      lastSyncAt: '2026-07-12T08:05:00.000Z',
      lastSyncedRevision: 'trusted',
      freshness: { state: 'stale', reason: 'requested_verification_failed', potentiallyOutdated: true },
      latestVerification: {
        outcome: 'failed', errorCode: 'source_maintenance_failed', requestId: 'req-failed-verify',
      },
    }]);

    const operationId = failed!.operationId;
    await retryBackgroundOperation(engine, {
      workspaceId: 'w', operationId, actorMembershipId: 'm', requestId: 'req-verify-retry',
    });
    await runSourceMaintenanceWorkerOnce(engine, {
      workerId: 'worker-retry', execute: async () => ({ observedRevision: 'trusted', changed: false }),
    });
    expect(await listManagedGitSources(engine, 'w', new Date(Date.now() + 1_000).toISOString())).toMatchObject([{
      freshness: { state: 'current', reason: 'verified_within_cadence', potentiallyOutdated: false },
      latestVerification: {
        outcome: 'succeeded', errorCode: null, requestId: 'req-verify-retry',
      },
    }]);
    expect(await engine.executeRaw(
      "SELECT count(*)::int AS count FROM workspace_source_verification_events WHERE source_id='docs'",
    )).toEqual([{ count: 1 }]);
  });

  test('applies synchronization evidence once and rechecks authorization in the worker', async () => {
    await queueSourceMaintenance(engine, {
      workspaceId: 'w', sourceId: 'docs', type: 'source.sync', actorMembershipId: 'm',
      requestId: 'req-sync', idempotencyKey: 'sync-1',
    });
    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_id='m'");
    let executions = 0;
    expect(await runSourceMaintenanceWorkerOnce(engine, {
      workerId: 'worker-denied', execute: async () => { executions++; return { observedRevision: 'new', changed: true, applied: true }; },
    })).toMatchObject({ state: 'failed', error: { code: 'authorization_revoked' } });
    expect(executions).toBe(0);

    await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='all' WHERE principal_id='m'");
    const retried = await engine.executeRaw<{ operation_id: string }>(
      "UPDATE workspace_background_operations SET state='queued',available_at=now() WHERE operation_type='source.sync' RETURNING operation_id",
    );
    expect(retried).toHaveLength(1);
    await runSourceMaintenanceWorkerOnce(engine, {
      workerId: 'worker-ok', execute: async () => ({ observedRevision: 'new', changed: true, applied: true }),
    });
    expect(await engine.executeRaw(
      "SELECT last_synced_revision,known_unsynchronized_revision FROM workspace_sources WHERE source_id='docs'",
    )).toEqual([{ last_synced_revision: 'new', known_unsynchronized_revision: null }]);
    expect(await engine.executeRaw(
      "SELECT count(*)::int AS count FROM workspace_change_events WHERE summary='Synchronized a Source.'",
    )).toEqual([{ count: 1 }]);
  });

  test('archive rejects new work, cancels queued work, and wins a running completion race', async () => {
    await queueSourceMaintenance(engine, {
      workspaceId: 'w', sourceId: 'docs', type: 'source.verify', actorMembershipId: 'm',
      requestId: 'req-queued', idempotencyKey: 'queued-before-archive',
    });
    await archiveWorkspaceSource(engine, {
      workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'm', requestId: 'req-archive-queued',
    });
    let executions = 0;
    expect(await runSourceMaintenanceWorkerOnce(engine, {
      workerId: 'worker-queued', execute: async () => { executions++; return { observedRevision: 'new', changed: true }; },
    })).toBeNull();
    expect(executions).toBe(0);
    await expect(queueSourceMaintenance(engine, {
      workspaceId: 'w', sourceId: 'docs', type: 'source.verify', actorMembershipId: 'm',
      requestId: 'req-rejected', idempotencyKey: 'rejected-after-archive',
    })).rejects.toThrow('source_archived');

    await engine.executeRaw("UPDATE workspace_sources SET archived=FALSE,archived_at=NULL,archived_by_membership_id=NULL WHERE source_id='docs'");
    await queueSourceMaintenance(engine, {
      workspaceId: 'w', sourceId: 'docs', type: 'source.verify', actorMembershipId: 'm',
      requestId: 'req-running', idempotencyKey: 'running-before-archive',
    });
    const raced = await runSourceMaintenanceWorkerOnce(engine, {
      workerId: 'worker-running',
      execute: async () => {
        await archiveWorkspaceSource(engine, {
          workspaceId: 'w', sourceId: 'docs', actorMembershipId: 'm', requestId: 'req-archive-running',
        });
        return { observedRevision: 'must-not-persist', changed: true };
      },
    });
    expect(raced).toMatchObject({ state: 'failed', error: { code: 'source_archived' }, retryable: false });
    expect(await engine.executeRaw("SELECT count(*)::int AS count FROM workspace_source_verification_events WHERE request_id='req-running'")).toEqual([{ count: 0 }]);
    expect(await engine.executeRaw("SELECT last_verified_at,last_verified_revision FROM workspace_sources WHERE source_id='docs'")).toEqual([{ last_verified_at: null, last_verified_revision: null }]);
  });
});
