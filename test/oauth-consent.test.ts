/**
 * Session-gated OAuth consent seam (#47).
 *
 * A hosted Workspace exposes /mcp with OAuth 2.1 bearer verification, but no
 * credential may be minted without an authenticated Member's consent. These
 * tests exercise the workspace HTTP seam end-to-end on PGLite:
 *
 *   - /authorize without a Workspace Session is refused (no code minted)
 *   - consent mints a code -> token /mcp accepts
 *   - the token's authorization context follows the Member's CURRENT grants
 *   - Connected Apps list/revoke round-trip ends access immediately
 *
 * App assembly mirrors serve-http.ts composition: consent router intercepts
 * /authorize ahead of the SDK's mcpAuthRouter; /mcp uses the same
 * requireBearerAuth + dispatchToolCall pipeline.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import express, { type Express } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { createOauthConsentRouter } from '../src/web/oauth-consent.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { authorizationFromAuthInfo } from '../src/workspace/authorization-context.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';

let engine: PGLiteEngine;
let provider: GBrainOAuthProvider;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function withServer(app: Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose an address.');
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

/**
 * The consent seam spans the Workspace foundation AND a slice of core brain
 * schema (OAuth tables, sources, pages). The foundation initializer demands a
 * clean database, so it runs first (beforeAll) and the core slice is created
 * afterwards with the same column shapes the engine queries use.
 */
async function createCoreTables(): Promise<void> {
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    client_name TEXT NOT NULL,
    redirect_uris TEXT[],
    grant_types TEXT[] DEFAULT '{"client_credentials"}',
    scope TEXT,
    token_endpoint_auth_method TEXT,
    client_id_issued_at BIGINT,
    client_secret_expires_at BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_id TEXT,
    federated_read TEXT[] NOT NULL DEFAULT '{}',
    deleted_at TIMESTAMPTZ,
    token_ttl BIGINT
  )`);
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS oauth_tokens (
    token_hash TEXT PRIMARY KEY,
    token_type TEXT NOT NULL,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    scopes TEXT[],
    expires_at BIGINT,
    resource TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    membership_id TEXT
  )`);
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    scopes TEXT[],
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL DEFAULT 'S256',
    redirect_uri TEXT NOT NULL,
    state TEXT,
    resource TEXT,
    expires_at BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    membership_id TEXT
  )`);
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS workspace_connected_app_policies (
    membership_id TEXT NOT NULL,
    client_id TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    configured_access_level TEXT NOT NULL DEFAULT 'read'
      CHECK (configured_access_level IN ('read', 'write', 'admin')),
    connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (membership_id, client_id)
  )`);
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    archived BOOLEAN NOT NULL DEFAULT FALSE
  )`);
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS pages (
    id SERIAL PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id),
    slug TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'document',
    title TEXT NOT NULL,
    compiled_truth TEXT NOT NULL DEFAULT '',
    timeline JSONB,
    frontmatter JSONB NOT NULL DEFAULT '{}',
    content_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    source_kind TEXT,
    source_uri TEXT,
    ingested_via TEXT,
    ingested_at TIMESTAMPTZ,
    UNIQUE (source_id, slug)
  )`);
  await engine.executeRaw(`CREATE TABLE IF NOT EXISTS tags (
    id SERIAL PRIMARY KEY,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    UNIQUE(page_id, tag)
  )`);
}

/** Seed one Workspace with an administrator + member, sessions for both. */
async function seedWorkspace(): Promise<void> {
  await engine.executeRaw(
    "INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Consent Test Workspace', now())",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-admin', 'admin@example.test', now()), ('identity-member', 'member@example.test', now())",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('admin-1', 'workspace-1', 'identity-admin', 'administrator'), ('member-1', 'workspace-1', 'identity-member', 'member')",
  );
  await engine.executeRaw(`INSERT INTO workspace_sessions
    (session_hash, membership_id, csrf_hash, expires_at)
    VALUES ($1, 'admin-1', $2, now() + interval '1 day'),
           ($3, 'member-1', $4, now() + interval '1 day')`,
    [digest('admin-session'), digest('admin-csrf'), digest('member-session'), digest('member-csrf')]);
  await engine.executeRaw(
    "INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'admin-1', 'specific'), ('member', 'member-1', 'specific')",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', 'admin-1', 'allowed-source'), ('member', 'member-1', 'allowed-source')",
  );
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('allowed-source', 'Allowed'), ('denied-source', 'Denied')");
  await engine.executeRaw(
    "INSERT INTO pages (source_id, slug, title, compiled_truth) VALUES ('allowed-source', 'handbook', 'Team handbook', 'Trusted text'), ('denied-source', 'private-plan', 'Private plan', 'Secret')",
  );
}

function buildApp(): Express {
  const app = express();
  app.use(createWorkspaceRouter(engine, {
    allowedOrigin: 'https://workspace.example.test',
    requestId: () => 'req-oauth-consent',
  }));
  app.use(createOauthConsentRouter(engine, provider, {
    allowedOrigin: 'https://workspace.example.test',
  }));
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL('https://workspace.example.test'),
    resourceName: 'GBrain MCP Server',
  } as Parameters<typeof mcpAuthRouter>[0]));
  // Same seam serve-http.ts uses: bearer verification then dispatch with the
  // canonical authorization contract. Probe accepts {name, params} JSON.
  app.post('/mcp', requireBearerAuth({ verifier: provider }), express.json(), async (req, res) => {
    const authInfo = (req as unknown as { auth: AuthInfo }).auth;
    const result = await dispatchToolCall(engine, req.body.name, req.body.params, {
      authorization: authorizationFromAuthInfo(authInfo),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    res.status(200).json(result);
  });
  return app;
}

async function registerPublicClient(
  name = 'ChatGPT Connector',
  scope = 'read write',
): Promise<{ clientId: string; redirectUri: string }> {
  const redirectUri = 'https://client.example.test/callback';
  const registered = await provider.clientsStore.registerClient!({
    client_name: name,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    scope,
    token_endpoint_auth_method: 'none',
  } as Parameters<NonNullable<typeof provider.clientsStore.registerClient>>[0]);
  return { clientId: registered.client_id, redirectUri };
}

/** #52 shape: real connectors (ChatGPT confirmed) omit `scope` entirely at DCR time. */
async function registerClientWithoutScope(name = 'ChatGPT Connector'): Promise<{ clientId: string; redirectUri: string }> {
  const redirectUri = 'https://client.example.test/callback';
  const registered = await provider.clientsStore.registerClient!({
    client_name: name,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none',
  } as Parameters<NonNullable<typeof provider.clientsStore.registerClient>>[0]);
  return { clientId: registered.client_id, redirectUri };
}

// PKCE pair (S256). Verifier is fixed; challenge = BASE64URL(SHA256(verifier)).
const PKCE_VERIFIER = 'consent-test-verifier-0123456789-0123456789-0123456789';
const PKCE_CHALLENGE = createHash('sha256').update(PKCE_VERIFIER).digest('base64url');

function authorizeUrl(baseUrl: string, clientId: string, redirectUri: string, extra: Record<string, string> = {}): string {
  const url = new URL('/authorize', baseUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('code_challenge', PKCE_CHALLENGE);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', 'state-123');
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.toString();
}

function decisionBody(clientId: string, redirectUri: string, decision: 'approve' | 'deny', extra: Record<string, string> = {}): string {
  const body = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'read write',
    state: 'state-123',
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: 'S256',
    decision,
    ...extra,
  });
  return body.toString();
}

/** Consent-approve as the given session and redeem the code for tokens at /token. */
async function consentedTokens(
  baseUrl: string,
  clientId: string,
  redirectUri: string,
  session: string,
  extra: Record<string, string> = {},
): Promise<{ access_token: string; refresh_token?: string; scope: string }> {
  const decision = await fetch(`${baseUrl}/authorize/decision`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `workspace_session=${session}`,
    },
    body: decisionBody(clientId, redirectUri, 'approve', extra),
  });
  expect(decision.status).toBe(302);
  const location = new URL(decision.headers.get('location')!);
  expect(location.origin + location.pathname).toBe(redirectUri);
  const code = location.searchParams.get('code');
  expect(code).toBeTruthy();
  expect(location.searchParams.get('state')).toBe('state-123');

  const tokenResponse = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: PKCE_VERIFIER,
      client_id: clientId,
      redirect_uri: redirectUri,
    }).toString(),
  });
  expect(tokenResponse.status).toBe(200);
  return await tokenResponse.json() as { access_token: string; refresh_token?: string; scope: string };
}

async function mcpCall(baseUrl: string, token: string, name: string, params: Record<string, unknown>): Promise<{ status: number; body: { isError?: boolean; content: { text: string }[] } }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, params }),
  });
  const body = response.status === 200 ? await response.json() : { content: [] };
  return { status: response.status, body: body as { isError?: boolean; content: { text: string }[] } };
}

async function mcpGetPage(baseUrl: string, token: string, slug: string): Promise<{ status: number; body: { isError?: boolean; content: { text: string }[] } }> {
  return mcpCall(baseUrl, token, 'get_page', { slug });
}

async function countCodes(): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM oauth_codes');
  return Number(rows[0].n);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  // Foundation first: its initializer refuses a database that already holds
  // non-workspace tables, so the core slice is created after it.
  await initializeWorkspaceFoundation(engine);
  await createCoreTables();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('TRUNCATE TABLE workspace_audit_events, workspace_change_events CASCADE');
  for (const table of [
    'oauth_tokens', 'oauth_codes', 'workspace_connected_app_policies', 'oauth_clients', 'pages', 'sources',
    'workspace_sessions', 'workspace_source_grants', 'workspace_principal_source_policies',
    'workspace_memberships', 'workspace_identities', 'workspace_workspaces',
  ]) {
    await engine.executeRaw(`DELETE FROM ${table}`);
  }
  provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });
  await seedWorkspace();
});

describe('session-gated OAuth consent (#47)', () => {
  test('GET /authorize without a Workspace Session is refused and mints no code', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const response = await fetch(authorizeUrl(baseUrl, clientId, redirectUri), { redirect: 'manual' });
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/login');
    });
    expect(await countCodes()).toBe(0);
  });

  test('GET /authorize with a session renders consent naming the Connector Client', async () => {
    const { clientId, redirectUri } = await registerPublicClient('Perplexity Connector', 'read');
    await withServer(buildApp(), async baseUrl => {
      const response = await fetch(authorizeUrl(baseUrl, clientId, redirectUri), {
        redirect: 'manual',
        headers: { cookie: 'workspace_session=admin-session' },
      });
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('Perplexity Connector');
      expect(html).toContain('Consent Test Workspace');
      expect(html).toContain('name="access_level"');
      expect(html).toMatch(/value="read"[^>]*selected/);
      expect(html).toMatch(/value="admin"[^>]*disabled/);
      expect(html).toContain('unavailable because of this client registration');
      expect(html).not.toContain('unavailable for your Workspace role or this client registration');
      const formStart = html.indexOf('<form method="post" action="/authorize/decision">');
      const selector = html.indexOf('name="access_level"');
      const formEnd = html.indexOf('</form>', formStart);
      expect(selector).toBeGreaterThan(formStart);
      expect(selector).toBeLessThan(formEnd);
    });
    // Rendering consent must not mint anything yet.
    expect(await countCodes()).toBe(0);
  });

  test('GET /authorize refuses an unregistered redirect_uri without redirecting', async () => {
    const { clientId } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const response = await fetch(
        authorizeUrl(baseUrl, clientId, 'https://attacker.example.test/steal'),
        { redirect: 'manual', headers: { cookie: 'workspace_session=admin-session' } },
      );
      expect(response.status).toBe(400);
    });
  });

  test('approval mints a token /mcp accepts, scoped to the Member\'s current grants', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session');

      const allowed = await mcpGetPage(baseUrl, tokens.access_token, 'handbook');
      expect(allowed.status).toBe(200);
      expect(allowed.body.isError).toBeFalsy();
      expect(allowed.body.content[0]!.text).toContain('Team handbook');

      // Out-of-grant content stays invisible.
      const denied = await mcpGetPage(baseUrl, tokens.access_token, 'private-plan');
      expect(JSON.stringify(denied.body)).not.toContain('Secret');

      // Grant removal is effective on the NEXT request — no re-consent, no snapshot.
      await engine.executeRaw("DELETE FROM workspace_source_grants WHERE principal_id = 'admin-1'");
      const afterRemoval = await mcpGetPage(baseUrl, tokens.access_token, 'handbook');
      expect(afterRemoval.body.isError).toBe(true);
      expect(afterRemoval.body.content[0]!.text).toContain('permission_denied');

      // Restoring the grant restores access with the same token.
      await engine.executeRaw(
        "INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', 'admin-1', 'allowed-source')",
      );
      const restored = await mcpGetPage(baseUrl, tokens.access_token, 'handbook');
      expect(restored.body.isError).toBeFalsy();
    });
  });

  test('denial redirects with access_denied and mints nothing', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const response = await fetch(`${baseUrl}/authorize/decision`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'workspace_session=admin-session',
        },
        body: decisionBody(clientId, redirectUri, 'deny'),
      });
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location')!);
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.get('state')).toBe('state-123');
    });
    expect(await countCodes()).toBe(0);
  });

  test('consent decision without a session or from a foreign origin is refused', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const anonymous = await fetch(`${baseUrl}/authorize/decision`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: decisionBody(clientId, redirectUri, 'approve'),
      });
      expect(anonymous.status).toBe(303);
      expect(anonymous.headers.get('location')).toBe('/login');

      const crossOrigin = await fetch(`${baseUrl}/authorize/decision`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'workspace_session=admin-session',
          origin: 'https://evil.example.test',
        },
        body: decisionBody(clientId, redirectUri, 'approve'),
      });
      expect(crossOrigin.status).toBe(403);
    });
    expect(await countCodes()).toBe(0);
  });

  test('disabling the consenting membership invalidates outstanding tokens', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session');
      expect((await mcpGetPage(baseUrl, tokens.access_token, 'handbook')).status).toBe(200);

      await engine.executeRaw("UPDATE workspace_memberships SET status = 'disabled' WHERE membership_id = 'admin-1'");
      const refused = await mcpGetPage(baseUrl, tokens.access_token, 'handbook');
      expect(refused.status).toBe(401);
    });
  });

  test('new consent defaults to Read while a Member may explicitly select Write', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const defaultTokens = await consentedTokens(baseUrl, clientId, redirectUri, 'member-session');
      expect(defaultTokens.scope).toBe('read');

      const writeTokens = await consentedTokens(baseUrl, clientId, redirectUri, 'member-session', {
        access_level: 'write',
      });
      expect(writeTokens.scope).toBe('write');
    });
  });

  test('Administrator consent exposes Admin only when the client ceiling permits it', async () => {
    const { clientId, redirectUri } = await registerPublicClient('Admin Connector', 'read write admin');
    await withServer(buildApp(), async baseUrl => {
      const page = await fetch(authorizeUrl(baseUrl, clientId, redirectUri), {
        redirect: 'manual',
        headers: { cookie: 'workspace_session=admin-session' },
      });
      const html = await page.text();
      expect(html).toMatch(/value="admin"(?![^>]*disabled)/);

      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', {
        scope: 'read write admin',
        access_level: 'admin',
      });
      expect(tokens.scope).toBe('admin');
    });
  });

  test('Member consent identifies the Membership role as the Admin limiter', async () => {
    const { clientId, redirectUri } = await registerPublicClient('Member Connector', 'admin');
    await withServer(buildApp(), async baseUrl => {
      const page = await fetch(authorizeUrl(baseUrl, clientId, redirectUri), {
        redirect: 'manual',
        headers: { cookie: 'workspace_session=member-session' },
      });
      const html = await page.text();
      expect(html).toMatch(/value="admin"[^>]*disabled/);
      expect(html).toContain('unavailable for the Member role');
      expect(html).not.toContain('unavailable because of this client registration');
    });
  });

  test('invalid or unavailable access selection refuses without mutating policy or codes', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const response = await fetch(`${baseUrl}/authorize/decision`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'workspace_session=member-session',
        },
        body: decisionBody(clientId, redirectUri, 'approve', { access_level: 'admin' }),
      });
      expect(response.status).toBe(400);
    });
    expect(await countCodes()).toBe(0);
    expect(await engine.executeRaw('SELECT 1 FROM workspace_connected_app_policies')).toEqual([]);
  });

  test('re-consent changes configured access while preserving the original connected_at', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', { access_level: 'write' });
      const before = await engine.executeRaw<{ connected_at: Date }>(`SELECT connected_at
        FROM workspace_connected_app_policies WHERE membership_id = 'admin-1' AND client_id = $1`, [clientId]);

      await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', { access_level: 'read' });
      const after = await engine.executeRaw<{ configured_access_level: string; connected_at: Date }>(`SELECT
        configured_access_level, connected_at FROM workspace_connected_app_policies
        WHERE membership_id = 'admin-1' AND client_id = $1`, [clientId]);
      expect(after[0]!.configured_access_level).toBe('read');
      expect(new Date(after[0]!.connected_at).toISOString()).toBe(new Date(before[0]!.connected_at).toISOString());
    });
  });

  test('authorization-code exchange clamps the credential to the current policy', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const decision = await fetch(`${baseUrl}/authorize/decision`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: 'workspace_session=admin-session',
        },
        body: decisionBody(clientId, redirectUri, 'approve', { access_level: 'write' }),
      });
      expect(decision.status).toBe(302);
      const code = new URL(decision.headers.get('location')!).searchParams.get('code');
      expect(code).toBeTruthy();

      await engine.executeRaw(`UPDATE workspace_connected_app_policies
        SET configured_access_level = 'read' WHERE membership_id = 'admin-1' AND client_id = $1`, [clientId]);

      const tokenResponse = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          code_verifier: PKCE_VERIFIER,
          client_id: clientId,
          redirect_uri: redirectUri,
        }).toString(),
      });
      expect(tokenResponse.status).toBe(200);
      expect(((await tokenResponse.json()) as { scope: string }).scope).toBe('read');
    });
  });

  test('an existing credential is clamped by policy on its next use and missing policy fails closed', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', {
        access_level: 'write',
      });
      expect((await mcpCall(baseUrl, tokens.access_token, 'add_tag', {
        slug: 'handbook', tag: 'before-downgrade', source_id: 'allowed-source',
      })).body.isError).toBeFalsy();

      await engine.executeRaw(`UPDATE workspace_connected_app_policies
        SET configured_access_level = 'read' WHERE membership_id = 'admin-1' AND client_id = $1`, [clientId]);
      const downgraded = await mcpCall(baseUrl, tokens.access_token, 'add_tag', {
        slug: 'handbook', tag: 'after-downgrade', source_id: 'allowed-source',
      });
      expect(downgraded.body.isError).toBe(true);
      expect(downgraded.body.content[0]!.text).toContain('insufficient_scope');

      await engine.executeRaw(`DELETE FROM workspace_connected_app_policies
        WHERE membership_id = 'admin-1' AND client_id = $1`, [clientId]);
      expect((await mcpGetPage(baseUrl, tokens.access_token, 'handbook')).status).toBe(401);
    });
  });

  test('refresh rotation cannot widen past the live policy', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', {
        access_level: 'write',
      });
      await engine.executeRaw(`UPDATE workspace_connected_app_policies
        SET configured_access_level = 'read' WHERE membership_id = 'admin-1' AND client_id = $1`, [clientId]);
      const response = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token!,
          client_id: clientId,
        }).toString(),
      });
      expect(response.status).toBe(200);
      expect(((await response.json()) as { scope: string }).scope).toBe('read');
    });
  });

  test('Administrator consent for omitted-scope DCR defaults to Read with Admin available', async () => {
    const { clientId, redirectUri } = await registerClientWithoutScope();
    await withServer(buildApp(), async baseUrl => {
      const response = await fetch(authorizeUrl(baseUrl, clientId, redirectUri), {
        redirect: 'manual',
        headers: { cookie: 'workspace_session=admin-session' },
      });
      const html = await response.text();
      expect(html).toMatch(/value="read"[^>]*selected/);
      expect(html).toMatch(/value="write"(?![^>]*disabled)/);
      expect(html).toMatch(/value="admin"(?![^>]*disabled)/);

      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session');
      expect(tokens.scope).toBe('read');
      const page = await mcpGetPage(baseUrl, tokens.access_token, 'handbook');
      expect(page.status).toBe(200);
      expect(page.body.isError).toBeFalsy();
      expect(page.body.content[0]!.text).toContain('Team handbook');
    });
  });

  test('Member consent for omitted-scope DCR permits Write but explains the Admin role ceiling', async () => {
    const { clientId, redirectUri } = await registerClientWithoutScope('Member Connector');
    await withServer(buildApp(), async baseUrl => {
      const response = await fetch(authorizeUrl(baseUrl, clientId, redirectUri), {
        redirect: 'manual',
        headers: { cookie: 'workspace_session=member-session' },
      });
      const html = await response.text();
      expect(html).toMatch(/value="write"(?![^>]*disabled)/);
      expect(html).toMatch(/value="admin"[^>]*disabled/);
      expect(html).toContain('unavailable for the Member role');

      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'member-session', {
        scope: 'write',
        access_level: 'write',
      });
      expect(tokens.scope).toBe('write');
    });
  });

  test('higher re-consent does not widen historical access or refresh credentials', async () => {
    const { clientId, redirectUri } = await registerClientWithoutScope('Reconsent Connector');
    await withServer(buildApp(), async baseUrl => {
      const original = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session');
      expect(original.scope).toBe('read');

      const elevated = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', {
        scope: 'admin',
        access_level: 'admin',
      });
      expect(elevated.scope).toBe('admin');

      expect((await provider.verifyAccessToken(original.access_token)).scopes).toEqual(['read']);
      expect((await provider.verifyAccessToken(elevated.access_token)).scopes).toEqual(['admin']);

      const client = (await provider.clientsStore.getClient(clientId))!;
      const rotated = await provider.exchangeRefreshToken(client, original.refresh_token!);
      expect(rotated.scope).toBe('read');
    });
  });

  test('targeted legacy reconnect replaces only the selected Read registration', async () => {
    const legacy = await registerPublicClient('Legacy Connector', 'read');
    const explicitRead = await registerPublicClient('Explicit Read Connector', 'read');
    await withServer(buildApp(), async baseUrl => {
      const legacyTokens = await consentedTokens(
        baseUrl, legacy.clientId, legacy.redirectUri, 'admin-session', { scope: 'read' },
      );
      await consentedTokens(
        baseUrl, explicitRead.clientId, explicitRead.redirectUri, 'admin-session', { scope: 'read' },
      );

      await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id = $1', [legacy.clientId]);
      expect(await engine.executeRaw(
        'SELECT 1 FROM workspace_connected_app_policies WHERE client_id = $1', [legacy.clientId],
      )).toEqual([]);
      expect(await engine.executeRaw(
        'SELECT 1 FROM oauth_tokens WHERE client_id = $1', [legacy.clientId],
      )).toEqual([]);
      await expect(provider.verifyAccessToken(legacyTokens.access_token)).rejects.toThrow();
      expect((await provider.clientsStore.getClient(explicitRead.clientId))?.scope).toBe('read');

      const fresh = await registerClientWithoutScope('Reconnected Connector');
      const freshTokens = await consentedTokens(
        baseUrl, fresh.clientId, fresh.redirectUri, 'admin-session',
        { scope: 'admin', access_level: 'admin' },
      );
      expect(freshTokens.scope).toBe('admin');
    });
  });

  test('Connected Apps lists the consented Connector Client and revoke ends access immediately', async () => {
    const { clientId, redirectUri } = await registerPublicClient('Claude Connector');
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', { access_level: 'write' });
      expect((await mcpGetPage(baseUrl, tokens.access_token, 'handbook')).status).toBe(200);

      const listResponse = await fetch(`${baseUrl}/api/workspace/v1/connected-apps`, {
        headers: { cookie: 'workspace_session=admin-session' },
      });
      expect(listResponse.status).toBe(200);
      const listed = await listResponse.json() as { data: {
        client_id: string;
        client_name: string;
        connected_at: string;
        configured_access_level: string;
        effective_access_level: string;
      }[] };
      expect(listed.data).toHaveLength(1);
      expect(listed.data[0]!.client_id).toBe(clientId);
      expect(listed.data[0]!.client_name).toBe('Claude Connector');
      expect(listed.data[0]!.connected_at).toBeTruthy();
      expect(listed.data[0]!.configured_access_level).toBe('write');
      expect(listed.data[0]!.effective_access_level).toBe('write');

      // Another member sees nothing (member-own view only).
      const otherList = await fetch(`${baseUrl}/api/workspace/v1/connected-apps`, {
        headers: { cookie: 'workspace_session=member-session' },
      });
      expect(((await otherList.json()) as { data: unknown[] }).data).toHaveLength(0);

      const revoke = await fetch(`${baseUrl}/api/workspace/v1/connected-apps/${clientId}`, {
        method: 'DELETE',
        headers: {
          cookie: 'workspace_session=admin-session',
          'x-csrf-token': 'admin-csrf',
          origin: 'https://workspace.example.test',
        },
      });
      expect(revoke.status).toBe(200);

      const afterRevoke = await mcpGetPage(baseUrl, tokens.access_token, 'handbook');
      expect(afterRevoke.status).toBe(401);

      const relisted = await fetch(`${baseUrl}/api/workspace/v1/connected-apps`, {
        headers: { cookie: 'workspace_session=admin-session' },
      });
      expect(((await relisted.json()) as { data: unknown[] }).data).toHaveLength(0);
    });
  });

  test('Connected Apps API enforces ownership, Administrator audit, CSRF, and stale-update refusal', async () => {
    const { clientId, redirectUri } = await registerPublicClient('Policy Connector');
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'member-session', {
        access_level: 'write',
      });

      const memberList = await fetch(`${baseUrl}/api/workspace/v1/connected-apps`, {
        headers: { cookie: 'workspace_session=member-session' },
      });
      const memberRows = (await memberList.json()) as { data: Array<Record<string, unknown>> };
      expect(memberRows.data).toHaveLength(1);
      expect(memberRows.data[0]).not.toHaveProperty('member_email');

      const adminList = await fetch(`${baseUrl}/api/workspace/v1/connected-apps`, {
        headers: { cookie: 'workspace_session=admin-session' },
      });
      const adminRows = (await adminList.json()) as { data: Array<Record<string, unknown>> };
      expect(adminRows.data).toHaveLength(1);
      expect(adminRows.data[0]).toMatchObject({
        membership_id: 'member-1',
        member_email: 'member@example.test',
        configured_access_level: 'write',
        effective_access_level: 'write',
      });

      const noCsrf = await fetch(`${baseUrl}/api/workspace/v1/connected-apps/${clientId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: 'workspace_session=member-session',
          origin: 'https://workspace.example.test',
        },
        body: JSON.stringify({ access_level: 'read' }),
      });
      expect(noCsrf.status).toBe(403);

      const memberChange = await fetch(`${baseUrl}/api/workspace/v1/connected-apps/${clientId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: 'workspace_session=member-session',
          'x-csrf-token': 'member-csrf',
          origin: 'https://workspace.example.test',
        },
        body: JSON.stringify({ access_level: 'read' }),
      });
      expect(memberChange.status).toBe(200);
      expect(((await memberChange.json()) as { data: { configured_access_level: string } }).data.configured_access_level).toBe('read');
      expect(await engine.executeRaw('SELECT 1 FROM workspace_audit_events')).toEqual([]);

      const adminChange = await fetch(`${baseUrl}/api/workspace/v1/connected-apps/member-1/${clientId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: 'workspace_session=admin-session',
          'x-csrf-token': 'admin-csrf',
          origin: 'https://workspace.example.test',
        },
        body: JSON.stringify({ access_level: 'write' }),
      });
      expect(adminChange.status).toBe(200);

      const audit = await engine.executeRaw<{
        action: string;
        actor_id: string;
        target_id: string;
        reason: string | null;
        before_state: { value: Record<string, unknown> };
        after_state: { value: Record<string, unknown> };
        request_id: string;
      }>(`SELECT action, actor_id, target_id, reason, before_state, after_state, request_id
          FROM workspace_audit_events ORDER BY occurred_at`);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'connected_app.access_level.change',
        actor_id: 'admin-1',
        target_id: `member-1:${clientId}`,
        reason: null,
        request_id: 'req-oauth-consent',
      });
      expect(audit[0]!.before_state.value).toMatchObject({ configured_access_level: 'read' });
      expect(audit[0]!.after_state.value).toMatchObject({ configured_access_level: 'write' });

      const adminRevoke = await fetch(`${baseUrl}/api/workspace/v1/connected-apps/member-1/${clientId}`, {
        method: 'DELETE',
        headers: {
          cookie: 'workspace_session=admin-session',
          'x-csrf-token': 'admin-csrf',
          origin: 'https://workspace.example.test',
        },
      });
      expect(adminRevoke.status).toBe(200);
      expect((await mcpGetPage(baseUrl, tokens.access_token, 'handbook')).status).toBe(401);
      expect((await engine.executeRaw<{ action: string }>(
        'SELECT action FROM workspace_audit_events ORDER BY occurred_at',
      )).map(row => row.action)).toEqual([
        'connected_app.access_level.change',
        'connected_app.revoke',
      ]);

      const stale = await fetch(`${baseUrl}/api/workspace/v1/connected-apps/member-1/${clientId}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie: 'workspace_session=admin-session',
          'x-csrf-token': 'admin-csrf',
          origin: 'https://workspace.example.test',
        },
        body: JSON.stringify({ access_level: 'read' }),
      });
      expect(stale.status).toBe(404);
      const staleBody = await stale.json() as { error: { code: string; resource: string; request_id: string } };
      expect(staleBody.error).toMatchObject({
        code: 'not_found',
        resource: 'connected_app',
        request_id: 'req-oauth-consent',
      });
    });
  });

  test('dynamic registration cannot mint a member-less credential lane', async () => {
    // Explicit client_credentials request is refused outright.
    await expect(provider.clientsStore.registerClient!({
      client_name: 'Sneaky M2M',
      redirect_uris: ['https://client.example.test/callback'],
      grant_types: ['client_credentials'],
      scope: 'read',
      token_endpoint_auth_method: 'client_secret_post',
    } as Parameters<NonNullable<typeof provider.clientsStore.registerClient>>[0]))
      .rejects.toThrow('client_credentials requires operator registration');

    // Omitted grant_types defaults to the consent-gated flow, never
    // client_credentials — and the client_credentials exchange refuses it.
    const registered = await provider.clientsStore.registerClient!({
      client_name: 'Defaulted Client',
      redirect_uris: ['https://client.example.test/callback'],
      scope: 'read',
      token_endpoint_auth_method: 'client_secret_post',
    } as Parameters<NonNullable<typeof provider.clientsStore.registerClient>>[0]);
    expect(registered.grant_types).toEqual(['authorization_code', 'refresh_token']);
    await expect(provider.exchangeClientCredentials(registered.client_id, registered.client_secret!))
      .rejects.toThrow('not authorized');
  });

  test('Connected Apps keeps the original consent date across refresh rotation', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', { access_level: 'write' });
      const before = await (await fetch(`${baseUrl}/api/workspace/v1/connected-apps`, {
        headers: { cookie: 'workspace_session=admin-session' },
      })).json() as { data: { connected_at: string }[] };

      const refreshed = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token!,
          client_id: clientId,
        }).toString(),
      });
      expect(refreshed.status).toBe(200);

      const after = await (await fetch(`${baseUrl}/api/workspace/v1/connected-apps`, {
        headers: { cookie: 'workspace_session=admin-session' },
      })).json() as { data: { connected_at: string }[] };
      expect(after.data[0]!.connected_at).toBe(before.data[0]!.connected_at);
    });
  });

  test('refresh rotation preserves the Member binding', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session');
      expect(tokens.refresh_token).toBeTruthy();
      const refreshed = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refresh_token!,
          client_id: clientId,
        }).toString(),
      });
      expect(refreshed.status).toBe(200);
      const rotated = await refreshed.json() as { access_token: string };
      expect((await mcpGetPage(baseUrl, rotated.access_token, 'handbook')).status).toBe(200);

      // The rotated token still follows the Member: disable -> refused.
      await engine.executeRaw("UPDATE workspace_memberships SET status = 'disabled' WHERE membership_id = 'admin-1'");
      expect((await mcpGetPage(baseUrl, rotated.access_token, 'handbook')).status).toBe(401);
    });
  });
});

describe('member-consented write target (#50)', () => {
  test('an explicit granted source_id makes write-scope operations work', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', { access_level: 'write' });
      const write = await mcpCall(baseUrl, tokens.access_token, 'add_tag', {
        slug: 'handbook', tag: 'from-connector', source_id: 'allowed-source',
      });
      expect(write.status).toBe(200);
      expect(write.body.isError).toBeFalsy();
      const tags = await engine.executeRaw<{ tag: string }>(
        "SELECT tag FROM tags WHERE page_id = (SELECT id FROM pages WHERE slug = 'handbook')",
      );
      expect(tags.map(row => row.tag)).toContain('from-connector');
    });
  });

  test('a write without an explicit source_id stays refused (fail-closed)', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', { access_level: 'write' });
      const write = await mcpCall(baseUrl, tokens.access_token, 'add_tag', {
        slug: 'handbook', tag: 'no-target',
      });
      expect(write.body.isError).toBe(true);
      expect(write.body.content[0]!.text).toContain('permission_denied');
    });
  });

  test('an out-of-grant source_id is refused and leaks nothing', async () => {
    const { clientId, redirectUri } = await registerPublicClient();
    await withServer(buildApp(), async baseUrl => {
      const tokens = await consentedTokens(baseUrl, clientId, redirectUri, 'admin-session', { access_level: 'write' });
      const write = await mcpCall(baseUrl, tokens.access_token, 'add_tag', {
        slug: 'private-plan', tag: 'poke', source_id: 'denied-source',
      });
      expect(write.body.isError).toBe(true);
      expect(write.body.content[0]!.text).toContain('permission_denied');
      expect(JSON.stringify(write.body)).not.toContain('Secret');
      const tags = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM tags');
      expect(Number(tags[0]!.n)).toBe(0);
    });
  });
});
