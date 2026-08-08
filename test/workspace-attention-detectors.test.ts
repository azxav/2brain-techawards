import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation, recordWorkspaceRuntimeHeartbeat } from '../src/workspace/foundation.ts';
import { hashWorkspaceSecret } from '../src/workspace/auth.ts';
import { registerWorkspaceAgent, setWorkspaceAgentScope, setWorkspaceAgentStatus } from '../src/workspace/agents.ts';
import { recordWorkspaceAgentActivity } from '../src/workspace/agent-activity.ts';
import { queueSourceMaintenance, runSourceMaintenanceWorkerOnce } from '../src/workspace/source-synchronization.ts';
import {
  dismissWorkspaceAttentionItem,
  getWorkspaceAttentionItem,
  listWorkspaceAttentionItems,
  requestWorkspaceAttentionResolution,
  runWorkspaceAttentionDetectors,
  type WorkspaceAttentionItemView,
} from '../src/workspace/attention.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
});

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await engine.executeRaw('DROP TABLE IF EXISTS pages');
  await engine.executeRaw('DROP TABLE IF EXISTS sources');
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Test', now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-admin', 'admin@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('admin-1', 'workspace-1', 'identity-admin', 'administrator')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'admin-1', 'all')");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-member', 'member@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-member', 'member')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'member-1', 'specific')");
  await engine.executeRaw("INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', 'member-1', 'allowed-source')");
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id, archived)
    VALUES
      ('allowed-source', 'workspace-1', 'Allowed', 'https://example.test/allowed.git', 'daily', 'completed', 'admin-1', FALSE),
      ('denied-source', 'workspace-1', 'Denied', 'https://example.test/denied.git', 'daily', 'completed', 'admin-1', FALSE)`);
  await engine.executeRaw(`CREATE TABLE sources (id TEXT PRIMARY KEY, name TEXT NOT NULL)`);
  await engine.executeRaw(`CREATE TABLE pages (
    id SERIAL PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id),
    slug TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'document',
    title TEXT NOT NULL,
    frontmatter JSONB NOT NULL DEFAULT '{}',
    import_filename TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    UNIQUE (source_id, slug)
  )`);
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('allowed-source', 'Allowed'), ('denied-source', 'Denied')");
});

const adminViewer = { membershipId: 'admin-1', role: 'administrator' as const };
const memberViewer = { membershipId: 'member-1', role: 'member' as const };

function detect(requestId = `detectors-${Math.random().toString(36).slice(2)}`) {
  return runWorkspaceAttentionDetectors(engine, { workspaceId: 'workspace-1', requestId });
}

async function listItems(
  viewer: { membershipId: string; role: 'administrator' | 'member' } = adminViewer,
): Promise<WorkspaceAttentionItemView[]> {
  return listWorkspaceAttentionItems(engine, { workspaceId: 'workspace-1', viewer });
}

async function seedMissingEvidencePage(sourceId: string, slug: string): Promise<void> {
  await engine.executeRaw(
    "INSERT INTO pages (source_id, slug, title, frontmatter, import_filename) VALUES ($1, $2, $3, '{}'::jsonb, NULL)",
    [sourceId, slug, `Page ${slug}`],
  );
}

async function citePage(sourceId: string, slug: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE pages SET frontmatter='{"citations":["https://example.test/spec"]}'::jsonb, updated_at=now()
      WHERE source_id=$1 AND slug=$2`,
    [sourceId, slug],
  );
}

async function unCitePage(sourceId: string, slug: string): Promise<void> {
  await engine.executeRaw(
    "UPDATE pages SET frontmatter='{}'::jsonb, updated_at=now() WHERE source_id=$1 AND slug=$2",
    [sourceId, slug],
  );
}

async function registerAgent(scope: 'read' | 'write' | 'admin', name = `Agent ${scope}`): Promise<{ agentId: string; token: string }> {
  const registered = await registerWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', name, purpose: 'Automated summaries for tests.',
    ownerMembershipId: 'admin-1', scope, actorMembershipId: 'admin-1', requestId: `register-${randomUUID()}`,
  });
  return { agentId: registered.agentId, token: registered.credential.token };
}

async function recordAgentFailures(agentId: string, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await recordWorkspaceAgentActivity(engine, {
      workspaceId: 'workspace-1', agentId, operation: 'page.read', outcome: 'failed', sourceId: 'denied-source',
    });
  }
}

async function seedOrchestrationOperation(input: {
  operationType: 'source.provision' | 'source.permanent_delete' | 'source.verify' | 'source.sync';
  sourceId: string;
  state: 'completed' | 'failed';
  key: string;
}): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO workspace_background_operations (
       operation_id, workspace_id, operation_type, initiator_membership_id, resource_type, resource_id,
       state, error_code, idempotency_key, idempotency_fingerprint, request_id, completed_at
     ) VALUES ($1, 'workspace-1', $2, 'admin-1', 'source', $3, $4, $5, $6, $6, $7, clock_timestamp())`,
    [randomUUID(), input.operationType, input.sourceId, input.state,
      input.state === 'failed' ? 'operation_failed' : null, input.key, `req-${input.key}`],
  );
}

async function staleHeartbeat(role: 'worker' | 'scheduler'): Promise<void> {
  await recordWorkspaceRuntimeHeartbeat(engine, role);
  await engine.executeRaw(
    "UPDATE workspace_runtime_heartbeats SET last_heartbeat_at = now() - interval '10 minutes' WHERE role=$1",
    [role],
  );
}

test('a Page with Missing evidence creates one Knowledge quality item tied to the affected evidence', async () => {
  await seedMissingEvidencePage('allowed-source', 'guide');
  const run = await detect('knowledge-1');
  expect(run.detectedItemIds).toHaveLength(1);

  const items = await listItems();
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    category: 'knowledge_quality',
    conditionType: 'knowledge.missing_evidence',
    status: 'open',
    resource: { type: 'page', id: 'allowed-source:guide' },
  });
  expect(items[0]!.evidence).toMatchObject({
    source_id: 'allowed-source', slug: 'guide', evidence_status: 'missing_evidence',
  });

  // The uninterrupted episode is observed, never duplicated.
  const second = await detect();
  expect(second.detectedItemIds).toHaveLength(0);
  expect(second.observedItemIds).toEqual(run.detectedItemIds);

  // Adding citations is a verified recovery.
  await citePage('allowed-source', 'guide');
  const cleared = await detect();
  expect(cleared.resolvedItemIds).toEqual(run.detectedItemIds);
  const resolved = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: run.detectedItemIds[0]!, viewer: adminViewer });
  expect(resolved.status).toBe('resolved');
  expect(resolved.episode.state).toBe('cleared');

  // Recurrence begins a new episode with a new item.
  await unCitePage('allowed-source', 'guide');
  const recurrence = await detect();
  expect(recurrence.detectedItemIds).toHaveLength(1);
  expect(recurrence.detectedItemIds[0]).not.toBe(run.detectedItemIds[0]);
});

test('cited, source-backed, and deleted Pages produce no Knowledge quality work', async () => {
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, title, frontmatter, import_filename, deleted_at) VALUES
    ('allowed-source', 'cited', 'Cited', '{"citations":["https://example.test/spec"]}'::jsonb, NULL, NULL),
    ('allowed-source', 'backed', 'Backed', '{}'::jsonb, 'backed.md', NULL),
    ('allowed-source', 'gone', 'Gone', '{}'::jsonb, NULL, now())`);
  const run = await detect();
  expect(run.detectedItemIds).toHaveLength(0);
  expect(await listItems()).toHaveLength(0);
});

test('a deleted Page ends its episode without claiming verified recovery', async () => {
  await seedMissingEvidencePage('allowed-source', 'guide');
  const [itemId] = (await detect()).detectedItemIds;
  await engine.executeRaw("UPDATE pages SET deleted_at=now() WHERE source_id='allowed-source' AND slug='guide'");
  const run = await detect();
  expect(run.resolvedItemIds).toEqual([itemId!]);
  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: adminViewer });
  expect(detail.history.find(entry => entry.event === 'resolved')!.detail).toEqual({ cause: 'page_left_active_lifecycle' });
});

test('Members see Knowledge quality work only for Sources they can access, without disclosure', async () => {
  await seedMissingEvidencePage('allowed-source', 'guide');
  await seedMissingEvidencePage('denied-source', 'secret-plan');
  const run = await detect();
  expect(run.detectedItemIds).toHaveLength(2);

  expect(await listItems(adminViewer)).toHaveLength(2);
  const memberItems = await listItems(memberViewer);
  expect(memberItems).toHaveLength(1);
  expect(JSON.stringify(memberItems)).not.toContain('denied-source');
  expect(JSON.stringify(memberItems)).not.toContain('secret-plan');

  const hidden = (await listItems(adminViewer)).find(item => item.resource.id.startsWith('denied-source'))!;
  await expect(getWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: hidden.itemId, viewer: memberViewer,
  })).rejects.toThrow('attention_item_not_found');
});

test('repeated Agent authorization failures create one Agent access item without credential material', async () => {
  const agent = await registerAgent('read');
  await recordAgentFailures(agent.agentId, 3);
  const run = await detect();
  expect(run.detectedItemIds).toHaveLength(1);

  const items = await listItems();
  expect(items[0]).toMatchObject({
    category: 'agent_access',
    conditionType: 'agent.repeated_authorization_failure',
    resource: { type: 'agent', id: agent.agentId },
  });
  expect(items[0]!.evidence).toMatchObject({ agent_id: agent.agentId, consecutive_failures: 3 });

  // No secret credential material appears anywhere in the item payload.
  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: items[0]!.itemId, viewer: adminViewer });
  const payload = JSON.stringify(detail);
  expect(payload).not.toContain(agent.token);
  expect(payload.toLowerCase()).not.toContain('token');
  expect(payload.toLowerCase()).not.toContain('hash');

  // A continuing failure streak observes the same episode.
  await recordAgentFailures(agent.agentId, 1);
  const again = await detect();
  expect(again.detectedItemIds).toHaveLength(0);

  // A newer successful operation is a verified recovery.
  await recordWorkspaceAgentActivity(engine, {
    workspaceId: 'workspace-1', agentId: agent.agentId, operation: 'page.read', outcome: 'succeeded', sourceId: 'allowed-source',
  });
  const recovered = await detect();
  expect(recovered.resolvedItemIds).toEqual(run.detectedItemIds);
});

test('a recovery recorded across a backwards clock step still ends the Agent access episode', async () => {
  const agent = await registerAgent('read');
  await recordAgentFailures(agent.agentId, 3);
  const run = await detect();
  expect(run.detectedItemIds).toHaveLength(1);

  // Wall clock is not monotonic: an NTP correction or a VM suspend/resume can
  // stamp the recovery earlier than the failures it supersedes. Recency has to
  // follow the recorded order, or the episode stays open forever.
  await recordWorkspaceAgentActivity(engine, {
    workspaceId: 'workspace-1', agentId: agent.agentId, operation: 'page.read',
    outcome: 'succeeded', sourceId: 'allowed-source', requestId: 'recovery-across-clock-step',
  });
  await engine.executeRaw(
    `UPDATE workspace_agent_activity SET occurred_at = occurred_at - interval '1 hour'
      WHERE agent_id = $1 AND outcome = 'succeeded'`,
    [agent.agentId],
  );

  const recovered = await detect();
  expect(recovered.resolvedItemIds).toEqual(run.detectedItemIds);
  const detail = await getWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: run.detectedItemIds[0]!, viewer: adminViewer,
  });
  expect(detail.status).toBe('resolved');
  expect(detail.episode.state).toBe('cleared');
});

test('fewer than three consecutive failures is not yet a repeated authorization failure', async () => {
  const agent = await registerAgent('read');
  await recordAgentFailures(agent.agentId, 2);
  expect((await detect()).detectedItemIds).toHaveLength(0);
});

test('an active Admin-scope Agent is an access review condition until the scope is reduced', async () => {
  const agent = await registerAgent('admin');
  const run = await detect();
  expect(run.detectedItemIds).toHaveLength(1);
  const items = await listItems();
  expect(items[0]).toMatchObject({
    category: 'agent_access',
    conditionType: 'agent.admin_scope_review',
    resource: { type: 'agent', id: agent.agentId },
  });

  await setWorkspaceAgentScope(engine, 'workspace-1', agent.agentId, 'write', 'admin-1', 'scope-1', 'Least privilege review.');
  const recovered = await detect();
  expect(recovered.resolvedItemIds).toEqual(run.detectedItemIds);
  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: run.detectedItemIds[0]!, viewer: adminViewer });
  expect(detail.history.find(entry => entry.event === 'resolved')!.detail).toEqual({ cause: 'condition_absent' });
});

test('a revoked Agent ends its episode without claiming verified recovery', async () => {
  const agent = await registerAgent('admin');
  const [itemId] = (await detect()).detectedItemIds;
  await setWorkspaceAgentStatus(engine, 'workspace-1', agent.agentId, 'revoked', 'admin-1', 'revoke-1', 'Compromise suspected.');
  const run = await detect();
  expect(run.resolvedItemIds).toEqual([itemId!]);
  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: adminViewer });
  expect(detail.history.find(entry => entry.event === 'resolved')!.detail).toEqual({ cause: 'agent_left_active_lifecycle' });
});

test('Members never see Agent access or Automation health work, even with broad Source Access', async () => {
  const agent = await registerAgent('admin');
  await recordAgentFailures(agent.agentId, 3);
  await staleHeartbeat('worker');
  await seedOrchestrationOperation({ operationType: 'source.provision', sourceId: 'allowed-source', state: 'failed', key: 'provision-1' });
  const run = await detect();
  expect(run.detectedItemIds.length).toBeGreaterThanOrEqual(3);

  const adminItems = await listItems(adminViewer);
  expect(adminItems.some(item => item.category === 'agent_access')).toBe(true);
  expect(adminItems.some(item => item.category === 'automation_health')).toBe(true);

  const memberItems = await listItems(memberViewer);
  expect(memberItems).toHaveLength(0);

  const agentItem = adminItems.find(item => item.category === 'agent_access')!;
  await expect(getWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: agentItem.itemId, viewer: memberViewer,
  })).rejects.toThrow('attention_item_not_found');
});

test('a stalled runtime heartbeat is Automation health and a fresh heartbeat resolves it', async () => {
  await staleHeartbeat('worker');
  const run = await detect();
  expect(run.detectedItemIds).toHaveLength(1);
  const items = await listItems();
  expect(items[0]).toMatchObject({
    category: 'automation_health',
    conditionType: 'automation.runtime_stalled',
    resource: { type: 'runtime', id: 'worker' },
  });
  expect(items[0]!.evidence).toMatchObject({ role: 'worker' });

  await recordWorkspaceRuntimeHeartbeat(engine, 'worker');
  const recovered = await detect();
  expect(recovered.resolvedItemIds).toEqual(run.detectedItemIds);
});

test('failed orchestration is Automation health while verification and synchronization stay Source health', async () => {
  await seedOrchestrationOperation({ operationType: 'source.provision', sourceId: 'allowed-source', state: 'failed', key: 'provision-1' });
  await queueSourceMaintenance(engine, {
    workspaceId: 'workspace-1', sourceId: 'allowed-source', type: 'source.verify',
    actorMembershipId: 'admin-1', requestId: 'req-verify-1', idempotencyKey: 'verify-1',
  });
  await runSourceMaintenanceWorkerOnce(engine, {
    workerId: 'worker-verify-1',
    execute: async () => { throw new Error('remote unreachable'); },
  });

  await detect();
  const items = await listItems();
  const categories = items.map(item => `${item.category}:${item.conditionType}`).sort();
  expect(categories).toEqual([
    'automation_health:automation.operation_failure',
    'source_health:source.verification_failure',
  ]);
  const orchestration = items.find(item => item.category === 'automation_health')!;
  expect(orchestration.resource).toEqual({ type: 'orchestration', id: 'source.provision:allowed-source' });
  expect(orchestration.evidence).toMatchObject({ operation_type: 'source.provision', error_code: 'operation_failed' });

  // A later successful retry of the same orchestration verifies recovery.
  await seedOrchestrationOperation({ operationType: 'source.provision', sourceId: 'allowed-source', state: 'completed', key: 'provision-2' });
  const recovered = await detect();
  expect(recovered.resolvedItemIds).toEqual([orchestration.itemId]);
});

test('a verification recovered across a backwards clock step ends its Source health episode', async () => {
  await queueSourceMaintenance(engine, {
    workspaceId: 'workspace-1', sourceId: 'allowed-source', type: 'source.verify',
    actorMembershipId: 'admin-1', requestId: 'req-clock-fail', idempotencyKey: 'clock-fail',
  });
  await runSourceMaintenanceWorkerOnce(engine, {
    workerId: 'worker-clock-fail', execute: async () => { throw new Error('remote unreachable'); },
  });
  const detected = (await detect()).detectedItemIds;
  const failureItem = (await listItems()).find(item => item.conditionType === 'source.verification_failure')!;
  expect(detected).toContain(failureItem.itemId);

  await queueSourceMaintenance(engine, {
    workspaceId: 'workspace-1', sourceId: 'allowed-source', type: 'source.verify',
    actorMembershipId: 'admin-1', requestId: 'req-clock-ok', idempotencyKey: 'clock-ok',
  });
  await runSourceMaintenanceWorkerOnce(engine, {
    workerId: 'worker-clock-ok', execute: async () => ({ observedRevision: 'abc', changed: false }),
  });
  // The recovering verification lands with an earlier wall clock than the
  // failure it supersedes, exactly as a backwards clock step produces.
  await engine.executeRaw(
    `UPDATE workspace_source_verification_events SET completed_at = completed_at - interval '1 hour'
      WHERE source_id = 'allowed-source' AND outcome = 'succeeded'`,
  );

  const recovered = await detect();
  expect(recovered.resolvedItemIds).toContain(failureItem.itemId);
  const detail = await getWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: failureItem.itemId, viewer: adminViewer,
  });
  expect(detail.status).toBe('resolved');
  expect(detail.episode.state).toBe('cleared');
});

test('a permanently deleted Source ends its orchestration episode without claiming verified recovery', async () => {
  await seedOrchestrationOperation({ operationType: 'source.provision', sourceId: 'denied-source', state: 'failed', key: 'provision-gone' });
  const [itemId] = (await detect()).detectedItemIds;
  await engine.executeRaw("UPDATE workspace_sources SET deleted=TRUE, archived=TRUE, archived_at=now() WHERE source_id='denied-source'");
  const run = await detect();
  expect(run.resolvedItemIds).toEqual([itemId!]);
  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: adminViewer });
  expect(detail.history.find(entry => entry.event === 'resolved')!.detail).toEqual({ cause: 'source_left_active_lifecycle' });
});

test('dismissal suppresses a continuing Agent access episode until the condition truly clears', async () => {
  const agent = await registerAgent('admin');
  const [itemId] = (await detect()).detectedItemIds;
  await dismissWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, reason: 'Admin scope approved for this quarter.',
    viewer: adminViewer, requestId: 'dismiss-agent-1',
  });

  // The continuing episode stays suppressed; no duplicate item appears.
  expect((await detect()).detectedItemIds).toHaveLength(0);

  // The scope is reduced: the suppressed episode clears without resurrecting
  // the dismissed item.
  await setWorkspaceAgentScope(engine, 'workspace-1', agent.agentId, 'read', 'admin-1', 'scope-2', 'Least privilege.');
  const cleared = await detect();
  expect(cleared.detectedItemIds).toHaveLength(0);
  expect(cleared.resolvedItemIds).toHaveLength(0);
  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: adminViewer });
  expect(detail.status).toBe('dismissed');
  expect(detail.episode.state).toBe('cleared');
});

test('detector retries, concurrent evaluation, and worker restart never duplicate active items', async () => {
  await seedMissingEvidencePage('allowed-source', 'guide');
  await staleHeartbeat('scheduler');

  await Promise.all([
    detect('concurrent-1').catch(() => null),
    detect('concurrent-2').catch(() => null),
    detect('concurrent-3').catch(() => null),
  ]);
  // A restarted worker re-runs the same reconciliation.
  await runWorkspaceAttentionDetectors(engine, { workspaceId: 'workspace-1', requestId: 'restart-1', detectorId: 'restarted-worker' });

  const active = await engine.executeRaw<{ condition_type: string; count: string | number }>(
    `SELECT condition_type, count(*) AS count FROM workspace_attention_items
      WHERE status IN ('open', 'in_progress') GROUP BY condition_type ORDER BY condition_type`,
  );
  expect(active.map(row => ({ condition: row.condition_type, count: Number(row.count) }))).toEqual([
    { condition: 'automation.runtime_stalled', count: 1 },
    { condition: 'knowledge.missing_evidence', count: 1 },
  ]);
});

test('dismissal suppresses a continuing Knowledge episode and recurrence opens a new item', async () => {
  await seedMissingEvidencePage('allowed-source', 'guide');
  const [itemId] = (await detect()).detectedItemIds;
  await dismissWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, reason: 'Evidence backfill planned this sprint.',
    viewer: adminViewer, requestId: 'dismiss-1',
  });

  // The continuing episode stays suppressed.
  expect((await detect()).detectedItemIds).toHaveLength(0);

  // The condition clears, then returns: a new episode opens a new item.
  await citePage('allowed-source', 'guide');
  const cleared = await detect();
  expect(cleared.detectedItemIds).toHaveLength(0);
  expect(cleared.resolvedItemIds).toHaveLength(0);
  await unCitePage('allowed-source', 'guide');
  const recurrence = await detect();
  expect(recurrence.detectedItemIds).toHaveLength(1);
  expect(recurrence.detectedItemIds[0]).not.toBe(itemId);
});

test('Member-requested resolution verifies the condition per category', async () => {
  await seedMissingEvidencePage('allowed-source', 'guide');
  const [itemId] = (await detect()).detectedItemIds;

  const stillPresent = await requestWorkspaceAttentionResolution(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'resolve-1',
  });
  expect(stillPresent.conditionPresent).toBe(true);
  expect(stillPresent.item.status).toBe('open');

  await citePage('allowed-source', 'guide');
  const recovered = await requestWorkspaceAttentionResolution(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'resolve-2',
  });
  expect(recovered.conditionPresent).toBe(false);
  expect(recovered.item.status).toBe('resolved');
});

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createWorkspaceRouter(engine, { requestId: () => 'req-detectors-1' }));
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address.');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function issueSession(membershipId: string): Promise<{ cookie: string; csrf: string }> {
  const session = `session-${membershipId}`;
  const csrf = `csrf-${membershipId}`;
  await engine.executeRaw(
    "INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at) VALUES ($1,$2,$3,now()+interval '1 day')",
    [hashWorkspaceSecret(session), membershipId, hashWorkspaceSecret(csrf)],
  );
  return { cookie: `workspace_session=${session}`, csrf };
}

test('the Attention API reconciles every category and refuses user-authored items', async () => {
  await seedMissingEvidencePage('allowed-source', 'guide');
  await staleHeartbeat('worker');
  const admin = await issueSession('admin-1');
  const member = await issueSession('member-1');
  await withServer(async baseUrl => {
    // The queue read reconciles all detector categories before listing.
    const adminList = await fetch(`${baseUrl}/api/workspace/v1/attention`, { headers: { cookie: admin.cookie } });
    expect(adminList.status).toBe(200);
    const adminData = (await adminList.json() as { data: { items: { category: string }[] } }).data;
    expect(adminData.items.map(item => item.category).sort()).toEqual(['automation_health', 'knowledge_quality']);

    const memberList = await fetch(`${baseUrl}/api/workspace/v1/attention`, { headers: { cookie: member.cookie } });
    const memberBody = await memberList.text();
    const memberData = (JSON.parse(memberBody) as { data: { items: { category: string }[] } }).data;
    expect(memberData.items.map(item => item.category)).toEqual(['knowledge_quality']);
    expect(memberBody).not.toContain('automation_health');

    // The Attention Queue accepts no user-authored tasks: no creation route exists.
    const created = await fetch(`${baseUrl}/api/workspace/v1/attention`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', cookie: admin.cookie,
        'x-csrf-token': admin.csrf, origin: new URL(baseUrl).origin,
      },
      body: JSON.stringify({ summary: 'Manual task', category: 'source_health' }),
    });
    expect(created.status).toBe(404);
  });
});
