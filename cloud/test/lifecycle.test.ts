import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import type { SqlExecutor } from '../src/db.ts';
import { migrateControlPlaneSchema } from '../src/db.ts';
import { createControlPlaneApp } from '../src/app.ts';
import { FakeGitHubOAuth, type GitHubProfile } from '../src/adapters/github.ts';
import { FakeCompute } from '../src/adapters/compute.ts';
import { FakeDns } from '../src/adapters/dns.ts';
import { FakeWorkspace } from '../src/adapters/workspace.ts';
import { FakeOpenRouterKeys } from '../src/adapters/openrouter.ts';
import { drainProvisioning, runProvisioningTick, type ProvisioningDeps } from '../src/provisioning.ts';
import { findWorkspaceById } from '../src/store.ts';
import { parseSealingKey, randomSealingKey } from '../src/secrets.ts';

// ---------------------------------------------------------------------------
// Workspace lifecycle (#41): delete, suspend and resume.
//
// Same seam as the provisioning suite: every request goes through the public
// HTTP API, every cloud effect goes through a fake bound behind an adapter
// interface, and the reconciler is only ticked.
//
// The registry is read directly only where the HTTP surface deliberately will
// not answer: a deleted workspace is a 404 by design, so its final state and
// its emptied credential columns have nowhere else to be observed. Everything
// a live workspace exposes is asserted through the API instead.
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
        if (!canStartTransaction) return fn(executor);
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
let compute: FakeCompute;
let dns: FakeDns;
let workspace: FakeWorkspace;
let embeddingKeys: FakeOpenRouterKeys;
let server: Server;
let baseUrl: string;
let deps: ProvisioningDeps;

const OPERATOR_GITHUB_ID = 9001;
const OWNER_GITHUB_ID = 1001;
const OUTSIDER_GITHUB_ID = 1002;
const WORKSPACE_DOMAIN = 'workspaces.example.com';

beforeAll(async () => {
  pg = new PGlite();
  db = pgliteExecutor(pg);
  await migrateControlPlaneSchema(db);

  github = new FakeGitHubOAuth();
  compute = new FakeCompute();
  dns = new FakeDns();
  workspace = new FakeWorkspace();
  embeddingKeys = new FakeOpenRouterKeys();
  deps = {
    db,
    compute,
    dns,
    workspace,
    embeddingKeys,
    sealingKey: parseSealingKey(randomSealingKey()),
    resendApiKey: 'resend-test-key',
    emailFrom: '2Brain <no-reply@workspaces.example.com>',
    owner: 'test-reconciler',
    maxStepAttempts: 3,
  };

  const app = createControlPlaneApp({
    db,
    github,
    operatorGithubIds: [OPERATOR_GITHUB_ID],
    secureCookies: false,
    workspaceDomain: WORKSPACE_DOMAIN,
    fleetCap: 10,
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
  compute.reset();
  dns.reset();
  workspace.reset();
  embeddingKeys.reset();
});

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
  return { githubId: OPERATOR_GITHUB_ID, login: 'operator-example', name: 'Operator', avatarUrl: null, ...overrides };
}

async function githubCallback(jar: CookieJar, who: GitHubProfile): Promise<Response> {
  const start = await request(jar, '/auth/github');
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
  const code = github.issueCode(who);
  return request(jar, `/auth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state!)}`);
}

/** The operator identity: claims the one-time bootstrap and skips signup. */
async function operatorJar(): Promise<CookieJar> {
  const jar = new CookieJar();
  expect((await githubCallback(jar, profile())).headers.get('location')).toBe('/dashboard');
  return jar;
}

/** Any other identity: signup is invite-gated, so it needs a code first. */
async function invitedJar(who: GitHubProfile): Promise<CookieJar> {
  const operator = await operatorJar();
  const issued = await request(operator, '/api/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': operator.get('cp_csrf') ?? '' },
    body: JSON.stringify({}),
  });
  expect(issued.status).toBe(201);
  const { code } = (await issued.json()) as { code: string };

  const jar = new CookieJar();
  expect((await githubCallback(jar, who)).headers.get('location')).toBe('/signup');
  const signup = await request(jar, '/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `invite_code=${encodeURIComponent(code)}`,
  });
  expect(signup.headers.get('location')).toBe('/dashboard');
  return jar;
}

interface WorkspaceView {
  workspaceId: string;
  name: string;
  subdomain: string;
  lifecycleState: string;
  provisioningStep: string;
  setupLink: string | null;
  error: string | null;
}

async function createWorkspace(jar: CookieJar, name: string, tier?: 'brain' | 'agent'): Promise<WorkspaceView> {
  const res = await request(jar, '/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('cp_csrf') ?? '' },
    body: JSON.stringify(tier === undefined ? { name } : { name, tier }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as WorkspaceView;
}

/** A workspace already provisioned all the way to running. */
async function runningWorkspace(jar: CookieJar, name: string, tier?: 'brain' | 'agent'): Promise<WorkspaceView> {
  const created = await createWorkspace(jar, name, tier);
  await drainProvisioning(deps);
  const view = await status(jar, created.workspaceId);
  expect(view.lifecycleState).toBe('running');
  return view;
}

async function act(jar: CookieJar, workspaceId: string, action: 'delete' | 'suspend' | 'resume'): Promise<Response> {
  return request(jar, `/api/workspaces/${workspaceId}/${action}`, {
    method: 'POST',
    headers: { 'x-csrf-token': jar.get('cp_csrf') ?? '' },
  });
}

async function status(jar: CookieJar, workspaceId: string): Promise<WorkspaceView> {
  const res = await request(jar, `/api/workspaces/${workspaceId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceView;
}

async function dashboard(jar: CookieJar): Promise<string> {
  const res = await request(jar, '/dashboard');
  expect(res.status).toBe(200);
  return res.text();
}

// --------------------------------------------------------------------- delete

test('delete releases every cloud effect and leaves nothing orphaned', async () => {
  const jar = await operatorJar();
  const { workspaceId, subdomain } = await runningWorkspace(jar, 'Doomed Example');
  expect(compute.liveInstances()).toHaveLength(1);
  expect(dns.liveRecords()).toHaveLength(1);
  const ocid = compute.liveInstances()[0].ocid;

  const requested = await act(jar, workspaceId, 'delete');
  expect(requested.status).toBe(202);
  expect(((await requested.json()) as WorkspaceView).lifecycleState).toBe('deleting');
  // The request records intent only; the instance is still standing.
  expect(compute.terminated).toEqual([]);

  await drainProvisioning(deps);

  expect(compute.terminated).toEqual([ocid]);
  expect(compute.liveInstances()).toEqual([]);
  expect(dns.liveRecords()).toEqual([]);
  expect(dns.deletes).toHaveLength(1);

  // Gone from every surface the owner has.
  expect((await request(jar, `/api/workspaces/${workspaceId}`)).status).toBe(404);
  expect(await dashboard(jar)).not.toContain(subdomain);

  const row = await findWorkspaceById(db, workspaceId);
  expect(row?.lifecycleState).toBe('deleted');
  expect(row?.provisioningError).toBeNull();
});

test('delete revokes the credentials and integrations the registry held', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Credentialed Example');

  // The embedding token and the GitHub App installation are minted by tickets
  // that have not landed (#42, #43), so they are seeded here rather than left
  // null — an assertion that a column nothing ever fills is empty proves nothing.
  await db.query(
    'UPDATE cp_workspaces SET embedding_token_ref = $2, github_installation_id = $3 WHERE workspace_id = $1',
    [workspaceId, 'sealed-embedding-token', '12345678'],
  );

  const before = await findWorkspaceById(db, workspaceId);
  expect(before?.bootstrapCredentialRef).not.toBeNull();
  expect(before?.setupLink).not.toBeNull();
  expect(before?.embeddingTokenRef).not.toBeNull();
  expect(before?.githubInstallationId).not.toBeNull();

  expect((await act(jar, workspaceId, 'delete')).status).toBe(202);
  await drainProvisioning(deps);

  const after = await findWorkspaceById(db, workspaceId);
  expect(after?.bootstrapCredentialRef).toBeNull();
  expect(after?.embeddingTokenRef).toBeNull();
  expect(after?.githubInstallationId).toBeNull();
  expect(after?.setupLink).toBeNull();
});

test('deleting a workspace mid-provision tears down whatever it had created', async () => {
  const jar = await operatorJar();
  const created = await createWorkspace(jar, 'Halfway Example');

  // Far enough in to hold an instance and a DNS record, not far enough to run.
  await runProvisioningTick(deps); // pending -> credentials
  await runProvisioningTick(deps); // credentials -> instance (VM launched)
  await runProvisioningTick(deps); // instance -> dns (record published)
  const midway = await status(jar, created.workspaceId);
  expect(midway.lifecycleState).toBe('provisioning');
  expect(compute.liveInstances()).toHaveLength(1);
  expect(dns.liveRecords()).toHaveLength(1);

  expect((await act(jar, created.workspaceId, 'delete')).status).toBe(202);
  await drainProvisioning(deps);

  expect(compute.liveInstances()).toEqual([]);
  expect(dns.liveRecords()).toEqual([]);
  expect((await findWorkspaceById(db, created.workspaceId))?.lifecycleState).toBe('deleted');
  // The provision never resumed past the delete request.
  expect(workspace.setupLinkRequests).toHaveLength(0);
});

test('delete finds an instance whose launch was never recorded', async () => {
  const jar = await operatorJar();
  const created = await createWorkspace(jar, 'Lost Ack Example');
  await runProvisioningTick(deps); // pending -> credentials

  // The launch OCI acknowledged but the control plane never wrote down: the
  // registry has no OCID, so only a lookup by display name can find this VM.
  const displayName = `2brain-ws-${created.workspaceId}`;
  await compute.launchInstance({ displayName, cloudInit: 'orphan' });
  expect(compute.liveInstances()).toHaveLength(1);
  expect((await findWorkspaceById(db, created.workspaceId))?.ociInstanceOcid).toBeNull();

  expect((await act(jar, created.workspaceId, 'delete')).status).toBe(202);
  await drainProvisioning(deps);

  expect(compute.liveInstances()).toEqual([]);
});

test('a teardown that cannot release everything retries, then names the residue', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Sticky Example');

  // Fails every attempt: maxStepAttempts is 3 in this suite.
  dns.failNext('deleteRecord');
  expect((await act(jar, workspaceId, 'delete')).status).toBe(202);
  await runProvisioningTick(deps);

  // Still deleting, because a resource is still out there.
  expect((await status(jar, workspaceId)).lifecycleState).toBe('deleting');
  // The instance went on the first pass even though the DNS record did not.
  expect(compute.liveInstances()).toEqual([]);

  dns.failNext('deleteRecord');
  await runProvisioningTick(deps);
  dns.failNext('deleteRecord');
  await runProvisioningTick(deps);

  const row = await findWorkspaceById(db, workspaceId);
  expect(row?.lifecycleState).toBe('deleted');
  expect(row?.provisioningError).toContain('manual cleanup still required');
  expect(row?.provisioningError).toContain('DNS record');
});

test('a second delete request while one is under way is accepted, not refused', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Double Submit Example');
  expect((await act(jar, workspaceId, 'delete')).status).toBe(202);
  expect((await act(jar, workspaceId, 'delete')).status).toBe(202);
  await drainProvisioning(deps);
  expect(compute.terminated).toHaveLength(1);
});

test('a deleted workspace cannot be deleted, suspended or resumed again', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Twice Example');
  expect((await act(jar, workspaceId, 'delete')).status).toBe(202);
  await drainProvisioning(deps);

  for (const action of ['delete', 'suspend', 'resume'] as const) {
    const res = await act(jar, workspaceId, action);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_not_found');
  }
});

test('a workspace someone else owns cannot be deleted, and is reported absent', async () => {
  const owner = await invitedJar({ githubId: OWNER_GITHUB_ID, login: 'owner-example', name: null, avatarUrl: null });
  const { workspaceId } = await runningWorkspace(owner, 'Private Example');

  const outsider = await invitedJar({ githubId: OUTSIDER_GITHUB_ID, login: 'outsider-example', name: null, avatarUrl: null });
  const res = await act(outsider, workspaceId, 'delete');
  expect(res.status).toBe(404);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('workspace_not_found');

  await drainProvisioning(deps);
  expect(compute.terminated).toEqual([]);
  expect((await status(owner, workspaceId)).lifecycleState).toBe('running');
});

test('a delete without a CSRF token is refused', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'No Token Example');
  const res = await request(jar, `/api/workspaces/${workspaceId}/delete`, { method: 'POST' });
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe('csrf_mismatch');
  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');
});

// -------------------------------------------------- delete confirmation copy

test('the delete confirmation names what survives and what does not', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Copy Example');

  const page = await (await request(jar, `/workspaces/${workspaceId}/delete`)).text();

  // What the owner keeps.
  expect(page).toContain('Sources synced from GitHub');
  // What nobody can give back.
  expect(page).toMatch(/Members and their Source grants/);
  expect(page).toMatch(/Agent memory/);
  expect(page).toMatch(/Event history/);
  // And why there is no undo.
  expect(page).toContain('no backups');
});

test('the dashboard delete form requires the workspace name typed back', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Typed Example');
  const csrf = jar.get('cp_csrf') ?? '';

  const wrong = await request(jar, `/workspaces/${workspaceId}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `csrf=${encodeURIComponent(csrf)}&confirm_name=${encodeURIComponent('Something Else')}`,
  });
  expect(wrong.status).toBe(400);
  expect(await wrong.text()).toContain('not the workspace name');
  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');

  const right = await request(jar, `/workspaces/${workspaceId}/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `csrf=${encodeURIComponent(csrf)}&confirm_name=${encodeURIComponent('Typed Example')}`,
  });
  expect(right.status).toBe(302);
  expect(right.headers.get('location')).toBe('/dashboard');
  expect((await status(jar, workspaceId)).lifecycleState).toBe('deleting');
});

// ------------------------------------------------------------ suspend/resume

test('suspend stops the instance, keeps the address, and resume brings it back', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Suspendable Example');
  const ocid = compute.liveInstances()[0].ocid;
  const recordCount = dns.liveRecords().length;

  const suspending = await act(jar, workspaceId, 'suspend');
  expect(suspending.status).toBe(202);
  expect(((await suspending.json()) as WorkspaceView).lifecycleState).toBe('suspending');

  await drainProvisioning(deps);
  expect(compute.stopped).toEqual([ocid]);
  expect((await status(jar, workspaceId)).lifecycleState).toBe('suspended');
  // Stopped, not terminated: the data is still on the boot volume.
  expect(compute.terminated).toEqual([]);
  expect(compute.liveInstances()).toHaveLength(1);
  // The subdomain goes dark but is not released, so resume needs no new record.
  expect(dns.liveRecords()).toHaveLength(recordCount);
  expect(dns.deletes).toEqual([]);

  const resuming = await act(jar, workspaceId, 'resume');
  expect(resuming.status).toBe(202);
  expect(((await resuming.json()) as WorkspaceView).lifecycleState).toBe('resuming');

  await drainProvisioning(deps);
  expect(compute.started).toEqual([ocid]);
  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');
  // No second record, and no second VM.
  expect(dns.upserts).toHaveLength(1);
  expect(compute.launches).toHaveLength(1);
});

test('resume waits for the workspace to answer before it reports running', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Slow Boot Example');
  expect((await act(jar, workspaceId, 'suspend')).status).toBe(202);
  await drainProvisioning(deps);

  workspace.healthy = false;
  expect((await act(jar, workspaceId, 'resume')).status).toBe(202);
  await runProvisioningTick(deps); // starts the instance
  await runProvisioningTick(deps); // probes, still silent

  expect(compute.started).toHaveLength(1);
  expect((await status(jar, workspaceId)).lifecycleState).toBe('resuming');

  workspace.healthy = true;
  await drainProvisioning(deps);
  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');
});

test('resume waits for an agent workspace gateway too, not just HTTPS', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Agent Resume Example', 'agent');
  expect((await act(jar, workspaceId, 'suspend')).status).toBe(202);
  await drainProvisioning(deps);

  // HTTPS answers on the way back, but the agent's state and schedules have not
  // restored yet: running would be a lie while its gateway is down.
  workspace.agentStatus = null;
  expect((await act(jar, workspaceId, 'resume')).status).toBe(202);
  await runProvisioningTick(deps); // starts the instance
  expect(await runProvisioningTick(deps)).toBe('waiting'); // the gate fires
  expect((await status(jar, workspaceId)).lifecycleState).toBe('resuming');

  workspace.agentStatus = 204;
  await drainProvisioning(deps);
  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');
});

test('a resume whose instance never answers goes back to suspended and says why', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Never Answers Example');
  expect((await act(jar, workspaceId, 'suspend')).status).toBe(202);
  await drainProvisioning(deps);

  workspace.healthy = false;
  expect((await act(jar, workspaceId, 'resume')).status).toBe(202);
  await drainProvisioning(deps);

  const view = await status(jar, workspaceId);
  expect(view.lifecycleState).toBe('suspended');
  expect(view.error).toContain('gave up');
  // A resume that timed out must never be mistaken for a provision that failed:
  // nothing was torn down.
  expect(compute.terminated).toEqual([]);
  expect(compute.liveInstances()).toHaveLength(1);
  // And the row must not be lying. It says suspended, so the instance the
  // resume started has to be stopped again — otherwise a machine is running
  // that the operator can no longer stop, because suspend is only offered from
  // `running` and this row no longer says running.
  expect(compute.stopped).toHaveLength(2);
  expect(compute.liveInstances()[0].state).toBe('stopped');
});

test('a resume whose agent gateway never answers waits longer, then suspends rather than fails', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Agent Never Answers Example', 'agent');
  expect((await act(jar, workspaceId, 'suspend')).status).toBe(202);
  await drainProvisioning(deps);

  workspace.agentStatus = null;
  expect((await act(jar, workspaceId, 'resume')).status).toBe(202);
  await runProvisioningTick(deps); // starts the instance
  // maxStepAttempts is 3 in this suite, so a resume on the default budget would
  // already have given up: the agent's boot window is longer here too.
  for (let tick = 0; tick < 7; tick += 1) await runProvisioningTick(deps);
  expect((await status(jar, workspaceId)).lifecycleState).toBe('resuming');

  // Longer, not unbounded — and a resume setback is not a provision failure.
  await drainProvisioning(deps);
  const view = await status(jar, workspaceId);
  expect(view.lifecycleState).toBe('suspended');
  expect(view.error).toContain('gave up');
  expect(compute.terminated).toEqual([]);
  expect(compute.liveInstances()).toHaveLength(1);
  expect(compute.liveInstances()[0].state).toBe('stopped');
});

test('a resume that gave up can be asked for again', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Second Chance Example');
  expect((await act(jar, workspaceId, 'suspend')).status).toBe(202);
  await drainProvisioning(deps);

  workspace.healthy = false;
  expect((await act(jar, workspaceId, 'resume')).status).toBe(202);
  await drainProvisioning(deps);
  expect((await status(jar, workspaceId)).lifecycleState).toBe('suspended');

  // The setback left the workspace in a state resume is defined for, so the
  // operator is not stuck with a workspace nobody can bring back.
  workspace.healthy = true;
  expect((await act(jar, workspaceId, 'resume')).status).toBe(202);
  await drainProvisioning(deps);
  const recovered = await status(jar, workspaceId);
  expect(recovered.lifecycleState).toBe('running');
  expect(recovered.error).toBeNull();
});

test('suspending and resuming are refused in states they are not defined for', async () => {
  const jar = await operatorJar();
  const created = await createWorkspace(jar, 'Too Early Example');

  // Still provisioning: there is nothing settled to suspend.
  const early = await act(jar, created.workspaceId, 'suspend');
  expect(early.status).toBe(409);
  const earlyBody = (await early.json()) as { error: { code: string; message: string } };
  expect(earlyBody.error.code).toBe('incompatible_state');
  expect(earlyBody.error.message).toContain('provisioning');

  await drainProvisioning(deps);

  // Running: resume is meaningless.
  const running = await act(jar, created.workspaceId, 'resume');
  expect(running.status).toBe(409);
  expect(((await running.json()) as { error: { code: string } }).error.code).toBe('incompatible_state');

  expect((await act(jar, created.workspaceId, 'suspend')).status).toBe(202);
  await drainProvisioning(deps);

  // Suspended: suspending again is refused.
  const twice = await act(jar, created.workspaceId, 'suspend');
  expect(twice.status).toBe(409);
  expect(((await twice.json()) as { error: { code: string } }).error.code).toBe('incompatible_state');

  // And the refusals changed nothing.
  expect((await status(jar, created.workspaceId)).lifecycleState).toBe('suspended');
  expect(compute.stopped).toHaveLength(1);
});

test('suspend and resume are the operator lever, not the owner one', async () => {
  const owner = await invitedJar({ githubId: OWNER_GITHUB_ID, login: 'owner-example', name: null, avatarUrl: null });
  const { workspaceId } = await runningWorkspace(owner, 'Not Yours Example');

  const refused = await act(owner, workspaceId, 'suspend');
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('operator_required');
  expect(compute.stopped).toEqual([]);

  // The operator may act on a workspace they do not own.
  const operator = await operatorJar();
  expect((await act(operator, workspaceId, 'suspend')).status).toBe(202);
  await drainProvisioning(deps);
  expect(compute.stopped).toHaveLength(1);
  expect((await status(owner, workspaceId)).lifecycleState).toBe('suspended');
});

// --------------------------------------------------------------- dashboard

test('the dashboard tells the owner what state their workspace is in', async () => {
  const jar = await operatorJar();
  const { workspaceId, subdomain } = await runningWorkspace(jar, 'Visible Example');

  expect((await dashboard(jar))).toContain('data-state="running"');

  expect((await act(jar, workspaceId, 'suspend')).status).toBe(202);
  await drainProvisioning(deps);
  const suspended = await dashboard(jar);
  expect(suspended).toContain('data-state="suspended"');
  expect(suspended).toContain('Suspended by the operator');
  expect(suspended).toContain('Your data is untouched');

  expect((await act(jar, workspaceId, 'resume')).status).toBe(202);
  expect(await dashboard(jar)).toContain('data-state="resuming"');
  await drainProvisioning(deps);

  expect((await act(jar, workspaceId, 'delete')).status).toBe(202);
  const deleting = await dashboard(jar);
  expect(deleting).toContain('data-state="deleting"');
  // A delete under way offers no second delete link.
  expect(deleting).not.toContain(`/workspaces/${workspaceId}/delete`);

  await drainProvisioning(deps);
  // A deleted workspace renders as absent rather than as a tombstone: the owner
  // asked for it to be gone, and the status route agrees by answering 404.
  const gone = await dashboard(jar);
  expect(gone).not.toContain(subdomain);
  expect(gone).toContain('No workspaces yet.');
  expect((await request(jar, `/api/workspaces/${workspaceId}`)).status).toBe(404);
});

test('a delete request repeated while one is under way does not refill its retry budget', async () => {
  const jar = await operatorJar();
  const { workspaceId } = await runningWorkspace(jar, 'Persistent Example');

  // maxStepAttempts is 3 here, and the DNS record never releases.
  dns.failNext('deleteRecord');
  expect((await act(jar, workspaceId, 'delete')).status).toBe(202);
  await runProvisioningTick(deps);
  dns.failNext('deleteRecord');
  await runProvisioningTick(deps);

  // Asking again must not hand the teardown a fresh budget, or a caller could
  // postpone the bounded give-up path — the thing that guarantees residue is
  // eventually named — for as long as they keep asking.
  expect((await act(jar, workspaceId, 'delete')).status).toBe(202);
  dns.failNext('deleteRecord');
  await runProvisioningTick(deps);

  const row = await findWorkspaceById(db, workspaceId);
  expect(row?.lifecycleState).toBe('deleted');
  expect(row?.provisioningError).toContain('DNS record');
});
