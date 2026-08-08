import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { runWorkspaceRuntime } from '../src/workspace/runtime.ts';
import {
  enqueueWorkspaceRetention,
  getWorkspaceRetentionJob,
  retryWorkspaceRetention,
  runWorkspaceRetentionWorkerOnce,
} from '../src/workspace/retention.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
});

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(engine);
  for (const table of ['page_versions', 'pages', 'sources']) {
    await engine.executeRaw(`DROP TABLE IF EXISTS ${table}`);
  }
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw(
    "INSERT INTO workspace_workspaces (workspace_id,name,setup_completed_at) VALUES ('w','Workspace',now())",
  );
});

describe('Workspace retention lifecycle', () => {
  test('queues one auditable durable job for an idempotency key', async () => {
    const first = await enqueueWorkspaceRetention(engine, {
      workspaceId: 'w', requestId: 'retention:2026-07-14', idempotencyKey: 'daily:2026-07-14',
    });
    const replay = await enqueueWorkspaceRetention(engine, {
      workspaceId: 'w', requestId: 'retention:replay', idempotencyKey: 'daily:2026-07-14',
    });

    expect(replay.retentionId).toBe(first.retentionId);
    expect(await getWorkspaceRetentionJob(engine, 'w', first.retentionId)).toMatchObject({
      state: 'queued', progress: 0, attempt: 0, retryable: true,
    });
    expect(await engine.executeRaw('SELECT retention_id FROM workspace_retention_jobs')).toHaveLength(1);
    expect(await engine.executeRaw<{ action: string }>(
      "SELECT action FROM workspace_audit_events WHERE action='retention.request'",
    )).toEqual([{ action: 'retention.request' }]);
  });

  test('purges Change Events at the inclusive 90-day boundary and never purges Audit Events', async () => {
    await engine.executeRaw(
      `INSERT INTO workspace_change_events
         (event_id,workspace_id,actor_kind,actor_id,resource_type,resource_id,summary,request_id,occurred_at)
       VALUES
         ('change-older-a','w','system','fixture','source','docs','older a','change-older-a','2020-01-01T00:00:00.000Z'),
         ('change-older-b','w','system','fixture','source','docs','older b','change-older-b','2021-01-01T00:00:00.000Z'),
         ('change-boundary','w','system','fixture','source','docs','boundary','change-1','2026-04-15T12:00:00.000Z'),
         ('change-newer','w','system','fixture','source','docs','newer','change-2','2026-04-15T12:00:00.001Z')`,
    );
    await engine.executeRaw(
      `INSERT INTO workspace_audit_events
         (event_id,actor_kind,actor_id,action,target_type,target_id,outcome,before_state,after_state,request_id,occurred_at)
       VALUES ('audit-old','system','fixture','retention.request','fixture','old','succeeded','{}'::jsonb,'{}'::jsonb,
               'audit-old-request','2020-01-01T00:00:00.000Z')`,
    );
    await enqueueWorkspaceRetention(engine, {
      workspaceId: 'w', requestId: 'retention:boundary', idempotencyKey: 'boundary',
    });

    const firstPass = await runWorkspaceRetentionWorkerOnce(engine, {
      workerId: 'retention-worker-a', now: '2026-07-14T12:00:00.000Z', batchSize: 2,
    });
    expect(firstPass).toMatchObject({
      state: 'queued', progress: 95, attempt: 0, purgedCounts: { changeEvents: 2 },
    });

    const completed = await runWorkspaceRetentionWorkerOnce(engine, {
      workerId: 'retention-worker-b', now: '2030-01-01T00:00:00.000Z', batchSize: 2,
    });

    expect(completed).toMatchObject({
      state: 'completed', progress: 100, attempt: 1, purgedCounts: { changeEvents: 3 },
    });
    expect(await engine.executeRaw<{ event_id: string }>(
      "SELECT event_id FROM workspace_change_events WHERE workspace_id='w' ORDER BY event_id",
    )).toEqual([{ event_id: 'change-newer' }]);
    expect(await engine.executeRaw<{ event_id: string }>(
      "SELECT event_id FROM workspace_audit_events WHERE event_id='audit-old'",
    )).toEqual([{ event_id: 'audit-old' }]);
  });

  test('enforces every fixed cutoff while preserving Workspace-lifetime evidence', async () => {
    await engine.executeRaw(
      "INSERT INTO workspace_identities (identity_id,normalized_email) VALUES ('identity','member@example.test')",
    );
    await engine.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('member','w','identity','administrator')",
    );
    await engine.executeRaw(
      `INSERT INTO workspace_sources
         (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id)
       VALUES ('docs','w','Docs','https://example.test/docs.git','daily','completed','member')`,
    );
    await engine.executeRaw(
      "INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member','member','all')",
    );
    await engine.executeRaw(
      `INSERT INTO workspace_condition_episodes
         (episode_id,workspace_id,category,condition_type,resource_type,resource_id,detected_at)
       VALUES ('episode','w','source_health','stale_source','source','docs','2020-01-01T00:00:00.000Z')`,
    );
    await engine.executeRaw(
      `INSERT INTO workspace_attention_items
         (item_id,workspace_id,episode_id,category,condition_type,resource_type,resource_id,summary,detected_at)
       VALUES ('attention','w','episode','source_health','stale_source','source','docs','Old evidence','2020-01-01T00:00:00.000Z')`,
    );
    await engine.executeRaw(
      `INSERT INTO workspace_attention_item_history
         (history_id,item_id,event,actor_kind,actor_id,occurred_at)
       VALUES ('attention-history','attention','detected','system','fixture','2020-01-01T00:00:00.000Z')`,
    );

    await engine.executeRaw(
      `INSERT INTO workspace_agents
         (agent_id,workspace_id,name,purpose,owner_membership_id,created_by_membership_id)
       VALUES ('agent','w','Agent','Retention fixture','member','member')`,
    );
    await engine.executeRaw(
      `INSERT INTO workspace_agent_runs (run_id,agent_id,started_at,ended_at,outcome)
       VALUES
         ('run-boundary','agent','2026-04-15T11:00:00.000Z','2026-04-15T12:00:00.000Z','succeeded'),
         ('run-newer','agent','2026-04-15T11:00:00.000Z','2026-04-15T12:00:00.001Z','succeeded'),
         ('run-abandoned','agent','2026-04-15T12:00:00.000Z',NULL,NULL)`,
    );
    await engine.executeRaw(
      `INSERT INTO workspace_agent_activity
         (activity_id,agent_id,run_id,operation,outcome,occurred_at)
       VALUES
         ('activity-boundary','agent','run-boundary','search','succeeded','2026-04-15T12:00:00.000Z'),
         ('activity-newer','agent','run-newer','search','succeeded','2026-04-15T12:00:00.001Z'),
         ('activity-full-newer','agent',NULL,'search','succeeded','2026-07-14T11:00:00.000Z')`,
    );
    await engine.executeRaw(
      `INSERT INTO workspace_agent_request_details
         (activity_id,redacted_detail,full_parameters,full_parameters_expire_at,captured_at)
       VALUES
         ('activity-boundary','{"safe":"old"}'::jsonb,'{"secret":"expired-with-activity"}'::jsonb,
          '2026-07-14T12:00:00.000Z','2026-07-07T12:00:00.000Z'),
         ('activity-newer','{"safe":"retained"}'::jsonb,'{"secret":"boundary"}'::jsonb,
          '2026-07-14T12:00:00.000Z','2026-07-07T12:00:00.000Z'),
         ('activity-full-newer','{"safe":"retained"}'::jsonb,'{"secret":"newer"}'::jsonb,
          '2026-07-14T12:00:00.001Z','2026-07-07T12:00:00.001Z')`,
    );

    await engine.executeRaw(
      `INSERT INTO workspace_ask_results
         (ask_result_id,workspace_id,requester_membership_id,question,expires_at)
       VALUES
         ('ask-boundary','w','member','Boundary?','2026-07-14T12:00:00.000Z'),
         ('ask-newer','w','member','Newer?','2026-07-14T12:00:00.001Z')`,
    );
    await engine.executeRaw(
      `INSERT INTO workspace_notifications
         (notification_id,workspace_id,recipient_membership_id,event_key,event_type,target_type,target_id,summary,expires_at)
       VALUES
         ('notification-boundary','w','member','boundary','membership_access_changed','membership','member','Boundary',
          '2026-07-14T12:00:00.000Z'),
         ('notification-newer','w','member','newer','membership_access_changed','membership','member','Newer',
          '2026-07-14T12:00:00.001Z')`,
    );
    await engine.executeRaw(
      `INSERT INTO workspace_background_operations
         (operation_id,workspace_id,operation_type,initiator_membership_id,resource_type,resource_id,state,progress,
          outcome_summary,error_summary,initiator_reason,idempotency_key,idempotency_fingerprint,request_id,completed_at)
       VALUES
         ('operation-boundary','w','source.verify','member','source','docs','completed',100,
          'sensitive outcome','sensitive failure','sensitive reason','op-old','fp-old','request-old','2026-06-14T12:00:00.000Z'),
         ('operation-newer','w','source.verify','member','source','docs','completed',100,
          'newer outcome',NULL,NULL,'op-new','fp-new','request-new','2026-06-14T12:00:00.001Z')`,
    );
    await engine.executeRaw(
      `INSERT INTO workspace_exports
         (export_id,workspace_id,requested_by_membership_id,state,progress,idempotency_key,idempotency_fingerprint,
          request_id,artifact_content,manifest,record_counts,expires_at,completed_at)
       VALUES ('export-boundary','w','member','completed',100,'export-old','fp-export','request-export',
               'sensitive archive','{}'::jsonb,'{"pages":1}'::jsonb,
               '2026-07-14T12:00:00.000Z','2026-06-14T12:00:00.000Z')`,
    );

    await engine.executeRaw('CREATE TABLE sources (id TEXT PRIMARY KEY)');
    await engine.executeRaw('CREATE TABLE pages (id SERIAL PRIMARY KEY, source_id TEXT NOT NULL, slug TEXT NOT NULL)');
    await engine.executeRaw('CREATE TABLE page_versions (id SERIAL PRIMARY KEY, page_id INTEGER NOT NULL)');
    await engine.executeRaw("INSERT INTO sources (id) VALUES ('docs')");
    await engine.executeRaw("INSERT INTO pages (source_id,slug) VALUES ('docs','retained')");
    await engine.executeRaw("INSERT INTO page_versions (page_id) SELECT id FROM pages WHERE slug='retained'");

    await enqueueWorkspaceRetention(engine, {
      workspaceId: 'w', requestId: 'retention:all-cutoffs', idempotencyKey: 'all-cutoffs',
    });
    const completed = await runWorkspaceRetentionWorkerOnce(engine, {
      workerId: 'retention-worker-a', now: '2026-07-14T12:00:00.000Z', batchSize: 3,
    });

    expect(completed).toMatchObject({
      state: 'completed',
      purgedCounts: {
        fullRequestParameters: 1,
        agentActivity: 1,
        agentRuns: 1,
        askResults: 1,
        backgroundOperationDetails: 1,
        workspaceExportDetails: 1,
        notifications: 1,
      },
    });
    expect(await engine.executeRaw<{ activity_id: string }>(
      'SELECT activity_id FROM workspace_agent_activity ORDER BY activity_id',
    )).toEqual([{ activity_id: 'activity-full-newer' }, { activity_id: 'activity-newer' }]);
    expect(await engine.executeRaw<{ activity_id: string; full_parameters: unknown; redacted_detail: unknown }>(
      'SELECT activity_id,full_parameters,redacted_detail FROM workspace_agent_request_details ORDER BY activity_id',
    )).toEqual([
      { activity_id: 'activity-full-newer', full_parameters: { secret: 'newer' }, redacted_detail: { safe: 'retained' } },
      { activity_id: 'activity-newer', full_parameters: null, redacted_detail: { safe: 'retained' } },
    ]);
    expect(await engine.executeRaw<{ run_id: string }>('SELECT run_id FROM workspace_agent_runs ORDER BY run_id'))
      .toEqual([{ run_id: 'run-abandoned' }, { run_id: 'run-newer' }]);
    expect(await engine.executeRaw<{ ask_result_id: string }>('SELECT ask_result_id FROM workspace_ask_results'))
      .toEqual([{ ask_result_id: 'ask-newer' }]);
    expect(await engine.executeRaw<{ notification_id: string }>('SELECT notification_id FROM workspace_notifications'))
      .toEqual([{ notification_id: 'notification-newer' }]);
    expect(await engine.executeRaw<{ outcome_summary: string | null; error_summary: string | null; initiator_reason: string | null }>(
      "SELECT outcome_summary,error_summary,initiator_reason FROM workspace_background_operations WHERE operation_id='operation-boundary'",
    )).toEqual([{ outcome_summary: null, error_summary: null, initiator_reason: null }]);
    expect(await engine.executeRaw<{ artifact_content: string | null; manifest: unknown; record_counts: unknown }>(
      "SELECT artifact_content,manifest,record_counts FROM workspace_exports WHERE export_id='export-boundary'",
    )).toEqual([{ artifact_content: null, manifest: null, record_counts: { pages: 1 } }]);

    expect(await engine.executeRaw('SELECT source_id FROM workspace_sources')).toHaveLength(1);
    expect(await engine.executeRaw('SELECT principal_id FROM workspace_principal_source_policies')).toHaveLength(1);
    expect(await engine.executeRaw('SELECT item_id FROM workspace_attention_items')).toHaveLength(1);
    expect(await engine.executeRaw('SELECT history_id FROM workspace_attention_item_history')).toHaveLength(1);
    expect(await engine.executeRaw('SELECT id FROM page_versions')).toHaveLength(1);
  });

  test('retries a retryable failed retention job without changing its deterministic cutoff', async () => {
    await engine.executeRaw(
      "INSERT INTO workspace_identities (identity_id,normalized_email) VALUES ('identity','member@example.test')",
    );
    await engine.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('member','w','identity','administrator')",
    );
    await engine.executeRaw(
      `INSERT INTO workspace_ask_results
         (ask_result_id,workspace_id,requester_membership_id,question,expires_at)
       VALUES ('ask-after-original-cutoff','w','member','Still retained?','2027-01-01T00:00:00.000Z')`,
    );
    const queued = await enqueueWorkspaceRetention(engine, {
      workspaceId: 'w', requestId: 'retention:retry', idempotencyKey: 'retry',
    });
    await engine.executeRaw(
      `UPDATE workspace_retention_jobs
          SET state='failed', attempt=1, retryable=TRUE, error_code='retention_failed',
              error_summary='safe failure', cutoff_at='2026-07-14T12:00:00.000Z', completed_at=now()
        WHERE retention_id=$1`,
      [queued.retentionId],
    );

    const retried = await retryWorkspaceRetention(engine, {
      workspaceId: 'w', retentionId: queued.retentionId, requestId: 'retention:retry:2',
    });
    expect(retried).toMatchObject({
      state: 'queued', progress: 0, retryable: true, cutoffAt: '2026-07-14T12:00:00.000Z',
    });

    const completed = await runWorkspaceRetentionWorkerOnce(engine, {
      workerId: 'retention-worker-retry', now: '2030-01-01T00:00:00.000Z',
    });
    expect(completed).toMatchObject({
      retentionId: queued.retentionId,
      state: 'completed',
      attempt: 2,
      cutoffAt: '2026-07-14T12:00:00.000Z',
    });
    expect(await engine.executeRaw<{ ask_result_id: string }>(
      "SELECT ask_result_id FROM workspace_ask_results WHERE ask_result_id='ask-after-original-cutoff'",
    )).toEqual([{ ask_result_id: 'ask-after-original-cutoff' }]);
  });

  test('reclaims an expired running lease after worker restart', async () => {
    const queued = await enqueueWorkspaceRetention(engine, {
      workspaceId: 'w', requestId: 'retention:restart', idempotencyKey: 'restart',
    });
    await engine.executeRaw(
      `UPDATE workspace_retention_jobs
          SET state='running', progress=35, attempt=1, lease_owner='dead-worker',
              lease_expires_at=now() - interval '1 hour', cutoff_at='2026-07-14T12:00:00.000Z'
        WHERE retention_id=$1`,
      [queued.retentionId],
    );

    const recovered = await runWorkspaceRetentionWorkerOnce(engine, {
      workerId: 'replacement-worker', now: '2030-01-01T00:00:00.000Z',
    });
    expect(recovered).toMatchObject({
      retentionId: queued.retentionId,
      state: 'completed',
      attempt: 2,
      cutoffAt: '2026-07-14T12:00:00.000Z',
    });
  });

  test('fails an expired lease durably when restart attempts are exhausted', async () => {
    const queued = await enqueueWorkspaceRetention(engine, {
      workspaceId: 'w', requestId: 'retention:exhausted', idempotencyKey: 'exhausted',
    });
    await engine.executeRaw(
      `UPDATE workspace_retention_jobs
          SET state='running', attempt=3, max_attempts=3, lease_owner='dead-worker',
              lease_expires_at=now() - interval '1 hour', cutoff_at='2026-07-14T12:00:00.000Z'
        WHERE retention_id=$1`,
      [queued.retentionId],
    );

    const exhausted = await runWorkspaceRetentionWorkerOnce(engine, {
      workerId: 'replacement-worker', now: '2030-01-01T00:00:00.000Z',
    });
    expect(exhausted).toMatchObject({
      retentionId: queued.retentionId,
      state: 'failed',
      retryable: false,
      error: { code: 'retention_exhausted' },
    });
    expect(await engine.executeRaw<{ action: string }>(
      "SELECT action FROM workspace_audit_events WHERE action='retention.fail'",
    )).toEqual([{ action: 'retention.fail' }]);
  });

  test('allows only one concurrent worker to claim a queued job', async () => {
    const queued = await enqueueWorkspaceRetention(engine, {
      workspaceId: 'w', requestId: 'retention:concurrent', idempotencyKey: 'concurrent',
    });

    const results = await Promise.all([
      runWorkspaceRetentionWorkerOnce(engine, { workerId: 'worker-a', now: '2026-07-14T12:00:00.000Z' }),
      runWorkspaceRetentionWorkerOnce(engine, { workerId: 'worker-b', now: '2026-07-14T12:00:00.000Z' }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ retentionId: queued.retentionId, state: 'completed', attempt: 1 });
    expect(await engine.executeRaw<{ action: string }>(
      "SELECT action FROM workspace_audit_events WHERE action='retention.complete'",
    )).toEqual([{ action: 'retention.complete' }]);
  });

  test('the scheduler enqueues one daily retention job across restarts', async () => {
    await runWorkspaceRuntime(engine, 'scheduler', {
      once: true, now: '2026-07-14T12:00:00.000Z',
    });
    await runWorkspaceRuntime(engine, 'scheduler', {
      once: true, now: '2026-07-14T23:59:59.999Z',
    });

    expect(await engine.executeRaw<{ idempotency_key: string; request_id: string }>(
      'SELECT idempotency_key,request_id FROM workspace_retention_jobs',
    )).toEqual([{
      idempotency_key: 'daily:2026-07-14',
      request_id: 'retention:2026-07-14',
    }]);
  });

  test('records a payload-free durable failure when a purge batch cannot run', async () => {
    const secret = 'PLANTED-RETENTION-SENSITIVE-PAYLOAD';
    await engine.executeRaw(
      "INSERT INTO workspace_identities (identity_id,normalized_email) VALUES ('identity','member@example.test')",
    );
    await engine.executeRaw(
      "INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('member','w','identity','administrator')",
    );
    await engine.executeRaw(
      `INSERT INTO workspace_ask_results
         (ask_result_id,workspace_id,requester_membership_id,question,expires_at)
       VALUES ('ask-sensitive','w','member',$1,'2020-01-01T00:00:00.000Z')`,
      [secret],
    );
    const queued = await enqueueWorkspaceRetention(engine, {
      workspaceId: 'w', requestId: 'retention:failure', idempotencyKey: 'failure',
    });
    await engine.executeRaw('DROP TABLE workspace_change_events');

    const failed = await runWorkspaceRetentionWorkerOnce(engine, {
      workerId: 'retention-worker-failure', now: '2026-07-14T12:00:00.000Z',
    });
    expect(failed).toMatchObject({
      retentionId: queued.retentionId,
      state: 'failed',
      retryable: true,
      error: {
        code: 'retention_failed',
        message: 'Workspace retention failed. Retry when the Workspace is reachable.',
      },
    });
    const audit = await engine.executeRaw<{ before_state: unknown; after_state: unknown }>(
      "SELECT before_state,after_state FROM workspace_audit_events WHERE action='retention.fail'",
    );
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain('workspace_change_events');
  });
});
