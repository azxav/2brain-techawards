import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashWorkspaceSecret } from '../src/workspace/auth.ts';
import { assignWorkspaceAttentionItem, requestWorkspaceAttentionResolution, runWorkspaceAttentionDetector } from '../src/workspace/attention.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { setWorkspaceMembershipRole } from '../src/workspace/memberships.ts';
import { cancelBackgroundOperation } from '../src/workspace/source-provisioning.ts';
import {
  archiveWorkspaceNotification,
  countWorkspaceUnreadNotifications,
  createWorkspaceNotificationForEvent,
  listWorkspaceNotifications,
  purgeExpiredWorkspaceNotifications,
  setWorkspaceNotificationRead,
} from '../src/workspace/notifications.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { appDocument, workspacePanelForPath } from '../src/web/workspace-shell.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(createWorkspaceRouter(engine, { requestId: () => 'req-notifications' }));
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

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id,name,setup_completed_at) VALUES ('workspace-1','Workspace',now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id,normalized_email,email_confirmed_at) VALUES ('identity-admin','admin@example.test',now()),('identity-member','member@example.test',now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id,workspace_id,identity_id,role) VALUES ('admin-1','workspace-1','identity-admin','administrator'),('member-1','workspace-1','identity-member','member')");
  await engine.executeRaw("INSERT INTO workspace_principal_source_policies (principal_kind,principal_id,access_mode) VALUES ('member','admin-1','all'),('member','member-1','all')");
  await engine.executeRaw("INSERT INTO workspace_sources (source_id,workspace_id,name,remote_url,expected_cadence,provisioning_state,created_by_membership_id) VALUES ('source-1','workspace-1','Source','https://example.test/source.git','daily','completed','admin-1')");
  await engine.executeRaw("INSERT INTO workspace_condition_episodes (episode_id,workspace_id,category,condition_type,resource_type,resource_id) VALUES ('episode-1','workspace-1','source_health','source.verification_failure','source','source-1')");
  await engine.executeRaw("INSERT INTO workspace_attention_items (item_id,workspace_id,episode_id,category,condition_type,resource_type,resource_id,summary,assignee_membership_id) VALUES ('attention-1','workspace-1','episode-1','source_health','source.verification_failure','source','source-1','Source verification is failing.','member-1')");
});

test('an Attention assignment creates one personal notification without copying the shared item', async () => {
  const created = await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1',
    eventKey: 'assignment:attention-1:member-1',
    eventType: 'attention_assigned',
    target: { type: 'attention_item', id: 'attention-1' },
  });

  expect(created?.recipientMembershipId).toBe('member-1');
  expect(created?.target).toEqual({ type: 'attention_item', id: 'attention-1' });
  const notifications = await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', limit: 20,
  });
  expect(notifications.items.map(item => item.id)).toEqual([created!.id]);
  expect(await engine.executeRaw<{ count: string }>('SELECT count(*)::text AS count FROM workspace_attention_items')).toEqual([{ count: '1' }]);
});

test('only the recipient can change personal state without changing the shared condition', async () => {
  const notification = await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1', eventKey: 'assignment:attention-1:member-1',
    eventType: 'attention_assigned', target: { type: 'attention_item', id: 'attention-1' },
  });
  expect(notification).not.toBeNull();

  await expect(setWorkspaceNotificationRead(engine, {
    workspaceId: 'workspace-1', membershipId: 'admin-1', notificationId: notification!.id, read: true,
  })).rejects.toThrow('notification_not_found');
  expect(await countWorkspaceUnreadNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1',
  })).toBe(1);

  const read = await setWorkspaceNotificationRead(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', notificationId: notification!.id, read: true,
  });
  expect(read.unread).toBe(false);
  await setWorkspaceNotificationRead(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', notificationId: notification!.id, read: false,
  });
  expect(await countWorkspaceUnreadNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1',
  })).toBe(1);

  const archived = await archiveWorkspaceNotification(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', notificationId: notification!.id,
  });
  expect(archived.archived).toBe(true);
  expect((await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1',
  })).items).toEqual([]);
  expect(await engine.executeRaw<{ status: string }>(
    "SELECT status FROM workspace_attention_items WHERE item_id='attention-1'",
  )).toEqual([{ status: 'open' }]);
});

test('Notifications use fixed 30-day retention and purge expiry in bounded batches', async () => {
  const first = await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1', eventKey: 'expired', eventType: 'attention_assigned',
    target: { type: 'attention_item', id: 'attention-1' },
  });
  const second = await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1', eventKey: 'current', eventType: 'attention_assigned',
    target: { type: 'attention_item', id: 'attention-1' },
  });
  const lifetime = new Date(second!.expiresAt).getTime() - new Date(second!.createdAt).getTime();
  expect(lifetime).toBe(30 * 24 * 60 * 60 * 1000);
  await engine.executeRaw(
    "UPDATE workspace_notifications SET expires_at=now()-interval '1 second' WHERE notification_id=$1",
    [first!.id],
  );

  expect(await purgeExpiredWorkspaceNotifications(engine, { limit: 1 })).toBe(1);
  expect(await engine.executeRaw<{ notification_id: string }>(
    'SELECT notification_id FROM workspace_notifications ORDER BY notification_id',
  )).toEqual([{ notification_id: second!.id }]);
});

test('authenticated HTTP APIs list, count, mark, and archive only personal Notifications', async () => {
  const session = 'notification-session';
  const csrf = 'notification-csrf';
  await engine.executeRaw(
    `INSERT INTO workspace_sessions (session_hash,membership_id,csrf_hash,expires_at)
     VALUES ($1,'member-1',$2,now()+interval '1 day')`,
    [hashWorkspaceSecret(session), hashWorkspaceSecret(csrf)],
  );
  const notification = await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1', eventKey: 'http-assignment', eventType: 'attention_assigned',
    target: { type: 'attention_item', id: 'attention-1' },
  });

  await withServer(async baseUrl => {
    const headers = { cookie: `workspace_session=${session}` };
    expect((await fetch(`${baseUrl}/api/workspace/v1/notifications`)).status).toBe(401);
    const count = await (await fetch(`${baseUrl}/api/workspace/v1/notifications/unread-count`, { headers })).json() as { data: { unread_count: number } };
    expect(count.data.unread_count).toBe(1);
    const list = await (await fetch(`${baseUrl}/api/workspace/v1/notifications`, { headers })).json() as {
      data: { items: { notification_id: string; unread: boolean }[]; next_cursor: string | null };
    };
    expect(list.data).toEqual({
      items: [expect.objectContaining({ notification_id: notification!.id, unread: true })],
      next_cursor: null,
    });

    const mutationHeaders = { ...headers, origin: baseUrl, 'content-type': 'application/json', 'x-csrf-token': csrf };
    const invalidLimitResponse = await fetch(`${baseUrl}/api/workspace/v1/notifications?limit=nope`, { headers });
    expect(invalidLimitResponse.status).toBe(400);
    expect((await invalidLimitResponse.json() as { error: { code: string } }).error.code).toBe('invalid_notification_limit');
    const invalidReadResponse = await fetch(`${baseUrl}/api/workspace/v1/notifications/${notification!.id}/read`, {
      method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ read: 'yes' }),
    });
    expect(invalidReadResponse.status).toBe(400);
    expect((await invalidReadResponse.json() as { error: { code: string } }).error.code).toBe('invalid_notification_read_state');
    const read = await (await fetch(`${baseUrl}/api/workspace/v1/notifications/${notification!.id}/read`, {
      method: 'PATCH', headers: mutationHeaders, body: JSON.stringify({ read: true }),
    })).json() as { data: { unread: boolean } };
    expect(read.data.unread).toBe(false);
    const archived = await (await fetch(`${baseUrl}/api/workspace/v1/notifications/${notification!.id}/archive`, {
      method: 'POST', headers: mutationHeaders,
    })).json() as { data: { archived: boolean } };
    expect(archived.data.archived).toBe(true);
  });
});

test('assigning shared Attention work atomically notifies the assignee', async () => {
  await engine.executeRaw("UPDATE workspace_attention_items SET assignee_membership_id=NULL WHERE item_id='attention-1'");
  await assignWorkspaceAttentionItem(engine, {
    workspaceId: 'workspace-1', itemId: 'attention-1', assigneeMembershipId: 'member-1',
    viewer: { membershipId: 'admin-1', role: 'administrator' },
    requestId: 'req-assign-member',
  });

  const notifications = await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1',
  });
  expect(notifications.items).toEqual([
    expect.objectContaining({
      eventType: 'attention_assigned',
      target: { type: 'attention_item', id: 'attention-1' },
    }),
  ]);
});

test('a Membership access change notifies only the affected active Member', async () => {
  await setWorkspaceMembershipRole(
    engine, 'workspace-1', 'member-1', 'administrator', 'admin-1', 'req-role-change', 'Temporary administration duty.',
  );

  expect((await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1',
  })).items).toEqual([
    expect.objectContaining({
      eventType: 'membership_access_changed',
      target: { type: 'membership', id: 'member-1' },
    }),
  ]);
  expect((await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'admin-1',
  })).items).toEqual([]);
});

test('a terminal Background Operation outcome notifies its initiator', async () => {
  await engine.executeRaw(
    `INSERT INTO workspace_background_operations (
       operation_id,workspace_id,operation_type,initiator_membership_id,resource_type,resource_id,
       idempotency_key,idempotency_fingerprint,request_id
     ) VALUES ('operation-1','workspace-1','source.verify','member-1','source','source-1','verify-1','fingerprint','req-queue')`,
  );
  await cancelBackgroundOperation(engine, {
    workspaceId: 'workspace-1', operationId: 'operation-1',
    actorMembershipId: 'admin-1', requestId: 'req-cancel-operation',
  });

  expect((await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1',
  })).items).toEqual([
    expect.objectContaining({
      eventType: 'background_operation_outcome',
      target: { type: 'background_operation', id: 'operation-1' },
    }),
  ]);
});

test('a requested verification outcome creates one personal result notification', async () => {
  const outcome = await requestWorkspaceAttentionResolution(engine, {
    workspaceId: 'workspace-1', itemId: 'attention-1',
    viewer: { membershipId: 'member-1', role: 'member' }, requestId: 'req-verify-attention',
  });
  expect(outcome.conditionPresent).toBe(false);

  expect((await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1',
  })).items).toEqual([
    expect.objectContaining({
      eventType: 'attention_verification_outcome',
      target: { type: 'attention_item', id: 'attention-1' },
    }),
  ]);
});

test('a detector-confirmed change notifies the Member who owns the shared condition', async () => {
  const run = await runWorkspaceAttentionDetector(engine, {
    workspaceId: 'workspace-1', category: 'source_health', requestId: 'req-detector-clear',
  });
  expect(run.resolvedItemIds).toEqual(['attention-1']);
  expect((await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1',
  })).items).toEqual([
    expect.objectContaining({
      eventType: 'attention_condition_changed',
      target: { type: 'attention_item', id: 'attention-1' },
    }),
  ]);
});

test('Notification storage excludes raw prompts, credentials, provider secrets, and restricted metadata', async () => {
  const secret = 'sk-provider-secret raw prompt: reveal hidden-source remote_url';
  const created = await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1', eventKey: secret, eventType: 'attention_assigned',
    target: { type: 'attention_item', id: 'attention-1' },
    payload: { credential: secret, restricted_source: 'hidden-source' },
  } as Parameters<typeof createWorkspaceNotificationForEvent>[1] & { payload: Record<string, string> });
  const stored = JSON.stringify(await engine.executeRaw(
    `SELECT notification_id,event_key,event_type,target_type,target_id,source_id,summary
       FROM workspace_notifications WHERE notification_id=$1`,
    [created!.id],
  ));
  const changes = JSON.stringify(await engine.executeRaw(
    `SELECT resource_type,resource_id,summary,request_id FROM workspace_change_events
      WHERE resource_type='notification'`,
  ));

  expect(stored).not.toContain(secret);
  expect(changes).not.toContain(secret);
  expect(JSON.stringify(created)).not.toContain('hidden-source');
  expect(JSON.stringify(created)).not.toContain('credential');
});

test('the shell exposes the personal Notification indicator, states, actions, and live arrival contract', () => {
  const html = appDocument('Workspace', 'member', 'all', '/app/notifications', {}, '42');

  expect(workspacePanelForPath('/app/notifications')).toBe('notifications');
  expect(html).toContain('href="/app/notifications"');
  expect(html).toContain('id="workspace-notification-count"');
  expect(html).toContain('aria-label="Notifications"');
  expect(html).toContain('Loading Notifications');
  expect(html).toContain('No Notifications');
  expect(html).toContain('/api/workspace/v1/notifications/unread-count');
  expect(html).toContain("event.resource==='notifications'");
  expect(html).toContain("window.workspaceNotificationLiveArrival");
  expect(html).toContain("'read'");
  expect(html).toContain("'archive'");
  expect(html).toContain('Retry');
  expect(html).toContain("event.key==='r'");
  expect(html).toContain("scrollIntoView({block:'nearest',inline:'nearest'})");
  expect(html).toContain('@media(max-width:720px)');
  expect(html).toContain('@media(prefers-color-scheme:dark)');
  expect(html).not.toContain('/attention/'+encodeURIComponent('notification-1'));
});

test('creation and every read fail closed against current Membership and Source Access', async () => {
  await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id='member-1'");
  expect(await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1', eventKey: 'denied-at-create', eventType: 'attention_assigned',
    target: { type: 'attention_item', id: 'attention-1' },
  })).toBeNull();
  await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='all' WHERE principal_kind='member' AND principal_id='member-1'");
  const created = await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1', eventKey: 'allowed-at-create', eventType: 'attention_assigned',
    target: { type: 'attention_item', id: 'attention-1' },
  });
  await engine.executeRaw("UPDATE workspace_principal_source_policies SET access_mode='none' WHERE principal_kind='member' AND principal_id='member-1'");

  expect((await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1',
  })).items).toEqual([]);
  await expect(setWorkspaceNotificationRead(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', notificationId: created!.id, read: true,
  })).rejects.toThrow('notification_not_found');
  await engine.executeRaw("UPDATE workspace_memberships SET status='disabled' WHERE membership_id='member-1'");
  await expect(listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1',
  })).rejects.toThrow('unauthorized');
});

test('event creation is idempotent and cursor pagination does not duplicate delivery', async () => {
  const first = await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1', eventKey: 'same-event', eventType: 'attention_assigned',
    target: { type: 'attention_item', id: 'attention-1' },
  });
  const duplicate = await createWorkspaceNotificationForEvent(engine, {
    workspaceId: 'workspace-1', eventKey: 'same-event', eventType: 'attention_assigned',
    target: { type: 'attention_item', id: 'attention-1' },
  });
  for (const eventKey of ['second-event', 'third-event']) {
    await createWorkspaceNotificationForEvent(engine, {
      workspaceId: 'workspace-1', eventKey, eventType: 'attention_assigned',
      target: { type: 'attention_item', id: 'attention-1' },
    });
  }

  expect(duplicate!.id).toBe(first!.id);
  expect(await engine.executeRaw<{ count: string }>(
    "SELECT count(*)::text AS count FROM workspace_change_events WHERE resource_type='notification'",
  )).toEqual([{ count: '3' }]);
  const pageOne = await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', limit: 2,
  });
  const pageTwo = await listWorkspaceNotifications(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', limit: 2, cursor: pageOne.nextCursor!,
  });
  expect(pageOne.items).toHaveLength(2);
  expect(pageTwo.items).toHaveLength(1);
  expect(new Set([...pageOne.items, ...pageTwo.items].map(item => item.id)).size).toBe(3);
});
