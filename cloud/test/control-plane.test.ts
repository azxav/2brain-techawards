import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import type { SqlExecutor } from '../src/db.ts';
import { migrateControlPlaneSchema } from '../src/db.ts';
import { createControlPlaneApp } from '../src/app.ts';
import { FakeGitHubOAuth, type GitHubProfile } from '../src/adapters/github.ts';
import { createUser, createWorkspaceRecord, listWorkspacesForUser } from '../src/store.ts';

// ---------------------------------------------------------------------------
// Test harness: PGLite-backed SqlExecutor (embedded Postgres — the control
// plane's own database, hermetic in tests) + fake GitHub OAuth adapter.
// Everything below drives the control plane exclusively through its HTTP API.
// ---------------------------------------------------------------------------

function pgliteExecutor(pg: PGlite): SqlExecutor {
  type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  const wrap = (q: Queryable, canStartTransaction: boolean): SqlExecutor => {
    const executor: SqlExecutor = {
      async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
        const result = await q.query(text, params);
        return result.rows as T[];
      },
      async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
        if (!canStartTransaction) return fn(executor); // already inside a transaction
        return pg.transaction(async tx => fn(wrap(tx, false)));
      },
    };
    return executor;
  };
  return wrap(pg, true);
}

let pg: PGlite;
let db: SqlExecutor;
let github: FakeGitHubOAuth;
let server: Server;
let baseUrl: string;

const OPERATOR_LOGIN = 'operator-example';
const OPERATOR_GITHUB_ID = 9001;
const SECOND_BOOTSTRAP_GITHUB_ID = 9002;

beforeAll(async () => {
  pg = new PGlite();
  db = pgliteExecutor(pg);
  await migrateControlPlaneSchema(db);

  github = new FakeGitHubOAuth();
  const app = createControlPlaneApp({
    db,
    github,
    operatorGithubIds: [OPERATOR_GITHUB_ID, SECOND_BOOTSTRAP_GITHUB_ID],
    secureCookies: false,
  });
  server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not expose a TCP address.');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  await pg.close();
});

beforeEach(async () => {
  await db.query('DELETE FROM cp_sessions');
  await db.query('DELETE FROM cp_pending_signups');
  await db.query('DELETE FROM cp_workspaces');
  await db.query('UPDATE cp_users SET invite_id = NULL');
  await db.query('DELETE FROM cp_invite_codes');
  await db.query('DELETE FROM cp_users');
  github.reset();
});

// Minimal cookie jar so multi-step browser flows carry state between requests.
class CookieJar {
  private cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /max-age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  get(name: string): string | undefined {
    return this.cookies.get(name);
  }
  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function request(jar: CookieJar, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = jar.header();
  if (cookie) headers.set('cookie', cookie);
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers, redirect: 'manual' });
  jar.absorb(res);
  return res;
}

function profile(overrides: Partial<GitHubProfile> = {}): GitHubProfile {
  return {
    githubId: 1001,
    login: 'alice-example',
    name: 'Alice Example',
    avatarUrl: null,
    ...overrides,
  };
}

/** Drive the GitHub sign-in dance: /auth/github -> provider -> callback. */
async function signInWithGitHub(jar: CookieJar, who: GitHubProfile): Promise<Response> {
  const start = await request(jar, '/auth/github');
  expect(start.status).toBe(302);
  const location = start.headers.get('location') ?? '';
  const state = new URL(location).searchParams.get('state');
  expect(state).toBeTruthy();
  const code = github.issueCode(who);
  return request(jar, `/auth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state!)}`);
}

/** Full signup for a fresh (non-operator) user with an invite code. */
async function signUpWithInvite(jar: CookieJar, who: GitHubProfile, inviteCode: string): Promise<Response> {
  const callback = await signInWithGitHub(jar, who);
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toBe('/signup');
  return request(jar, '/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `invite_code=${encodeURIComponent(inviteCode)}`,
  });
}

/** Claim or sign into the one-time, immutable-id operator bootstrap. */
async function operatorSession(): Promise<CookieJar> {
  const jar = new CookieJar();
  const callback = await signInWithGitHub(jar, profile({ githubId: OPERATOR_GITHUB_ID, login: OPERATOR_LOGIN, name: 'Operator' }));
  expect(callback.status).toBe(302);
  expect(callback.headers.get('location')).toBe('/dashboard');
  return jar;
}

async function issueInvite(jar: CookieJar, body: Record<string, unknown> = {}): Promise<{ code: string; inviteId: string; maxUses: number }> {
  const res = await request(jar, '/api/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('cp_csrf') ?? '' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return res.json() as Promise<{ code: string; inviteId: string; maxUses: number }>;
}

describe('control plane basics', () => {
  test('healthz responds', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('workspace registry stores a resolvable bootstrap credential reference', async () => {
    const credentialColumns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'cp_workspaces' AND column_name LIKE 'bootstrap_credential_%'
        ORDER BY column_name`,
    );
    expect(credentialColumns).toEqual([{ column_name: 'bootstrap_credential_ref' }]);
  });

  test('migration upgrades the legacy bootstrap credential hash column to a reference', async () => {
    const legacyPg = new PGlite();
    const legacyDb = pgliteExecutor(legacyPg);
    try {
      // A database that stopped at version 2 — stubbed down to the columns the
      // later migrations actually touch, but every table migration 1 created
      // must exist, or this fixture stops standing in for a real v2 database.
      await legacyDb.query('CREATE TABLE cp_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      await legacyDb.query('INSERT INTO cp_migrations (version) VALUES (1), (2)');
      // lifecycle_state carries its original inline CHECK, because migration 8
      // replaces that constraint by the name Postgres generated for it. A
      // fixture without it would let a migration that cannot run against a real
      // v2 database pass here.
      await legacyDb.query(`CREATE TABLE cp_workspaces (
        bootstrap_credential_hash text,
        lifecycle_state text NOT NULL DEFAULT 'provisioning'
          CHECK (lifecycle_state IN ('provisioning', 'running', 'suspended', 'deleted', 'failed'))
      )`);
      await legacyDb.query('CREATE TABLE cp_users (user_id uuid PRIMARY KEY, is_operator boolean NOT NULL DEFAULT false)');
      await legacyDb.query('CREATE TABLE cp_invite_codes (invite_id uuid PRIMARY KEY)');

      await migrateControlPlaneSchema(legacyDb);

      const columns = await legacyDb.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'cp_workspaces' AND column_name LIKE 'bootstrap_credential_%'
          ORDER BY column_name`,
      );
      expect(columns).toEqual([{ column_name: 'bootstrap_credential_ref' }]);

      // The upgraded database accepts the lifecycle states the actions move
      // through, and still refuses one that is not a state at all.
      for (const state of ['suspending', 'resuming', 'deleting']) {
        await legacyDb.query('INSERT INTO cp_workspaces (lifecycle_state) VALUES ($1)', [state]);
      }
      await expect(
        legacyDb.query('INSERT INTO cp_workspaces (lifecycle_state) VALUES ($1)', ['not-a-state']),
      ).rejects.toThrow();

      await legacyDb.query("INSERT INTO cp_users (user_id, is_operator) VALUES ('00000000-0000-0000-0000-000000000001', true)");
      await expect(legacyDb.query(
        "INSERT INTO cp_users (user_id, is_operator) VALUES ('00000000-0000-0000-0000-000000000002', true)",
      )).rejects.toThrow();
    } finally {
      await legacyPg.close();
    }
  });

  test('the database enforces a single operator bootstrap claim', async () => {
    await createUser(db, profile({ githubId: OPERATOR_GITHUB_ID, login: OPERATOR_LOGIN }), { isOperator: true });
    await expect(createUser(db, profile({
      githubId: SECOND_BOOTSTRAP_GITHUB_ID,
      login: 'second-operator-example',
    }), { isOperator: true })).rejects.toThrow();
  });

  test('landing page offers GitHub sign-in and nothing else', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/auth/github');
    expect(html).not.toContain('password');
  });
});

describe('GitHub sign-in', () => {
  test('start redirects to the provider authorize URL with a state cookie', async () => {
    const jar = new CookieJar();
    const res = await request(jar, '/auth/github');
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith('https://github.example/oauth/authorize')).toBe(true);
    expect(jar.get('cp_oauth_state')).toBeTruthy();
  });

  test('callback with mismatched state is refused', async () => {
    const jar = new CookieJar();
    await request(jar, '/auth/github');
    const code = github.issueCode(profile());
    const res = await request(jar, `/auth/github/callback?code=${code}&state=not-the-state`);
    expect(res.status).toBe(400);
  });

  test('callback without a prior state cookie is refused', async () => {
    const jar = new CookieJar();
    const code = github.issueCode(profile());
    const res = await request(jar, `/auth/github/callback?code=${code}&state=whatever`);
    expect(res.status).toBe(400);
  });

  test('callback with a code the provider rejects is refused', async () => {
    const jar = new CookieJar();
    const start = await request(jar, '/auth/github');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state')!;
    const res = await request(jar, `/auth/github/callback?code=bogus&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
  });

  test('an existing user signs straight in and lands on the dashboard', async () => {
    const operatorJar = await operatorSession();
    const invite = await issueInvite(operatorJar);
    const jar = new CookieJar();
    const done = await signUpWithInvite(jar, profile(), invite.code);
    expect(done.status).toBe(302);

    // Second visit: no invite required, straight to dashboard.
    const again = new CookieJar();
    const res = await signInWithGitHub(again, profile());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard');
    const me = await request(again, '/api/me');
    expect(me.status).toBe(200);
    const body = (await me.json()) as { login: string; operator: boolean };
    expect(body.login).toBe('alice-example');
    expect(body.operator).toBe(false);
  });

  test('the configured immutable GitHub id bootstraps the first operator', async () => {
    const jar = await operatorSession();
    const me = await request(jar, '/api/me');
    expect(me.status).toBe(200);
    const body = (await me.json()) as { login: string; operator: boolean };
    expect(body.login).toBe(OPERATOR_LOGIN);
    expect(body.operator).toBe(true);
  });

  test('a reclaimed operator login cannot bootstrap a different GitHub identity', async () => {
    await operatorSession();
    const reclaimed = new CookieJar();
    const callback = await signInWithGitHub(reclaimed, profile({
      githubId: 9003,
      login: OPERATOR_LOGIN,
      name: 'Different identity',
    }));
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/signup');
    expect((await request(reclaimed, '/api/me')).status).toBe(401);
  });

  test('operator bootstrap closes after the first configured identity claims it', async () => {
    await operatorSession();
    const second = new CookieJar();
    const callback = await signInWithGitHub(second, profile({
      githubId: SECOND_BOOTSTRAP_GITHUB_ID,
      login: 'second-operator-example',
      name: 'Second configured identity',
    }));
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/signup');
    expect((await request(second, '/api/me')).status).toBe(401);
  });
});

describe('invite-gated signup', () => {
  test('a brand-new user is routed to signup, not signed in', async () => {
    const jar = new CookieJar();
    const res = await signInWithGitHub(jar, profile());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/signup');
    const me = await request(jar, '/api/me');
    expect(me.status).toBe(401);
    const page = await request(jar, '/signup');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('invite_code');
  });

  test('signup page without a pending signup redirects home', async () => {
    const jar = new CookieJar();
    const res = await request(jar, '/signup');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  test('a valid invite code creates the account and signs the user in', async () => {
    const operatorJar = await operatorSession();
    const invite = await issueInvite(operatorJar);

    const jar = new CookieJar();
    const done = await signUpWithInvite(jar, profile(), invite.code);
    expect(done.status).toBe(302);
    expect(done.headers.get('location')).toBe('/dashboard');

    const me = await request(jar, '/api/me');
    expect(me.status).toBe(200);
    expect(((await me.json()) as { login: string }).login).toBe('alice-example');
  });

  test('an invalid invite code is refused and no account is created', async () => {
    const jar = new CookieJar();
    const res = await signUpWithInvite(jar, profile(), 'not-a-real-code');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('not valid');
    const me = await request(jar, '/api/me');
    expect(me.status).toBe(401);
  });

  test('an exhausted invite code is refused', async () => {
    const operatorJar = await operatorSession();
    const invite = await issueInvite(operatorJar, { maxUses: 1 });

    const first = new CookieJar();
    const ok = await signUpWithInvite(first, profile({ githubId: 2001, login: 'bob-example' }), invite.code);
    expect(ok.status).toBe(302);

    const second = new CookieJar();
    const refused = await signUpWithInvite(second, profile({ githubId: 2002, login: 'carol-example' }), invite.code);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('exhausted');
    const me = await request(second, '/api/me');
    expect(me.status).toBe(401);
  });

  test('a multi-use invite code admits users until exhausted', async () => {
    const operatorJar = await operatorSession();
    const invite = await issueInvite(operatorJar, { maxUses: 2 });
    expect(invite.maxUses).toBe(2);

    const a = await signUpWithInvite(new CookieJar(), profile({ githubId: 3001, login: 'dave-example' }), invite.code);
    expect(a.status).toBe(302);
    const b = await signUpWithInvite(new CookieJar(), profile({ githubId: 3002, login: 'erin-example' }), invite.code);
    expect(b.status).toBe(302);
    const c = await signUpWithInvite(new CookieJar(), profile({ githubId: 3003, login: 'frank-example' }), invite.code);
    expect(c.status).toBe(400);
  });

  test('signup POST without a pending signup is refused', async () => {
    const jar = new CookieJar();
    const res = await request(jar, '/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'invite_code=whatever',
    });
    expect(res.status).toBe(401);
  });
});

describe('operator invite issuance', () => {
  test('operator issues an invite code and can list it', async () => {
    const jar = await operatorSession();
    const invite = await issueInvite(jar, { note: 'pilot wave 1', maxUses: 3 });
    expect(invite.code.length).toBeGreaterThanOrEqual(12);
    expect(invite.maxUses).toBe(3);

    const list = await request(jar, '/api/invites');
    expect(list.status).toBe(200);
    const body = (await list.json()) as { invites: Array<{ inviteId: string; codePrefix: string; maxUses: number; useCount: number; note: string | null }> };
    expect(body.invites.length).toBe(1);
    expect(body.invites[0].inviteId).toBe(invite.inviteId);
    expect(body.invites[0].useCount).toBe(0);
    expect(body.invites[0].note).toBe('pilot wave 1');
    // The listing never exposes the redeemable secret, only a display prefix.
    expect(invite.code.startsWith(body.invites[0].codePrefix)).toBe(true);
    expect(body.invites[0].codePrefix.length).toBeLessThan(invite.code.length);
  });

  test('redemption is visible in the listing use count', async () => {
    const operatorJar = await operatorSession();
    const invite = await issueInvite(operatorJar);
    await signUpWithInvite(new CookieJar(), profile(), invite.code);
    const list = await request(operatorJar, '/api/invites');
    const body = (await list.json()) as { invites: Array<{ useCount: number }> };
    expect(body.invites[0].useCount).toBe(1);
  });

  test('a non-operator cannot issue or list invites', async () => {
    const operatorJar = await operatorSession();
    const invite = await issueInvite(operatorJar);
    const jar = new CookieJar();
    await signUpWithInvite(jar, profile(), invite.code);

    const res = await request(jar, '/api/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('cp_csrf') ?? '' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    const list = await request(jar, '/api/invites');
    expect(list.status).toBe(403);
  });

  test('unauthenticated invite issuance is refused', async () => {
    const res = await fetch(`${baseUrl}/api/invites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  test('invite issuance without the CSRF header is refused', async () => {
    const jar = await operatorSession();
    const res = await request(jar, '/api/invites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });
});

describe('dashboard and workspace registry', () => {
  test('dashboard requires a session', async () => {
    const jar = new CookieJar();
    const res = await request(jar, '/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  test('dashboard renders the signed-in user with an empty workspace list', async () => {
    const jar = await operatorSession();
    const res = await request(jar, '/dashboard');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(OPERATOR_LOGIN);
    expect(html).toContain('No workspaces yet');
  });

  test('workspace list API starts empty', async () => {
    const jar = await operatorSession();
    const res = await request(jar, '/api/workspaces');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaces: [] });
  });

  test('registry rows carry the full workspace shape and appear for their owner only', async () => {
    const operatorJar = await operatorSession();
    const invite = await issueInvite(operatorJar);
    const jar = new CookieJar();
    await signUpWithInvite(jar, profile(), invite.code);
    const me = (await (await request(jar, '/api/me')).json()) as { userId: string };

    await createWorkspaceRecord(db, {
      ownerUserId: me.userId,
      name: 'Acme Brain',
      subdomain: 'acme-example',
      tier: 'brain',
      ociInstanceOcid: 'ocid1.instance.oc1..example',
      bootstrapCredentialRef: 'secret://workspaces/acme-example/bootstrap-credential',
      embeddingTokenRef: 'openrouter-key-ref-1',
      githubInstallationId: '12345',
    });

    const rows = await listWorkspacesForUser(db, me.userId);
    expect(rows.length).toBe(1);
    expect(rows[0].lifecycleState).toBe('provisioning');
    expect(rows[0].billingState).toBe('none');
    expect(rows[0].billingManualOverride).toBe(false);
    expect(rows[0].stripeSubscriptionId).toBeNull();
    expect(rows[0].bootstrapCredentialRef).toBe('secret://workspaces/acme-example/bootstrap-credential');

    const credentialColumns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'cp_workspaces' AND column_name LIKE 'bootstrap_credential_%'
        ORDER BY column_name`,
    );
    expect(credentialColumns).toEqual([{ column_name: 'bootstrap_credential_ref' }]);

    const mine = await request(jar, '/api/workspaces');
    const body = (await mine.json()) as { workspaces: Array<Record<string, unknown>> };
    expect(body.workspaces).toEqual([
      {
        workspaceId: rows[0].workspaceId,
        name: 'Acme Brain',
        subdomain: 'acme-example',
        tier: 'brain',
        lifecycleState: 'provisioning',
        provisioningStep: 'pending',
        setupLink: null,
        error: null,
      },
    ]);
    // The sealed credential columns stay server-side: the list is a view, not a dump.
    expect(JSON.stringify(body)).not.toContain('bootstrap');
    expect(JSON.stringify(body)).not.toContain('openrouter-key-ref-1');

    // The registry row never leaks into someone else's list.
    const other = await request(operatorJar, '/api/workspaces');
    expect(await other.json()).toEqual({ workspaces: [] });

    // Dashboard now shows the workspace instead of the empty state, with the
    // registry-defaulted lifecycle state observable over HTTP.
    const dash = await request(jar, '/dashboard');
    const html = await dash.text();
    expect(html).toContain('Acme Brain');
    expect(html).toContain('provisioning');
    expect(html).not.toContain('No workspaces yet');
  });
});

describe('workspace tier selection (#57)', () => {
  const createBody = (jar: CookieJar, body: Record<string, unknown>) => ({
    method: 'POST' as const,
    headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('cp_csrf') ?? '' },
    body: JSON.stringify(body),
  });

  test('agent tier is accepted and recorded', async () => {
    const jar = await operatorSession();
    const res = await request(jar, '/api/workspaces', createBody(jar, { name: 'Agent One', tier: 'agent' }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { tier: string };
    expect(body.tier).toBe('agent');
  });

  test('an unknown tier is refused with 400 and creates nothing', async () => {
    const jar = await operatorSession();
    const res = await request(jar, '/api/workspaces', createBody(jar, { name: 'Bogus Tier', tier: 'super' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('invalid_tier');
    const list = (await (await request(jar, '/api/workspaces')).json()) as { workspaces: unknown[] };
    expect(list.workspaces.length).toBe(0);
  });

  test('a missing tier still defaults to brain', async () => {
    const jar = await operatorSession();
    const res = await request(jar, '/api/workspaces', createBody(jar, { name: 'Plain Brain' }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as { tier: string }).tier).toBe('brain');
  });

  test('the dashboard form forwards tier too', async () => {
    const jar = await operatorSession();
    const csrf = jar.get('cp_csrf') ?? '';
    const res = await request(jar, '/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=${encodeURIComponent('Form Agent')}&tier=agent&csrf=${encodeURIComponent(csrf)}`,
    });
    expect(res.status).toBe(302);
    const list = (await (await request(jar, '/api/workspaces')).json()) as { workspaces: Array<{ tier: string }> };
    expect(list.workspaces.length).toBe(1);
    expect(list.workspaces[0].tier).toBe('agent');
  });

  test('the dashboard form refuses an unknown tier and creates nothing', async () => {
    const jar = await operatorSession();
    const csrf = jar.get('cp_csrf') ?? '';
    const res = await request(jar, '/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=${encodeURIComponent('Form Bogus')}&tier=super&csrf=${encodeURIComponent(csrf)}`,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('Choose a workspace tier of brain or agent.');
    const list = (await (await request(jar, '/api/workspaces')).json()) as { workspaces: unknown[] };
    expect(list.workspaces.length).toBe(0);
  });

  test('the dashboard form offers both tiers and explains the difference', async () => {
    const jar = await operatorSession();
    const html = await (await request(jar, '/dashboard')).text();
    const formStart = html.indexOf('action="/workspaces"');
    const formEnd = html.indexOf('</form>', formStart);
    const form = html.slice(formStart, formEnd);
    expect(form).toContain('name="tier" value="brain" checked');
    expect(form).toContain('name="tier" value="agent"');
    // The copy must say what agent tier adds and state the permission consequence.
    expect(html).toContain('OpenClaw');
    const normalized = html.replace(/\s+/g, ' ');
    expect(normalized).toContain('their own workspace permissions would not allow');
  });

  test('a refused dashboard submission keeps the tier the user chose', async () => {
    const jar = await operatorSession();
    const csrf = jar.get('cp_csrf') ?? '';
    const res = await request(jar, '/workspaces', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `name=&tier=agent&csrf=${encodeURIComponent(csrf)}`,
    });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('name="tier" value="agent" checked');
  });
});

describe('sessions', () => {
  test('logout revokes the session', async () => {
    const jar = await operatorSession();
    const res = await request(jar, '/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': jar.get('cp_csrf') ?? '' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    const me = await request(jar, '/api/me');
    expect(me.status).toBe(401);
  });

  test('a forged session cookie is refused', async () => {
    const jar = new CookieJar();
    const res = await request(jar, '/api/me', { headers: { cookie: 'cp_session=forged-token' } });
    expect(res.status).toBe(401);
  });
});
