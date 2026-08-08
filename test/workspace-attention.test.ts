import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { hashWorkspaceSecret } from '../src/workspace/auth.ts';
import { queueSourceMaintenance, runSourceMaintenanceWorkerOnce } from '../src/workspace/source-synchronization.ts';
import { archiveWorkspaceSource } from '../src/workspace/source-lifecycle.ts';
import {
  assignWorkspaceAttentionItem,
  dismissWorkspaceAttentionItem,
  getWorkspaceAttentionItem,
  listWorkspaceAttentionItems,
  requestWorkspaceAttentionResolution,
  runWorkspaceSourceHealthDetector,
  startWorkspaceAttentionProgress,
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
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Test', now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-admin', 'admin@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('admin-1', 'workspace-1', 'identity-admin', 'administrator')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'admin-1', 'all')");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-member', 'member@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-member', 'member')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'member-1', 'specific')");
  await engine.executeRaw("INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', 'member-1', 'flaky-source')");
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id, archived)
    VALUES
      ('flaky-source', 'workspace-1', 'Flaky', 'https://example.test/flaky.git', 'daily', 'completed', 'admin-1', FALSE),
      ('hidden-source', 'workspace-1', 'Hidden', 'https://example.test/hidden.git', 'daily', 'completed', 'admin-1', FALSE)`);
});

const adminViewer = { membershipId: 'admin-1', role: 'administrator' as const };
const memberViewer = { membershipId: 'member-1', role: 'member' as const };

async function runMaintenance(
  sourceId: string,
  type: 'source.verify' | 'source.sync',
  outcome: 'succeed' | 'fail',
  key: string,
): Promise<void> {
  await queueSourceMaintenance(engine, {
    workspaceId: 'workspace-1', sourceId, type,
    actorMembershipId: 'admin-1', requestId: `req-${key}`, idempotencyKey: key,
  });
  const completed = await runSourceMaintenanceWorkerOnce(engine, {
    workerId: `worker-${key}`,
    execute: async () => {
      if (outcome === 'fail') throw new Error('remote unreachable');
      return { observedRevision: 'rev-1', changed: false, applied: type === 'source.sync' };
    },
  });
  expect(completed).not.toBeNull();
}

function detect(requestId = `detector-${Math.random().toString(36).slice(2)}`) {
  return runWorkspaceSourceHealthDetector(engine, { workspaceId: 'workspace-1', requestId });
}

test('a real verification failure creates one Source health item linked to its Source and evidence', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  const run = await detect('detector-run-1');
  expect(run.detectedItemIds).toHaveLength(1);

  const items = await listWorkspaceAttentionItems(engine, { workspaceId: 'workspace-1', viewer: adminViewer });
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    category: 'source_health',
    conditionType: 'source.verification_failure',
    status: 'open',
    resource: { type: 'source', id: 'flaky-source' },
    assignee: null,
  });
  expect(items[0]!.evidence).toMatchObject({ error_code: 'source_maintenance_failed' });
  expect(items[0]!.evidence.operation_id).toBeTruthy();
  expect(items[0]!.detectedAt).toBeTruthy();
  expect(items[0]!.lastVerifiedAt).toBeTruthy();
  expect(items[0]!.episode.state).toBe('active');
});

test('an uninterrupted episode never produces a duplicate active item', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  const first = await detect();
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-2');
  const second = await detect();
  expect(first.detectedItemIds).toHaveLength(1);
  expect(second.detectedItemIds).toHaveLength(0);
  expect(second.observedItemIds).toEqual(first.detectedItemIds);

  const items = await listWorkspaceAttentionItems(engine, { workspaceId: 'workspace-1', viewer: adminViewer });
  expect(items).toHaveLength(1);
  const episodes = await engine.executeRaw<{ state: string }>('SELECT state FROM workspace_condition_episodes');
  expect(episodes).toEqual([{ state: 'active' }]);
});

test('a synchronization failure is a distinct Source health condition', async () => {
  await runMaintenance('flaky-source', 'source.sync', 'fail', 'sync-1');
  const run = await detect();
  expect(run.detectedItemIds).toHaveLength(1);
  const items = await listWorkspaceAttentionItems(engine, { workspaceId: 'workspace-1', viewer: adminViewer });
  expect(items[0]).toMatchObject({ conditionType: 'source.synchronization_failure', summary: 'Source synchronization is failing.' });
});

test('a Member assigns an item and moves it from Open to In progress', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  const [itemId] = (await detect()).detectedItemIds;

  const assigned = await assignWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'assign-1',
  });
  expect(assigned.assignee).toMatchObject({ membershipId: 'member-1', email: 'member@example.test' });

  const started = await startWorkspaceAttentionProgress(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'start-1',
  });
  expect(started.status).toBe('in_progress');
  await expect(startWorkspaceAttentionProgress(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'start-2',
  })).rejects.toThrow('attention_status_invalid');

  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer });
  expect(detail.history.map(entry => entry.event)).toEqual(['detected', 'assigned', 'status_changed']);
  await expect(assignWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, assigneeMembershipId: 'missing-member',
    viewer: memberViewer, requestId: 'assign-2',
  })).rejects.toThrow('attention_assignee_not_found');
});

test('Resolved is recorded only after the detector verifies the condition is absent', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  const [itemId] = (await detect()).detectedItemIds;

  // The remediation attempt did not fix the problem: the item stays active.
  const stillFailing = await requestWorkspaceAttentionResolution(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'resolve-1',
  });
  expect(stillFailing.conditionPresent).toBe(true);
  expect(stillFailing.item.status).toBe('open');

  await runMaintenance('flaky-source', 'source.verify', 'succeed', 'verify-2');
  const recovered = await requestWorkspaceAttentionResolution(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'resolve-2',
  });
  expect(recovered.conditionPresent).toBe(false);
  expect(recovered.item.status).toBe('resolved');
  expect(recovered.item.resolvedAt).toBeTruthy();
  expect(recovered.item.episode.state).toBe('cleared');

  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: adminViewer });
  expect(detail.history.map(entry => entry.event)).toEqual([
    'detected', 'resolution_requested', 'verification_condition_present', 'resolution_requested', 'resolved',
  ]);
  expect(detail.history.find(entry => entry.event === 'resolved')!.detail).toEqual({ cause: 'condition_absent' });
  await expect(requestWorkspaceAttentionResolution(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'resolve-3',
  })).rejects.toThrow('attention_status_invalid');
});

test('dismissal requires an auditable reason and suppresses the continuing episode until it clears', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  const [itemId] = (await detect()).detectedItemIds;

  await expect(dismissWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, reason: '   ', viewer: memberViewer, requestId: 'dismiss-0',
  })).rejects.toThrow('reason_required');

  const dismissed = await dismissWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: itemId!, reason: 'Planned remote outage this week.',
    viewer: memberViewer, requestId: 'dismiss-1',
  });
  expect(dismissed.status).toBe('dismissed');
  expect(dismissed.dismissReason).toBe('Planned remote outage this week.');
  expect(dismissed.episode.state).toBe('active');

  // The same continuing episode stays suppressed: no new item appears.
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-2');
  const suppressed = await detect();
  expect(suppressed.detectedItemIds).toHaveLength(0);

  const audit = await engine.executeRaw<{ reason: string | null }>(
    "SELECT reason FROM workspace_audit_events WHERE action='attention.dismiss' AND outcome='succeeded'",
  );
  expect(audit).toHaveLength(1);
  expect(audit[0]!.reason).toBe('Planned remote outage this week.');
});

test('clearing and later recurrence creates a new Condition Episode and a new Attention Item', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  const [firstItemId] = (await detect()).detectedItemIds;
  await dismissWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: firstItemId!, reason: 'Known outage.', viewer: adminViewer, requestId: 'dismiss-1',
  });

  // The condition clears: the suppressed episode ends without resurrecting
  // the dismissed item.
  await runMaintenance('flaky-source', 'source.verify', 'succeed', 'verify-2');
  const cleared = await detect();
  expect(cleared.detectedItemIds).toHaveLength(0);
  expect(cleared.resolvedItemIds).toHaveLength(0);

  // The condition returns: a new episode opens a new item.
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-3');
  const recurrence = await detect();
  expect(recurrence.detectedItemIds).toHaveLength(1);
  expect(recurrence.detectedItemIds[0]).not.toBe(firstItemId);

  const items = await listWorkspaceAttentionItems(engine, { workspaceId: 'workspace-1', viewer: adminViewer });
  expect(items).toHaveLength(2);
  const episodes = await engine.executeRaw<{ state: string }>('SELECT state FROM workspace_condition_episodes ORDER BY detected_at');
  expect(episodes.map(row => row.state)).toEqual(['cleared', 'active']);
});

test('an open item is resolved by the detector once its condition is verified absent', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  const [itemId] = (await detect()).detectedItemIds;
  await runMaintenance('flaky-source', 'source.verify', 'succeed', 'verify-2');
  const run = await detect('detector-clear');
  expect(run.resolvedItemIds).toEqual([itemId!]);

  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: adminViewer });
  expect(detail.status).toBe('resolved');
  expect(detail.episode.state).toBe('cleared');
});

test('archived Sources stop producing active Source health work', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  const [itemId] = (await detect()).detectedItemIds;
  await archiveWorkspaceSource(engine, {
    workspaceId: 'workspace-1', sourceId: 'flaky-source', actorMembershipId: 'admin-1', requestId: 'archive-1',
  });
  const run = await detect();
  expect(run.detectedItemIds).toHaveLength(0);
  expect(run.resolvedItemIds).toEqual([itemId!]);

  // Archival is not a verified recovery; the recorded cause says so.
  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: adminViewer });
  expect(detail.history.find(entry => entry.event === 'resolved')!.detail).toEqual({ cause: 'source_left_active_lifecycle' });

  // Reconciliation stays idempotent for the archived Source.
  const again = await detect();
  expect(again.detectedItemIds).toHaveLength(0);
  expect(again.resolvedItemIds).toHaveLength(0);
});

test('attention mutations and detector outcomes emit safe history, Audit Events, and Change Events', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  const [itemId] = (await detect('detector-evidence')).detectedItemIds;
  await assignWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'assign-1' });
  await startWorkspaceAttentionProgress(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'start-1' });
  await runMaintenance('flaky-source', 'source.verify', 'succeed', 'verify-2');
  await requestWorkspaceAttentionResolution(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: memberViewer, requestId: 'resolve-1' });

  const audits = await engine.executeRaw<{ action: string; actor_kind: string }>(
    `SELECT action, actor_kind FROM workspace_audit_events
      WHERE action LIKE 'attention.%' AND outcome='succeeded' ORDER BY occurred_at, event_id`,
  );
  expect(audits.map(row => row.action).sort()).toEqual([
    'attention.assign', 'attention.detect', 'attention.resolve', 'attention.resolve.request', 'attention.status.change',
  ]);
  expect(audits.find(row => row.action === 'attention.detect')!.actor_kind).toBe('system');
  expect(audits.find(row => row.action === 'attention.resolve')!.actor_kind).toBe('system');
  expect(audits.find(row => row.action === 'attention.assign')!.actor_kind).toBe('member');

  const changes = await engine.executeRaw<{ summary: string }>(
    `SELECT summary FROM workspace_change_events WHERE resource_type='attention_item' ORDER BY occurred_at, event_id`,
  );
  expect(changes.map(row => row.summary)).toContain('Opened an Attention Item.');
  expect(changes.map(row => row.summary)).toContain('Resolved an Attention Item after verified recovery.');

  // History and evidence stay safe: no remote URL or raw worker output.
  const detail = await getWorkspaceAttentionItem(engine, { workspaceId: 'workspace-1', itemId: itemId!, viewer: adminViewer });
  const payload = JSON.stringify(detail);
  expect(payload).not.toContain('https://example.test');
  expect(payload).not.toContain('remote unreachable');
});

test('ordinary Members see only Source health work for Sources they can access, without disclosure', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  await runMaintenance('hidden-source', 'source.verify', 'fail', 'verify-hidden');
  const run = await detect();
  expect(run.detectedItemIds).toHaveLength(2);

  const adminItems = await listWorkspaceAttentionItems(engine, { workspaceId: 'workspace-1', viewer: adminViewer });
  expect(adminItems).toHaveLength(2);
  const memberItems = await listWorkspaceAttentionItems(engine, { workspaceId: 'workspace-1', viewer: memberViewer });
  expect(memberItems).toHaveLength(1);
  expect(JSON.stringify(memberItems)).not.toContain('hidden-source');

  const hiddenItem = adminItems.find(item => item.resource.id === 'hidden-source')!;
  await expect(getWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: hiddenItem.itemId, viewer: memberViewer,
  })).rejects.toThrow('attention_item_not_found');
  await expect(assignWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: hiddenItem.itemId, viewer: memberViewer, requestId: 'assign-denied',
  })).rejects.toThrow('attention_item_not_found');
});

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createWorkspaceRouter(engine, { requestId: () => 'req-attention-1' }));
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

test('the Attention API serves the authorized queue and the full lifecycle', async () => {
  await runMaintenance('flaky-source', 'source.verify', 'fail', 'verify-1');
  await runMaintenance('hidden-source', 'source.verify', 'fail', 'verify-hidden');
  const admin = await issueSession('admin-1');
  const member = await issueSession('member-1');
  await withServer(async baseUrl => {
    const post = (path: string, session: { cookie: string; csrf: string }, body: unknown = {}) =>
      fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', cookie: session.cookie,
          'x-csrf-token': session.csrf, origin: new URL(baseUrl).origin,
        },
        body: JSON.stringify(body),
      });

    const unauthenticated = await fetch(`${baseUrl}/api/workspace/v1/attention`);
    expect(unauthenticated.status).toBe(401);

    // The queue read reconciles detector state before listing.
    const adminList = await fetch(`${baseUrl}/api/workspace/v1/attention`, { headers: { cookie: admin.cookie } });
    expect(adminList.status).toBe(200);
    const adminData = (await adminList.json() as { data: { items: { item_id: string; resource: { id: string } }[] } }).data;
    expect(adminData.items).toHaveLength(2);

    const memberList = await fetch(`${baseUrl}/api/workspace/v1/attention`, { headers: { cookie: member.cookie } });
    const memberBody = await memberList.text();
    expect((JSON.parse(memberBody) as { data: { items: unknown[] } }).data.items).toHaveLength(1);
    expect(memberBody).not.toContain('hidden-source');

    const itemId = adminData.items.find(item => item.resource.id === 'flaky-source')!.item_id;
    const hiddenId = adminData.items.find(item => item.resource.id === 'hidden-source')!.item_id;

    const denied = await fetch(`${baseUrl}/api/workspace/v1/attention/${hiddenId}`, { headers: { cookie: member.cookie } });
    expect(denied.status).toBe(404);

    const assigned = await post(`/api/workspace/v1/attention/${itemId}/assign`, member);
    expect(assigned.status).toBe(200);
    expect((await assigned.json() as { data: { assignee: { membership_id: string } } }).data.assignee.membership_id).toBe('member-1');

    const started = await post(`/api/workspace/v1/attention/${itemId}/start`, member);
    expect(started.status).toBe(200);

    const stillPresent = await post(`/api/workspace/v1/attention/${itemId}/request-resolution`, member);
    expect(stillPresent.status).toBe(200);
    expect((await stillPresent.json() as { data: { condition_present: boolean; item: { status: string } } }).data)
      .toMatchObject({ condition_present: true, item: { status: 'in_progress' } });

    await runMaintenance('flaky-source', 'source.verify', 'succeed', 'verify-2');
    const resolved = await post(`/api/workspace/v1/attention/${itemId}/request-resolution`, member);
    expect((await resolved.json() as { data: { condition_present: boolean; item: { status: string } } }).data)
      .toMatchObject({ condition_present: false, item: { status: 'resolved' } });

    const missingReason = await post(`/api/workspace/v1/attention/${hiddenId}/dismiss`, admin, {});
    expect(missingReason.status).toBe(400);
    expect((await missingReason.json() as { error: { code: string } }).error.code).toBe('reason_required');

    const dismissed = await post(`/api/workspace/v1/attention/${hiddenId}/dismiss`, admin, { reason: 'Decommissioning this remote.' });
    expect(dismissed.status).toBe(200);
    expect((await dismissed.json() as { data: { status: string } }).data.status).toBe('dismissed');

    const detail = await fetch(`${baseUrl}/api/workspace/v1/attention/${itemId}`, { headers: { cookie: member.cookie } });
    const detailData = (await detail.json() as { data: { history: { event: string }[] } }).data;
    expect(detailData.history.map(entry => entry.event)).toContain('resolved');
  });
});
