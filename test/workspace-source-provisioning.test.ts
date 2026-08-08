import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import {
  cancelBackgroundOperation,
  listBackgroundOperations,
  provisionManagedGitSource,
  queueManagedGitSource,
  retryBackgroundOperation,
  runBackgroundOperationWorkerOnce,
} from '../src/workspace/source-provisioning.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';
import { archiveWorkspaceSource, restoreWorkspaceSource } from '../src/workspace/source-lifecycle.ts';

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

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw(
    "INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Workspace', now())",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-1', 'admin@example.test', now())",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-1', 'administrator')",
  );
});

describe('managed Git Source provisioning', () => {
  test('accepts only Hourly, Daily, Weekly, or Manual cadence presets', async () => {
    const queued = await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'weekly-source', name: 'Weekly source',
      remoteUrl: 'https://example.test/team/weekly.git', expectedCadence: 'Weekly',
      actorMembershipId: 'member-1', requestId: 'req-weekly', idempotencyKey: 'weekly-source',
    });
    expect(queued.source.expectedCadence).toBe('weekly');

    await expect(queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'custom-source', name: 'Custom source',
      remoteUrl: 'https://example.test/team/custom.git', expectedCadence: 'biweekly',
      actorMembershipId: 'member-1', requestId: 'req-custom', idempotencyKey: 'custom-source',
    })).rejects.toMatchObject({ code: 'invalid_expected_cadence' });
  });

  test('durably queues the partial Source without widening Source Access', async () => {
    const queued = await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1',
      sourceId: 'handbook',
      name: 'Team handbook',
      remoteUrl: 'https://example.test/team/handbook.git',
      expectedCadence: 'daily',
      actorMembershipId: 'member-1',
      requestId: 'req-source-create',
      idempotencyKey: 'create-handbook',
    });

    expect(queued).toMatchObject({
      source: {
        sourceId: 'handbook',
        provisioningState: 'queued',
        includedInWorkspaceSearch: true,
      },
      operation: {
        state: 'queued',
        progress: 0,
        retryable: true,
      },
    });
    expect(await engine.executeRaw('SELECT * FROM workspace_source_grants')).toEqual([]);
    expect(await engine.executeRaw('SELECT event_id FROM workspace_audit_events')).toHaveLength(1);
    expect(await engine.executeRaw('SELECT event_id FROM workspace_change_events')).toHaveLength(1);
    expect(await listBackgroundOperations(engine, 'workspace-1')).toEqual([
      expect.objectContaining({ operationId: queued.operation.operationId, resourceId: 'handbook', state: 'queued' }),
    ]);

    const duplicate = await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'handbook', name: 'Team handbook',
      remoteUrl: 'https://example.test/team/handbook.git', expectedCadence: 'daily',
      actorMembershipId: 'member-1', requestId: 'req-source-create-replayed',
      idempotencyKey: 'create-handbook',
    });
    expect(duplicate.operation.operationId).toBe(queued.operation.operationId);
    expect(await engine.executeRaw('SELECT operation_id FROM workspace_background_operations')).toHaveLength(1);
    expect(await engine.executeRaw('SELECT event_id FROM workspace_audit_events')).toHaveLength(1);
    await expect(queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'handbook', name: 'Conflicting payload',
      remoteUrl: 'https://example.test/team/handbook.git', expectedCadence: 'weekly',
      actorMembershipId: 'member-1', requestId: 'req-source-create-conflict',
      idempotencyKey: 'create-handbook',
    })).rejects.toMatchObject({ code: 'idempotency_key_reused' });
  });

  test('claims concurrently and completes one operation exactly once', async () => {
    const queued = await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1',
      sourceId: 'engineering',
      name: 'Engineering',
      remoteUrl: 'https://example.test/team/engineering.git',
      expectedCadence: 'daily',
      actorMembershipId: 'member-1',
      requestId: 'req-source-worker',
      idempotencyKey: 'create-engineering',
    });
    let executions = 0;
    const execute = async () => { executions += 1; };

    const results = await Promise.all([
      runBackgroundOperationWorkerOnce(engine, { workerId: 'worker-a', executeSourceProvisioning: execute }),
      runBackgroundOperationWorkerOnce(engine, { workerId: 'worker-b', executeSourceProvisioning: execute }),
    ]);

    expect(executions).toBe(1);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({
      operationId: queued.operation.operationId,
      state: 'completed',
      progress: 100,
      outcome: 'Managed Git Source connected.',
    });
    const sources = await engine.executeRaw<{ provisioning_state: string }>(
      "SELECT provisioning_state FROM workspace_sources WHERE source_id='engineering'",
    );
    expect(sources).toEqual([{ provisioning_state: 'completed' }]);
  });

  test('retains a failed Source with safe retryable diagnostics', async () => {
    const queued = await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1',
      sourceId: 'private-notes',
      name: 'Private notes',
      remoteUrl: 'https://example.test/team/private-notes.git',
      expectedCadence: 'weekly',
      actorMembershipId: 'member-1',
      requestId: 'req-source-failure',
      idempotencyKey: 'create-private-notes',
    });

    const failed = await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'worker-failure',
      executeSourceProvisioning: async () => {
        throw new Error('https://user:secret@example.test at C:\\managed\\private-notes');
      },
    });

    expect(failed).toMatchObject({
      operationId: queued.operation.operationId,
      state: 'failed',
      retryable: true,
      error: {
        code: 'source_provisioning_failed',
        message: 'Source provisioning failed. Retry when the Git remote is available.',
        requestId: 'req-source-failure',
      },
    });
    const persisted = await engine.executeRaw<{
      provisioning_state: string;
      error_summary: string;
    }>(
      `SELECT s.provisioning_state, o.error_summary
         FROM workspace_sources s
         JOIN workspace_background_operations o ON o.resource_id=s.source_id
        WHERE s.source_id='private-notes'`,
    );
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain('secret');
    expect(JSON.stringify(persisted)).not.toContain('managed');
  });

  test('retries a failed operation and safely cancels queued work', async () => {
    const first = await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'retry-source', name: 'Retry source',
      remoteUrl: 'https://example.test/team/retry.git', expectedCadence: 'daily',
      actorMembershipId: 'member-1', requestId: 'req-retry-create', idempotencyKey: 'retry-source',
    });
    await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'worker-first-attempt',
      executeSourceProvisioning: async () => { throw new Error('temporary failure'); },
    });
    const retried = await retryBackgroundOperation(engine, {
      workspaceId: 'workspace-1', operationId: first.operation.operationId,
      actorMembershipId: 'member-1', requestId: 'req-retry',
    });
    expect(retried).toMatchObject({ state: 'queued', progress: 0, error: null, retryable: true });
    const completed = await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'worker-retry', executeSourceProvisioning: async () => undefined,
    });
    expect(completed).toMatchObject({ state: 'completed', attempt: 2 });

    const second = await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'cancel-source', name: 'Cancel source',
      remoteUrl: 'https://example.test/team/cancel.git', expectedCadence: 'daily',
      actorMembershipId: 'member-1', requestId: 'req-cancel-create', idempotencyKey: 'cancel-source',
    });
    const cancelled = await cancelBackgroundOperation(engine, {
      workspaceId: 'workspace-1', operationId: second.operation.operationId,
      actorMembershipId: 'member-1', requestId: 'req-cancel',
    });
    expect(cancelled).toMatchObject({
      state: 'failed', retryable: false, cancellationSafe: false,
      error: { code: 'operation_cancelled', requestId: 'req-cancel' },
    });
    let executed = false;
    expect(await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'worker-after-cancel', executeSourceProvisioning: async () => { executed = true; },
    })).toBeNull();
    expect(executed).toBe(false);
  });

  test('Archive wins queued and running provisioning races', async () => {
    await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member','member-1','all')");
    await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'queued-archive', name: 'Queued archive',
      remoteUrl: 'https://example.test/team/queued.git', expectedCadence: 'daily',
      actorMembershipId: 'member-1', requestId: 'req-queued-create', idempotencyKey: 'queued-archive',
    });
    await archiveWorkspaceSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'queued-archive', actorMembershipId: 'member-1', requestId: 'req-queued-archive',
    });
    let executions = 0;
    expect(await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'worker-queued-archive', executeSourceProvisioning: async () => { executions++; },
    })).toBeNull();
    expect(executions).toBe(0);
    await restoreWorkspaceSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'queued-archive', actorMembershipId: 'member-1', requestId: 'req-queued-restore',
    });
    expect(await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'worker-queued-restore', executeSourceProvisioning: async () => { executions++; },
    })).toMatchObject({ state: 'completed' });
    expect(executions).toBe(1);

    await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'running-archive', name: 'Running archive',
      remoteUrl: 'https://example.test/team/running.git', expectedCadence: 'daily',
      actorMembershipId: 'member-1', requestId: 'req-running-create', idempotencyKey: 'running-archive',
    });
    const raced = await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'worker-running-archive',
      executeSourceProvisioning: async () => {
        await archiveWorkspaceSource(engine, {
          workspaceId: 'workspace-1', sourceId: 'running-archive', actorMembershipId: 'member-1', requestId: 'req-running-archive',
        });
      },
    });
    expect(raced).toMatchObject({ state: 'failed', error: { code: 'source_archived' }, retryable: false });
    expect(await engine.executeRaw("SELECT archived,provisioning_state FROM workspace_sources WHERE source_id='running-archive'")).toEqual([
      { archived: true, provisioning_state: 'failed' },
    ]);
    await restoreWorkspaceSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'running-archive', actorMembershipId: 'member-1', requestId: 'req-running-restore',
    });
    expect(await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'worker-running-restore', executeSourceProvisioning: async () => undefined,
    })).toMatchObject({ state: 'completed' });
  });

  test('does not expose a legacy Source when Archive wins registration', async () => {
    await engine.executeRaw(`CREATE TABLE gbrain_cycle_locks (
      id TEXT PRIMARY KEY, holder_pid INTEGER NOT NULL, holder_host TEXT NOT NULL,
      acquired_at TIMESTAMPTZ NOT NULL, ttl_expires_at TIMESTAMPTZ NOT NULL,
      last_refreshed_at TIMESTAMPTZ
    )`);
    await engine.executeRaw(`CREATE TABLE sources (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, local_path TEXT,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      archived BOOLEAN NOT NULL DEFAULT FALSE, archived_at TIMESTAMPTZ,
      archive_expires_at TIMESTAMPTZ
    )`);
    await engine.executeRaw(`INSERT INTO workspace_sources
      (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,
       created_by_membership_id,archived,archived_at)
      VALUES ('registration-race','workspace-1','Registration race',
        'https://example.test/team/race.git','daily','running','member-1',TRUE,now())`);
    await engine.executeRaw(`INSERT INTO sources (id,name,config) VALUES
      ('registration-race','Registration race',
       '{"remote_url":"https://example.test/team/race.git","managed_clone":true}'::jsonb)`);

    try {
      await provisionManagedGitSource(engine, {
        operationId: 'operation-race', workspaceId: 'workspace-1',
        source: {
          sourceId: 'registration-race', name: 'Registration race',
          remoteUrl: 'https://example.test/team/race.git', expectedCadence: 'daily',
          includedInWorkspaceSearch: true, provisioningState: 'running',
        },
        attempt: 1, requestId: 'request-race', signal: new AbortController().signal,
      });
      expect(await engine.executeRaw("SELECT archived FROM sources WHERE id='registration-race'"))
        .toEqual([{ archived: true }]);
    } finally {
      await engine.executeRaw('DROP TABLE IF EXISTS sources');
      await engine.executeRaw('DROP TABLE IF EXISTS gbrain_cycle_locks');
    }
  });

  test('acknowledges browser creation immediately and rejects filesystem or non-HTTPS input', async () => {
    const session = 'administrator-session';
    const csrf = 'administrator-csrf';
    const digest = (value: string) => createHash('sha256').update(value).digest('hex');
    await engine.executeRaw(
      `INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at)
       VALUES ($1, 'member-1', $2, now() + interval '1 day')`,
      [digest(session), digest(csrf)],
    );
    const app = express();
    app.use(createWorkspaceRouter(engine, {
      allowedOrigin: 'https://workspace.example.test',
      requestId: () => 'req-browser-source',
    }));
    const headers = {
      origin: 'https://workspace.example.test',
      cookie: `workspace_session=${session}`,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
      'idempotency-key': 'browser-handbook',
    };

    await withServer(app, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/workspace/v1/sources`, {
        method: 'POST', headers,
        body: JSON.stringify({
          source_id: 'browser-handbook', name: 'Browser handbook',
          remote_url: 'https://example.test/team/browser-handbook.git', expected_cadence: 'daily',
        }),
      });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        data: {
          source: { source_id: 'browser-handbook', included_in_workspace_search: true, provisioning_state: 'queued' },
          operation: { state: 'queued', progress: 0 },
        },
        request_id: 'req-browser-source',
      });
      const operationId = (await engine.executeRaw<{ operation_id: string }>(
        "SELECT operation_id FROM workspace_background_operations WHERE resource_id='browser-handbook'",
      ))[0].operation_id;
      const listed = await fetch(`${baseUrl}/api/workspace/v1/sources`, { headers });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        data: [{
          source_id: 'browser-handbook', last_verified_at: null, last_sync_at: null,
          lifecycle_state: 'active', archived_at: null,
          latest_verification: null,
          freshness: {
            state: 'unknown', reason: 'insufficient_verification_evidence', potentially_outdated: false,
          },
        }],
        request_id: 'req-browser-source',
      });
      const detail = await fetch(`${baseUrl}/api/workspace/v1/operations/${operationId}`, { headers });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ data: { operation_id: operationId, state: 'queued' } });
      const operations = await fetch(`${baseUrl}/api/workspace/v1/operations`, { headers });
      expect(operations.status).toBe(200);
      expect(await operations.json()).toMatchObject({ data: [{ operation_id: operationId, state: 'queued' }] });
      const sourcesShell = await fetch(`${baseUrl}/app/settings/sources`, { headers });
      const sourcesHtml = await sourcesShell.text();
      expect(sourcesShell.status).toBe(200);
      expect(sourcesHtml).toContain('id="source-form"');
      expect(sourcesHtml).toContain('pattern="https://.*"');
      expect(sourcesHtml).toContain('<option value="hourly">Hourly</option>');
      expect(sourcesHtml).toContain('name="included_in_workspace_search" type="checkbox" checked');
      expect(sourcesHtml).toContain('Last Trustworthy State');
      expect(sourcesHtml).toContain('potentially outdated');
      expect(sourcesHtml).toContain('Last verified');
      expect(sourcesHtml).toContain('Freshness');
      expect(sourcesHtml).toContain('role="tablist" aria-label="Source lifecycle"');
      expect(sourcesHtml).toContain('id="active-sources-tab"');
      expect(sourcesHtml).toContain('id="archived-sources-tab"');
      expect(sourcesHtml).toContain('id="source-lifecycle-dialog"');
      expect(sourcesHtml).toContain('Archive Source');
      expect(sourcesHtml).toContain('Restore Source');
      expect(sourcesHtml).toContain('Knowledge, history, and configuration are retained');
      expect(sourcesHtml).toContain('Use a larger viewport to Archive or restore Sources.');
      expect(sourcesHtml).toContain('#connect-source-button{display:none!important}');
      expect(sourcesHtml).toContain("'/api/workspace/v1/sources/'+encodeURIComponent(sourceId)+'/'+action");
      expect(sourcesHtml).toContain('requestedState!==sourceListState');
      expect(sourcesHtml).toContain('--muted:#72716d');
      expect(sourcesHtml).toContain('--accent:#1f73c4');
      expect(sourcesHtml).toContain('--danger:#c7352b');
      expect(sourcesHtml).toContain('--danger:#f17b70');
      expect(sourcesHtml).toContain('--state-current:#26733a');
      expect(sourcesHtml).toContain('--state-current:#68b879');
      expect(sourcesHtml).toContain("if(document.querySelector('#source-refresh-warning')?.hidden){form.reset()");
      expect(sourcesHtml).not.toContain('name="local_path"');
      expect(sourcesHtml).not.toContain('name="clone_dir"');
      // Browsers compile the pattern attribute with the `v` flag, which rejects
      // an unescaped `-` after a range. An invalid pattern silently disables
      // client-side Source ID validation, so assert the rendered pattern
      // compiles the way a browser compiles it and still accepts exactly the
      // canonical Source IDs.
      const sourceIdPattern = sourcesHtml.match(/id="source-id"[^>]*pattern="([^"]+)"/)?.[1];
      expect(sourceIdPattern).toBeDefined();
      const browserPattern = new RegExp(`^(?:${sourceIdPattern})$`, 'v');
      expect(browserPattern.test('release-source')).toBe(true);
      expect(browserPattern.test('a-b-c')).toBe(true);
      expect(browserPattern.test('a')).toBe(true);
      expect(browserPattern.test('-bad')).toBe(false);
      expect(browserPattern.test('bad-')).toBe(false);
      expect(browserPattern.test('Bad')).toBe(false);
      expect(browserPattern.test('a_b')).toBe(false);
      const operationsShell = await fetch(`${baseUrl}/app/settings/operations`, { headers });
      expect(await operationsShell.text()).toContain('id="operations"');
      await runBackgroundOperationWorkerOnce(engine, {
        workerId: 'browser-failure-worker',
        executeSourceProvisioning: async () => { throw new Error('temporary remote failure'); },
      });
      const retried = await fetch(`${baseUrl}/api/workspace/v1/operations/${operationId}/retry`, {
        method: 'POST', headers,
      });
      expect(retried.status).toBe(202);
      expect(await retried.json()).toMatchObject({ data: { operation_id: operationId, state: 'queued' } });
      const cancelled = await fetch(`${baseUrl}/api/workspace/v1/operations/${operationId}/cancel`, {
        method: 'POST', headers,
      });
      expect(cancelled.status).toBe(200);
      expect(await cancelled.json()).toMatchObject({ data: { operation_id: operationId, state: 'failed' } });

      await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member','member-1','all')");
      const archived = await fetch(`${baseUrl}/api/workspace/v1/sources/browser-handbook/archive`, {
        method: 'POST', headers, body: JSON.stringify({ reason: 'No longer active' }),
      });
      expect(archived.status).toBe(200);
      expect(await archived.json()).toMatchObject({ data: { source_id: 'browser-handbook', lifecycle_state: 'archived', changed: true } });
      expect(await (await fetch(`${baseUrl}/api/workspace/v1/sources`, { headers })).json()).toMatchObject({ data: [] });
      expect(await (await fetch(`${baseUrl}/api/workspace/v1/sources?state=archived`, { headers })).json()).toMatchObject({
        data: [{ source_id: 'browser-handbook', lifecycle_state: 'archived' }],
      });
      const restored = await fetch(`${baseUrl}/api/workspace/v1/sources/browser-handbook/restore`, {
        method: 'POST', headers,
      });
      expect(restored.status).toBe(200);
      expect(await restored.json()).toMatchObject({ data: { source_id: 'browser-handbook', lifecycle_state: 'active', changed: true } });

      for (const body of [
        { source_id: 'local-path', name: 'Local', remote_url: 'https://example.test/repo.git', expected_cadence: 'daily', local_path: 'C:\\private' },
        { source_id: 'ssh-source', name: 'SSH', remote_url: 'ssh://git@example.test/repo.git', expected_cadence: 'daily' },
      ]) {
        const rejected = await fetch(`${baseUrl}/api/workspace/v1/sources`, {
          method: 'POST', headers: { ...headers, 'idempotency-key': body.source_id }, body: JSON.stringify(body),
        });
        expect(rejected.status).toBe(400);
      }

      await engine.executeRaw(
        "INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-2', 'member@example.test', now())",
      );
      await engine.executeRaw(
        "INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-2', 'workspace-1', 'identity-2', 'member')",
      );
      const memberSession = 'member-session';
      const memberCsrf = 'member-csrf';
      await engine.executeRaw(
        `INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at)
         VALUES ($1, 'member-2', $2, now() + interval '1 day')`,
        [digest(memberSession), digest(memberCsrf)],
      );
      const memberHeaders = {
        ...headers,
        cookie: `workspace_session=${memberSession}`,
        'x-csrf-token': memberCsrf,
        'idempotency-key': 'member-forbidden',
      };
      for (const request of [
        [`${baseUrl}/api/workspace/v1/sources`, { headers: memberHeaders }],
        [`${baseUrl}/api/workspace/v1/operations`, { headers: memberHeaders }],
        [`${baseUrl}/api/workspace/v1/operations/${operationId}`, { headers: memberHeaders }],
         [`${baseUrl}/api/workspace/v1/sources`, { method: 'POST', headers: memberHeaders, body: JSON.stringify({ source_id: 'forbidden', name: 'Forbidden', remote_url: 'https://example.test/forbidden.git', expected_cadence: 'daily' }) }],
         [`${baseUrl}/api/workspace/v1/sources/browser-handbook/archive`, { method: 'POST', headers: memberHeaders }],
         [`${baseUrl}/api/workspace/v1/sources/browser-handbook/restore`, { method: 'POST', headers: memberHeaders }],
        [`${baseUrl}/api/workspace/v1/operations/${operationId}/retry`, { method: 'POST', headers: memberHeaders }],
        [`${baseUrl}/api/workspace/v1/operations/${operationId}/cancel`, { method: 'POST', headers: memberHeaders }],
      ] as const) {
        expect((await fetch(request[0], request[1])).status).toBe(403);
      }
      expect((await fetch(`${baseUrl}/app/settings/sources`, { headers: memberHeaders })).status).toBe(403);
    });
    expect(await engine.executeRaw('SELECT source_id FROM workspace_sources ORDER BY source_id'))
      .toEqual([{ source_id: 'browser-handbook' }]);
  });

  test('recovers an expired running claim after a worker process restart', async () => {
    const queued = await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'restart-source', name: 'Restart source',
      remoteUrl: 'https://example.test/team/restart.git', expectedCadence: 'daily',
      actorMembershipId: 'member-1', requestId: 'req-restart', idempotencyKey: 'restart-source',
    });
    await engine.executeRaw(
      `UPDATE workspace_background_operations
          SET state='running', attempt=1, progress=15, lease_owner='dead-worker',
              lease_expires_at=now() - interval '1 minute'
        WHERE operation_id=$1`,
      [queued.operation.operationId],
    );
    await engine.executeRaw(
      "UPDATE workspace_sources SET provisioning_state='running' WHERE source_id='restart-source'",
    );

    const recovered = await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'replacement-worker', executeSourceProvisioning: async () => undefined,
    });
    expect(recovered).toMatchObject({
      operationId: queued.operation.operationId,
      state: 'completed',
      attempt: 2,
      progress: 100,
    });
  });

  test('records but does not unsafely interrupt cancellation after external work starts', async () => {
    const queued = await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'running-cancel', name: 'Running cancel',
      remoteUrl: 'https://example.test/team/running.git', expectedCadence: 'daily',
      actorMembershipId: 'member-1', requestId: 'req-running-cancel', idempotencyKey: 'running-cancel',
    });
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    const worker = runBackgroundOperationWorkerOnce(engine, {
      workerId: 'worker-running-cancel',
      executeSourceProvisioning: async () => { started(); await releasePromise; },
    });
    await startedPromise;
    const cancellation = await cancelBackgroundOperation(engine, {
      workspaceId: 'workspace-1', operationId: queued.operation.operationId,
      actorMembershipId: 'member-1', requestId: 'req-running-cancel-request',
    });
    expect(cancellation).toMatchObject({
      state: 'running', cancelRequested: true, cancellationSafe: false,
    });
    release();
    expect(await worker).toMatchObject({ state: 'completed', progress: 100 });
  });

  test('fails an exhausted expired claim instead of leaving it Running forever', async () => {
    const queued = await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'exhausted-source', name: 'Exhausted source',
      remoteUrl: 'https://example.test/team/exhausted.git', expectedCadence: 'daily',
      actorMembershipId: 'member-1', requestId: 'req-exhausted', idempotencyKey: 'exhausted-source',
    });
    await engine.executeRaw(
      `UPDATE workspace_background_operations
          SET state='running', attempt=max_attempts, lease_owner='dead-final-worker',
              lease_expires_at=now() - interval '1 minute'
        WHERE operation_id=$1`,
      [queued.operation.operationId],
    );
    let executed = false;
    const recovered = await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'recovery-worker', executeSourceProvisioning: async () => { executed = true; },
    });
    expect(recovered).toMatchObject({
      state: 'failed', retryable: false,
      error: { code: 'source_provisioning_exhausted' },
    });
    expect(executed).toBe(false);
  });

  test('renews a live lease so a long provisioning step is not executed concurrently', async () => {
    await queueManagedGitSource(engine, {
      workspaceId: 'workspace-1', sourceId: 'long-source', name: 'Long source',
      remoteUrl: 'https://example.test/team/long.git', expectedCadence: 'daily',
      actorMembershipId: 'member-1', requestId: 'req-long', idempotencyKey: 'long-source',
    });
    const first = runBackgroundOperationWorkerOnce(engine, {
      workerId: 'long-worker-a', leaseMs: 1_000,
      executeSourceProvisioning: async () => { await new Promise(resolve => setTimeout(resolve, 1_400)); },
    });
    await new Promise(resolve => setTimeout(resolve, 1_100));
    let duplicateExecution = false;
    const second = await runBackgroundOperationWorkerOnce(engine, {
      workerId: 'long-worker-b', leaseMs: 1_000,
      executeSourceProvisioning: async () => { duplicateExecution = true; },
    });
    expect(second).toBeNull();
    expect(duplicateExecution).toBe(false);
    expect(await first).toMatchObject({ state: 'completed' });
  });
});
