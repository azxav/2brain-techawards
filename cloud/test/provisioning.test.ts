import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type { Server } from 'node:http';
import { PGlite } from '@electric-sql/pglite';
import type { SqlExecutor } from '../src/db.ts';
import { migrateControlPlaneSchema } from '../src/db.ts';
import { createControlPlaneApp } from '../src/app.ts';
import { FakeGitHubOAuth, type GitHubProfile } from '../src/adapters/github.ts';
import { FakeCompute } from '../src/adapters/compute.ts';
import { FakeDns } from '../src/adapters/dns.ts';
import { FakeWorkspace, type WorkspaceAdapter } from '../src/adapters/workspace.ts';
import { FakeOpenRouterKeys } from '../src/adapters/openrouter.ts';
import { drainProvisioning, embeddingKeyName, instanceDisplayName, runProvisioningTick, type ProvisioningDeps } from '../src/provisioning.ts';
import { renderCloudInit } from '../src/cloud-init.ts';
import { createReconciler } from '../src/reconciler.ts';
import { advanceProvisioningStep } from '../src/store.ts';
import { openSecret, parseSealingKey, randomSealingKey } from '../src/secrets.ts';

// ---------------------------------------------------------------------------
// Everything here drives the control plane through its public HTTP API with
// fakes bound behind the adapter interfaces — the seam #35 and #40 fixed. No
// test reaches into the reconciler's internals; the reconciler is only ticked.
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
const WORKSPACE_DOMAIN = 'workspaces.example.com';
const FLEET_CAP = 3;

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
    fleetCap: FLEET_CAP,
    embeddingKeys,
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

/** Drive the GitHub dance; the caller knows where it should land. */
async function githubCallback(jar: CookieJar, who: GitHubProfile): Promise<Response> {
  const start = await request(jar, '/auth/github');
  const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
  const code = github.issueCode(who);
  return request(jar, `/auth/github/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state!)}`);
}

/** The operator identity, which claims the one-time bootstrap and skips signup. */
async function signedInJar(who: GitHubProfile = profile()): Promise<CookieJar> {
  const jar = new CookieJar();
  const callback = await githubCallback(jar, who);
  expect(callback.headers.get('location')).toBe('/dashboard');
  return jar;
}

/** Any other identity: signup is invite-gated, so it needs a code first. */
async function invitedJar(who: GitHubProfile): Promise<CookieJar> {
  const operator = await signedInJar();
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

async function createWorkspace(jar: CookieJar, name: string, tier?: 'brain' | 'agent'): Promise<Response> {
  return request(jar, '/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': jar.get('cp_csrf') ?? '' },
    body: JSON.stringify(tier === undefined ? { name } : { name, tier }),
  });
}

async function status(jar: CookieJar, workspaceId: string): Promise<WorkspaceView> {
  const res = await request(jar, `/api/workspaces/${workspaceId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as WorkspaceView;
}

// ---------------------------------------------------------------------------

test('creating a workspace drives the machine to running and surfaces the setup link', async () => {
  const jar = await signedInJar();
  const created = await createWorkspace(jar, 'Acme Example');
  expect(created.status).toBe(201);
  const { workspaceId, subdomain } = (await created.json()) as WorkspaceView;
  expect(subdomain).toBe(`acme-example.${WORKSPACE_DOMAIN}`);

  const before = await status(jar, workspaceId);
  expect(before.lifecycleState).toBe('provisioning');
  expect(before.provisioningStep).toBe('pending');
  expect(before.setupLink).toBeNull();

  await drainProvisioning(deps);

  const after = await status(jar, workspaceId);
  expect(after.lifecycleState).toBe('running');
  expect(after.provisioningStep).toBe('running');
  expect(after.setupLink).toBe(`https://${subdomain}/setup/fake-token-${workspaceId}`);
  expect(after.error).toBeNull();

  // Each external effect happened exactly once, against this workspace.
  expect(compute.launches).toHaveLength(1);
  expect(compute.launches[0].displayName).toBe(instanceDisplayName(workspaceId));
  expect(dns.upserts).toEqual([{ name: subdomain, ipv4: '203.0.113.1' }]);
  expect(workspace.setupLinkRequests).toHaveLength(1);
  expect(workspace.setupLinkRequests[0].idempotencyKey).toBe(workspaceId);
  // The management lane dials the address the DNS record points at, never the
  // just-created hostname: the health probe and the setup-link call both carry
  // the launched instance's IP, so no local DNS lookup gates the provision.
  expect(workspace.healthProbes).toContainEqual({ baseUrl: `https://${subdomain}`, ip: '203.0.113.1' });
  expect(workspace.setupLinkRequests[0].ip).toBe('203.0.113.1');
});

/** Ticks until the workspace is sitting on `step`, so an inserted step cannot
 *  silently change which step the caller goes on to exercise. */
async function advanceToStep(jar: CookieJar, workspaceId: string, step: string): Promise<void> {
  for (let tick = 0; tick < 12; tick += 1) {
    if ((await status(jar, workspaceId)).provisioningStep === step) return;
    await runProvisioningTick(deps);
  }
  throw new Error(`the workspace never reached the ${step} step`);
}

test('an agent workspace is not running until the agent gateway answers', async () => {
  const jar = await signedInJar();
  workspace.agentStatus = null;
  const created = (await (await createWorkspace(jar, 'Agent WS', 'agent')).json()) as WorkspaceView;

  // On the health step, where the gate lives: HTTPS answered but nothing answers
  // at the agent path, so the step waits rather than advancing. Asserting the
  // outcome ties this to the gate firing, not merely to arriving at the step.
  await advanceToStep(jar, created.workspaceId, 'health');
  expect(await runProvisioningTick(deps)).toBe('waiting');
  const stalled = await status(jar, created.workspaceId);
  expect(stalled.lifecycleState).toBe('provisioning');
  expect(stalled.provisioningStep).toBe('health');
  expect(stalled.setupLink).toBeNull();

  workspace.agentStatus = 204;
  await drainProvisioning(deps);
  const done = await status(jar, created.workspaceId);
  expect(done.lifecycleState).toBe('running');
  // The gate probed the same origin and address as the TLS probe.
  expect(workspace.agentProbes).toContainEqual({ baseUrl: `https://${created.subdomain}`, ip: '203.0.113.1' });
});

test('anything other than GBrain’s exact 204 is not the runtime being ready', async () => {
  const jar = await signedInJar();
  // The real VM timeline: the Brain finalizer has already enabled Caddy with a
  // Caddyfile that has no agent route, so the health path reaches gbrain-web and
  // 404s for tens of seconds while the agent finalizer configures the gateway.
  // A 200 would be just as wrong — only the bodiless 204 the gate emits after
  // `control.runtimeHealth()` succeeded proves the loopback Gateway is alive.
  workspace.agentStatus = 404;
  const created = (await (await createWorkspace(jar, 'Agent 404', 'agent')).json()) as WorkspaceView;

  await advanceToStep(jar, created.workspaceId, 'health');
  expect(await runProvisioningTick(deps)).toBe('waiting');
  const stalled = await status(jar, created.workspaceId);
  expect(stalled.lifecycleState).toBe('provisioning');
  expect(stalled.setupLink).toBeNull();

  // A 200 at the gate is still not the proof: the gate never answers 200, so a
  // 200 means something else is serving that path.
  workspace.agentStatus = 200;
  await advanceToStep(jar, created.workspaceId, 'health');
  expect(await runProvisioningTick(deps)).toBe('waiting');
  expect((await status(jar, created.workspaceId)).lifecycleState).toBe('provisioning');

  // Only once the route is installed and GBrain proves the runtime for itself.
  workspace.agentStatus = 204;
  await drainProvisioning(deps);
  expect((await status(jar, created.workspaceId)).lifecycleState).toBe('running');
});

test('the agent gate outlasts the default step budget, but is still bounded', async () => {
  const jar = await signedInJar();
  workspace.agentStatus = 404;
  const created = (await (await createWorkspace(jar, 'Slow Agent', 'agent')).json()) as WorkspaceView;
  await advanceToStep(jar, created.workspaceId, 'health');

  // maxStepAttempts is 3 here, so a step on the default budget would already have
  // given up and torn the instance down by now. The agent's boot window is longer
  // than one step's by design.
  for (let tick = 0; tick < 8; tick += 1) await runProvisioningTick(deps);
  expect((await status(jar, created.workspaceId)).lifecycleState).toBe('provisioning');
  expect(compute.liveInstances()).toHaveLength(1);

  // Longer, not unbounded: the allowance still ends in the ordinary give-up and
  // the same cleanup path.
  await drainProvisioning(deps, 40);
  const failed = await status(jar, created.workspaceId);
  expect(failed.lifecycleState).toBe('failed');
  expect(failed.error).toContain('gave up');
  expect(compute.liveInstances()).toEqual([]);
  expect(dns.liveRecords()).toEqual([]);
});

/**
 * The shared native password is derived, never stored: HMAC(deployment secret,
 * workspace, generation). The deployment secret IS `GBRAIN_WORKSPACE_TOKEN_SECRET`
 * in /etc/gbrain/workspace.env, and the binding pins a fingerprint of it. So a
 * re-provision — the shape an Agent image upgrade takes, since the launch is the
 * only thing that writes that file — must carry the SAME value through, or every
 * derived password silently changes and native ingress fails closed forever with
 * `agent_password_secret_changed`.
 */
test('an agent image upgrade preserves the deployment secret the password derivation is pinned to', async () => {
  const jar = await signedInJar();
  workspace.agentStatus = 204;
  const created = (await (await createWorkspace(jar, 'Upgrade Me', 'agent')).json()) as WorkspaceView;
  // Stop at the first step AFTER the launch: the sealed launch secrets are
  // released once the provision completes, and an upgrade re-launches from them.
  await advanceToStep(jar, created.workspaceId, 'instance');

  const mine = () => compute.launches.filter(launch => launch.displayName === instanceDisplayName(created.workspaceId));
  const tokenSecret = (cloudInit: string) => /^\s*GBRAIN_WORKSPACE_TOKEN_SECRET=(.*)$/m.exec(cloudInit)?.[1] ?? null;

  const launches = mine();
  expect(launches.length).toBeGreaterThanOrEqual(1);
  const first = tokenSecret(launches[0].cloudInit);
  // Guards the assertion itself: a render that stopped emitting the key at all
  // would make every "unchanged" comparison below trivially true.
  expect(first).not.toBeNull();
  expect(first).not.toBe('');
  expect(first!.length).toBeGreaterThanOrEqual(32);
  expect(launches[0].cloudInit).toContain(`GBRAIN_WORKSPACE_TOKEN_SECRET=${first}`);

  // Now the upgrade itself. A re-launch does not re-mint: it reloads the sealed
  // blob the `pending` step persisted and renders from that. Reading the stored
  // secrets and re-rendering is that path exactly, without rewinding the state
  // machine through a transition it does not have.
  const stored = await db.query<{ provisioning_secrets: string | null }>(
    'SELECT provisioning_secrets FROM cp_workspaces WHERE workspace_id=$1', [created.workspaceId],
  );
  expect(stored[0]?.provisioning_secrets, 'the launch secrets were released before the launch').toBeTruthy();
  const secrets = JSON.parse(openSecret(stored[0]!.provisioning_secrets!, deps.sealingKey)) as {
    tokenSecret: string; bootstrapCredential: string; postgresPassword: string; openrouterKey: string;
  };
  // The stored value IS the one the first launch carried; nothing re-derives it.
  expect(secrets.tokenSecret).toBe(first!);

  const relaunch = renderCloudInit({
    name: 'Upgrade Me',
    subdomain: created.subdomain,
    tier: 'agent',
    secrets,
    resendApiKey: deps.resendApiKey,
    emailFrom: deps.emailFrom,
    openrouterKey: secrets.openrouterKey,
  });
  for (const cloudInit of [...launches.map(launch => launch.cloudInit), relaunch]) {
    // A changed — or missing — value silently changes every derived native
    // password and permanently closes native ingress with
    // `agent_password_secret_changed`. The launch contract must reproduce it.
    expect(tokenSecret(cloudInit)).toBe(first);
    // And the agent-scoped environment file stays a MARKER: cloud-init never
    // writes /etc/openclaw/agent.env at all, and the finalizer that does writes
    // exactly one boolean into it. Nothing in the launch contract may put the
    // deployment secret — or any credential — on a path OpenClaw can read.
    expect(cloudInit).not.toContain('/etc/openclaw/agent.env');
    expect(cloudInit).toContain('/usr/local/sbin/gbrain-agent-finalize');
  }

  // A missing or blank value must fail the render outright rather than shipping
  // a VM whose finalizer will refuse — and whose password fingerprint would
  // otherwise be pinned to nothing.
  for (const broken of ['', '   ']) {
    const cloudInit = renderCloudInit({
      name: 'Upgrade Me', subdomain: created.subdomain, tier: 'agent',
      secrets: { ...secrets, tokenSecret: broken },
      resendApiKey: deps.resendApiKey, emailFrom: deps.emailFrom, openrouterKey: secrets.openrouterKey,
    });
    // Asserted against the IMAGE-SIDE grammar verbatim, not a JS `.trim()` rule
    // standing in for it. gbrain-agent-finalize counts lines matching
    // `^GBRAIN_WORKSPACE_TOKEN_SECRET=[^[:space:]]` and refuses the VM when the
    // count is zero, so this is the exact predicate the VM will apply — which is
    // what makes "the image-side precondition refuses this" a true statement for
    // the whitespace case as well as the empty one.
    const imageSideAccepts = /^GBRAIN_WORKSPACE_TOKEN_SECRET=[^\s]/m.test(
      cloudInit.split('\n').map(line => line.trim()).join('\n'),
    );
    expect(imageSideAccepts, `a token secret of ${JSON.stringify(broken)} must not satisfy the VM's precondition`).toBe(false);
  }
});

test('a brain workspace never probes the agent gateway', async () => {
  const jar = await signedInJar();
  const created = (await (await createWorkspace(jar, 'Brain WS')).json()) as WorkspaceView;

  await drainProvisioning(deps);

  expect((await status(jar, created.workspaceId)).lifecycleState).toBe('running');
  expect(workspace.agentProbes).toEqual([]);
});

test('the status transitions are observable one step at a time', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Stepwise')).json()) as WorkspaceView;

  const seen: string[] = [(await status(jar, workspaceId)).provisioningStep];
  for (let tick = 0; tick < 6; tick += 1) {
    await runProvisioningTick(deps);
    seen.push((await status(jar, workspaceId)).provisioningStep);
  }
  expect(seen).toEqual(['pending', 'credentials', 'instance', 'dns', 'health', 'setup_link', 'running']);
});

test('a control plane killed mid-provision converges without duplicating the instance', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Resumable')).json()) as WorkspaceView;

  // Three ticks in, the "process" dies: no state exists outside the row.
  await runProvisioningTick(deps);
  await runProvisioningTick(deps);
  await runProvisioningTick(deps);
  const midway = await status(jar, workspaceId);
  expect(midway.provisioningStep).toBe('dns');

  // A different reconciler identity picks the row up and finishes it.
  await drainProvisioning({ ...deps, owner: 'reconciler-after-restart' });

  const after = await status(jar, workspaceId);
  expect(after.lifecycleState).toBe('running');
  expect(after.setupLink).not.toBeNull();
  // The whole point: the restart did not launch a second VM.
  expect(compute.launches).toHaveLength(1);
  expect(compute.liveInstances()).toHaveLength(1);
});

test('a launch whose acknowledgement was lost is adopted rather than repeated', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Lost Ack')).json()) as WorkspaceView;

  await runProvisioningTick(deps); // pending -> credentials

  // The VM exists in the cloud, but the control plane never learned its id.
  await compute.launchInstance({ displayName: instanceDisplayName(workspaceId), cloudInit: '#cloud-config' });
  expect(compute.launches).toHaveLength(1);

  await drainProvisioning(deps);

  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');
  expect(compute.launches).toHaveLength(1);
  expect(compute.liveInstances()).toHaveLength(1);
});

test('a failure at each step releases everything that step had already created', async () => {
  const cases: Array<{ name: string; arm: () => void; expectInstance: boolean; expectDns: boolean }> = [
    { name: 'launch fails', arm: () => compute.failNext('launchInstance'), expectInstance: false, expectDns: false },
    { name: 'dns fails', arm: () => dns.failNext('upsertRecord'), expectInstance: true, expectDns: false },
    { name: 'setup link fails', arm: () => workspace.failNext('issueSetupLink'), expectInstance: true, expectDns: true },
  ];

  for (const scenario of cases) {
    await db.query('DELETE FROM cp_workspaces');
    compute.reset();
    dns.reset();
    workspace.reset();
    embeddingKeys.reset();
    const jar = await signedInJar();
    const { workspaceId } = (await (await createWorkspace(jar, `Doomed ${scenario.name}`)).json()) as WorkspaceView;

    // Arm the failure only once the step that uses it is next.
    for (let tick = 0; tick < 8; tick += 1) {
      const current = (await status(jar, workspaceId)).provisioningStep;
      if (current === 'failed') break;
      if (
        (scenario.name === 'launch fails' && current === 'credentials')
        || (scenario.name === 'dns fails' && current === 'instance')
        || (scenario.name === 'setup link fails' && current === 'health')
      ) {
        scenario.arm();
      }
      await runProvisioningTick(deps);
    }

    const failed = await status(jar, workspaceId);
    expect(failed.lifecycleState).toBe('failed');
    expect(failed.provisioningStep).toBe('failed');
    expect(failed.error).toBeString();
    // Nothing survives a failed provision, whatever it had got as far as.
    expect(compute.liveInstances()).toEqual([]);
    expect(dns.liveRecords()).toEqual([]);
    expect(scenario.expectInstance ? compute.terminated.length : 0).toBe(scenario.expectInstance ? 1 : 0);
    expect(scenario.expectDns ? dns.deletes.length : 0).toBe(scenario.expectDns ? 1 : 0);
  }
});

test('a step that never becomes ready gives up and cleans up rather than spinning forever', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Never Healthy')).json()) as WorkspaceView;
  workspace.healthy = false;

  await drainProvisioning(deps, 40);

  const failed = await status(jar, workspaceId);
  expect(failed.lifecycleState).toBe('failed');
  expect(failed.error).toContain('gave up');
  expect(compute.liveInstances()).toEqual([]);
  expect(dns.liveRecords()).toEqual([]);
});

test('cleanup that cannot finish records the residue instead of dropping it', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Sticky')).json()) as WorkspaceView;

  await runProvisioningTick(deps); // -> credentials
  await runProvisioningTick(deps); // -> instance
  await runProvisioningTick(deps); // -> dns
  workspace.failNext('probeHealth');
  compute.failNext('terminateInstance');
  await runProvisioningTick(deps);

  const failed = await status(jar, workspaceId);
  expect(failed.lifecycleState).toBe('failed');
  expect(failed.error).toContain('manual cleanup still required: compute instance');
  // The DNS record it *could* release is released.
  expect(dns.liveRecords()).toEqual([]);
});

test('an instance still without an address is waited on, not failed', async () => {
  compute.assignPublicIpImmediately = false;
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Slow Address')).json()) as WorkspaceView;

  await runProvisioningTick(deps); // -> credentials
  await runProvisioningTick(deps); // -> instance
  expect(await runProvisioningTick(deps)).toBe('waiting');
  expect((await status(jar, workspaceId)).provisioningStep).toBe('instance');
  expect((await status(jar, workspaceId)).lifecycleState).toBe('provisioning');

  const ocid = compute.launches.length > 0 ? (await compute.findInstanceByName(instanceDisplayName(workspaceId)))!.ocid : '';
  compute.attachPublicIp(ocid, '203.0.113.77');
  await drainProvisioning(deps);

  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');
  expect(dns.upserts).toEqual([{ name: `slow-address.${WORKSPACE_DOMAIN}`, ipv4: '203.0.113.77' }]);
});

test('two reconcilers racing the same workspace still produce exactly one VM', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Contended')).json()) as WorkspaceView;

  // Interleave two reconcilers on the same fleet for the whole provision. The
  // lease makes the overlap rare; what makes it *safe* is that every effect is
  // keyed on the workspace id and looked up before it is created.
  const alice = { ...deps, owner: 'reconciler-alice' };
  const bob = { ...deps, owner: 'reconciler-bob' };
  for (let round = 0; round < 8; round += 1) {
    await Promise.all([runProvisioningTick(alice), runProvisioningTick(bob)]);
  }

  const after = await status(jar, workspaceId);
  expect(after.lifecycleState).toBe('running');
  expect(after.setupLink).not.toBeNull();
  expect(compute.liveInstances()).toHaveLength(1);
  expect(dns.liveRecords()).toHaveLength(1);
});

test('a reconciler whose lease expired mid-step cannot overwrite the new holder', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Stale Holder')).json()) as WorkspaceView;

  // Alice claims with a lease so short it is already gone by the time she writes.
  await runProvisioningTick({ ...deps, owner: 'alice', leaseSeconds: 0 });
  // Bob legitimately claims the same work and finishes it.
  await drainProvisioning({ ...deps, owner: 'bob' });
  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');

  // Alice's write from the step she no longer owns must not land.
  const stale = await advanceProvisioningStep(db, workspaceId, 'pending', { ociInstanceOcid: 'ocid1.instance.stale' }, 'alice');
  expect(stale).toBe(false);
  expect((await status(jar, workspaceId)).provisioningStep).toBe('running');
});

test('the fleet cap counts live workspaces, so failures do not wedge it shut', async () => {
  const jar = await signedInJar();
  // Fill the fleet, then make every one of them fail.
  for (let index = 0; index < FLEET_CAP; index += 1) {
    expect((await createWorkspace(jar, `Doomed ${index}`)).status).toBe(201);
  }
  compute.failNext('launchInstance');
  await drainProvisioning(deps, 60);
  await db.query(`UPDATE cp_workspaces SET lifecycle_state = 'failed', provisioning_step = 'failed'`);

  // A failed provision holds no instance, so it must not hold a slot either —
  // #40 ships no delete path, so counting them would wedge the fleet for good.
  expect((await createWorkspace(jar, 'After The Failures')).status).toBe(201);
});

test('the fleet cap refuses creation past the configured bound', async () => {
  const jar = await signedInJar();
  for (let index = 0; index < FLEET_CAP; index += 1) {
    expect((await createWorkspace(jar, `Capped ${index}`)).status).toBe(201);
  }
  const refused = await createWorkspace(jar, 'One Too Many');
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as any).error.code).toBe('fleet_cap_reached');
});

test('a repeated name gets its own subdomain rather than colliding', async () => {
  const jar = await signedInJar();
  const first = (await (await createWorkspace(jar, 'Same Name')).json()) as WorkspaceView;
  const second = (await (await createWorkspace(jar, 'Same Name')).json()) as WorkspaceView;
  expect(first.subdomain).toBe(`same-name.${WORKSPACE_DOMAIN}`);
  expect(second.subdomain).not.toBe(first.subdomain);
  expect(second.subdomain.startsWith(`same-name-`)).toBe(true);
});

test('workspace creation and status refuse anyone who is not the signed-in owner', async () => {
  const owner = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(owner, 'Private')).json()) as WorkspaceView;

  // No session at all.
  const anonymous = new CookieJar();
  expect((await request(anonymous, `/api/workspaces/${workspaceId}`)).status).toBe(401);
  expect((await createWorkspace(anonymous, 'Uninvited')).status).toBe(401);

  // A signed-in stranger is told it does not exist, not that it is forbidden.
  const stranger = await invitedJar(profile({ githubId: 7777, login: 'stranger-example' }));
  expect((await request(stranger, `/api/workspaces/${workspaceId}`)).status).toBe(404);

  // An id that cannot be a workspace is absent, not a 500 from the uuid parser.
  expect((await request(owner, '/api/workspaces/not-a-uuid')).status).toBe(404);

  // A session without the CSRF token cannot create.
  const noCsrf = await request(owner, '/api/workspaces', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'No CSRF' }),
  });
  expect(noCsrf.status).toBe(403);
});

test('a name that cannot become a subdomain is refused', async () => {
  const jar = await signedInJar();
  expect((await createWorkspace(jar, '')).status).toBe(400);
  expect((await createWorkspace(jar, '   ')).status).toBe(400);
  expect((await createWorkspace(jar, '!!!')).status).toBe(400);
  expect((await createWorkspace(jar, 'x'.repeat(121))).status).toBe(400);
});

test('the invite quota bounds one user, independently of the fleet cap', async () => {
  const operator = await signedInJar();
  const issued = await request(operator, '/api/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': operator.get('cp_csrf') ?? '' },
    body: JSON.stringify({ workspaceQuota: 2 }),
  });
  expect(issued.status).toBe(201);
  const { code, workspaceQuota } = (await issued.json()) as { code: string; workspaceQuota: number };
  expect(workspaceQuota).toBe(2);

  const guest = new CookieJar();
  await githubCallback(guest, profile({ githubId: 8888, login: 'guest-example' }));
  await request(guest, '/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `invite_code=${encodeURIComponent(code)}`,
  });

  expect((await createWorkspace(guest, 'Guest One')).status).toBe(201);
  expect((await createWorkspace(guest, 'Guest Two')).status).toBe(201);
  const refused = await createWorkspace(guest, 'Guest Three');
  expect(refused.status).toBe(409);
  expect(((await refused.json()) as any).error.code).toBe('invite_quota_reached');

  // The quota is per-invite, not global: the operator signed up without one and
  // is still bounded only by the fleet cap.
  expect((await createWorkspace(operator, 'Operator One')).status).toBe(201);
});

test('an invite defaults to a single workspace and refuses a nonsense quota', async () => {
  const operator = await signedInJar();
  const issue = (body: Record<string, unknown>) => request(operator, '/api/invites', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': operator.get('cp_csrf') ?? '' },
    body: JSON.stringify(body),
  });
  expect(((await (await issue({})).json()) as any).workspaceQuota).toBe(1);
  expect((await issue({ workspaceQuota: 0 })).status).toBe(400);
  expect((await issue({ workspaceQuota: 2.5 })).status).toBe(400);
  expect((await issue({ workspaceQuota: 101 })).status).toBe(400);
});

// ---------------------------------------------------------------------------
// The reconciler loop guard (#48). The interval guard assumed every tick
// settles; a probeHealth that never did left `ticking` true forever and froze
// provisioning for the whole fleet. The watchdog makes a wedged adapter call
// cost one tick, never the reconciler.
// ---------------------------------------------------------------------------

test('a health probe that never settles costs one tick, not the fleet: a second workspace still provisions', async () => {
  const jar = await signedInJar();
  const stuck = (await (await createWorkspace(jar, 'Stuck Boot')).json()) as WorkspaceView;
  // Walk only the stuck workspace to the probing step, so the hang is armed
  // before the healthy workspace even exists.
  await runProvisioningTick(deps);
  await runProvisioningTick(deps);
  await runProvisioningTick(deps);
  expect((await status(jar, stuck.workspaceId)).provisioningStep).toBe('dns');

  const healthy = (await (await createWorkspace(jar, 'Healthy Boot')).json()) as WorkspaceView;

  // The real incident: the transport's promise simply never settled. The fake
  // reproduces that exactly for the stuck workspace and stays normal for the rest.
  const hangingWorkspace: WorkspaceAdapter = {
    probeHealth: (baseUrl, ip) => (baseUrl === `https://${stuck.subdomain}` ? new Promise<boolean>(() => {}) : workspace.probeHealth(baseUrl, ip)),
    probeAgent: (baseUrl, ip) => workspace.probeAgent(baseUrl, ip),
    issueSetupLink: input => workspace.issueSetupLink(input),
  };
  const logged: string[] = [];
  const reconciler = createReconciler({ ...deps, workspace: hangingWorkspace }, { watchdogMs: 100, log: line => logged.push(line) });

  // First run claims the stuck workspace, wedges, and is abandoned by the
  // watchdog rather than awaited forever.
  expect(await reconciler.runOnce()).toBe('stalled');
  expect(logged.some(line => /stalled/.test(line))).toBe(true);

  // The guard reset: later runs keep reconciling, and the healthy workspace
  // reaches running while the stuck one sits leased to the abandoned tick.
  for (let run = 0; run < 8; run += 1) await reconciler.runOnce();
  expect((await status(jar, healthy.workspaceId)).lifecycleState).toBe('running');
  expect((await status(jar, stuck.workspaceId)).provisioningStep).toBe('dns');
});

// ---------------------------------------------------------------------------
// Observability (#48). The incident's journal was empty between service start
// and the freeze: a wedged reconciler was indistinguishable from an idle one.
// Provisioning now narrates itself — transitions, waits, failures — through an
// injected log, so the journal always shows where a provision is and why.
// ---------------------------------------------------------------------------

test('provisioning narrates every step transition, wait, and failure', async () => {
  const logged: string[] = [];
  const chatty: ProvisioningDeps = { ...deps, log: line => logged.push(line) };
  const jar = await signedInJar();

  const { workspaceId } = (await (await createWorkspace(jar, 'Chatty')).json()) as WorkspaceView;
  workspace.healthy = false; // first probe is a "not yet", like every real boot
  for (let tick = 0; tick < 5; tick += 1) await runProvisioningTick(chatty);
  workspace.healthy = true;
  await drainProvisioning(chatty);
  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');

  const mine = logged.filter(line => line.includes(workspaceId));
  const transitions = ['pending -> credentials', 'credentials -> instance', 'instance -> dns', 'dns -> health', 'health -> setup_link', 'setup_link -> running'];
  for (const transition of transitions) {
    expect(mine.some(line => line.includes(transition))).toBe(true);
  }
  expect(mine.some(line => line.includes('waiting for the workspace to answer over HTTPS'))).toBe(true);

  // A failure names its reason in the journal, not only in the registry row.
  logged.length = 0;
  const doomed = (await (await createWorkspace(jar, 'Doomed')).json()) as WorkspaceView;
  compute.failNext('launchInstance', 'fake launch refusal');
  await drainProvisioning(chatty);
  expect((await status(jar, doomed.workspaceId)).lifecycleState).toBe('failed');
  expect(logged.some(line => line.includes(doomed.workspaceId) && line.includes('failed'))).toBe(true);
});

// ---------------------------------------------------------------------------
// Platform embeddings: the workspace searches out of the box, on its own key.
// ---------------------------------------------------------------------------

test('a provisioned workspace carries its own spend-limited embedding key and nothing fleet-wide', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Embeds')).json()) as WorkspaceView;

  await drainProvisioning(deps);
  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');

  // Exactly one key, named for this workspace, capped.
  expect(embeddingKeys.mints).toEqual([{ name: embeddingKeyName(workspaceId) }]);
  const live = embeddingKeys.liveKeys();
  expect(live).toHaveLength(1);
  expect(live[0].limitUsd).toBe(5);

  // And it is that key — no other — that reached the VM, alongside the model and
  // dimensions that make search work with nothing the user ever configured.
  const cloudInit = compute.launches[0].cloudInit;
  expect(cloudInit).toMatch(/^\s*OPENROUTER_API_KEY=sk-or-v1-fake-1$/m);
  expect(cloudInit).toMatch(/^\s*GBRAIN_EMBEDDING_MODEL=openrouter:openai\/text-embedding-3-small$/m);
  expect(cloudInit).toMatch(/^\s*GBRAIN_EMBEDDING_DIMENSIONS=1536$/m);
});

test('two workspaces never share an embedding key', async () => {
  const jar = await signedInJar();
  const first = (await (await createWorkspace(jar, 'Alpha')).json()) as WorkspaceView;
  const second = (await (await createWorkspace(jar, 'Beta')).json()) as WorkspaceView;

  await drainProvisioning(deps);

  const keys = compute.launches.map(launch => /^\s*OPENROUTER_API_KEY=(.+)$/m.exec(launch.cloudInit)![1]);
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(2);
  expect(embeddingKeys.mints.map(mint => mint.name).sort()).toEqual(
    [embeddingKeyName(first.workspaceId), embeddingKeyName(second.workspaceId)].sort(),
  );
});

test('a failed provision revokes the embedding key rather than leaving it billable', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Doomed Embeds')).json()) as WorkspaceView;

  await runProvisioningTick(deps); // pending -> credentials, minting the key
  expect(embeddingKeys.liveKeys()).toHaveLength(1);
  compute.failNext('launchInstance');
  await drainProvisioning(deps);

  expect((await status(jar, workspaceId)).lifecycleState).toBe('failed');
  expect(embeddingKeys.liveKeys()).toEqual([]);
  expect(embeddingKeys.revoked).toHaveLength(1);
});

test('a key minted but never recorded is still found and revoked by name', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Lost Mint')).json()) as WorkspaceView;

  // The mint succeeded at OpenRouter; the row never learned the handle.
  await embeddingKeys.mintKey({ name: embeddingKeyName(workspaceId) });
  // Fail the very next step so cleanup runs with no embeddingTokenRef recorded.
  embeddingKeys.failNext('mintKey');
  await drainProvisioning(deps);

  expect((await status(jar, workspaceId)).lifecycleState).toBe('failed');
  expect(embeddingKeys.liveKeys()).toEqual([]);
});

test('cleanup that cannot revoke the key names it as residue instead of dropping it', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Sticky Key')).json()) as WorkspaceView;

  await runProvisioningTick(deps); // -> credentials
  compute.failNext('launchInstance');
  embeddingKeys.failNext('revokeKey');
  await drainProvisioning(deps);

  const failed = await status(jar, workspaceId);
  expect(failed.error).toContain('manual cleanup still required: OpenRouter embedding key');
});

test('the operator can meter one workspace, and nobody else can', async () => {
  const operator = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(operator, 'Metered')).json()) as WorkspaceView;
  await drainProvisioning(deps);
  embeddingKeys.recordUsage(embeddingKeys.liveKeys()[0].hash, 1.5);

  const metered = await request(operator, `/api/workspaces/${workspaceId}/usage`);
  expect(metered.status).toBe(200);
  expect(await metered.json()).toMatchObject({ workspaceId, embedding: { usageUsd: 1.5, limitUsd: 5, disabled: false } });

  // Not the owner's to read: it is the platform's account being metered.
  const member = await invitedJar(profile({ githubId: 4242, login: 'member-example' }));
  expect((await request(member, `/api/workspaces/${workspaceId}/usage`)).status).toBe(403);
  expect((await request(new CookieJar(), `/api/workspaces/${workspaceId}/usage`)).status).toBe(401);
});

test('an unreadable provider is reported as unavailable, never as zero spend', async () => {
  const operator = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(operator, 'Unreadable')).json()) as WorkspaceView;
  await drainProvisioning(deps);

  embeddingKeys.failNext('readUsage');
  const res = await request(operator, `/api/workspaces/${workspaceId}/usage`);
  expect(res.status).toBe(503);
  expect(((await res.json()) as any).error.code).toBe('usage_unavailable');
});

test('a rate-limited mint is waited on, not failed: a create survives a transient OpenRouter fault', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Rate Limited')).json()) as WorkspaceView;

  embeddingKeys.failNext('mintKey', 'openrouter returned 429', true);
  expect(await runProvisioningTick(deps)).toBe('waiting');
  expect((await status(jar, workspaceId)).provisioningStep).toBe('pending');

  await drainProvisioning(deps);
  expect((await status(jar, workspaceId)).lifecycleState).toBe('running');
});

test('a refused mint fails the workspace rather than retrying a rejection forever', async () => {
  const jar = await signedInJar();
  const { workspaceId } = (await (await createWorkspace(jar, 'Refused')).json()) as WorkspaceView;

  embeddingKeys.failNext('mintKey', 'openrouter returned 401');
  await drainProvisioning(deps);

  const failed = await status(jar, workspaceId);
  expect(failed.lifecycleState).toBe('failed');
  expect(failed.error).toContain('EmbeddingKeyError');
  expect(compute.liveInstances()).toEqual([]);
});
