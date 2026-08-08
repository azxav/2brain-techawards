import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashWorkspaceSecret } from '../src/workspace/auth.ts';
import { appendWorkspaceChangeEvent } from '../src/workspace/events.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { listWorkspaceLiveUpdates } from '../src/workspace/live-updates.ts';
import { createWorkspaceNotificationForEvent } from '../src/workspace/notifications.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { appDocument, liveUpdatesClientScript } from '../src/web/workspace-shell.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createWorkspaceRouter(engine, { requestId: () => 'req-live-updates', liveUpdateIntervalMs: 20 }));
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose an address.');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

async function readEventStreamUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 2_000;
  while (!predicate(text) && Date.now() < deadline) {
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('event_stream_timeout')), 500)),
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
});

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Workspace', now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-member', 'member@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-admin', 'admin@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('admin-1', 'workspace-1', 'identity-admin', 'administrator')");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-member', 'member')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'admin-1', 'all')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'member-1', 'specific')");
  await engine.executeRaw("INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', 'member-1', 'allowed-source')");
  await engine.executeRaw(`INSERT INTO workspace_sources
    (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id, archived)
    VALUES
      ('allowed-source', 'workspace-1', 'Allowed', 'https://example.test/allowed.git', 'daily', 'completed', 'member-1', FALSE),
      ('hidden-source', 'workspace-1', 'Hidden', 'https://example.test/hidden.git', 'daily', 'completed', 'member-1', FALSE)`);
});

test('projects only currently authorized Source events and advances past hidden events', async () => {
  const allowedEventId = await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'source-worker' },
    action: 'source.verify.complete',
    resource: { type: 'source', id: 'allowed-source' },
    requestId: 'req-allowed',
  });
  await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'source-worker' },
    action: 'source.verify.complete',
    resource: { type: 'source', id: 'hidden-source' },
    requestId: 'req-hidden',
  });

  const first = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1',
    membershipId: 'member-1',
    role: 'member',
  });

  expect(first.events).toEqual([{
    id: allowedEventId,
    cursor: expect.stringMatching(/^\d+$/),
    resource: 'sources',
    occurred_at: expect.any(String),
  }]);
  expect(first.cursor).toMatch(/^\d+$/);
  expect(JSON.stringify(first)).not.toContain('allowed-source');
  expect(JSON.stringify(first)).not.toContain('hidden-source');
  expect(JSON.stringify(first)).not.toContain('req-hidden');

  const recovered = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1',
    membershipId: 'member-1',
    role: 'member',
    cursor: first.cursor,
  });
  expect(recovered).toEqual({ cursor: first.cursor, events: [] });

  await engine.executeRaw(
    "UPDATE workspace_principal_source_policies SET access_mode='specific' WHERE principal_kind='member' AND principal_id='admin-1'",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_source_grants (principal_kind,principal_id,source_id) VALUES ('member','admin-1','allowed-source')",
  );
  const restrictedAdministrator = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'admin-1', role: 'administrator',
  });
  expect(restrictedAdministrator.events.map(event => event.id)).toEqual([allowedEventId]);
});

test('projects personal Notification invalidations only to the current recipient', async () => {
  await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1',
    eventKey: 'member-access-changed:member-1',
    eventType: 'membership_access_changed',
    target: { type: 'membership', id: 'member-1' },
  });

  const recipient = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', role: 'member',
  });
  expect(recipient.events.map(event => event.resource)).toEqual(['notifications']);
  expect(JSON.stringify(recipient)).not.toContain('member-1');

  const administrator = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'admin-1', role: 'administrator',
  });
  expect(administrator.events).toEqual([]);
  expect(administrator.cursor).toBe(recipient.cursor);
});

test('access reduction discards a queued Source-scoped Notification invalidation', async () => {
  await engine.executeRaw("INSERT INTO workspace_condition_episodes (episode_id,workspace_id,category,condition_type,resource_type,resource_id) VALUES ('episode-live','workspace-1','source_health','source.verification_failure','source','allowed-source')");
  await engine.executeRaw("INSERT INTO workspace_attention_items (item_id,workspace_id,episode_id,category,condition_type,resource_type,resource_id,summary,assignee_membership_id) VALUES ('attention-live','workspace-1','episode-live','source_health','source.verification_failure','source','allowed-source','Source verification is failing.','member-1')");
  await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1', eventKey: 'queued-source-notification', eventType: 'attention_assigned',
    target: { type: 'attention_item', id: 'attention-live' },
  });
  await engine.executeRaw("DELETE FROM workspace_source_grants WHERE principal_kind='member' AND principal_id='member-1' AND source_id='allowed-source'");

  const afterReduction = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', role: 'member',
  });
  expect(afterReduction.events).toEqual([]);
  expect(afterReduction.cursor).toMatch(/^[1-9]\d*$/);
});

test('delivers a deleted Source invalidation only to Administrators', async () => {
  await engine.executeRaw("DELETE FROM workspace_source_grants WHERE source_id='allowed-source'");
  await engine.executeRaw("DELETE FROM workspace_sources WHERE source_id='allowed-source'");
  const eventId = await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'deletion-worker' }, action: 'source.delete',
    resource: { type: 'source', id: 'allowed-source' }, requestId: 'req-deleted',
    workspaceId: 'workspace-1',
  });

  const member = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', role: 'member',
  });
  expect(member.events).toEqual([]);

  const administrator = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'admin-1', role: 'administrator',
  });
  expect(administrator.events.map(event => [event.id, event.resource])).toEqual([[eventId, 'sources']]);
});

test('projects a full burst with bounded database queries inside the update budget', async () => {
  await engine.executeRaw(`INSERT INTO workspace_change_events
    (event_id,workspace_id,actor_kind,actor_id,resource_type,resource_id,summary,request_id)
    SELECT 'burst-'||n,'workspace-1','system','burst-worker','source','allowed-source',
           'Verified a Source.','req-burst-'||n
      FROM generate_series(1,100) AS n`);
  let queryCount = 0;
  const countingEngine = {
    executeRaw<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
      opts?: { signal?: AbortSignal },
    ): Promise<T[]> {
      queryCount += 1;
      return engine.executeRaw<T>(sql, params, opts);
    },
  };
  const startedAt = Date.now();
  const batch = await listWorkspaceLiveUpdates(countingEngine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', role: 'member', limit: 100,
  });

  expect(batch.events).toHaveLength(100);
  expect(queryCount).toBeLessThanOrEqual(5);
  expect(Date.now() - startedAt).toBeLessThan(5_000);
});

test('access reduction discards queued Source events and emits only a self access invalidation', async () => {
  await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'source-worker' },
    action: 'source.verify.complete',
    resource: { type: 'source', id: 'allowed-source' },
    requestId: 'req-before-revocation',
  });
  await engine.executeRaw(
    "DELETE FROM workspace_source_grants WHERE principal_kind='member' AND principal_id='member-1'",
  );
  const accessEventId = await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'member', id: 'member-1' },
    action: 'membership.source_access.change',
    resource: { type: 'membership', id: 'member-1' },
    requestId: 'req-access-reduced',
  });

  const batch = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', role: 'member',
  });

  expect(batch.events).toEqual([{
    id: accessEventId,
    cursor: expect.stringMatching(/^\d+$/),
    resource: 'access',
    occurred_at: expect.any(String),
  }]);
  expect(JSON.stringify(batch)).not.toContain('allowed-source');
  expect(JSON.stringify(batch)).not.toContain('req-before-revocation');
});

test('resolves indirect Attention visibility without exposing hidden or administrator-only items', async () => {
  await engine.executeRaw(`INSERT INTO workspace_condition_episodes
    (episode_id, workspace_id, category, condition_type, resource_type, resource_id)
    VALUES
      ('episode-allowed', 'workspace-1', 'source_health', 'source.verification_failure', 'source', 'allowed-source'),
      ('episode-hidden', 'workspace-1', 'source_health', 'source.synchronization_failure', 'source', 'hidden-source'),
      ('episode-agent', 'workspace-1', 'agent_access', 'agent.admin_scope_review', 'agent', 'agent-secret')`);
  await engine.executeRaw(`INSERT INTO workspace_attention_items
    (item_id, workspace_id, episode_id, category, condition_type, resource_type, resource_id, summary)
    VALUES
      ('item-allowed', 'workspace-1', 'episode-allowed', 'source_health', 'source.verification_failure', 'source', 'allowed-source', 'Allowed condition'),
      ('item-hidden', 'workspace-1', 'episode-hidden', 'source_health', 'source.synchronization_failure', 'source', 'hidden-source', 'Hidden condition'),
      ('item-agent', 'workspace-1', 'episode-agent', 'agent_access', 'agent.admin_scope_review', 'agent', 'agent-secret', 'Administrator condition')`);
  const allowedEventId = await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'attention-detector' }, action: 'attention.detect',
    resource: { type: 'attention_item', id: 'item-allowed' }, requestId: 'req-attention-allowed',
  });
  await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'attention-detector' }, action: 'attention.detect',
    resource: { type: 'attention_item', id: 'item-hidden' }, requestId: 'req-attention-hidden',
  });
  const administratorEventId = await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'attention-detector' }, action: 'attention.detect',
    resource: { type: 'attention_item', id: 'item-agent' }, requestId: 'req-attention-agent',
  });

  const batch = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', role: 'member',
  });

  expect(batch.events).toEqual([{
    id: allowedEventId,
    cursor: expect.stringMatching(/^\d+$/),
    resource: 'attention',
    occurred_at: expect.any(String),
  }]);
  expect(JSON.stringify(batch)).not.toContain('hidden-source');
  expect(JSON.stringify(batch)).not.toContain('agent-secret');
  expect(JSON.stringify(batch)).not.toContain('item-hidden');

  await engine.executeRaw(
    "UPDATE workspace_principal_source_policies SET access_mode='specific' WHERE principal_kind='member' AND principal_id='admin-1'",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_source_grants (principal_kind,principal_id,source_id) VALUES ('member','admin-1','allowed-source')",
  );
  const restrictedAdministrator = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'admin-1', role: 'administrator',
  });
  expect(restrictedAdministrator.events.map(event => event.id)).toEqual([
    allowedEventId,
    administratorEventId,
  ]);
});

test('shows organization-visible Agent invalidations to Members and Workspace invalidations only to Administrators', async () => {
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('identity-other','other@example.test',now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('member-other','workspace-1','identity-other','member')");
  await engine.executeRaw(`INSERT INTO workspace_agents
    (agent_id, workspace_id, name, purpose, owner_membership_id, created_by_membership_id)
    VALUES ('agent-1', 'workspace-1', 'Indexer', 'Indexes permitted Knowledge', 'admin-1', 'admin-1')`);
  const agentEventId = await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'member', id: 'admin-1' }, action: 'agent.purpose.change',
    resource: { type: 'agent', id: 'agent-1' }, requestId: 'req-agent',
  });
  const workspaceEventId = await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'workspace-setup' }, action: 'workspace.setup.confirm',
    resource: { type: 'workspace', id: 'workspace-1' }, requestId: 'req-workspace',
  });
  const otherMembershipEventId = await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'member', id: 'admin-1' }, action: 'membership.role.change',
    resource: { type: 'membership', id: 'member-other' }, requestId: 'req-other-member',
  });

  const member = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', role: 'member',
  });
  expect(member.events.map(event => [event.id, event.resource])).toEqual([[agentEventId, 'agents']]);

  const administrator = await listWorkspaceLiveUpdates(engine, {
    workspaceId: 'workspace-1', membershipId: 'admin-1', role: 'administrator',
  });
  expect(administrator.events.map(event => [event.id, event.resource])).toEqual([
    [agentEventId, 'agents'],
    [workspaceEventId, 'workspace'],
    [otherMembershipEventId, 'members'],
  ]);
});

test('polling exposes the safe projection and reauthenticates every request', async () => {
  const session = 'member-live-session';
  await engine.executeRaw(
    `INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at)
     VALUES ($1, 'member-1', $2, now()+interval '1 day')`,
    [hashWorkspaceSecret(session), hashWorkspaceSecret('member-live-csrf')],
  );
  const eventId = await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'source-worker' }, action: 'source.verify.complete',
    resource: { type: 'source', id: 'allowed-source' }, requestId: 'req-visible',
  });
  await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'source-worker' }, action: 'source.verify.complete',
    resource: { type: 'source', id: 'hidden-source' }, requestId: 'req-hidden',
  });

  await withServer(async baseUrl => {
    const unauthenticated = await fetch(`${baseUrl}/api/workspace/v1/live-updates`);
    expect(unauthenticated.status).toBe(401);

    const bootstrapResponse = await fetch(`${baseUrl}/api/workspace/v1/live-updates?cursor=latest`, {
      headers: { cookie: `workspace_session=${session}` },
    });
    const bootstrap = await bootstrapResponse.json() as { data: { cursor: string; events: unknown[] } };
    expect(bootstrap.data.events).toEqual([]);
    expect(bootstrap.data.cursor).toMatch(/^\d+$/);
    const postBootstrapEventId = await appendWorkspaceChangeEvent(engine, {
      actor: { kind: 'system', id: 'source-worker' }, action: 'source.verify.complete',
      resource: { type: 'source', id: 'allowed-source' }, requestId: 'req-after-bootstrap',
    });
    const deltaResponse = await fetch(`${baseUrl}/api/workspace/v1/live-updates?cursor=${bootstrap.data.cursor}`, {
      headers: { cookie: `workspace_session=${session}` },
    });
    const delta = await deltaResponse.json() as { data: { events: { id: string }[] } };
    expect(delta.data.events.map(event => event.id)).toEqual([postBootstrapEventId]);

    const response = await fetch(`${baseUrl}/api/workspace/v1/live-updates`, {
      headers: { cookie: `workspace_session=${session}` },
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as { data: { cursor: string; events: { id: string; cursor: string; resource: string; occurred_at: string }[] } };
    expect(body.data.events).toEqual([
      { id: eventId, cursor: expect.any(String), resource: 'sources', occurred_at: expect.any(String) },
      { id: postBootstrapEventId, cursor: expect.any(String), resource: 'sources', occurred_at: expect.any(String) },
    ]);
    expect(text).not.toContain('hidden-source');
    expect(text).not.toContain('req-hidden');

    const invalid = await fetch(`${baseUrl}/api/workspace/v1/live-updates?cursor=not-a-cursor`, {
      headers: { cookie: `workspace_session=${session}` },
    });
    expect(invalid.status).toBe(400);
    const overflow = await fetch(`${baseUrl}/api/workspace/v1/live-updates?cursor=9223372036854775808`, {
      headers: { cookie: `workspace_session=${session}` },
    });
    expect(overflow.status).toBe(400);

    await engine.executeRaw('UPDATE workspace_sessions SET revoked_at=now() WHERE membership_id=$1', ['member-1']);
    const revoked = await fetch(`${baseUrl}/api/workspace/v1/live-updates`, {
      headers: { cookie: `workspace_session=${session}` },
    });
    expect(revoked.status).toBe(401);
  });
});

test('SSE uses the same projection and stops future delivery after session revocation', async () => {
  const session = 'member-stream-session';
  await engine.executeRaw(
    `INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at)
     VALUES ($1, 'member-1', $2, now()+interval '1 day')`,
    [hashWorkspaceSecret(session), hashWorkspaceSecret('member-stream-csrf')],
  );
  const visibleEventId = await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'source-worker' }, action: 'source.verify.complete',
    resource: { type: 'source', id: 'allowed-source' }, requestId: 'req-stream-visible',
  });
  await appendWorkspaceChangeEvent(engine, {
    actor: { kind: 'system', id: 'source-worker' }, action: 'source.verify.complete',
    resource: { type: 'source', id: 'hidden-source' }, requestId: 'req-stream-hidden',
  });

  await withServer(async baseUrl => {
    const controller = new AbortController();
    const response = await fetch(`${baseUrl}/api/workspace/v1/live-updates/stream`, {
      headers: { cookie: `workspace_session=${session}` }, signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const initial = await readEventStreamUntil(reader, text => text.includes(visibleEventId));
    expect(initial).toContain('event: update');
    expect(initial).toContain(visibleEventId);
    expect(initial).not.toContain('hidden-source');
    expect(initial).not.toContain('req-stream-hidden');

    await engine.executeRaw('UPDATE workspace_sessions SET revoked_at=now() WHERE membership_id=$1', ['member-1']);
    const afterRevocation = await readEventStreamUntil(reader, text => text.includes('event: access-revoked'));
    expect(afterRevocation).toContain('event: access-revoked');
    controller.abort();
  });
});

test('the shell exposes explicit pending, connection-loss, polling, and retry controls', () => {
  const html = appDocument('Workspace', 'member', 'specific', '/app/knowledge', {}, '42');
  const settingsHtml = appDocument('Workspace', 'administrator', 'all', '/app/settings/sources', {}, '42');

  expect(html).toContain('id="workspace-live-updates"');
  expect(html).toContain('id="workspace-live-update-count"');
  expect(html).toContain('aria-live="polite" aria-atomic="true"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain('Apply updates');
  expect(html).toContain('Potentially outdated');
  expect(html).toContain('/api/workspace/v1/live-updates/stream');
  expect(html).toContain('/api/workspace/v1/live-updates?cursor=');
  expect(html).toContain('||"42"');
  expect(html).toContain("event.resource==='access'");
  expect(html).toContain('pendingById.has(event.id)');
  expect(html).toContain('BigInt(next)>BigInt(liveCursor)');
  expect(html).toContain('workspaceLiveUpdatesIsEmpty');
  expect(html).toContain("!empty.querySelector('.checklist')");
  expect(html).toContain('min-height:44px');
  expect(html).not.toContain('live-updates{animation:');
  expect(settingsHtml.indexOf('id="workspace-live-updates"')).toBeGreaterThan(settingsHtml.indexOf('<section class="settings"'));
  expect(settingsHtml.indexOf('id="workspace-live-updates"')).toBeLessThan(settingsHtml.indexOf('</section></div>'));
  expect(settingsHtml).toContain('z-index:25');
  expect(settingsHtml).toContain("sourceWarning.hidden");
  expect(settingsHtml).toContain("location.reload();return false");
});

test('the live client executes pending counts, dedup, explicit apply, and access revocation', async () => {
  class FakeElement {
    hidden = true;
    disabled = false;
    textContent = '';
    private listeners = new Map<string, () => unknown>();
    addEventListener(type: string, listener: () => unknown): void { this.listeners.set(type, listener); }
    dispatch(type: string): unknown { return this.listeners.get(type)?.(); }
  }
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    private listeners = new Map<string, (event: { data: string }) => unknown>();
    constructor(readonly url: string) { FakeEventSource.instances.push(this); }
    addEventListener(type: string, listener: (event: { data: string }) => unknown): void {
      this.listeners.set(type, listener);
    }
    emit(type: string, data = ''): unknown { return this.listeners.get(type)?.({ data }); }
    close(): void {}
  }
  const connection = new FakeElement();
  const count = new FakeElement();
  const outdated = new FakeElement();
  const retry = new FakeElement();
  const elements = new Map<string, FakeElement>([
    ['#workspace-live-connection', connection],
    ['#workspace-live-update-count', count],
    ['#workspace-live-outdated', outdated],
    ['#workspace-live-retry', retry],
  ]);
  const documentStub = { querySelector: (selector: string) => elements.get(selector) ?? null };
  const storage = new Map<string, string>();
  const sessionStorageStub = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  };
  let applyCalls = 0;
  let applySucceeds = false;
  let reloads = 0;
  const windowStub = {
    workspaceApplyLiveUpdates: async () => { applyCalls += 1; return applySucceeds; },
    workspaceLiveUpdatesIsEmpty: () => false,
    addEventListener: () => undefined,
  };
  const execute = new Function(
    'document', 'window', 'sessionStorage', 'location', 'EventSource', 'fetch',
    'setTimeout', 'clearTimeout',
    liveUpdatesClientScript('0'),
  );
  const fetchUrls: string[] = [];
  let resolvePoll: ((value: unknown) => void) | undefined;
  const timers: { callback: () => unknown; delay: number }[] = [];
  execute(
    documentStub,
    windowStub,
    sessionStorageStub,
    { reload: () => { reloads += 1; } },
    FakeEventSource,
    async (url: string) => {
      fetchUrls.push(url);
      return new Promise(resolve => { resolvePoll = resolve; });
    },
    (callback: () => unknown, delay: number) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    () => undefined,
  );
  const stream = FakeEventSource.instances[0]!;
  expect(fetchUrls).toEqual([]);
  expect(stream.url).toContain('cursor=0');
  expect(timers.some(timer => timer.delay === 4_000)).toBe(true);
  stream.emit('update', JSON.stringify({ id: 'event-1', cursor: '1', resource: 'sources' }));
  stream.emit('update', JSON.stringify({ id: 'event-1', cursor: '1', resource: 'sources' }));
  expect(count.hidden).toBe(false);
  expect(count.textContent).toBe('Apply 1 new update');
  expect(applyCalls).toBe(0);
  stream.emit('update', JSON.stringify({ id: 'event-2', cursor: '2', resource: 'attention' }));
  expect(count.textContent).toBe('Apply 2 new updates');

  await count.dispatch('click');
  expect(applyCalls).toBe(1);
  expect(count.hidden).toBe(false);
  expect(count.textContent).toBe('Apply 2 new updates');
  applySucceeds = true;
  await count.dispatch('click');
  expect(applyCalls).toBe(2);
  expect(count.hidden).toBe(true);
  expect(JSON.parse(storage.get('workspace_live_applied')!)).toEqual(['event-1', 'event-2']);

  stream.emit('error');
  await timers.find(timer => timer.delay === 10_000)!.callback();
  const replacementStream = FakeEventSource.instances[1]!;
  replacementStream.emit('open');
  resolvePoll!({
    status: 200,
    ok: true,
    json: async () => ({ data: { cursor: '99', events: [{ id: 'stale-poll', cursor: '99', resource: 'sources' }] } }),
  });
  await new Promise(resolve => globalThis.setTimeout(resolve, 0));
  expect(connection.textContent).toBe('Live updates connected');
  expect(count.hidden).toBe(true);

  replacementStream.emit('update', JSON.stringify({ id: 'event-3', cursor: '3', resource: 'access' }));
  expect(reloads).toBe(1);
  expect(count.hidden).toBe(true);
});

test('the latest fallback persists one numeric baseline and reloads before streaming', async () => {
  const element = {
    hidden: true, disabled: false, textContent: '',
    addEventListener: () => undefined,
  };
  const storage = new Map<string, string>();
  let reloads = 0;
  let streams = 0;
  class UnexpectedEventSource { constructor() { streams += 1; } }
  const execute = new Function(
    'document', 'window', 'sessionStorage', 'location', 'EventSource', 'fetch',
    'setTimeout', 'clearTimeout',
    liveUpdatesClientScript(),
  );
  execute(
    { querySelector: () => element },
    { workspaceLiveUpdatesIsEmpty: () => false, addEventListener: () => undefined },
    {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
    { reload: () => { reloads += 1; } },
    UnexpectedEventSource,
    async () => ({ status: 200, ok: true, json: async () => ({ data: { cursor: '12', events: [] } }) }),
    () => 1,
    () => undefined,
  );
  await new Promise(resolve => globalThis.setTimeout(resolve, 0));

  expect(storage.get('workspace_live_cursor')).toBe('12');
  expect(reloads).toBe(1);
  expect(streams).toBe(0);
});
