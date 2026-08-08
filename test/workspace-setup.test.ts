import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { authenticateWorkspaceSession, beginWorkspaceSetup, confirmFirstAdministrator, inspectWorkspaceToken, issueWorkspaceSetupToken, redeemWorkspaceRecovery, renewWorkspaceConfirmation } from '../src/workspace/auth.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import type { WorkspaceEmailMessage } from '../src/workspace/email-delivery.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' }); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetWorkspaceFoundationForTest(engine); await initializeWorkspaceFoundation(engine); });

type DeliveredMessage = WorkspaceEmailMessage;

async function server(run: (base: string, delivered: { token?: string; messages: DeliveredMessage[]; failNextDelivery?: boolean }) => Promise<void>) {
  const app = express();
  const delivered: { token?: string; messages: DeliveredMessage[]; failNextDelivery?: boolean } = { messages: [] };
  app.use(createWorkspaceRouter(engine, {
    bootstrapCredential: 'bootstrap-test',
    tokenSecret: 'workspace-token-secret-for-tests',
    allowedOrigin: 'https://workspace.example.test',
    requestId: () => 'req-setup',
    deliverConfirmation: async message => {
      if (delivered.failNextDelivery) { delivered.failNextDelivery = false; throw new Error('resend_delivery_failed: status 500'); }
      delivered.token = message.token; delivered.messages.push({ ...message });
    },
  }));
  const listener = await new Promise<Server>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  try { await run(`http://127.0.0.1:${address.port}`, delivered); } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
}

test('bootstrap credential issues a replay-safe setup link and the confirmed administrator enters only the empty shell', async () => {
  await server(async (base, delivered) => {
    expect((await fetch(`${base}/api/workspace/v1/operator/links`, { method: 'POST' })).status).toBe(401);
    const issue = await fetch(`${base}/api/workspace/v1/operator/links`, { method: 'POST', headers: { authorization: 'Bootstrap bootstrap-test', 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'setup' }) });
    const setupToken = (await issue.json() as any).data.token;
    const setup = () => fetch(`${base}/api/workspace/v1/setup`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ token: setupToken, workspace_name: 'Acme Example', administrator_email: 'ADMIN@example.test' }) });
    expect((await setup()).status).toBe(202);
    expect((await setup()).status).not.toBe(202);

    expect(delivered.token).toBeString();
    expect(delivered.messages).toEqual([{ email: 'ADMIN@example.test', token: delivered.token!, purpose: 'confirmation' }]);
    const outbox = await engine.executeRaw<{ delivery_key: string }>('SELECT delivery_key FROM workspace_email_outbox');
    expect(outbox).toHaveLength(1);
    expect(JSON.stringify(outbox)).not.toContain(delivered.token!);
    const confirmed = await fetch(`${base}/api/workspace/v1/setup/confirm`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ token: delivered.token }) });
    expect(confirmed.status).toBe(200);
    const confirmationBody = await confirmed.json() as any;
    const setCookie = confirmed.headers.get('set-cookie')!;
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=2592000');
    expect((await fetch(`${base}/api/workspace/v1/setup/confirm`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ token: delivered.token }) })).status).not.toBe(200);

    const cookie = setCookie.split(';')[0];
    const shell = await fetch(`${base}/app`, { headers: { cookie }, redirect: 'manual' });
    const html = await shell.text();
    expect(html).toContain('Set up your Workspace');
    expect(html).toContain('Setup Checklist');
    expect(html).toContain('href="/app/knowledge"');
    expect(html).not.toContain('href="/app/members"');
    expect(html).toContain('href="/app/agents"');
    const session = await (await fetch(`${base}/api/workspace/v1/session`, { headers: { cookie } })).json() as any;
    expect(session.data).toMatchObject({ workspace_name: 'Acme Example', role: 'administrator', surfaces: [] });

    const loginRequest = await fetch(`${base}/api/workspace/v1/login/request`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test' }) });
    expect(loginRequest.status).toBe(202);
    expect(delivered.messages.at(-1)).toMatchObject({ email: 'admin@example.test', purpose: 'login' });
    const deliveriesBeforeUnknown = delivered.messages.length;
    const unknownLogin = await fetch(`${base}/api/workspace/v1/login/request`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'unknown@example.test' }) });
    expect(unknownLogin.status).toBe(202);
    expect(delivered.messages).toHaveLength(deliveriesBeforeUnknown);

    expect((await fetch(`${base}/api/workspace/v1/session/revoke`, { method: 'POST', headers: { origin: 'https://workspace.example.test', cookie } })).status).toBe(403);
    expect((await fetch(`${base}/api/workspace/v1/session/revoke`, { method: 'POST', headers: { origin: 'https://workspace.example.test', cookie, 'x-csrf-token': confirmationBody.data.csrf_token } })).status).toBe(204);
    expect((await fetch(`${base}/app`, { headers: { cookie }, redirect: 'manual' })).status).toBe(303);
  });

  expect(await engine.executeRaw('SELECT event_id FROM workspace_audit_events')).toHaveLength(4);
  expect(await engine.executeRaw('SELECT event_id FROM workspace_change_events')).toHaveLength(2);
});

test('database singleton invariant prevents concurrent first-Administrator setup', async () => {
  const issue = async () => issueWorkspaceSetupToken(engine, 'setup');
  const [first, second] = await Promise.all([issue(), issue()]);
  const attempts = await Promise.allSettled([
    beginWorkspaceSetup(engine, first, 'Workspace One', 'one@example.test', 'req-one', 'secret'),
    beginWorkspaceSetup(engine, second, 'Workspace Two', 'two@example.test', 'req-two', 'secret'),
  ]);
  expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await engine.executeRaw('SELECT workspace_id FROM workspace_workspaces')).toHaveLength(1);
  const identities = await engine.executeRaw<{ normalized_email: string }>('SELECT normalized_email FROM workspace_identities');
  const pendingRecovery = await issueWorkspaceSetupToken(engine, 'recovery', { email: identities[0].normalized_email });
  await expect(redeemWorkspaceRecovery(engine, pendingRecovery, 'req-pending-recovery')).rejects.toThrow('membership_not_found');
  const firstConfirmation = attempts.find(result => result.status === 'fulfilled');
  if (!firstConfirmation || firstConfirmation.status !== 'fulfilled') throw new Error('expected one pending confirmation');
  const renewed = await renewWorkspaceConfirmation(engine, identities[0].normalized_email, 'req-concurrent-confirm', 'secret');
  const confirmations = await Promise.allSettled([
    confirmFirstAdministrator(engine, firstConfirmation.value.confirmationToken, 'req-confirm-a'),
    confirmFirstAdministrator(engine, renewed.confirmationToken, 'req-confirm-b'),
  ]);
  expect(confirmations.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await engine.executeRaw('SELECT session_hash FROM workspace_sessions')).toHaveLength(1);
});

test('active sessions observe role, membership, and revocation changes at the next authorization decision', async () => {
  const setupToken = await issueWorkspaceSetupToken(engine, 'setup');
  const pending = await beginWorkspaceSetup(
    engine,
    setupToken,
    'Authorization Workspace',
    'admin@example.test',
    'req-live-auth-setup',
    'workspace-token-secret-for-tests',
  );
  const auth = await confirmFirstAdministrator(engine, pending.confirmationToken, 'req-live-auth-confirm');
  const membership = await engine.executeRaw<{ membership_id: string }>(
    'SELECT membership_id FROM workspace_memberships',
  );
  const membershipId = membership[0]!.membership_id;

  expect(await authenticateWorkspaceSession(engine, auth.session)).toMatchObject({
    membership_id: membershipId,
    role: 'administrator',
  });
  await server(async (base, delivered) => {
    const cookie = `workspace_session=${auth.session}`;
    const readSession = () => fetch(`${base}/api/workspace/v1/session`, { headers: { cookie } });
    expect((await (await readSession()).json() as any).data.role).toBe('administrator');

    await engine.executeRaw(
      "UPDATE workspace_memberships SET role='member' WHERE membership_id=$1",
      [membershipId],
    );
    expect(await authenticateWorkspaceSession(engine, auth.session)).toMatchObject({ role: 'member' });
    expect((await (await readSession()).json() as any).data.role).toBe('member');

    await engine.executeRaw(
      "UPDATE workspace_memberships SET status='disabled' WHERE membership_id=$1",
      [membershipId],
    );
    expect(await authenticateWorkspaceSession(engine, auth.session)).toBeNull();
    expect((await readSession()).status).toBe(401);

    await engine.executeRaw(
      "UPDATE workspace_memberships SET status='active' WHERE membership_id=$1",
      [membershipId],
    );
    expect((await fetch(`${base}/api/workspace/v1/session/revoke`, {
      method: 'POST',
      headers: {
        cookie,
        origin: 'https://workspace.example.test',
        'x-csrf-token': auth.csrf,
      },
    })).status).toBe(204);
    expect(await authenticateWorkspaceSession(engine, auth.session)).toBeNull();
    expect((await readSession()).status).toBe(401);
  });
});

test('rejects cross-origin mutations and supports single-use recovery for the confirmed Administrator', async () => {
  await server(async (base, delivered) => {
    const crossOrigin = await fetch(`${base}/api/workspace/v1/operator/links`, { method: 'POST', headers: { origin: 'https://evil.example', authorization: 'Bootstrap bootstrap-test', 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'setup' }) });
    expect(crossOrigin.status).toBe(403);

    const setupToken = await issueWorkspaceSetupToken(engine, 'setup');
    const originalPending = await beginWorkspaceSetup(engine, setupToken, 'Recovery Workspace', 'admin@example.test', 'req-recovery-setup', 'workspace-token-secret-for-tests');
    const outboxLookup = await fetch(`${base}/api/workspace/v1/operator/outbox?request_id=req-recovery-setup`, { headers: { authorization: 'Bootstrap bootstrap-test' } });
    const queued = (await outboxLookup.json() as any).data;
    expect(queued).toHaveLength(1);
    const retry = await fetch(`${base}/api/workspace/v1/operator/outbox/${queued[0].delivery_key}/retry`, { method: 'POST', headers: { authorization: 'Bootstrap bootstrap-test' } });
    expect(retry.status).toBe(200);
    expect(delivered.token).toBeString();
    expect((await fetch(`${base}/api/workspace/v1/setup/confirm`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ token: delivered.token }) })).status).toBe(200);
    expect((await fetch(`${base}/api/workspace/v1/setup/confirm`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ token: originalPending.confirmationToken }) })).status).not.toBe(200);

    const recoveryResponse = await fetch(`${base}/api/workspace/v1/operator/links`, { method: 'POST', headers: { authorization: 'Bootstrap bootstrap-test', 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'recovery', email: 'admin@example.test' }) });
    const recoveryToken = (await recoveryResponse.json() as any).data.token;
    expect((await fetch(`${base}/api/workspace/v1/recovery/redeem`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ token: recoveryToken }) })).status).toBe(200);
    expect((await fetch(`${base}/api/workspace/v1/recovery/redeem`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ token: recoveryToken }) })).status).not.toBe(200);
  });
});

test('a login delivery failure stays enumeration-safe and marks the outbox row failed', async () => {
  const setupToken = await issueWorkspaceSetupToken(engine, 'setup');
  const pending = await beginWorkspaceSetup(engine, setupToken, 'Delivery Workspace', 'admin@example.test', 'req-delivery-setup', 'workspace-token-secret-for-tests');
  await confirmFirstAdministrator(engine, pending.confirmationToken, 'req-delivery-confirm');
  await server(async (base, delivered) => {
    delivered.failNextDelivery = true;
    const failed = await fetch(`${base}/api/workspace/v1/login/request`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test' }) });
    expect(failed.status).toBe(202);
    const outbox = await engine.executeRaw<{ delivery_state: string }>("SELECT delivery_state FROM workspace_email_outbox WHERE template='workspace_sign_in'");
    expect(outbox).toHaveLength(1);
    expect(outbox[0].delivery_state).toBe('failed');

    const retried = await fetch(`${base}/api/workspace/v1/login/request`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test' }) });
    expect(retried.status).toBe(202);
    expect(delivered.messages.at(-1)).toMatchObject({ email: 'admin@example.test', purpose: 'login' });
  });
});

test('membership administration is session, CSRF, and Administrator gated without leaking data', async () => {
  const setupToken = await issueWorkspaceSetupToken(engine, 'setup');
  const pending = await beginWorkspaceSetup(engine, setupToken, 'Members Workspace', 'admin@example.test', 'req-members-setup', 'secret');
  const admin = await confirmFirstAdministrator(engine, pending.confirmationToken, 'req-members-confirm');
  await server(async (base, delivered) => {
    const headers = { origin: 'https://workspace.example.test', cookie: `workspace_session=${admin.session}`, 'x-csrf-token': admin.csrf, 'content-type': 'application/json' };
    const invite = await fetch(`${base}/api/workspace/v1/invitations`, { method: 'POST', headers, body: JSON.stringify({ email: 'member@example.test', role: 'member', source_access: { mode: 'none' } }) });
    expect(invite.status).toBe(201);
    const invitationBody = await invite.json() as any;
    expect(JSON.stringify(invitationBody)).not.toContain(delivered.token!);
    expect(delivered.messages.at(-1)).toMatchObject({ email: 'member@example.test', purpose: 'invitation' });
    const token = delivered.token;
    const invitationPage = await (await fetch(`${base}/invitations/${encodeURIComponent(token!)}`)).text();
    expect(invitationPage).toContain('/api/workspace/v1/invitations/redeem');
    expect(invitationPage).toContain('type="email"');
    expect(invitationPage).not.toContain(`>${token}<`);
    const redemption = await fetch(`${base}/api/workspace/v1/invitations/redeem`, { method: 'POST', headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ token, email: 'member@example.test' }) });
    expect(redemption.status).toBe(200);
    const memberBody = await redemption.json() as any;
    const memberCookie = redemption.headers.get('set-cookie')!.split(';')[0];

    const adminLegacyEntry = await fetch(`${base}/admin`, {
      headers: { cookie: `workspace_session=${admin.session}` },
      redirect: 'manual',
    });
    expect(adminLegacyEntry.status).toBe(303);
    expect(adminLegacyEntry.headers.get('location')).toBe('/app/settings/members');
    const memberLegacyEntry = await fetch(`${base}/admin/agents`, {
      headers: { cookie: memberCookie },
      redirect: 'manual',
    });
    expect(memberLegacyEntry.status).toBe(303);
    expect(memberLegacyEntry.headers.get('location')).toBe('/app');

    const denied = await fetch(`${base}/api/workspace/v1/memberships`, { headers: { cookie: memberCookie } });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toContain('admin@example.test');
    const memberShell = await (await fetch(`${base}/app/settings/members`, { headers: { cookie: memberCookie } })).text();
    expect(memberShell).not.toContain('Members &amp; access');
    expect((await fetch(`${base}/app/settings/members`, { headers: { cookie: memberCookie } })).status).toBe(403);

    const listed = await fetch(`${base}/api/workspace/v1/memberships`, { headers: { cookie: `workspace_session=${admin.session}` } });
    expect(listed.status).toBe(200);
    const memberships = (await listed.json() as any).data;
    expect(memberships).toHaveLength(2);
    const invitedMember = memberships.find((membership: any) => membership.email === 'member@example.test');
    const adminSettings = await (await fetch(`${base}/app/settings/members`, { headers: { cookie: `workspace_session=${admin.session}` } })).text();
    expect(adminSettings).toContain('Send invitation');
    expect(adminSettings).toContain('member-role');
    expect(adminSettings).toContain('member-access');
    expect(adminSettings).toContain('Disable');
    expect(adminSettings).toContain('Select at least one Source.');
    expect(adminSettings).toContain("event.key==='Escape'");

    expect((await fetch(`${base}/api/workspace/v1/memberships/${invitedMember.membershipId}/role`, { method: 'PATCH', headers, body: JSON.stringify({ role: 'administrator', reason: 'Approved administrator' }) })).status).toBe(204);
    expect((await fetch(`${base}/api/workspace/v1/memberships/${invitedMember.membershipId}/source-access`, { method: 'PATCH', headers, body: JSON.stringify({ source_access: { mode: 'all' }, reason: 'Needs all sources' }) })).status).toBe(204);
    expect((await fetch(`${base}/api/workspace/v1/memberships/${invitedMember.membershipId}/status`, { method: 'PATCH', headers, body: JSON.stringify({ status: 'disabled', reason: 'Access paused' }) })).status).toBe(204);
    expect((await engine.executeRaw<{ action: string }>('SELECT action FROM workspace_audit_events WHERE target_id=$1 ORDER BY occurred_at', [invitedMember.membershipId])).map(row => row.action)).toEqual([
      'membership.role.change', 'membership.source_access.change', 'membership.status.change',
    ]);
    expect(memberBody.data.csrf_token).toBeString();
  });
});

test('setup tokens derived from an idempotency key are stable, scoped to the request, and unguessable without the secret', async () => {
  const secret = 'workspace-token-secret-for-tests';
  const first = await issueWorkspaceSetupToken(engine, 'setup', { idempotencyKey: 'ws-1', tokenSecret: secret });

  // Same request -> byte-identical token, and no second row.
  expect(await issueWorkspaceSetupToken(engine, 'setup', { idempotencyKey: 'ws-1', tokenSecret: secret })).toBe(first);
  expect(await engine.executeRaw('SELECT token_hash FROM workspace_setup_tokens')).toHaveLength(1);

  // Anything that makes it a different request makes it a different token.
  expect(await issueWorkspaceSetupToken(engine, 'setup', { idempotencyKey: 'ws-2', tokenSecret: secret })).not.toBe(first);
  expect(await issueWorkspaceSetupToken(engine, 'setup', { idempotencyKey: 'ws-1', tokenSecret: secret, email: 'admin@example.test' })).not.toBe(first);

  // Unguessability rests on the secret, not on the key.
  expect(await issueWorkspaceSetupToken(engine, 'setup', { idempotencyKey: 'ws-1', tokenSecret: 'a-different-secret' })).not.toBe(first);
  expect(issueWorkspaceSetupToken(engine, 'setup', { idempotencyKey: 'ws-1' })).rejects.toThrow('setup_token_secret_required');

  // A derived token is a real, redeemable setup token.
  expect((await inspectWorkspaceToken(engine, first, 'setup')).valid).toBe(true);

  // Omitting the key preserves random-token behaviour exactly.
  expect(await issueWorkspaceSetupToken(engine, 'setup')).not.toBe(await issueWorkspaceSetupToken(engine, 'setup'));
});

test('re-issuing a derived setup token refreshes an unconsumed link but never revives a consumed one', async () => {
  const secret = 'workspace-token-secret-for-tests';
  const issue = () => issueWorkspaceSetupToken(engine, 'setup', { idempotencyKey: 'ws-ttl', tokenSecret: secret });

  // A provision that stalls past the TTL must not hand out a token that is
  // already dead: the retry returns the same token, usable again.
  const token = await issue();
  await engine.executeRaw("UPDATE workspace_setup_tokens SET expires_at = now() - interval '1 minute'");
  expect((await inspectWorkspaceToken(engine, token, 'setup')).valid).toBe(false);
  expect(await issue()).toBe(token);
  expect((await inspectWorkspaceToken(engine, token, 'setup')).valid).toBe(true);
  expect(await engine.executeRaw('SELECT token_hash FROM workspace_setup_tokens')).toHaveLength(1);

  // Single use still wins: once consumed, no amount of re-issuing brings it back.
  await engine.executeRaw('UPDATE workspace_setup_tokens SET consumed_at = now()');
  expect(await issue()).toBe(token);
  expect((await inspectWorkspaceToken(engine, token, 'setup')).valid).toBe(false);
});

test('the operator links endpoint returns the same link for a repeated idempotency key and refuses an unusable one', async () => {
  await server(async base => {
    const issue = (body: Record<string, unknown>) =>
      fetch(`${base}/api/workspace/v1/operator/links`, {
        method: 'POST',
        headers: { authorization: 'Bootstrap bootstrap-test', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const tokenOf = async (response: Response) => (await response.json() as any).data.token;

    const first = await issue({ purpose: 'setup', idempotency_key: 'workspace-1' });
    const retry = await issue({ purpose: 'setup', idempotency_key: 'workspace-1' });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    const link = await tokenOf(first);
    expect(await tokenOf(retry)).toBe(link);
    expect(await engine.executeRaw('SELECT token_hash FROM workspace_setup_tokens')).toHaveLength(1);

    expect(await tokenOf(await issue({ purpose: 'setup', idempotency_key: 'workspace-2' }))).not.toBe(link);
    expect(await tokenOf(await issue({ purpose: 'setup' }))).not.toBe(await tokenOf(await issue({ purpose: 'setup' })));

    // Present but unusable: a clean refusal, never a 500.
    expect((await issue({ purpose: 'setup', idempotency_key: '' })).status).toBe(400);
    expect((await issue({ purpose: 'setup', idempotency_key: 42 })).status).toBe(400);
    expect((await issue({ purpose: 'setup', idempotency_key: 'k'.repeat(201) })).status).toBe(400);
  });
});
