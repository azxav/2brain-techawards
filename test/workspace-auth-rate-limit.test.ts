import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { createWorkspaceRouter, type WorkspaceRouterOptions } from '../src/web/workspace-router.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' }); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetWorkspaceFoundationForTest(engine); await initializeWorkspaceFoundation(engine); });

async function server(options: WorkspaceRouterOptions, run: (base: string) => Promise<void>) {
  const app = express();
  app.use(createWorkspaceRouter(engine, {
    bootstrapCredential: 'bootstrap-test',
    tokenSecret: 'workspace-token-secret-for-tests',
    allowedOrigin: 'https://workspace.example.test',
    requestId: () => 'req-rate-limit',
    deliverConfirmation: async () => {},
    ...options,
  }));
  const listener = await new Promise<Server>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  try { await run(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
}

const loginRequest = (base: string) => fetch(`${base}/api/workspace/v1/login/request`, {
  method: 'POST',
  headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'unknown@example.test' }),
});

test('requests beyond the per-IP threshold are refused with the Workspace error envelope', async () => {
  await server({ authRateLimit: { limit: 3, windowMs: 60_000 } }, async base => {
    for (let i = 0; i < 3; i++) expect((await loginRequest(base)).status).toBe(202);
    const refused = await loginRequest(base);
    expect(refused.status).toBe(429);
    const body = await refused.json() as any;
    expect(body).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many Workspace authentication requests were made.',
        recovery: 'Wait before trying again.',
        retryable: true,
        request_id: 'req-rate-limit',
        occurred_at: expect.any(String),
        resource: 'login',
      },
    });
    expect(Number.isNaN(Date.parse(body.error.occurred_at))).toBe(false);
  });
});

test('the authentication surface shares one per-IP budget across endpoints', async () => {
  await server({ authRateLimit: { limit: 3, windowMs: 60_000 } }, async base => {
    for (let i = 0; i < 3; i++) expect((await loginRequest(base)).status).toBe(202);
    // Exhausted budget refuses every other authentication endpoint too.
    const setup = await fetch(`${base}/api/workspace/v1/setup`, {
      method: 'POST',
      headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'whatever', workspace_name: 'Acme Example', administrator_email: 'admin@example.test' }),
    });
    expect(setup.status).toBe(429);
    const redeem = await fetch(`${base}/api/workspace/v1/login/redeem`, {
      method: 'POST',
      headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'whatever' }),
    });
    expect(redeem.status).toBe(429);
    const operator = await fetch(`${base}/api/workspace/v1/operator/links`, {
      method: 'POST',
      headers: { authorization: 'Bootstrap bootstrap-test', 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'setup' }),
    });
    expect(operator.status).toBe(429);
  });
});

test('requests below the threshold behave normally and non-auth routes stay unaffected', async () => {
  await server({ authRateLimit: { limit: 3, windowMs: 60_000 } }, async base => {
    for (let i = 0; i < 3; i++) expect((await loginRequest(base)).status).toBe(202);
    // Exhausted auth budget does not touch the rest of the Workspace surface.
    expect((await fetch(`${base}/login`)).status).toBe(200);
    expect((await fetch(`${base}/api/workspace/v1/session`)).status).toBe(401);
  });
});

test('default limits leave the legitimate setup-to-login journey untouched', async () => {
  await server({}, async base => {
    const issue = await fetch(`${base}/api/workspace/v1/operator/links`, {
      method: 'POST',
      headers: { authorization: 'Bootstrap bootstrap-test', 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'setup' }),
    });
    expect(issue.status).toBe(201);
    const setupToken = (await issue.json() as any).data.token;
    const setup = await fetch(`${base}/api/workspace/v1/setup`, {
      method: 'POST',
      headers: { origin: 'https://workspace.example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ token: setupToken, workspace_name: 'Acme Example', administrator_email: 'admin@example.test' }),
    });
    expect(setup.status).toBe(202);
    expect((await loginRequest(base)).status).toBe(202);
  });
});
