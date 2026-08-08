/**
 * #51: client mistakes on the workspace auth/membership endpoints must
 * refuse with typed 4xx envelopes (retryable: false), never leak through
 * the generic handler as 500 internal_error (retryable: true).
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import type { WorkspaceEmailMessage } from '../src/workspace/email-delivery.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' }); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetWorkspaceFoundationForTest(engine); await initializeWorkspaceFoundation(engine); });

const ORIGIN = 'https://workspace.example.test';

async function server(run: (base: string, delivered: { token?: string; messages: WorkspaceEmailMessage[] }) => Promise<void>) {
  const app = express();
  const delivered: { token?: string; messages: WorkspaceEmailMessage[] } = { messages: [] };
  app.use(createWorkspaceRouter(engine, {
    bootstrapCredential: 'bootstrap-test',
    tokenSecret: 'workspace-token-secret-for-tests',
    allowedOrigin: ORIGIN,
    requestId: () => 'req-refusals',
    deliverConfirmation: async message => { delivered.token = message.token; delivered.messages.push({ ...message }); },
  }));
  const listener = await new Promise<Server>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  try { await run(`http://127.0.0.1:${address.port}`, delivered); } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
}

/** Run the real bootstrap → setup → confirm flow; returns an authenticated admin. */
async function establishAdmin(base: string, delivered: { token?: string }): Promise<{ cookie: string; csrf: string; workspaceId: string }> {
  const issue = await fetch(`${base}/api/workspace/v1/operator/links`, { method: 'POST', headers: { authorization: 'Bootstrap bootstrap-test', 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'setup' }) });
  const setupToken = (await issue.json() as any).data.token;
  const setup = await fetch(`${base}/api/workspace/v1/setup`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ token: setupToken, workspace_name: 'Refusal Test', administrator_email: 'admin@example.test' }) });
  expect(setup.status).toBe(202);
  const confirmed = await fetch(`${base}/api/workspace/v1/setup/confirm`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ token: delivered.token }) });
  expect(confirmed.status).toBe(200);
  const csrf = ((await confirmed.json()) as any).data.csrf_token as string;
  const cookie = confirmed.headers.get('set-cookie')!.split(';')[0]!;
  const rows = await engine.executeRaw<{ workspace_id: string }>('SELECT workspace_id FROM workspace_workspaces');
  return { cookie, csrf, workspaceId: rows[0]!.workspace_id };
}

/** Insert a plain member the admin can PATCH. */
async function seedMember(workspaceId: string): Promise<string> {
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-member', 'member@example.test', now())");
  await engine.executeRaw(
    "INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', $1, 'identity-member', 'member')",
    [workspaceId],
  );
  return 'member-1';
}

function adminHeaders(cookie: string, csrf: string): Record<string, string> {
  return { origin: ORIGIN, 'content-type': 'application/json', cookie, 'x-csrf-token': csrf };
}

test('setup/confirm with an unknown token refuses with a typed envelope, not internal_error', async () => {
  await server(async base => {
    const res = await fetch(`${base}/api/workspace/v1/setup/confirm`, {
      method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'bogus-token' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_token');
    expect(body.error.retryable).toBe(false);
    expect(body.error.request_id).toBeString();
  });
});

test('source-access PATCH with a malformed body refuses as invalid_request', async () => {
  await server(async (base, delivered) => {
    const admin = await establishAdmin(base, delivered);
    const memberId = await seedMember(admin.workspaceId);
    // Body missing the source_access wrapper entirely (reason present, so the
    // failure isolates to body shape).
    const res = await fetch(`${base}/api/workspace/v1/memberships/${memberId}/source-access`, {
      method: 'PATCH', headers: adminHeaders(admin.cookie, admin.csrf), body: JSON.stringify({ mode: 'none', reason: 'cleanup' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.retryable).toBe(false);
  });
});

test('source-access PATCH without a reason refuses as reason_required', async () => {
  await server(async (base, delivered) => {
    const admin = await establishAdmin(base, delivered);
    const memberId = await seedMember(admin.workspaceId);
    const res = await fetch(`${base}/api/workspace/v1/memberships/${memberId}/source-access`, {
      method: 'PATCH', headers: adminHeaders(admin.cookie, admin.csrf), body: JSON.stringify({ source_access: { mode: 'none' } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe('reason_required');
    expect(body.error.retryable).toBe(false);
  });
});

test('source-access PATCH for an unknown membership refuses as not_found', async () => {
  await server(async (base, delivered) => {
    const admin = await establishAdmin(base, delivered);
    const res = await fetch(`${base}/api/workspace/v1/memberships/no-such-membership/source-access`, {
      method: 'PATCH', headers: adminHeaders(admin.cookie, admin.csrf), body: JSON.stringify({ source_access: { mode: 'none' }, reason: 'cleanup' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json() as any;
    expect(body.error.code).toBe('not_found');
    expect(body.error.resource).toBe('membership');
    expect(body.error.retryable).toBe(false);
  });
});
