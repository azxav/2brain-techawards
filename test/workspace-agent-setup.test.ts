/**
 * #68 Task 7 — the three closed GBrain gate endpoints that Caddy asks before it
 * lets anything reach the colocated OpenClaw runtime.
 *
 *   GET /api/workspace/v1/agent/runtime-health   the control plane's readiness proof
 *   GET /api/workspace/v1/agent/authorize        the browser route's forward_auth
 *   GET /api/workspace/v1/agent/native-ready     the native app/CLI route's forward_auth
 *
 * All three are gates, not APIs: they answer with a status and, for `authorize`,
 * exactly one identity header. They never redirect, never emit HTML, never emit
 * a body, and never trust anything the caller sent — the pinned Gateway's
 * trusted-proxy `requiredHeaders` is a PRESENCE check that never compares the
 * value, so a forged identity header that survived to the upstream would be a
 * full authentication bypass.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { hashWorkspaceSecret } from '../src/workspace/auth.ts';
import {
  AGENT_WARNING_REVISION,
  CLAUDE_FALLBACK_MODEL,
  CODEX_DEFAULT_MODEL,
  confirmAgentWarning,
  deriveAgentNativePassword,
  hasConfirmedAgentWarning,
  initializeBoundWorkspaceAgent,
  runAgentRuntimeOperationWorkerOnce,
} from '../src/workspace/agent-access.ts';
import { createWorkspaceInvitation } from '../src/workspace/memberships.ts';
import type {
  OpenClawControl,
  OpenClawImportableProvider,
  OpenClawProviderId,
  OpenClawProviderStatus,
} from '../src/workspace/openclaw-control.ts';
import {
  clearBindingReadiness,
  readinessFromBinding,
  resolveBoundWorkspaceId,
} from '../src/workspace/agent-binding.ts';
import {
  AGENT_AUTHORIZE_PATH,
  AGENT_NATIVE_READY_PATH,
  AGENT_RUNTIME_HEALTH_PATH,
} from '../src/workspace/agent-gate-paths.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { resetWorkspaceFoundationForTest } from './helpers/reset-workspace-foundation.ts';
import { pushEnv, withEnv } from './helpers/with-env.ts';

const TOKEN_SECRET = 'deployment-secret-for-agent-setup-tests';

let engine: PGLiteEngine;
let restoreTier: () => void;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
});

afterAll(async () => engine.disconnect());

beforeEach(async () => {
  // Default every test to the agent tier; the handful of tests that probe
  // brain-tier or off-tier behavior override via withEnv() around just their
  // own scope (see below), then this restore reverts to the pre-suite value.
  restoreTier = pushEnv({ GBRAIN_AGENT_TIER: 'true' });
  await resetWorkspaceFoundationForTest(engine);
  await initializeWorkspaceFoundation(engine);
  await engine.executeRaw("INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Test', now())");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-admin', 'admin@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('admin-1', 'workspace-1', 'identity-admin', 'administrator')");
  await engine.executeRaw("INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-member', 'member@example.test', now())");
  await engine.executeRaw("INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-member', 'member')");
});

afterEach(() => {
  restoreTier();
});

// ---------------------------------------------------------------------------
// A recording OpenClaw runtime. Only the four calls these gates make are
// implemented; anything else throwing is the point — a gate that reached for
// another capability would fail loudly rather than silently widen its surface.
// ---------------------------------------------------------------------------

class FakeControl implements OpenClawControl {
  healthy = true;
  accepted = new Set<string>();
  readonly verified: string[] = [];
  readonly rejectedProbes: string[] = [];
  runtimeHealthCalls = 0;
  /** Make `verifyNativePasswordRejected` lie the way a stale worker would. */
  previousStillAccepted = false;

  async runtimeHealth(): Promise<boolean> {
    this.runtimeHealthCalls += 1;
    if (this.healthy) return true;
    return false;
  }

  async verifyNativePassword(password: string): Promise<boolean> {
    this.verified.push(password);
    return this.accepted.has(password);
  }

  async verifyNativePasswordRejected(password: string): Promise<boolean> {
    this.rejectedProbes.push(password);
    if (this.previousStillAccepted) return false;
    return !this.accepted.has(password);
  }

  async applyNativePassword(): Promise<void> { throw new Error('not used by the gates'); }
  async configureGBrainMcp(): Promise<void> { throw new Error('not used by the gates'); }
  async probeGBrainWhoAmI(): Promise<never> { throw new Error('not used by the gates'); }
  // The parameters are declared even though this base ignores them, so the
  // Task 10 subclass below can override with the real signature.
  async importProviderCredential(
    _input: { provider: OpenClawImportableProvider; credential: string },
  ): Promise<void> { throw new Error('not used by the gates'); }
  /**
   * #68 Task 8. Left empty so the gate tests above keep the original
   * "reaching for another capability throws" behaviour, while the customer-API
   * tests below can seed real readings.
   */
  providers = new Map<OpenClawProviderId, OpenClawProviderStatus>();

  async getProviderStatus(provider: OpenClawProviderId): Promise<OpenClawProviderStatus> {
    const status = this.providers.get(provider);
    if (!status) throw new Error('not used by the gates');
    return status;
  }

  async listModels(): Promise<string[]> { throw new Error('not used by the gates'); }
  async probeModel(_model: string, _prompt: string): Promise<{ text: string }> {
    throw new Error('not used by the gates');
  }
  async probeDefaultAnswer(_prompt: string): Promise<{ text: string }> {
    throw new Error('not used by the gates');
  }
}

async function withServer(
  control: OpenClawControl | undefined,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(createWorkspaceRouter(engine, {
    requestId: () => 'req-agent-setup-1',
    tokenSecret: TOKEN_SECRET,
    openClawControl: control,
  }));
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

/** Bring the binding all the way to ready, exactly as the worker would. */
async function makeReady(nativeGeneration = 1): Promise<void> {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_bindings
        SET access_confirmed_revision=access_revision,
            mcp_verified_generation=mcp_generation,
            model_generation=1,
            codex_verified_generation=1, codex_verified_model=$1,
            claude_verified_generation=1, claude_verified_model=$2,
            answer_verified_generation=1, answer_verified_target='openclaw/default',
            native_password_generation=$3, native_password_applied_generation=$3,
            last_error_code=NULL, ready_at=now()
      WHERE workspace_id='workspace-1'`,
    [CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL, nativeGeneration],
  );
}

async function readyAt(): Promise<string | null> {
  const rows = await engine.executeRaw<{ ready_at: string | null }>(
    "SELECT ready_at FROM workspace_agent_runtime_bindings WHERE workspace_id='workspace-1'",
  );
  return rows[0]?.ready_at ?? null;
}

// The paths under test are the shared constants the router itself mounts, so a
// rename cannot pass here while the control-plane probe and the two Caddy
// forward_auth rewrites go on asking for the old paths.
const HEALTH = AGENT_RUNTIME_HEALTH_PATH;
const AUTHORIZE = AGENT_AUTHORIZE_PATH;
const NATIVE = AGENT_NATIVE_READY_PATH;

/**
 * The literal bytes, pinned once.
 *
 * Importing the constants everywhere else is what stops the router drifting from
 * the probe; this test is what stops BOTH drifting together away from the bash
 * that ships. `cloud/image/files/bin/gbrain-agent-finalize` hardcodes these
 * three strings and imports nothing, and `cloud/test/image-contract.test.ts`
 * asserts the finalizer against the same constants — so changing a value here
 * fails this test, and changing it in the finalizer fails that one.
 */
test('the gate paths are the exact strings the image and control plane pin', () => {
  expect(AGENT_RUNTIME_HEALTH_PATH).toBe('/api/workspace/v1/agent/runtime-health');
  expect(AGENT_AUTHORIZE_PATH).toBe('/api/workspace/v1/agent/authorize');
  expect(AGENT_NATIVE_READY_PATH).toBe('/api/workspace/v1/agent/native-ready');
});

/**
 * Every gate answer must be bodiless, uncached, non-HTML, and never a redirect —
 * refusals included, which is why the expected status is an argument rather than
 * an assumed success.
 */
async function assertGateShape(response: Response, expectedStatus: number): Promise<void> {
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('location')).toBeNull();
  const body = await response.text();
  expect(body).toBe('');
  expect(response.headers.get('content-type') ?? '').not.toContain('html');
}

// --- runtime-health --------------------------------------------------------

test('runtime-health answers 204 only when the loopback runtime proves itself', async () => {
  const control = new FakeControl();
  await withServer(control, async baseUrl => {
    const ok = await fetch(`${baseUrl}${HEALTH}`, { redirect: 'manual' });
    await assertGateShape(ok, 204);
    expect(control.runtimeHealthCalls).toBe(1);

    control.healthy = false;
    const down = await fetch(`${baseUrl}${HEALTH}`, { redirect: 'manual' });
    await assertGateShape(down, 503);
  });
});

test('runtime-health fails closed without an injected runtime or off the agent tier', async () => {
  await withServer(undefined, async baseUrl => {
    expect((await fetch(`${baseUrl}${HEALTH}`)).status).toBe(503);
  });
  await withEnv({ GBRAIN_AGENT_TIER: 'false' }, async () => {
    await withServer(new FakeControl(), async baseUrl => {
      expect((await fetch(`${baseUrl}${HEALTH}`)).status).toBe(503);
    });
  });
  await withEnv({ GBRAIN_AGENT_TIER: undefined }, async () => {
    await withServer(new FakeControl(), async baseUrl => {
      expect((await fetch(`${baseUrl}${HEALTH}`)).status).toBe(503);
    });
  });
});

test('runtime-health discloses nothing about the runtime it probed', async () => {
  const control = new FakeControl();
  await withServer(control, async baseUrl => {
    const response = await fetch(`${baseUrl}${HEALTH}`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    // No identity leaks outward either: this endpoint is unauthenticated by
    // design (Caddy never fronts it; the control plane dials it over TLS), so it
    // must not become an oracle for anything.
    expect(response.headers.get('x-gbrain-openclaw-user')).toBeNull();
  });
});

test('runtime-health treats a throwing runtime as down, never as an error page', async () => {
  const control = new FakeControl();
  control.runtimeHealth = async () => { throw new Error('boom'); };
  await withServer(control, async baseUrl => {
    const response = await fetch(`${baseUrl}${HEALTH}`, { redirect: 'manual' });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('');
  });
});

// --- authorize -------------------------------------------------------------

test('authorize returns 204 and exactly one identity header for a confirmed Administrator', async () => {
  await makeReady();
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'admin-1', revision: AGENT_WARNING_REVISION });
  const admin = await issueSession('admin-1');
  await withServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: admin.cookie }, redirect: 'manual' });
    expect(response.headers.get('X-GBrain-OpenClaw-User')).toBe('admin-1');
    await assertGateShape(response, 204);
  });
});

test('authorize refuses a caller with no GBrain session', async () => {
  await makeReady();
  await withServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${AUTHORIZE}`, { redirect: 'manual' });
    expect(response.headers.get('X-GBrain-OpenClaw-User')).toBeNull();
    await assertGateShape(response, 401);
  });
});

test('authorize refuses a Member who has not confirmed the current warning', async () => {
  await makeReady();
  const member = await issueSession('member-1');
  await withServer(new FakeControl(), async baseUrl => {
    const unconfirmed = await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: member.cookie }, redirect: 'manual' });
    expect(unconfirmed.headers.get('X-GBrain-OpenClaw-User')).toBeNull();
    await assertGateShape(unconfirmed, 403);

    // A confirmation of some OTHER revision is not a confirmation of this one.
    await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'member-1', revision: 'openclaw-shared-state-v0' });
    expect((await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: member.cookie } })).status).toBe(403);

    await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'member-1', revision: AGENT_WARNING_REVISION });
    const confirmed = await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: member.cookie }, redirect: 'manual' });
    expect(confirmed.status).toBe(204);
    expect(confirmed.headers.get('X-GBrain-OpenClaw-User')).toBe('member-1');
  });
});

test('before readiness only an Administrator passes; after readiness every active Member does', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  for (const membershipId of ['admin-1', 'member-1']) {
    await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId, revision: AGENT_WARNING_REVISION });
  }
  const admin = await issueSession('admin-1');
  const member = await issueSession('member-1');

  await withServer(new FakeControl(), async baseUrl => {
    // Not ready: the Administrator is doing the setup, the Member has nothing to
    // reach yet.
    expect((await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: admin.cookie } })).status).toBe(204);
    expect((await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: member.cookie } })).status).toBe(403);
  });

  await makeReady();
  await withServer(new FakeControl(), async baseUrl => {
    expect((await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: admin.cookie } })).status).toBe(204);
    const response = await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: member.cookie } });
    expect(response.status).toBe(204);
    expect(response.headers.get('X-GBrain-OpenClaw-User')).toBe('member-1');
  });
});

test('authorize never trusts an incoming identity, proxy, scope, or forwarded header', async () => {
  await makeReady();
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'member-1', revision: AGENT_WARNING_REVISION });
  const member = await issueSession('member-1');
  await withServer(new FakeControl(), async baseUrl => {
    const forged = {
      cookie: member.cookie,
      'X-GBrain-OpenClaw-User': 'admin-1',
      'X-GBrain-OpenClaw-Proxy': 'gbrain-browser-v1',
      'X-OpenClaw-Scopes': 'operator',
      'X-Forwarded-For': '127.0.0.1',
      forwarded: 'for=127.0.0.1',
    };
    const response = await fetch(`${baseUrl}${AUTHORIZE}`, { headers: forged, redirect: 'manual' });
    // The membership the SESSION proves, never the one the header claimed.
    expect(response.headers.get('X-GBrain-OpenClaw-User')).toBe('member-1');
    expect(response.headers.get('X-OpenClaw-Scopes')).toBeNull();
    expect(response.headers.get('X-GBrain-OpenClaw-Proxy')).toBeNull();
  });

  // …and a forged identity cannot substitute for a session at all.
  await withServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${AUTHORIZE}`, {
      headers: { 'X-GBrain-OpenClaw-User': 'admin-1', 'X-GBrain-OpenClaw-Proxy': 'gbrain-browser-v1' },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('X-GBrain-OpenClaw-User')).toBeNull();
  });
});

test('authorize refuses a disabled Membership even after readiness', async () => {
  await makeReady();
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'member-1', revision: AGENT_WARNING_REVISION });
  const member = await issueSession('member-1');
  await engine.executeRaw("UPDATE workspace_memberships SET status='disabled' WHERE membership_id='member-1'");
  await withServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: member.cookie } });
    expect(response.status).toBe(401);
    expect(response.headers.get('X-GBrain-OpenClaw-User')).toBeNull();
  });
});

// --- native-ready ----------------------------------------------------------

test('native-ready proves the current password works and the previous one does not', async () => {
  await makeReady(2);
  const control = new FakeControl();
  control.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 2));
  await withServer(control, async baseUrl => {
    const response = await fetch(`${baseUrl}${NATIVE}`, { redirect: 'manual' });
    await assertGateShape(response, 204);
  });
  expect(control.verified).toEqual([deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 2)]);
  expect(control.rejectedProbes).toEqual([deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1)]);
  expect(await readyAt()).not.toBeNull();
});

test('native-ready needs no cookie — native clients cannot present a browser session', async () => {
  await makeReady(1);
  const control = new FakeControl();
  control.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1));
  await withServer(control, async baseUrl => {
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(204);
  });
  // Generation 1 has no predecessor, so no old-password probe is possible.
  expect(control.rejectedProbes).toEqual([]);
});

test('native-ready closes ingress and clears ready_at when the runtime still accepts the old password', async () => {
  await makeReady(2);
  const control = new FakeControl();
  control.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 2));
  control.previousStillAccepted = true;
  expect(await readyAt()).not.toBeNull();
  await withServer(control, async baseUrl => {
    const response = await fetch(`${baseUrl}${NATIVE}`, { redirect: 'manual' });
    await assertGateShape(response, 503);
    // Caddy calls this on EVERY native request, so the failure side effect has
    // to be safe to repeat.
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(503);
  });
  expect(await readyAt()).toBeNull();
});

test('native-ready refuses when the runtime rejects the current derived password', async () => {
  await makeReady(1);
  const control = new FakeControl(); // accepts nothing
  await withServer(control, async baseUrl => {
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(503);
  });
  expect(await readyAt()).toBeNull();
});

test('native-ready refuses whenever the desired and applied generations disagree', async () => {
  // NOTE on what this does and does not isolate. The gate checks the generation
  // equality explicitly AND goes through `readinessFromBinding`, whose
  // `generationProven` already demands `verified === desired` exactly. So the
  // two guards are redundant TODAY and no HTTP-level test can separate them:
  // any state that fails one fails the other. The explicit check is kept as the
  // plan requires and for the same reason `advanceNativePasswordGenerationInTransaction`
  // keeps its redundant reset — it becomes load-bearing the moment
  // `generationProven` is loosened. The redundancy itself is locked below.
  await makeReady(2);
  await engine.executeRaw(
    "UPDATE workspace_agent_runtime_bindings SET native_password_applied_generation=1 WHERE workspace_id='workspace-1'",
  );
  const control = new FakeControl();
  // The runtime would happily prove BOTH candidate passwords; only the
  // generation comparison stands between that and open ingress.
  control.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1));
  control.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 2));
  await withServer(control, async baseUrl => {
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(503);
  });
  expect(await readyAt()).toBeNull();

  // An applied generation AHEAD of the desired one is malformed state, not
  // progress, and must fail closed the same way.
  await engine.executeRaw(
    "UPDATE workspace_agent_runtime_bindings SET native_password_applied_generation=3 WHERE workspace_id='workspace-1'",
  );
  await withServer(control, async baseUrl => {
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(503);
  });
});

test('the readiness projection the gate leans on really does demand exact generations', async () => {
  // This is the lock on the redundancy above: if `generationProven` is ever
  // loosened to `>=`, a stale applied generation would start reading as ready
  // and the gate's own explicit check would become the only thing holding the
  // line. Either way, one of these two tests fails.
  await makeReady(2);
  for (const applied of [0, 1, 3]) {
    await engine.executeRaw(
      'UPDATE workspace_agent_runtime_bindings SET native_password_applied_generation=$1 WHERE workspace_id=$2',
      [applied, 'workspace-1'],
    );
    const rows = await engine.executeRaw<Parameters<typeof readinessFromBinding>[0]>(
      `SELECT b.agent_id, b.access_revision, b.access_confirmed_revision, b.mcp_generation,
              b.mcp_verified_generation, b.model_generation, b.codex_verified_generation,
              b.codex_verified_model, b.claude_verified_generation, b.claude_verified_model,
              b.answer_verified_generation, b.answer_verified_target, b.native_password_generation,
              b.native_password_applied_generation, b.last_error_code,
              a.status agent_status, a.scope, p.access_mode
         FROM workspace_agent_runtime_bindings b
         LEFT JOIN workspace_agents a ON a.agent_id=b.agent_id AND a.workspace_id=b.workspace_id
         LEFT JOIN workspace_principal_source_policies p
                ON p.principal_kind='agent' AND p.principal_id=b.agent_id
        WHERE b.workspace_id='workspace-1'`,
    );
    const readiness = readinessFromBinding(rows[0]);
    expect(readiness.ready, `applied generation ${applied} must not read as ready`).toBe(false);
    expect(readiness.blockers).toContain('native_password_pending');
  }
});

/**
 * The two binding statements the gate leans on, owned by the binding module
 * rather than re-typed in the HTTP layer. The gate's own behaviour is proved by
 * the tests around this one; this locks the seam those tests run through.
 */
test('the binding module resolves the one bound Workspace and closes its readiness idempotently', async () => {
  expect(await resolveBoundWorkspaceId(engine)).toBeUndefined();
  await makeReady(1);
  expect(await resolveBoundWorkspaceId(engine)).toBe('workspace-1');
  expect(await readyAt()).not.toBeNull();

  await clearBindingReadiness(engine, 'workspace-1');
  expect(await readyAt()).toBeNull();
  // Safe to repeat: Caddy calls the gate that uses this on every native request.
  await clearBindingReadiness(engine, 'workspace-1');
  expect(await readyAt()).toBeNull();

  // Scoped by Workspace: a foreign ID clears nothing.
  await engine.executeRaw("UPDATE workspace_agent_runtime_bindings SET ready_at=now() WHERE workspace_id='workspace-1'");
  await clearBindingReadiness(engine, 'workspace-other');
  expect(await readyAt()).not.toBeNull();
});

test('native-ready refuses while overall readiness is false, whatever the password says', async () => {
  await makeReady(1);
  await engine.executeRaw(
    "UPDATE workspace_agent_runtime_bindings SET mcp_verified_generation=0 WHERE workspace_id='workspace-1'",
  );
  const control = new FakeControl();
  control.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1));
  await withServer(control, async baseUrl => {
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(503);
  });
  expect(await readyAt()).toBeNull();
});

test('native-ready refuses with no binding, no runtime, no secret, or off the agent tier', async () => {
  const control = new FakeControl();
  await withServer(control, async baseUrl => {
    // No binding at all.
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(503);
  });

  await makeReady(1);
  control.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1));
  await withServer(undefined, async baseUrl => {
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(503);
  });

  await withEnv({ GBRAIN_AGENT_TIER: 'false' }, async () => {
    await withServer(control, async baseUrl => {
      expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(503);
    });
  });
});

test('a forged Authorization or identity header cannot make native-ready pass', async () => {
  await makeReady(1);
  const control = new FakeControl(); // accepts nothing
  await withServer(control, async baseUrl => {
    const response = await fetch(`${baseUrl}${NATIVE}`, {
      headers: {
        authorization: `Bearer ${deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1)}`,
        'X-GBrain-OpenClaw-User': 'admin-1',
        'X-GBrain-OpenClaw-Proxy': 'gbrain-browser-v1',
        'X-OpenClaw-Scopes': 'operator',
      },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('X-GBrain-OpenClaw-User')).toBeNull();
  });
});

test('the gates never appear on a Brain-tier deployment as anything but closed', async () => {
  await withEnv({ GBRAIN_AGENT_TIER: undefined }, async () => {
    await makeReady(1);
    const admin = await issueSession('admin-1');
    await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'admin-1', revision: AGENT_WARNING_REVISION });
    await withServer(undefined, async baseUrl => {
      for (const path of [HEALTH, NATIVE]) {
        expect((await fetch(`${baseUrl}${path}`)).status).toBe(503);
      }
      const authorize = await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: admin.cookie } });
      expect(authorize.status).toBe(503);
      expect(authorize.headers.get('X-GBrain-OpenClaw-User')).toBeNull();
    });
  });
});

// ===========================================================================
// #68 Task 8 — the Agent customer APIs.
//
// These are the human surfaces, and every one of them is closed by a
// CONJUNCTION rather than a presence check. That distinction is this issue's
// recurring defect class, so each guard below is probed on its own: a test that
// only ever exercises the happy path cannot tell "the guard held" from "the
// guard was never reached".
// ===========================================================================

const CUSTOMER_ORIGIN = 'https://workspace.example.test';
const API = '/api/workspace/v1/agent';

/** Same server, plus the configured origin the native URL must be built from. */
async function withCustomerServer(
  control: OpenClawControl | undefined,
  run: (baseUrl: string) => Promise<void>,
  overrides: { allowedOrigin?: string; tokenSecret?: string } = {},
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use(createWorkspaceRouter(engine, {
    requestId: () => 'req-agent-customer-1',
    tokenSecret: 'tokenSecret' in overrides ? overrides.tokenSecret : TOKEN_SECRET,
    allowedOrigin: 'allowedOrigin' in overrides ? overrides.allowedOrigin : CUSTOMER_ORIGIN,
    openClawControl: control,
  }));
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

function authed(session: { cookie: string; csrf: string }, csrf = true): Record<string, string> {
  return {
    cookie: session.cookie,
    'content-type': 'application/json',
    // The router refuses a cross-origin state change before any route runs, so
    // every mutation here presents the configured origin. The origin guard is
    // proved by its own suite; these tests are about what comes after it.
    origin: CUSTOMER_ORIGIN,
    ...(csrf ? { 'x-csrf-token': session.csrf } : {}),
  };
}

/** Internal field names that must never reach a customer-facing answer. */
const NEVER_DISCLOSED_FIELDS = [
  'credential_id', 'credential_hash', 'token_hash', 'password_hash',
  'native_password_generation', 'mcp_generation', 'access_revision',
  'secret_fingerprint', 'last_error_code',
] as const;

/**
 * Everything the whole response is scanned for. A projection leaks by ADDING a
 * field, so the assertion has to be over the serialized body, not over a list
 * of fields someone remembered to check.
 *
 * The HEADERS are scanned on the same terms. A secret leaves through a header
 * exactly as easily as through a body — a `Location`, an ETag derived from the
 * payload, a diagnostic header someone added while debugging — and a scan that
 * reads only `response.text()` would call every one of those clean.
 */
async function assertNoSecretsLeak(response: Response, forbidden: string[]): Promise<unknown> {
  const text = await response.text();
  const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n');
  for (const needle of [...forbidden, ...NEVER_DISCLOSED_FIELDS]) {
    expect(text, `response body must not disclose ${needle}`).not.toContain(needle);
    expect(headers, `response headers must not disclose ${needle}`).not.toContain(needle);
  }
  return JSON.parse(text);
}

// --- GET /agent : the safe status projection --------------------------------

test('every active Member sees the safe Agent setup status', async () => {
  const member = await issueSession('member-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${API}`, { headers: { cookie: member.cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.request_id).toEqual(expect.any(String));
    expect(body.data.warning).toEqual({
      revision: AGENT_WARNING_REVISION,
      confirmed: false,
      shared_categories: [
        'conversations', 'memory', 'files', 'schedules',
        'model subscriptions and usage', 'browser sessions', 'credentials',
        'channels', 'GBrain Sources and Agent authority',
      ],
    });
    expect(body.data.setup).toEqual({ initialized: false, ready: false, blockers: ['agent_missing'] });
    expect(body.data.grant).toBeNull();
    expect(body.data.native).toEqual({ available: false });
    expect(body.data.channels).toEqual({ path: '/agent/', external_sender_warning_required: true });
    expect(body.data.backup).toEqual({ openclaw_included: false });
  });
});

test('the status projection refuses anyone without a session', async () => {
  await withCustomerServer(new FakeControl(), async baseUrl => {
    expect((await fetch(`${baseUrl}${API}`)).status).toBe(401);
  });
});

test('the grant appears only once bound, and reads confirmed only at the current revision', async () => {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-1',
  });
  const admin = await issueSession('admin-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const before = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: admin.cookie } })).json() as any;
    // The durable Agent begins at Read with No Source Access, unconfirmed.
    expect(before.data.grant).toEqual({
      scope: 'read', source_access: { mode: 'none', source_ids: [] }, confirmed: false,
    });

    await engine.executeRaw(
      "UPDATE workspace_agent_runtime_bindings SET access_confirmed_revision=access_revision WHERE workspace_id='workspace-1'",
    );
    const confirmed = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: admin.cookie } })).json() as any;
    expect(confirmed.data.grant.confirmed).toBe(true);

    // A widening bumps the revision; the OLD confirmation must not carry over.
    await engine.executeRaw(
      "UPDATE workspace_agent_runtime_bindings SET access_revision=access_revision+1 WHERE workspace_id='workspace-1'",
    );
    const stale = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: admin.cookie } })).json() as any;
    expect(stale.data.grant.confirmed).toBe(false);
  });
});

test('provider limits never fabricate availability from an absent or failed reading', async () => {
  const member = await issueSession('member-1');
  const control = new FakeControl();
  // Authenticated and comfortable.
  control.providers.set('openai', {
    authenticated: true, authStatus: 'ok',
    quota: { state: 'known', remainingPercent: 71, resetsAt: Date.UTC(2026, 6, 30) },
  });
  // Authenticated but nearly out.
  control.providers.set('anthropic', {
    authenticated: true, authStatus: 'expiring',
    quota: { state: 'known', remainingPercent: 4, resetsAt: null },
  });
  // `static` means an api_key ENTRY exists and says nothing about validity; the
  // adapter already reports it as unauthenticated and the projection must not
  // upgrade it. Its quota is unreadable, which is NOT the same as 0%.
  control.providers.set('openrouter', {
    authenticated: false, authStatus: 'static',
    quota: { state: 'unknown', remainingPercent: null, resetsAt: null },
  });

  await withCustomerServer(control, async baseUrl => {
    const body = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: member.cookie } })).json() as any;
    expect(body.data.providers.codex).toEqual({
      required: true, connected: true, model: CODEX_DEFAULT_MODEL,
      limits: { status: 'available', remaining_percent: 71, resets_at: new Date(Date.UTC(2026, 6, 30)).toISOString() },
    });
    expect(body.data.providers.claude).toEqual({
      required: true, connected: true, model: CLAUDE_FALLBACK_MODEL,
      limits: { status: 'limited', remaining_percent: 4, resets_at: null },
    });
    expect(body.data.providers.openrouter).toEqual({
      required: false, connected: false,
      limits: { status: 'unknown', remaining_percent: null, resets_at: null },
    });

    // Exhausted is a REAL zero reading, and must stay distinguishable from the
    // unreadable case above.
    control.providers.set('openai', {
      authenticated: true, authStatus: 'ok',
      quota: { state: 'known', remainingPercent: 0, resetsAt: null },
    });
    const exhausted = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: member.cookie } })).json() as any;
    expect(exhausted.data.providers.codex.limits)
      .toEqual({ status: 'exhausted', remaining_percent: 0, resets_at: null });
  });
});

test('a throwing provider read never becomes an error page or a raw upstream string', async () => {
  const member = await issueSession('member-1');
  const control = new FakeControl();
  control.getProviderStatus = async () => { throw new Error('openclaw said: token sk-live-DEADBEEF is invalid'); };
  await withCustomerServer(control, async baseUrl => {
    const response = await fetch(`${baseUrl}${API}`, { headers: { cookie: member.cookie } });
    expect(response.status).toBe(200);
    const body = await assertNoSecretsLeak(response, ['sk-live-DEADBEEF', 'openclaw said']) as any;
    for (const provider of ['codex', 'claude', 'openrouter']) {
      expect(body.data.providers[provider].connected).toBe(false);
      expect(body.data.providers[provider].limits.status).toBe('unknown');
    }
  });
});

test('the status projection discloses no credential, hash, generation, or fingerprint', async () => {
  await makeReady(3);
  const admin = await issueSession('admin-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'admin-1', revision: AGENT_WARNING_REVISION });
  await engine.executeRaw(
    "UPDATE workspace_agent_runtime_bindings SET native_password_secret_fingerprint='de10adde10adde10adde10adde10adde10adde10adde10adde10adde10adde10' WHERE workspace_id='workspace-1'",
  );
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${API}`, { headers: { cookie: admin.cookie } });
    await assertNoSecretsLeak(response, [
      'de10adde10adde10adde10adde10adde10adde10adde10adde10adde10adde10',
      deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 3),
      TOKEN_SECRET,
    ]);
  });
});

// --- warning acknowledgment -------------------------------------------------

test('warning acknowledgment requires CSRF and records only the server revision', async () => {
  const member = await issueSession('member-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const noCsrf = await fetch(`${baseUrl}${API}/warning-ack`, {
      method: 'POST', headers: authed(member, false),
    });
    expect(noCsrf.status).toBe(403);
    expect((await noCsrf.json() as any).error.code).toBe('csrf_or_session_invalid');

    // A caller-supplied revision is not read. If it were, this body would
    // record `v99` and the CURRENT revision would still be unconfirmed.
    const acked = await fetch(`${baseUrl}${API}/warning-ack`, {
      method: 'POST', headers: authed(member),
      body: JSON.stringify({ revision: 'openclaw-shared-state-v99' }),
    });
    expect(acked.status).toBe(204);
  });
  const rows = await engine.executeRaw<{ revision: string }>(
    'SELECT revision FROM workspace_agent_warning_confirmations WHERE membership_id=$1', ['member-1'],
  );
  expect(rows.map(row => row.revision)).toEqual([AGENT_WARNING_REVISION]);
});

test('a stale acknowledgment stops counting once the revision moves on', async () => {
  await makeReady(1);
  const member = await issueSession('member-1');
  await confirmAgentWarning(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', revision: 'openclaw-shared-state-v0',
  });
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const body = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: member.cookie } })).json() as any;
    expect(body.data.warning.confirmed).toBe(false);
    expect(body.data.native.available).toBe(false);
    const denied = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member.cookie } });
    expect(denied.status).toBe(409);
    expect((await denied.json() as any).error.code).toBe('agent_warning_required');
  });
});

// --- native access ----------------------------------------------------------

test('native details require active membership, the current warning, and readiness', async () => {
  const member = await issueSession('member-1');
  const control = new FakeControl();
  await withCustomerServer(control, async baseUrl => {
    // 1. No acknowledgment, no binding.
    const unacknowledged = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member.cookie } });
    expect(unacknowledged.status).toBe(409);
    expect((await unacknowledged.json() as any).error.code).toBe('agent_warning_required');

    // 2. Acknowledged, still not ready.
    expect((await fetch(`${baseUrl}${API}/warning-ack`, { method: 'POST', headers: authed(member) })).status).toBe(204);
    const notReady = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member.cookie } });
    expect(notReady.status).toBe(409);
    expect((await notReady.json() as any).error.code).toBe('agent_setup_incomplete');
  });

  // 3. Acknowledged AND ready.
  await makeReady(2);
  await withCustomerServer(control, async baseUrl => {
    const response = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member.cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const body = await response.json() as any;
    expect(body.data.url).toMatch(/^wss:\/\/.+\/agent-client\/$/);
    expect(body.data.url).toBe('wss://workspace.example.test/agent-client/');
    // The password is derived from the APPLIED generation and nothing else.
    expect(body.data.password).toBe(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 2));
  });
});

test('native access builds its URL from configuration, never from the request headers', async () => {
  await makeReady(1);
  const member = await issueSession('member-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'member-1', revision: AGENT_WARNING_REVISION });
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${API}/native-access`, {
      headers: {
        cookie: member.cookie,
        host: 'attacker.example.invalid',
        origin: 'https://attacker.example.invalid',
        'x-forwarded-host': 'attacker.example.invalid',
        'x-forwarded-proto': 'https',
      },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.data.url).toBe('wss://workspace.example.test/agent-client/');
    expect(body.data.url).not.toContain('attacker');
  });
});

test('native access fails closed when the origin is unconfigured or not HTTPS', async () => {
  await makeReady(1);
  const member = await issueSession('member-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'member-1', revision: AGENT_WARNING_REVISION });
  await withEnv({ GBRAIN_WORKSPACE_BASE_URL: undefined }, async () => {
    // Every case the guard's own comment claims to refuse: absent, empty,
    // unparseable, not HTTPS, userinfo, a path, a query, and a fragment. An
    // origin that is REPAIRED rather than refused decides which host a shared
    // password is handed to, so each one is fed in rather than assumed.
    for (const origin of [
      undefined, '', 'http://workspace.example.test', 'not a url',
      'https://user:pw@ws.example.test',
      'https://ws.example.test/nested',
      'https://ws.example.test/?a=1',
      'https://ws.example.test/#f',
    ]) {
      await withCustomerServer(new FakeControl(), async baseUrl => {
        const response = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member.cookie } });
        expect(response.status, `origin ${String(origin)} must not disclose a password`).toBe(503);
        expect((await response.json() as any).error.code).toBe('openclaw_runtime_unavailable');
      }, { allowedOrigin: origin });
    }
  });
});

/**
 * A pending rotation gets its OWN refusal, and this test names it exactly.
 *
 * An earlier draft asserted `expect([409, 503]).toContain(status)`, which is
 * the recurring presence-check class in test clothing: it proves that SOME
 * refusal happened, not that the rotation guard is what refused, and it passed
 * with that guard deleted. The guard is therefore evaluated before the general
 * readiness check in `nativeAvailability` — readiness subsumes it completely,
 * so any other ordering makes this status code unemittable.
 */
test('native access refuses with the rotation-pending code while a rotation has not landed', async () => {
  const member = await issueSession('member-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'member-1', revision: AGENT_WARNING_REVISION });

  // Desired ahead of applied: the ordinary in-flight rotation.
  await makeReady(2);
  await engine.executeRaw(
    "UPDATE workspace_agent_runtime_bindings SET native_password_generation=3 WHERE workspace_id='workspace-1'",
  );
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member.cookie } });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body).error.code).toBe('agent_native_rotation_pending');
    expect(JSON.parse(body).error.retryable).toBe(true);
    for (const generation of [1, 2, 3]) {
      expect(body).not.toContain(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', generation));
    }
  });

  // Applied AHEAD of desired is malformed state, not progress, and must fail
  // closed through the same refusal rather than reading as settled.
  await makeReady(2);
  await engine.executeRaw(
    "UPDATE workspace_agent_runtime_bindings SET native_password_applied_generation=5 WHERE workspace_id='workspace-1'",
  );
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member.cookie } });
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body).error.code).toBe('agent_native_rotation_pending');
    for (const generation of [1, 2, 5]) {
      expect(body).not.toContain(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', generation));
    }
  });

  // The third malformed case — a desired generation below 1, which has no
  // derivable password at all — cannot be reached through storage: a CHECK
  // constraint on workspace_agent_runtime_bindings.native_password_generation
  // rejects the UPDATE outright. The `desiredGeneration < 1` clause in
  // `nativeAvailability` is therefore defence in depth against a future schema
  // change, not a condition this suite can construct, and it is stated here
  // rather than left as an untested-looking branch.
  await makeReady(1);
  await expect(engine.executeRaw(
    "UPDATE workspace_agent_runtime_bindings SET native_password_generation=0, native_password_applied_generation=0 WHERE workspace_id='workspace-1'",
  )).rejects.toThrow();
});

test('native access refuses a disabled Membership even after acknowledgment and readiness', async () => {
  await makeReady(1);
  const member = await issueSession('member-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'member-1', revision: AGENT_WARNING_REVISION });
  await engine.executeRaw("UPDATE workspace_memberships SET status='disabled' WHERE membership_id='member-1'");
  await withCustomerServer(new FakeControl(), async baseUrl => {
    expect((await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member.cookie } })).status).toBe(401);
  });
});

test('native availability in the status projection agrees with the disclosure endpoint', async () => {
  await makeReady(1);
  const member = await issueSession('member-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const before = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: member.cookie } })).json() as any;
    expect(before.data.native.available).toBe(false);
    expect((await fetch(`${baseUrl}${API}/warning-ack`, { method: 'POST', headers: authed(member) })).status).toBe(204);
    const after = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: member.cookie } })).json() as any;
    expect(after.data.native.available).toBe(true);
    // …and the status projection still never carries the password itself.
    expect(JSON.stringify(after)).not.toContain(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1));
  });
});

// --- Administrator-only mutations -------------------------------------------

const ADMIN_ONLY: ReadonlyArray<{ method: string; path: string; body: unknown }> = [
  { method: 'POST', path: `${API}/initialize`, body: {} },
  { method: 'PUT', path: `${API}/grant`, body: { scope: 'write', source_access: { mode: 'all' }, reason: 'Grant the shared Agent write access.' } },
  { method: 'POST', path: `${API}/grant/confirm`, body: { reason: 'The Scope and Sources are correct.' } },
  { method: 'POST', path: `${API}/native/rotate`, body: { reason: 'Rotate the shared native password.' } },
  { method: 'POST', path: `${API}/operations/op-1/retry`, body: { reason: 'Repair the failed runtime operation.' } },
];

test('every Agent mutation is Administrator-only and CSRF-protected', async () => {
  await makeReady(1);
  const member = await issueSession('member-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    for (const route of ADMIN_ONLY) {
      const forbidden = await fetch(`${baseUrl}${route.path}`, {
        method: route.method, headers: authed(member), body: JSON.stringify(route.body),
      });
      expect(forbidden.status, `${route.method} ${route.path} must refuse a plain Member`).toBe(403);
      expect((await forbidden.json() as any).error.code).toBe('forbidden');

      const anonymous = await fetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: { 'content-type': 'application/json', origin: CUSTOMER_ORIGIN },
        body: JSON.stringify(route.body),
      });
      expect(anonymous.status, `${route.method} ${route.path} must refuse an anonymous caller`).toBe(401);
    }
  });

  const admin = await issueSession('admin-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    for (const route of ADMIN_ONLY) {
      const noCsrf = await fetch(`${baseUrl}${route.path}`, {
        method: route.method, headers: authed(admin, false), body: JSON.stringify(route.body),
      });
      expect(noCsrf.status, `${route.method} ${route.path} must require CSRF`).toBe(403);
      expect((await noCsrf.json() as any).error.code).toBe('csrf_or_session_invalid');
    }
  });
});

test('initialization creates the one durable Agent at Read with No Source Access, idempotently', async () => {
  const admin = await issueSession('admin-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const first = await fetch(`${baseUrl}${API}/initialize`, { method: 'POST', headers: authed(admin), body: '{}' });
    expect(first.status).toBe(200);
    const second = await fetch(`${baseUrl}${API}/initialize`, { method: 'POST', headers: authed(admin), body: '{}' });
    expect(second.status).toBe(200);
    const status = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: admin.cookie } })).json() as any;
    expect(status.data.grant).toEqual({
      scope: 'read', source_access: { mode: 'none', source_ids: [] }, confirmed: false,
    });
  });
  const agents = await engine.executeRaw("SELECT agent_id FROM workspace_agents WHERE workspace_id='workspace-1'");
  expect(agents.length).toBe(1);
});

test('the grant requires a reason and re-locks readiness until it is confirmed again', async () => {
  const admin = await issueSession('admin-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    expect((await fetch(`${baseUrl}${API}/initialize`, { method: 'POST', headers: authed(admin), body: '{}' })).status).toBe(200);

    const noReason = await fetch(`${baseUrl}${API}/grant`, {
      method: 'PUT', headers: authed(admin),
      body: JSON.stringify({ scope: 'write', source_access: { mode: 'all' } }),
    });
    expect(noReason.status).toBe(400);
    expect((await noReason.json() as any).error.code).toBe('reason_required');

    const badScope = await fetch(`${baseUrl}${API}/grant`, {
      method: 'PUT', headers: authed(admin),
      body: JSON.stringify({ scope: 'root', source_access: { mode: 'all' }, reason: 'Widen the shared Agent.' }),
    });
    expect(badScope.status).toBe(400);
    expect((await badScope.json() as any).error.code).toBe('invalid_agent_scope');

    const granted = await fetch(`${baseUrl}${API}/grant`, {
      method: 'PUT', headers: authed(admin),
      body: JSON.stringify({ scope: 'write', source_access: { mode: 'all' }, reason: 'Widen the shared Agent.' }),
    });
    expect(granted.status).toBe(200);
    const body = await granted.json() as any;
    expect(body.data.grant).toEqual({ scope: 'write', source_access: { mode: 'all', source_ids: [] }, confirmed: false });
    expect(body.data.setup.blockers).toContain('grant_unconfirmed');

    const confirmed = await fetch(`${baseUrl}${API}/grant/confirm`, {
      method: 'POST', headers: authed(admin),
      body: JSON.stringify({ reason: 'The Scope and Sources are correct.' }),
    });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json() as any).data.blockers).not.toContain('grant_unconfirmed');
  });
});

test('the grant refuses before the durable Agent exists', async () => {
  const admin = await issueSession('admin-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${API}/grant`, {
      method: 'PUT', headers: authed(admin),
      body: JSON.stringify({ scope: 'write', source_access: { mode: 'all' }, reason: 'Widen the shared Agent.' }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as any).error.code).toBe('agent_setup_incomplete');
  });
});

test('manual rotation advances the desired generation once per idempotency key', async () => {
  await makeReady(1);
  const admin = await issueSession('admin-1');
  const desired = async () => {
    const rows = await engine.executeRaw<{ native_password_generation: number }>(
      "SELECT native_password_generation FROM workspace_agent_runtime_bindings WHERE workspace_id='workspace-1'",
    );
    return Number(rows[0]!.native_password_generation);
  };
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const rotate = (key: string) => fetch(`${baseUrl}${API}/native/rotate`, {
      method: 'POST', headers: authed(admin),
      body: JSON.stringify({ reason: 'Rotate the shared native password.', idempotency_key: key }),
    });
    const first = await rotate('rotate-a');
    expect(first.status).toBe(202);
    const firstBody = await first.json() as any;
    expect(firstBody.data.operation_id).toEqual(expect.any(String));
    // The generation is a password input, never a response field.
    expect(JSON.stringify(firstBody)).not.toContain('generation');
    expect(await desired()).toBe(2);

    const replay = await rotate('rotate-a');
    expect(replay.status).toBe(202);
    expect((await replay.json() as any).data.operation_id).toBe(firstBody.data.operation_id);
    expect(await desired()).toBe(2);

    const second = await rotate('rotate-b');
    expect(second.status).toBe(202);
    expect(await desired()).toBe(3);
  });
});

test('retry repairs a failed current-generation operation and cannot revive a superseded one', async () => {
  await makeReady(1);
  const admin = await issueSession('admin-1');
  const operations = await engine.executeRaw<{ operation_id: string; operation_type: string; generation: number }>(
    "SELECT operation_id, operation_type, generation FROM workspace_agent_runtime_operations WHERE workspace_id='workspace-1' ORDER BY operation_type",
  );
  const mcp = operations.find(row => row.operation_type === 'mcp.configure')!;
  await engine.executeRaw(
    "UPDATE workspace_agent_runtime_operations SET state='failed' WHERE operation_id=$1", [mcp.operation_id],
  );

  await withCustomerServer(new FakeControl(), async baseUrl => {
    const retried = await fetch(`${baseUrl}${API}/operations/${mcp.operation_id}/retry`, {
      method: 'POST', headers: authed(admin),
      body: JSON.stringify({ reason: 'Repair the failed runtime operation.' }),
    });
    expect(retried.status).toBe(202);
    const state = await engine.executeRaw<{ state: string }>(
      'SELECT state FROM workspace_agent_runtime_operations WHERE operation_id=$1', [mcp.operation_id],
    );
    expect(state[0]!.state).toBe('queued');

    // Now supersede it: a newer desired generation retires this operation.
    await engine.executeRaw(
      "UPDATE workspace_agent_runtime_bindings SET mcp_generation=mcp_generation+1 WHERE workspace_id='workspace-1'",
    );
    await engine.executeRaw(
      "UPDATE workspace_agent_runtime_operations SET state='superseded' WHERE operation_id=$1", [mcp.operation_id],
    );
    const superseded = await fetch(`${baseUrl}${API}/operations/${mcp.operation_id}/retry`, {
      method: 'POST', headers: authed(admin),
      body: JSON.stringify({ reason: 'Repair the failed runtime operation.' }),
    });
    expect(superseded.status).toBe(404);
    expect((await superseded.json() as any).error.code).toBe('agent_operation_not_found');
    const after = await engine.executeRaw<{ state: string }>(
      'SELECT state FROM workspace_agent_runtime_operations WHERE operation_id=$1', [mcp.operation_id],
    );
    expect(after[0]!.state).toBe('superseded');
  });
});

test('retry never accepts a generation, an operation from another Workspace, or an unknown id', async () => {
  await makeReady(1);
  const admin = await issueSession('admin-1');
  const rows = await engine.executeRaw<{ operation_id: string; generation: number }>(
    "SELECT operation_id, generation FROM workspace_agent_runtime_operations WHERE workspace_id='workspace-1' AND operation_type='mcp.configure'",
  );
  const operationId = rows[0]!.operation_id;
  await engine.executeRaw("UPDATE workspace_agent_runtime_operations SET state='failed' WHERE operation_id=$1", [operationId]);
  // Retire the generation this operation belongs to.
  await engine.executeRaw(
    "UPDATE workspace_agent_runtime_bindings SET mcp_generation=99 WHERE workspace_id='workspace-1'",
  );

  await withCustomerServer(new FakeControl(), async baseUrl => {
    // A client-supplied generation matching the operation must not rescue it:
    // the desired generation is read from the binding and nowhere else.
    const forged = await fetch(`${baseUrl}${API}/operations/${operationId}/retry`, {
      method: 'POST', headers: authed(admin),
      body: JSON.stringify({
        reason: 'Repair the failed runtime operation.',
        generation: rows[0]!.generation,
        desired_generation: rows[0]!.generation,
      }),
    });
    expect(forged.status).toBe(404);

    const unknown = await fetch(`${baseUrl}${API}/operations/does-not-exist/retry`, {
      method: 'POST', headers: authed(admin),
      body: JSON.stringify({ reason: 'Repair the failed runtime operation.' }),
    });
    expect(unknown.status).toBe(404);
  });
  const state = await engine.executeRaw<{ state: string }>(
    'SELECT state FROM workspace_agent_runtime_operations WHERE operation_id=$1', [operationId],
  );
  expect(state[0]!.state).toBe('failed');
});

// --- Brain tier -------------------------------------------------------------

test('a Brain-tier deployment answers the not-found envelope on every Agent customer API', async () => {
  await makeReady(1);
  const admin = await issueSession('admin-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'admin-1', revision: AGENT_WARNING_REVISION });

  const routes: ReadonlyArray<{ method: string; path: string }> = [
    { method: 'GET', path: API },
    { method: 'GET', path: `${API}/native-access` },
    { method: 'POST', path: `${API}/warning-ack` },
    ...ADMIN_ONLY.map(route => ({ method: route.method, path: route.path })),
  ];
  await withEnv({ GBRAIN_AGENT_TIER: undefined }, async () => {
    await withCustomerServer(undefined, async baseUrl => {
      for (const route of routes) {
        const response = await fetch(`${baseUrl}${route.path}`, {
          method: route.method,
          headers: authed(admin),
          ...(route.method === 'GET' ? {} : { body: '{}' }),
        });
        expect(response.status, `${route.method} ${route.path} must be not-found on Brain tier`).toBe(404);
        const body = await response.json() as any;
        expect(body.error.code).toBe('not_found');
        expect(body.error.resource).toBe('agent');
        expect(body.error.retryable).toBe(false);
      }
    });
  });
});

/**
 * The password is derived, disclosed once, and recorded nowhere. Rotation and
 * disclosure both write durable evidence — an Audit Event and a queued
 * Operation — and neither may carry the credential those records are about.
 */
test('neither rotation nor disclosure ever writes the password into durable evidence', async () => {
  await makeReady(1);
  const admin = await issueSession('admin-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'admin-1', revision: AGENT_WARNING_REVISION });
  await withCustomerServer(new FakeControl(), async baseUrl => {
    expect((await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: admin.cookie } })).status).toBe(200);
    const rotated = await fetch(`${baseUrl}${API}/native/rotate`, {
      method: 'POST', headers: authed(admin),
      body: JSON.stringify({ reason: 'Rotate the shared native password.', idempotency_key: 'evidence-1' }),
    });
    expect(rotated.status).toBe(202);
  });

  const secrets = [1, 2].map(generation => deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', generation));
  for (const table of [
    'workspace_audit_events',
    'workspace_change_events',
    'workspace_agent_runtime_operations',
    'workspace_agent_runtime_bindings',
  ]) {
    const rows = await engine.executeRaw(`SELECT * FROM ${table}`);
    const dump = JSON.stringify(rows);
    for (const secret of secrets) {
      expect(dump, `${table} must not store the shared native password`).not.toContain(secret);
    }
    expect(dump, `${table} must not store the deployment secret`).not.toContain(TOKEN_SECRET);
  }
});

/**
 * The readiness clause of `native-access`, isolated.
 *
 * The bound Agent EXISTS and the Member has acknowledged the current warning,
 * so neither of the other two clauses can be what refuses: only readiness is
 * false. Without this the readiness check could be deleted outright and every
 * other native test would still pass, because they all reach the refusal
 * through the missing-binding clause instead. (Found by reverting the guard.)
 */
test('native access refuses a bound, acknowledged Workspace whose runtime is merely not ready', async () => {
  await makeReady(1);
  const member = await issueSession('member-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'member-1', revision: AGENT_WARNING_REVISION });

  // One blocker at a time, each on an otherwise fully ready binding.
  // Each blocker names the EXACT code it must produce. `grant_unconfirmed` is
  // the one a human resolves directly — an Administrator confirming the Scope
  // and Sources — so it carries its own mandated envelope rather than being
  // folded into the generic incomplete-setup refusal.
  const blockers: ReadonlyArray<[string, string, string]> = [
    ['mcp_unverified', 'mcp_verified_generation=0', 'agent_setup_incomplete'],
    ['grant_unconfirmed', 'access_confirmed_revision=0', 'agent_grant_confirmation_needed'],
    ['codex_unverified', "codex_verified_model='openai/some-other-model'", 'agent_setup_incomplete'],
    ['runtime_error', "last_error_code='openclaw_unreachable'", 'agent_setup_incomplete'],
  ];
  for (const [blocker, mutation, code] of blockers) {
    await makeReady(1);
    await engine.executeRaw(
      `UPDATE workspace_agent_runtime_bindings SET ${mutation} WHERE workspace_id='workspace-1'`,
    );
    await withCustomerServer(new FakeControl(), async baseUrl => {
      const status = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: member.cookie } })).json() as any;
      expect(status.data.setup.ready, `${blocker} must not read as ready`).toBe(false);
      expect(status.data.setup.blockers).toContain(blocker);
      expect(status.data.native.available, `${blocker} must close native availability`).toBe(false);

      const response = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member.cookie } });
      expect(response.status, `${blocker} must refuse native access`).toBe(409);
      const body = await response.json() as any;
      expect(body.error.code, `${blocker} must refuse with ${code}`).toBe(code);
      expect(body.error.retryable).toBe(false);
    });
  }
});

/**
 * The grant-confirmation refusal end to end, through the real endpoints rather
 * than a hand-written binding: widening the grant re-locks access, and only the
 * Administrator's explicit confirmation reopens it.
 */
test('a widened but unconfirmed grant refuses native access with its own code', async () => {
  const admin = await issueSession('admin-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'admin-1', revision: AGENT_WARNING_REVISION });
  await withCustomerServer(new FakeControl(), async baseUrl => {
    expect((await fetch(`${baseUrl}${API}/initialize`, { method: 'POST', headers: authed(admin), body: '{}' })).status).toBe(200);
    const granted = await fetch(`${baseUrl}${API}/grant`, {
      method: 'PUT', headers: authed(admin),
      body: JSON.stringify({ scope: 'write', source_access: { mode: 'all' }, reason: 'Widen the shared Agent.' }),
    });
    expect(granted.status).toBe(200);

    // Everything EXCEPT the grant confirmation is proven, so only the
    // unconfirmed grant can be what refuses.
    await engine.executeRaw(
      `UPDATE workspace_agent_runtime_bindings
          SET mcp_verified_generation=mcp_generation, model_generation=1,
              codex_verified_generation=1, codex_verified_model=$1,
              claude_verified_generation=1, claude_verified_model=$2,
              answer_verified_generation=1, answer_verified_target='openclaw/default',
              native_password_generation=1, native_password_applied_generation=1,
              last_error_code=NULL
        WHERE workspace_id='workspace-1'`,
      [CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL],
    );
    const refused = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: admin.cookie } });
    expect(refused.status).toBe(409);
    expect((await refused.json() as any).error.code).toBe('agent_grant_confirmation_needed');

    const confirmed = await fetch(`${baseUrl}${API}/grant/confirm`, {
      method: 'POST', headers: authed(admin),
      body: JSON.stringify({ reason: 'The Scope and Sources are correct.' }),
    });
    expect(confirmed.status).toBe(200);
    const allowed = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: admin.cookie } });
    expect(allowed.status).toBe(200);
    expect((await allowed.json() as any).data.password)
      .toBe(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1));
  });
});

/**
 * The refusal a real `PUT /grant` produces, with nothing hand-patched.
 *
 * This matters because a grant leaves TWO blockers set at once:
 * `setBoundAgentGrant` zeroes `mcp_verified_generation` in the same UPDATE that
 * bumps `access_revision`. The other tests here either hand-write
 * `mcp_verified_generation=mcp_generation` first or mutate one field at a time
 * from a fully ready binding, so neither ever sees the state the product
 * actually produces, and the precedence between the two blockers was decided by
 * iteration order rather than on purpose.
 */
test('a real grant leaves two blockers, and the caller is told the one they can act on', async () => {
  const admin = await issueSession('admin-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'admin-1', revision: AGENT_WARNING_REVISION });
  await withCustomerServer(new FakeControl(), async baseUrl => {
    expect((await fetch(`${baseUrl}${API}/initialize`, { method: 'POST', headers: authed(admin), body: '{}' })).status).toBe(200);
    // Bring everything the reconciler owns to proven, so the ONLY unproven
    // things after the grant below are the ones the grant itself resets.
    await engine.executeRaw(
      `UPDATE workspace_agent_runtime_bindings
          SET mcp_verified_generation=mcp_generation, model_generation=1,
              codex_verified_generation=1, codex_verified_model=$1,
              claude_verified_generation=1, claude_verified_model=$2,
              answer_verified_generation=1, answer_verified_target='openclaw/default',
              native_password_generation=1, native_password_applied_generation=1,
              last_error_code=NULL
        WHERE workspace_id='workspace-1'`,
      [CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL],
    );

    const granted = await fetch(`${baseUrl}${API}/grant`, {
      method: 'PUT', headers: authed(admin),
      body: JSON.stringify({ scope: 'write', source_access: { mode: 'all' }, reason: 'Widen the shared Agent.' }),
    });
    expect(granted.status).toBe(200);
    // Both blockers, exactly as the product produces them.
    expect((await granted.json() as any).data.setup.blockers)
      .toEqual(['grant_unconfirmed', 'mcp_unverified']);

    // The caller is told about the one THEY resolve, not the reconciler's work.
    const refused = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: admin.cookie } });
    expect(refused.status).toBe(409);
    const body = await refused.json() as any;
    expect(body.error.code).toBe('agent_grant_confirmation_needed');
    // …and the copy must not promise that confirming is the last step, because
    // the MCP reconfiguration below is still outstanding.
    expect(body.error.recovery).toContain('runtime then finishes applying it');

    // Confirming really does leave more to do — the refusal changes, it does
    // not disappear.
    const confirmed = await fetch(`${baseUrl}${API}/grant/confirm`, {
      method: 'POST', headers: authed(admin),
      body: JSON.stringify({ reason: 'The Scope and Sources are correct.' }),
    });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json() as any).data.blockers).toEqual(['mcp_unverified']);
    const stillRefused = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: admin.cookie } });
    expect(stillRefused.status).toBe(409);
    expect((await stillRefused.json() as any).error.code).toBe('agent_setup_incomplete');
  });
});

/**
 * `/initialize` must speak the same closed refusal vocabulary as its four
 * siblings. It was the one route whose catch omitted `sendAgentAccessError`, so
 * an `AgentAccessError` — which `enqueueAgentRuntimeOperation` and the losing
 * side of the uniqueness race both raise — surfaced as a generic 500
 * `internal_error` instead of a typed refusal.
 */
test('initialize maps a domain refusal onto the closed vocabulary, never internal_error', async () => {
  const admin = await issueSession('admin-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    // An operation row already holding this initialization's idempotency key
    // under a DIFFERENT type is exactly the `idempotency_conflict` the queue
    // raises, reached without stubbing anything.
    await engine.executeRaw(
      `INSERT INTO workspace_agent_runtime_operations
         (operation_id, workspace_id, operation_type, generation, request_id,
          idempotency_key, idempotency_fingerprint, state)
       VALUES ('op-clash', 'workspace-1', 'native_password.rotate', 1, 'req-seed',
               'initialize:mcp.configure:1', $1, 'queued')`,
      // A fingerprint of the right shape that cannot match the one the queue
      // derives, which is what makes this the conflict rather than a replay.
      ['0'.repeat(64)],
    );
    const response = await fetch(`${baseUrl}${API}/initialize`, {
      method: 'POST', headers: authed(admin), body: '{}',
    });
    expect(response.status).toBe(409);
    const body = await response.json() as any;
    expect(body.error.code).toBe('agent_operation_conflict');
    expect(body.error.code).not.toBe('internal_error');
    expect(body.error.request_id).toEqual(expect.any(String));
  });
});

// ===========================================================================
// #68 Task 9 — Member disablement, sessions, and native-password rotation as
// one atomic lifecycle, proved at the live HTTP seam.
// ===========================================================================

/**
 * A control that actually drives the `native_password.rotate` flow to
 * completion (unlike the gates-only `FakeControl` above, whose
 * `applyNativePassword` deliberately throws). Only the four calls
 * `runNativePasswordRotation` makes are implemented.
 */
class RotatingControl implements OpenClawControl {
  healthy = true;
  accepted = new Set<string>();
  readonly applied: string[] = [];

  async runtimeHealth(): Promise<boolean> { return this.healthy; }

  async applyNativePassword(password: string): Promise<void> {
    this.applied.push(password);
    this.accepted.clear();
    this.accepted.add(password);
  }

  async verifyNativePassword(password: string): Promise<boolean> {
    return this.accepted.has(password);
  }

  async verifyNativePasswordRejected(password: string): Promise<boolean> {
    return !this.accepted.has(password);
  }

  async configureGBrainMcp(): Promise<void> { throw new Error('not used by this control'); }
  async probeGBrainWhoAmI(): Promise<never> { throw new Error('not used by this control'); }
  async importProviderCredential(): Promise<void> { throw new Error('not used by this control'); }
  async getProviderStatus(): Promise<OpenClawProviderStatus> { throw new Error('not used by this control'); }
  async listModels(): Promise<string[]> { throw new Error('not used by this control'); }
  async probeModel(): Promise<{ text: string }> { throw new Error('not used by this control'); }
  async probeDefaultAnswer(): Promise<{ text: string }> { throw new Error('not used by this control'); }
}

async function addMember(membershipId: string, email: string): Promise<void> {
  await engine.executeRaw(
    'INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ($1,$2,now())',
    [`identity-${membershipId}`, email],
  );
  await engine.executeRaw(
    "INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ($1,'workspace-1',$2,'member')",
    [membershipId, `identity-${membershipId}`],
  );
}

test('disabling an active Member reaches the runtime synchronously: 200, the shared password rotates, and the old one stops working', async () => {
  await makeReady(1);
  await addMember('member-2', 'member2@example.test');
  for (const membershipId of ['admin-1', 'member-1', 'member-2']) {
    await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId, revision: AGENT_WARNING_REVISION });
  }
  const admin = await issueSession('admin-1');
  const member1 = await issueSession('member-1');
  const member2 = await issueSession('member-2');
  const control = new RotatingControl();
  const oldPassword = deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1);
  control.accepted.add(oldPassword);

  await withCustomerServer(control, async baseUrl => {
    // The soon-to-be-disabled Member's copy of the shared credential works
    // right up until the disable commits.
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(204);

    const disable = await fetch(`${baseUrl}/api/workspace/v1/memberships/member-1/status`, {
      method: 'PATCH', headers: authed(admin), body: JSON.stringify({ status: 'disabled', reason: 'Left the team.' }),
    });
    expect(disable.status).toBe(200);
    expect(await disable.json()).toMatchObject({ data: { status: 'disabled', native_access: 'rotated' } });

    // The reload is what disconnected the old password; no second restart, no
    // second rotation.
    expect(control.applied).toHaveLength(1);
    expect(control.accepted.has(oldPassword)).toBe(false);
    const newPassword = deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 2);
    expect(control.accepted.has(newPassword)).toBe(true);

    // The rotation already landed, so the gate is open again immediately.
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(204);

    // The disabled Member's session is dead — both membership status and the
    // explicit session revocation refuse it — and so is the GBrain gate.
    expect((await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member1.cookie } })).status).toBe(401);
    expect((await fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie: member1.cookie } })).status).toBe(401);
    expect(await engine.executeRaw(
      "SELECT session_hash FROM workspace_sessions WHERE membership_id='member-1' AND revoked_at IS NULL",
    )).toEqual([]);

    // A still-active Member reaches the SAME shared runtime with the NEW
    // password after acknowledging the warning — Task 9 rotates access, it
    // never revokes the other Members' shared standing.
    const access = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member2.cookie } });
    expect(access.status).toBe(200);
    expect((await access.json() as any).data.password).toBe(newPassword);
  });
});

test('repeating disabled is idempotent: no second rotation, sessions still revoked defensively', async () => {
  await makeReady(1);
  const admin = await issueSession('admin-1');
  const control = new RotatingControl();
  control.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1));

  await withCustomerServer(control, async baseUrl => {
    const first = await fetch(`${baseUrl}/api/workspace/v1/memberships/member-1/status`, {
      method: 'PATCH', headers: authed(admin), body: JSON.stringify({ status: 'disabled', reason: 'Left the team.' }),
    });
    expect(first.status).toBe(200);
    expect(control.applied).toHaveLength(1);

    // A session planted after the first disable must not survive the second.
    await engine.executeRaw(
      "INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at) VALUES ('replanted','member-1','replanted-csrf',now()+interval '1 day')",
    );
    const second = await fetch(`${baseUrl}/api/workspace/v1/memberships/member-1/status`, {
      method: 'PATCH', headers: authed(admin), body: JSON.stringify({ status: 'disabled', reason: 'Repeat.' }),
    });
    expect(second.status).toBe(204);
    expect(control.applied).toHaveLength(1);
    expect(await engine.executeRaw(
      "SELECT session_hash FROM workspace_sessions WHERE session_hash='replanted' AND revoked_at IS NULL",
    )).toEqual([]);
    const rows = await engine.executeRaw<{ native_password_generation: number }>(
      "SELECT native_password_generation FROM workspace_agent_runtime_bindings WHERE workspace_id='workspace-1'",
    );
    expect(rows[0]?.native_password_generation).toBe(2);
  });
});

test('when the runtime cannot reconcile synchronously, disablement still commits (202) and the durable worker finishes it', async () => {
  await makeReady(1);
  const admin = await issueSession('admin-1');
  const member1 = await issueSession('member-1');
  const stalled = new RotatingControl();
  stalled.healthy = false; // applyNativePassword succeeds, but the runtime never reports healthy again.
  stalled.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1));

  let operationId: string | undefined;
  await withCustomerServer(stalled, async baseUrl => {
    const disable = await fetch(`${baseUrl}/api/workspace/v1/memberships/member-1/status`, {
      method: 'PATCH', headers: authed(admin), body: JSON.stringify({ status: 'disabled', reason: 'Left the team.' }),
    });
    expect(disable.status).toBe(202);
    expect(await disable.json()).toMatchObject({ data: { status: 'disabled', native_access: 'rotation_pending' } });

    // The disable committed regardless: the Membership is disabled and the
    // session is gone, even though OpenClaw never reconciled.
    expect(await engine.executeRaw(
      "SELECT status FROM workspace_memberships WHERE membership_id='member-1'",
    )).toEqual([{ status: 'disabled' }]);
    expect(await engine.executeRaw(
      "SELECT session_hash FROM workspace_sessions WHERE membership_id='member-1' AND revoked_at IS NULL",
    )).toEqual([]);
    expect((await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member1.cookie } })).status).toBe(401);

    // Ingress is locked until reconciliation actually lands.
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(503);

    const pending = await engine.executeRaw<{ operation_id: string }>(
      "SELECT operation_id FROM workspace_agent_runtime_operations WHERE operation_type='native_password.rotate' AND generation=2",
    );
    operationId = pending[0]?.operation_id;
    expect(operationId).toBeString();
  });

  // The failed synchronous attempt backed the retry off into the near future;
  // the durable worker loop would simply see it again on its next pass, so
  // pull it back to immediately due rather than sleeping the test.
  await engine.executeRaw(
    "UPDATE workspace_agent_runtime_operations SET available_at=now() - interval '1 hour' WHERE operation_id=$1",
    [operationId],
  );

  // The request process is gone; the durable worker is what actually finishes
  // the rotation, with a runtime that has since recovered.
  const recovered = new RotatingControl();
  recovered.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1));
  const result = await runAgentRuntimeOperationWorkerOnce(engine, {
    workerId: 'durable-worker-1', tokenSecret: TOKEN_SECRET, control: recovered,
  });
  expect(result?.requestId).toBeString();
  expect(recovered.accepted.has(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 2))).toBe(true);

  await withCustomerServer(recovered, async baseUrl => {
    expect((await fetch(`${baseUrl}${NATIVE}`)).status).toBe(204);
  });
});

test('when reconciliation genuinely THROWS (not just returns a failed/pending outcome), disablement still commits: 202, membership disabled, session revoked, generation advanced', async () => {
  // The stalled-runtime test above (`runtimeHealth() === false`) only proves
  // the case `executeClaimedOperation` catches INTERNALLY and converts into a
  // `'failed'`/`'pending'` RETURN VALUE — `reconcileAgentRuntimeOperation`
  // never throws there. In fact every control-driven failure inside
  // `runNativePasswordRotation`/`runMcpConfigure` is caught by
  // `executeClaimedOperation`'s own try/catch, and even a lost lease inside
  // `failOperation` itself is swallowed back into a `'pending'` return value
  // (agent-runtime-queue.ts's `failOperation(...).catch(error => error
  // instanceof LeaseLostError ? 'pending' : throw)`). Verified this by direct
  // probe before writing this test: a control whose methods throw never
  // produces an uncaught rejection from `reconcileAgentRuntimeOperation` —
  // only a genuine fault BEFORE any of that recovery logic runs (i.e. in
  // `claimOperation` itself) does. That is exactly the class of failure the
  // router's catch (workspace-router.ts, "never roll back or reactivate ...
  // because OpenClaw is unavailable") exists for: an infrastructure fault
  // that also takes down the very query trying to claim the operation.
  // Reproduce it directly rather than assuming a control double can: rename
  // the column `claimOperation`'s own UPDATE writes, so the claim query
  // itself throws a genuine, uncaught SQL error.
  await makeReady(1);
  const admin = await issueSession('admin-1');
  const member1 = await issueSession('member-1');
  const control = new RotatingControl();
  control.accepted.add(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1));

  await engine.executeRaw(
    'ALTER TABLE workspace_agent_runtime_operations RENAME COLUMN lease_token TO lease_token_disabled_by_test',
  );
  try {
    await withCustomerServer(control, async baseUrl => {
      const disable = await fetch(`${baseUrl}/api/workspace/v1/memberships/member-1/status`, {
        method: 'PATCH', headers: authed(admin), body: JSON.stringify({ status: 'disabled', reason: 'Left the team.' }),
      });
      expect(disable.status).toBe(202);
      expect(await disable.json()).toMatchObject({ data: { status: 'disabled', native_access: 'rotation_pending' } });

      // The router's catch never let the throw roll back or reactivate the
      // Member: the disable already committed inside
      // setWorkspaceMembershipStatus's own transaction, before the
      // reconciliation attempt (and its fault) ever ran.
      expect(await engine.executeRaw(
        "SELECT status FROM workspace_memberships WHERE membership_id='member-1'",
      )).toEqual([{ status: 'disabled' }]);
      expect(await engine.executeRaw(
        "SELECT session_hash FROM workspace_sessions WHERE membership_id='member-1' AND revoked_at IS NULL",
      )).toEqual([]);
      const binding = await engine.executeRaw<{ native_password_generation: number }>(
        "SELECT native_password_generation FROM workspace_agent_runtime_bindings WHERE workspace_id='workspace-1'",
      );
      expect(binding[0]?.native_password_generation).toBe(2);
      expect((await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member1.cookie } })).status).toBe(401);
    });
  } finally {
    await engine.executeRaw(
      'ALTER TABLE workspace_agent_runtime_operations RENAME COLUMN lease_token_disabled_by_test TO lease_token',
    );
  }
});

// ===========================================================================
// #68 Task 10 — Administrator provider setup and the real readiness proofs,
// proved at the live HTTP seam.
//
// Readiness may only be granted by a real MCP proof and real model calls. A
// configured profile or an `authStatus` of `ok` is never enough, so nothing
// here reaches ready without every proof having actually been made.
// ===========================================================================

/** A control whose provider/model surface the Administrator routes exercise. */
class SetupControl extends FakeControl {
  models: string[] = [CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL];
  imports: { provider: string; credential: string }[] = [];
  probedModels: (string | null)[] = [];
  importError: Error | null = null;
  probeError: Error | null = null;
  answerText = '2BRAIN_AGENT_READY';

  override async importProviderCredential(
    input: { provider: OpenClawImportableProvider; credential: string },
  ): Promise<void> {
    this.imports.push({ provider: input.provider, credential: input.credential });
    if (this.importError) throw this.importError;
  }

  override async listModels(): Promise<string[]> { return [...this.models]; }

  override async probeModel(model: string): Promise<{ text: string }> {
    this.probedModels.push(model);
    if (this.probeError) throw this.probeError;
    return { text: 'answered' };
  }

  override async probeDefaultAnswer(): Promise<{ text: string }> {
    this.probedModels.push(null);
    if (this.probeError) throw this.probeError;
    return { text: this.answerText };
  }
}

const PROVIDERS = `${API}/providers`;
const SETUP_TOKEN = 'sk-ant-oat01-valid-fixture';

/**
 * Everything a ready binding needs EXCEPT the three model proofs. Deliberately
 * not `makeReady`: the point of these tests is that the model proofs have to be
 * earned by live calls.
 */
async function readyExceptModels(): Promise<void> {
  await initializeBoundWorkspaceAgent(engine, {
    workspaceId: 'workspace-1', ownerMembershipId: 'admin-1',
    actorMembershipId: 'admin-1', requestId: 'init-task10',
  });
  await engine.executeRaw(
    `UPDATE workspace_agent_runtime_bindings
        SET access_confirmed_revision=access_revision,
            mcp_verified_generation=mcp_generation,
            native_password_applied_generation=native_password_generation
      WHERE workspace_id='workspace-1'`,
  );
}

test('readiness requires real checks of both exact subscription models and a default answer', async () => {
  await readyExceptModels();
  const admin = await issueSession('admin-1');
  const control = new SetupControl();
  await withCustomerServer(control, async baseUrl => {
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: authed(admin), body: JSON.stringify(body),
    });
    const setup = async () => (await (await fetch(`${baseUrl}${API}`, {
      headers: { cookie: admin.cookie },
    })).json() as any).data.setup;

    expect((await post(`${PROVIDERS}/anthropic`, { setup_token: SETUP_TOKEN })).status).toBe(200);
    expect((await post(`${PROVIDERS}/check`, { provider: 'codex' })).status).toBe(200);
    expect((await setup()).blockers).toContain('claude_unverified');

    expect((await post(`${PROVIDERS}/check`, { provider: 'claude' })).status).toBe(200);
    expect((await setup()).blockers).toContain('answer_unverified');

    expect((await post(`${API}/answer-proof`, {})).status).toBe(200);
    expect(await setup()).toMatchObject({ ready: true, blockers: [] });
  });
  // The proofs really were live calls carrying the exact required overrides,
  // and the default-answer proof really did omit the override.
  expect(control.probedModels).toEqual([CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL, null]);
});

test('a catalog without the exact required model fails closed', async () => {
  await readyExceptModels();
  const admin = await issueSession('admin-1');
  const control = new SetupControl();
  control.models = ['openai/gpt-5.5', 'anthropic/claude-opus-5'];
  await withCustomerServer(control, async baseUrl => {
    const response = await fetch(`${baseUrl}${PROVIDERS}/check`, {
      method: 'POST', headers: authed(admin), body: JSON.stringify({ provider: 'codex' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'required_model_unavailable' } });
  });
  expect(control.probedModels).toEqual([]);
});

test('provider imports and checks are Administrator-only and CSRF-protected', async () => {
  await readyExceptModels();
  const routes: ReadonlyArray<{ path: string; body: unknown }> = [
    { path: `${PROVIDERS}/anthropic`, body: { setup_token: SETUP_TOKEN } },
    { path: `${PROVIDERS}/openrouter`, body: { api_key: 'sk-or-v1-fixture' } },
    { path: `${PROVIDERS}/check`, body: { provider: 'codex' } },
    { path: `${API}/answer-proof`, body: {} },
  ];
  const member = await issueSession('member-1');
  const control = new SetupControl();
  await withCustomerServer(control, async baseUrl => {
    for (const route of routes) {
      const forbidden = await fetch(`${baseUrl}${route.path}`, {
        method: 'POST', headers: authed(member), body: JSON.stringify(route.body),
      });
      expect(forbidden.status, `${route.path} must refuse a plain Member`).toBe(403);
      expect((await forbidden.json() as any).error.code).toBe('forbidden');

      const anonymous = await fetch(`${baseUrl}${route.path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: CUSTOMER_ORIGIN },
        body: JSON.stringify(route.body),
      });
      expect(anonymous.status, `${route.path} must refuse an anonymous caller`).toBe(401);
    }
  });
  const admin = await issueSession('admin-1');
  await withCustomerServer(control, async baseUrl => {
    for (const route of routes) {
      const noCsrf = await fetch(`${baseUrl}${route.path}`, {
        method: 'POST', headers: authed(admin, false), body: JSON.stringify(route.body),
      });
      expect(noCsrf.status, `${route.path} must require CSRF`).toBe(403);
      expect((await noCsrf.json() as any).error.code).toBe('csrf_or_session_invalid');
    }
  });
  // Not one refused call reached the runtime.
  expect(control.imports).toEqual([]);
  expect(control.probedModels).toEqual([]);
});

test('no provider secret ever appears in a response, an error, or durable evidence', async () => {
  await readyExceptModels();
  const admin = await issueSession('admin-1');
  const control = new SetupControl();
  const openRouterKey = 'sk-or-v1-openrouter-secret-fixture';
  await withCustomerServer(control, async baseUrl => {
    const ok = await fetch(`${baseUrl}${PROVIDERS}/anthropic`, {
      method: 'POST', headers: authed(admin), body: JSON.stringify({ setup_token: SETUP_TOKEN }),
    });
    await assertNoSecretsLeak(ok, [SETUP_TOKEN, 'setup_token']);

    const openrouter = await fetch(`${baseUrl}${PROVIDERS}/openrouter`, {
      method: 'POST', headers: authed(admin), body: JSON.stringify({ api_key: openRouterKey }),
    });
    await assertNoSecretsLeak(openrouter, [openRouterKey, 'api_key']);

    // A FAILING import must not echo it either.
    control.importError = new Error('openclaw_provider_import_failed');
    const failed = await fetch(`${baseUrl}${PROVIDERS}/anthropic`, {
      method: 'POST', headers: authed(admin), body: JSON.stringify({ setup_token: SETUP_TOKEN }),
    });
    expect(failed.status).toBe(503);
    const failedText = await failed.text();
    expect(failedText).not.toContain(SETUP_TOKEN);
    expect(JSON.parse(failedText).error.code).toBe('agent_provider_import_failed');
  });

  for (const table of [
    'workspace_agent_runtime_bindings', 'workspace_audit_events',
    'workspace_change_events', 'workspace_agent_runtime_operations',
  ]) {
    const rows = JSON.stringify(await engine.executeRaw(`SELECT * FROM ${table}`));
    expect(rows, `${table} must not carry the Anthropic setup token`).not.toContain(SETUP_TOKEN);
    expect(rows, `${table} must not carry the OpenRouter key`).not.toContain(openRouterKey);
  }
});

test('both credential routes forbid caching and referrer leakage of their answer', async () => {
  await readyExceptModels();
  const admin = await issueSession('admin-1');
  const control = new SetupControl();
  await withCustomerServer(control, async baseUrl => {
    for (const [path, body] of [
      [`${PROVIDERS}/anthropic`, { setup_token: SETUP_TOKEN }],
      [`${PROVIDERS}/openrouter`, { api_key: 'sk-or-v1-fixture' }],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: authed(admin), body: JSON.stringify(body),
      });
      expect(response.status, `${path} must have accepted the credential`).toBe(200);
      // A credential crossed this handler: the answer may not be stored by any
      // cache, and may not travel onward as a referrer from the setup screen.
      expect(response.headers.get('cache-control'), `${path} must forbid caching`).toBe('no-store');
      expect(
        response.headers.get('referrer-policy'), `${path} must forbid referrer leakage`,
      ).toBe('no-referrer');
    }
  });
});

test('a failed provider import records the failure and never a durable "connected" claim', async () => {
  await readyExceptModels();
  const admin = await issueSession('admin-1');
  const control = new SetupControl();
  const providerAudit = () => engine.executeRaw<{ action: string; outcome: string }>(
    `SELECT action, outcome FROM workspace_audit_events
      WHERE action LIKE 'agent.provider.%' ORDER BY occurred_at, event_id`,
  );
  const changeSummaries = async () => (await engine.executeRaw<{ summary: string }>(
    'SELECT summary FROM workspace_change_events',
  )).map(row => row.summary);
  const CONNECTED = 'Connected a shared runtime model provider.';

  await withCustomerServer(control, async baseUrl => {
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: authed(admin), body: JSON.stringify(body),
    });

    control.importError = new Error('openclaw_provider_import_failed');
    expect((await post(`${PROVIDERS}/anthropic`, { setup_token: SETUP_TOKEN })).status).toBe(503);
    expect((await post(`${PROVIDERS}/openrouter`, { api_key: 'sk-or-v1-fixture' })).status).toBe(503);

    // Neither import happened, so nothing may claim one did. The evidence is
    // written AFTER the adapter answers, so a failure is recorded as a failure.
    const failedOnly = await providerAudit();
    expect(failedOnly.filter(row => row.action === 'agent.provider.import')).toEqual([
      { action: 'agent.provider.import', outcome: 'failed' },
      { action: 'agent.provider.import', outcome: 'failed' },
    ]);
    expect(await changeSummaries()).not.toContain(CONNECTED);
    // The Anthropic attempt's LOCAL invalidation is a true, committed fact and
    // stays audited on its own action — that ordering is deliberate.
    expect(failedOnly).toContainEqual({ action: 'agent.provider.invalidate', outcome: 'succeeded' });

    // ...and a real import still records success on the same action.
    control.importError = null;
    expect((await post(`${PROVIDERS}/anthropic`, { setup_token: SETUP_TOKEN })).status).toBe(200);
    expect(await providerAudit()).toContainEqual({
      action: 'agent.provider.import', outcome: 'succeeded',
    });
    expect(await changeSummaries()).toContain(CONNECTED);
  });
});

test('a failed check never advances a proof and answers its own code', async () => {
  await readyExceptModels();
  const admin = await issueSession('admin-1');
  const control = new SetupControl();
  control.probeError = new Error('openclaw_probe_failed');
  await withCustomerServer(control, async baseUrl => {
    const check = await fetch(`${baseUrl}${PROVIDERS}/check`, {
      method: 'POST', headers: authed(admin), body: JSON.stringify({ provider: 'codex' }),
    });
    expect(check.status).toBe(503);
    // The SPECIFIC guard, not merely "a refusal fired": a catalog miss would
    // have answered 409 required_model_unavailable instead.
    expect((await check.json() as any).error.code).toBe('agent_model_check_failed');

    const proof = await fetch(`${baseUrl}${API}/answer-proof`, {
      method: 'POST', headers: authed(admin), body: '{}',
    });
    expect(proof.status).toBe(503);
    expect((await proof.json() as any).error.code).toBe('agent_answer_proof_failed');
  });
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT codex_verified_generation, answer_verified_generation, ready_at
       FROM workspace_agent_runtime_bindings WHERE workspace_id='workspace-1'`,
  );
  expect(Number(rows[0]!.codex_verified_generation)).toBe(0);
  expect(Number(rows[0]!.answer_verified_generation)).toBe(0);
  expect(rows[0]!.ready_at).toBeNull();
});

test('replacing the Anthropic credential re-locks readiness until every proof is redone', async () => {
  await readyExceptModels();
  const admin = await issueSession('admin-1');
  const control = new SetupControl();
  await withCustomerServer(control, async baseUrl => {
    const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: authed(admin), body: JSON.stringify(body),
    });
    const setup = async () => (await (await fetch(`${baseUrl}${API}`, {
      headers: { cookie: admin.cookie },
    })).json() as any).data.setup;

    await post(`${PROVIDERS}/check`, { provider: 'codex' });
    await post(`${PROVIDERS}/check`, { provider: 'claude' });
    await post(`${API}/answer-proof`, {});
    expect(await setup()).toMatchObject({ ready: true, blockers: [] });

    expect((await post(`${PROVIDERS}/anthropic`, { setup_token: SETUP_TOKEN })).status).toBe(200);
    expect((await setup()).blockers).toEqual(
      ['codex_unverified', 'claude_unverified', 'answer_unverified'],
    );

    // An OPTIONAL OpenRouter import in the same state changes nothing.
    expect((await post(`${PROVIDERS}/openrouter`, { api_key: 'sk-or-v1-fixture' })).status).toBe(200);
    expect((await setup()).blockers).toEqual(
      ['codex_unverified', 'claude_unverified', 'answer_unverified'],
    );

    await post(`${PROVIDERS}/check`, { provider: 'codex' });
    await post(`${PROVIDERS}/check`, { provider: 'claude' });
    await post(`${API}/answer-proof`, {});
    expect(await setup()).toMatchObject({ ready: true, blockers: [] });
  });
});

test('the provider routes accept only their own closed request shapes', async () => {
  await readyExceptModels();
  const admin = await issueSession('admin-1');
  const control = new SetupControl();
  await withCustomerServer(control, async baseUrl => {
    for (const provider of ['openrouter', 'anthropic', 'openai', '', null, 42]) {
      const response = await fetch(`${baseUrl}${PROVIDERS}/check`, {
        method: 'POST', headers: authed(admin), body: JSON.stringify({ provider }),
      });
      expect(response.status, `provider=${String(provider)} must be refused`).toBe(400);
      expect((await response.json() as any).error.code).toBe('invalid_provider');
    }
    for (const body of [{}, { setup_token: '' }, { setup_token: 42 }]) {
      const response = await fetch(`${baseUrl}${PROVIDERS}/anthropic`, {
        method: 'POST', headers: authed(admin), body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as any).error.code).toBe('invalid_provider_credential');
    }
    for (const body of [{}, { api_key: '  ' }, { api_key: [] }]) {
      const response = await fetch(`${baseUrl}${PROVIDERS}/openrouter`, {
        method: 'POST', headers: authed(admin), body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect((await response.json() as any).error.code).toBe('invalid_provider_credential');
    }
  });
  expect(control.imports).toEqual([]);
  expect(control.probedModels).toEqual([]);
});

test('an unconnected Codex subscription is given the no-VM native login instruction', async () => {
  // VERIFIED against pinned openclaw@2026.7.1-2, not assumed:
  //   dist/commands-registry.data-BKgJ3WoC.js:301-315 registers chat command key
  //     `login` with `textAlias: "/login"` and `choices: ["codex","openai"]`;
  //   dist/provider-auth-login-flow-runtime-Bgx33-w5.js:4-11 pins
  //     CODEX_LOGIN_METHOD = "device-code" and accepts the `codex` alias;
  //   docs/tools/slash-commands.md:205,478 documents `/login [codex|openai|
  //     openai-codex]` as owner/admin-only, usable from a private chat or the
  //     Web UI, which is where the device pairing code is delivered.
  // So the instruction shipped below names a command that really exists.
  await readyExceptModels();
  const member = await issueSession('member-1');
  const control = new SetupControl();
  control.providers.set('openai', {
    authenticated: false, authStatus: 'missing',
    quota: { state: 'unknown', remainingPercent: null, resetsAt: null },
  });
  await withCustomerServer(control, async baseUrl => {
    const body = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: member.cookie } })).json() as any;
    expect(body.data.providers.codex).toMatchObject({
      required: true,
      connected: false,
      model: CODEX_DEFAULT_MODEL,
      setup_path: '/agent/',
      instruction: 'Open Agent, start a chat, and send /login codex. Complete the device-code sign-in in your browser, then return here and run Check Codex.',
    });
    // Nothing about SSH or the VM is ever offered.
    const text = JSON.stringify(body);
    for (const forbidden of ['ssh', 'SSH', 'root@', 'systemctl']) {
      expect(text).not.toContain(forbidden);
    }
  });
});

test('a connected Codex subscription is no longer given setup instructions', async () => {
  await readyExceptModels();
  const member = await issueSession('member-1');
  const control = new SetupControl();
  control.providers.set('openai', {
    authenticated: true, authStatus: 'ok',
    quota: { state: 'known', remainingPercent: 88, resetsAt: null },
  });
  await withCustomerServer(control, async baseUrl => {
    const body = await (await fetch(`${baseUrl}${API}`, { headers: { cookie: member.cookie } })).json() as any;
    expect(body.data.providers.codex.connected).toBe(true);
    expect(body.data.providers.codex.setup_path).toBeUndefined();
    expect(body.data.providers.codex.instruction).toBeUndefined();
    // Limits stay inside the closed structured projection, never free text.
    expect(body.data.providers.codex.limits).toEqual({
      status: 'available', remaining_percent: 88, resets_at: null,
    });
  });
});

test('the provider routes answer the not-found envelope on a Brain-tier deployment', async () => {
  const admin = await issueSession('admin-1');
  await withEnv({ GBRAIN_AGENT_TIER: 'false' }, async () => {
    await withCustomerServer(new SetupControl(), async baseUrl => {
      for (const [path, body] of [
        [`${PROVIDERS}/anthropic`, { setup_token: SETUP_TOKEN }],
        [`${PROVIDERS}/openrouter`, { api_key: 'sk-or-v1-fixture' }],
        [`${PROVIDERS}/check`, { provider: 'codex' }],
        [`${API}/answer-proof`, {}],
      ] as const) {
        const response = await fetch(`${baseUrl}${path}`, {
          method: 'POST', headers: authed(admin), body: JSON.stringify(body),
        });
        expect(response.status, `${path} must be invisible on brain tier`).toBe(404);
        expect((await response.json() as any).error.code).toBe('not_found');
      }
    });
  });
});

test('the provider routes refuse before the durable Agent exists', async () => {
  const admin = await issueSession('admin-1');
  const control = new SetupControl();
  await withCustomerServer(control, async baseUrl => {
    for (const [path, body] of [
      [`${PROVIDERS}/anthropic`, { setup_token: SETUP_TOKEN }],
      [`${PROVIDERS}/check`, { provider: 'codex' }],
      [`${API}/answer-proof`, {}],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: authed(admin), body: JSON.stringify(body),
      });
      expect(response.status, `${path} must refuse an unbound Workspace`).toBe(409);
      expect((await response.json() as any).error.code).toBe('agent_setup_incomplete');
    }
  });
  expect(control.imports).toEqual([]);
  expect(control.probedModels).toEqual([]);
});

test('the provider routes fail closed when no runtime is injected', async () => {
  await readyExceptModels();
  const admin = await issueSession('admin-1');
  await withCustomerServer(undefined, async baseUrl => {
    for (const [path, body] of [
      [`${PROVIDERS}/anthropic`, { setup_token: SETUP_TOKEN }],
      [`${PROVIDERS}/check`, { provider: 'codex' }],
      [`${API}/answer-proof`, {}],
    ] as const) {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST', headers: authed(admin), body: JSON.stringify(body),
      });
      expect(response.status, `${path} must fail closed with no runtime`).toBe(503);
      expect((await response.json() as any).error.code).toBe('openclaw_runtime_unavailable');
    }
  });
});

// ===========================================================================
// #68 Task 11 — the served Agent page and the invitation acknowledgment.
//
// The page is the FIRST customer-visible surface for everything Tasks 8 and 10
// built, so it is tested the same way: at the HTTP boundary, over the bytes an
// actual browser receives. A rendered page proves nothing by containing a
// field NAME; every assertion below is over a value a customer can act on, or
// over the absence of a secret that must never be in the document at all.
// ===========================================================================

const AGENT_PAGE = '/app/agent';

async function servedPage(
  baseUrl: string, path: string, cookie: string,
): Promise<{ status: number; location: string | null; html: string }> {
  const response = await fetch(`${baseUrl}${path}`, { headers: { cookie }, redirect: 'manual' });
  return { status: response.status, location: response.headers.get('location'), html: await response.text() };
}

test('the served Agent page gives every active Member the shared-state warning and acknowledgment', async () => {
  const member = await issueSession('member-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const page = await servedPage(baseUrl, AGENT_PAGE, member.cookie);
    expect(page.status).toBe(200);
    expect(page.html).toContain('This Workspace uses one shared OpenClaw Agent. Every active Member can use it and may see or affect its conversations, memory, files, schedules, model subscriptions and usage, browser sessions, credentials, channels, and the GBrain Sources and authority granted to the Agent. Only connect channels whose external senders are allowed to use that shared authority.');
    expect(page.html).toContain('I understand this OpenClaw is shared with every active Workspace Member.');
    // The warning list is server DATA, read from the status API, not a second
    // hard-coded copy inside the page.
    expect(page.html).toContain('/api/workspace/v1/agent');
    expect(page.html).toContain('/api/workspace/v1/agent/warning-ack');
  });
});

test('a Member is served the checklist with no mutation control; an Administrator gets the controls', async () => {
  const member = await issueSession('member-1');
  const admin = await issueSession('admin-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const memberPage = (await servedPage(baseUrl, AGENT_PAGE, member.cookie)).html;
    const adminPage = (await servedPage(baseUrl, AGENT_PAGE, admin.cookie)).html;
    for (const step of [
      'Create the shared Agent.', 'Choose Scope and Source Access.', 'Confirm the current grant.',
      'Wait for the live GBrain MCP check.', 'Run Check Codex.', 'Run Check Claude.',
      'Run Prove default answer.',
    ]) {
      expect(memberPage, `a Member must still see "${step}"`).toContain(step);
    }
    for (const control of [
      'id="agent-initialize"', 'id="agent-grant-form"', 'id="agent-grant-confirm"',
      'id="agent-check-codex"', 'id="agent-check-claude"', 'id="agent-answer-proof"',
    ]) {
      expect(adminPage, `an Administrator must be served ${control}`).toContain(control);
      expect(memberPage, `a Member must never be served ${control}`).not.toContain(control);
    }
    // Setup is incomplete here. Provider connection and limit status must still
    // reach a Member: it lives before, and therefore outside, the hidden ready
    // section, so an exhausted subscription is visible during setup.
    for (const [label, page] of [['Member', memberPage], ['Administrator', adminPage]] as const) {
      const models = page.indexOf('id="agent-models"');
      const ready = page.indexOf('<section id="agent-ready"');
      expect(models, `a ${label} must be served provider status`).toBeGreaterThan(-1);
      expect(models, `a ${label} must see provider status while setup is incomplete`).toBeLessThan(ready);
      expect(page).toContain('Connected models');
    }
  });
});

test('the native password is never in the served page — only the click-time endpoint discloses it', async () => {
  await makeReady();
  await confirmAgentWarning(engine, {
    workspaceId: 'workspace-1', membershipId: 'member-1', revision: AGENT_WARNING_REVISION,
  });
  const password = deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 1);
  const member = await issueSession('member-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const page = await servedPage(baseUrl, AGENT_PAGE, member.cookie);
    expect(page.status).toBe(200);
    expect(page.html).not.toContain(password);
    // The reveal is a user gesture against the no-store endpoint.
    expect(page.html).toContain('/api/workspace/v1/agent/native-access');
    const disclosure = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: member.cookie } });
    expect(disclosure.status).toBe(200);
    expect(disclosure.headers.get('cache-control')).toBe('no-store');
    const body = await disclosure.json() as any;
    expect(body.data.password).toBe(password);
    expect(body.data.url).toBe('wss://workspace.example.test/agent-client/');
  });
});

test('a Brain-tier deployment serves the plural Agents page and never the shared Agent surface', async () => {
  const admin = await issueSession('admin-1');
  await withEnv({ GBRAIN_AGENT_TIER: 'false' }, async () => {
    await withCustomerServer(undefined, async baseUrl => {
      const agents = await servedPage(baseUrl, '/app/agents', admin.cookie);
      expect(agents.status).toBe(200);
      expect(agents.html).toContain('Register an Agent');
      const agent = await servedPage(baseUrl, AGENT_PAGE, admin.cookie);
      expect(agent.status).toBe(200);
      expect(agent.html).not.toContain('I understand this OpenClaw is shared');
      expect(agent.html).not.toContain('OpenClaw');
    });
  });
});

test('the Agent tier redirects the plural Agents path to the singular Agent page', async () => {
  const admin = await issueSession('admin-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const redirect = await servedPage(baseUrl, '/app/agents', admin.cookie);
    expect(redirect.status).toBe(303);
    expect(redirect.location).toBe(AGENT_PAGE);
  });
});

// --- the Agent-tier invitation acknowledgment -------------------------------

const REDEEM = '/api/workspace/v1/invitations/redeem';

async function invite(email: string, requestId: string): Promise<string> {
  return (await createWorkspaceInvitation(engine, {
    workspaceId: 'workspace-1', email, role: 'member', sourceAccess: { mode: 'none' },
    actorMembershipId: 'admin-1', requestId,
  })).token;
}

async function membershipFor(email: string): Promise<string> {
  const rows = await engine.executeRaw<{ membership_id: string }>(
    `SELECT m.membership_id FROM workspace_memberships m
       JOIN workspace_identities i ON i.identity_id=m.identity_id
      WHERE i.normalized_email=$1`,
    [email],
  );
  return rows[0]!.membership_id;
}

test('an Agent-tier invitation is refused before it is consumed when the acknowledgment is missing or false', async () => {
  const token = await invite('joiner@example.test', 'invite-http-1');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const headers = { 'content-type': 'application/json', origin: CUSTOMER_ORIGIN };
    for (const body of [
      { token, email: 'joiner@example.test' },
      { token, email: 'joiner@example.test', agent_warning_ack: false },
      { token, email: 'joiner@example.test', agent_warning_ack: 'true' },
    ]) {
      const response = await fetch(`${baseUrl}${REDEEM}`, { method: 'POST', headers, body: JSON.stringify(body) });
      expect(response.status, `${JSON.stringify(body)} must be refused`).toBe(409);
      expect((await response.json() as any).error.code).toBe('agent_warning_required');
    }
    // The invitation was never consumed by any of those refusals.
    expect(await engine.executeRaw('SELECT consumed_at FROM workspace_invitations WHERE consumed_at IS NOT NULL')).toEqual([]);
    const accepted = await fetch(`${baseUrl}${REDEEM}`, {
      method: 'POST', headers,
      body: JSON.stringify({ token, email: 'joiner@example.test', agent_warning_ack: true }),
    });
    expect(accepted.status).toBe(200);
  });
  const membershipId = await membershipFor('joiner@example.test');
  expect(await hasConfirmedAgentWarning(engine, 'workspace-1', membershipId, AGENT_WARNING_REVISION)).toBe(true);
});

test('the recorded revision is the server constant, whatever the browser claims', async () => {
  const token = await invite('claimer@example.test', 'invite-http-2');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const response = await fetch(`${baseUrl}${REDEEM}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: CUSTOMER_ORIGIN },
      body: JSON.stringify({
        token, email: 'claimer@example.test', agent_warning_ack: true,
        // A forged revision must have no effect at all.
        agent_warning_revision: 'openclaw-shared-state-v0',
        warning_revision: 'openclaw-shared-state-v99',
      }),
    });
    expect(response.status).toBe(200);
  });
  const membershipId = await membershipFor('claimer@example.test');
  expect(await engine.executeRaw('SELECT revision FROM workspace_agent_warning_confirmations WHERE membership_id=$1', [membershipId]))
    .toEqual([{ revision: AGENT_WARNING_REVISION }]);
});

test('a Brain-tier invitation needs no acknowledgment and records none', async () => {
  await withEnv({ GBRAIN_AGENT_TIER: 'false' }, async () => {
    const token = await invite('brain@example.test', 'invite-http-3');
    await withCustomerServer(undefined, async baseUrl => {
      const response = await fetch(`${baseUrl}${REDEEM}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: CUSTOMER_ORIGIN },
        body: JSON.stringify({ token, email: 'brain@example.test' }),
      });
      expect(response.status).toBe(200);
    });
  });
  expect(await engine.executeRaw('SELECT revision FROM workspace_agent_warning_confirmations')).toEqual([]);
});

test('the Agent-tier invitation page carries the warning and the required acknowledgment', async () => {
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const page = await fetch(`${baseUrl}/invitations/some-token`, { redirect: 'manual' });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('This Workspace uses one shared OpenClaw Agent.');
    expect(html).toContain('I understand this OpenClaw is shared with every active Workspace Member.');
    expect(html).toContain("agent_warning_ack:document.querySelector('#agent-warning-checkbox').checked");
    expect(html).not.toContain('agent_warning_ack:true');
  });
});

// --- the invitation page's own script, run against the real server ----------
//
// There is no DOM harness in this repo, so the acknowledgment path is proved by
// executing the EXACT script the browser is served against a minimal fake
// document and forwarding whatever it produces to the running server. That is
// the only way to prove the consent value the page sends is the checkbox's own
// `.checked`, and that an unchecked box is actually refused.

interface InvitationRun { requests: { body: any }[]; error: { textContent: string; hidden: boolean }; replaced: string[] }

async function runInvitationScript(
  baseUrl: string, html: string, checked: boolean, email: string,
): Promise<InvitationRun> {
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.lastIndexOf('</script>'));
  expect(script, 'the invitation page must serve a script').toContain('invitations/redeem');
  const run: InvitationRun = { requests: [], error: { textContent: '', hidden: true }, replaced: [] };
  const form = {
    // What the browser's FormData would collect from the rendered fields. The
    // acknowledgment checkbox has no `name`, so it is deliberately absent here:
    // its value can only reach the server through an explicit `.checked` read.
    fields: [['email', email]] as [string, string][],
    handler: null as null | ((event: unknown) => Promise<void>),
    addEventListener: (_type: string, handler: any) => { form.handler = handler; },
  };
  const nodes: Record<string, any> = {
    '#invitation-form': form,
    '#loading': { hidden: true },
    '#error': run.error,
    '#agent-warning-checkbox': { checked },
  };
  const fakeDocument = {
    querySelector: (selector: string) => {
      const node = nodes[selector];
      if (!node) throw new Error(`unexpected selector ${selector}`);
      return node;
    },
  };
  class FakeFormData {
    constructor(private readonly source: typeof form) {}
    [Symbol.iterator]() { return this.source.fields[Symbol.iterator](); }
  }
  const fakeFetch = async (path: string, init: any) => {
    run.requests.push({ body: JSON.parse(init.body) });
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { ...init.headers, origin: CUSTOMER_ORIGIN },
    });
  };
  const fakeSession = { setItem: () => {}, getItem: () => null };
  const fakeLocation = { replace: (target: string) => { run.replaced.push(target); } };
  // eslint-disable-next-line no-new-func
  new Function('document', 'FormData', 'fetch', 'sessionStorage', 'location', script)(
    fakeDocument, FakeFormData, fakeFetch, fakeSession, fakeLocation,
  );
  if (!form.handler) throw new Error('the invitation script registered no submit handler');
  await form.handler({ preventDefault: () => {} });
  return run;
}

test('an unchecked acknowledgment box is refused by the server and the invitation stays redeemable', async () => {
  const token = await invite('unchecked@example.test', 'invite-http-4');
  await withCustomerServer(new FakeControl(), async baseUrl => {
    const html = await (await fetch(`${baseUrl}/invitations/${token}`, { redirect: 'manual' })).text();

    const refused = await runInvitationScript(baseUrl, html, false, 'unchecked@example.test');
    // The page sent the box's own value, not a constant.
    expect(refused.requests).toHaveLength(1);
    expect(refused.requests[0]!.body.agent_warning_ack).toBe(false);
    // The server refused it, and the customer was told.
    expect(refused.error.hidden).toBe(false);
    expect(refused.error.textContent).toContain('The current shared-state warning has not been acknowledged.');
    expect(refused.replaced).toEqual([]);
    // Nothing was consumed: the invitation is still redeemable.
    expect(await engine.executeRaw('SELECT consumed_at FROM workspace_invitations WHERE consumed_at IS NOT NULL')).toEqual([]);
    expect(await engine.executeRaw('SELECT revision FROM workspace_agent_warning_confirmations')).toEqual([]);

    const accepted = await runInvitationScript(baseUrl, html, true, 'unchecked@example.test');
    expect(accepted.requests[0]!.body.agent_warning_ack).toBe(true);
    expect(accepted.replaced).toEqual(['/app']);
  });
  const membershipId = await membershipFor('unchecked@example.test');
  expect(await hasConfirmedAgentWarning(engine, 'workspace-1', membershipId, AGENT_WARNING_REVISION)).toBe(true);
});

test('the Brain-tier invitation page is unchanged and mentions no Agent at all', async () => {
  await withEnv({ GBRAIN_AGENT_TIER: 'false' }, async () => {
    await withCustomerServer(undefined, async baseUrl => {
      const html = await (await fetch(`${baseUrl}/invitations/some-token`, { redirect: 'manual' })).text();
      expect(html).toContain('Accept your invitation');
      expect(html).not.toContain('OpenClaw');
      expect(html).not.toContain('agent_warning_ack');
    });
  });
});

// ===========================================================================
// #68 Task 12 — approvals, model switching, and Channels stay in OpenClaw.
//
// The pilot's whole shared-agent design rests on GBrain owning IDENTITY
// (who may reach the runtime at all) and OpenClaw owning OPERATION (what the
// shared operator may then do). The failure mode this section exists to make
// impossible is the sympathetic one: someone adds a GBrain approval queue "so
// Members can see pending execs", or a GBrain channel form "so setup is
// easier", and the product quietly grows a second, weaker copy of a subsystem
// whose real fail-closed semantics live in the pinned runtime.
//
// Everything below is an ABSENCE proof. Absence proofs rot silently, so each
// one is anchored to something that is enumerated at runtime — the real
// schema, the real router stack — rather than to a string someone remembered
// to grep for.
//
// The pinned OpenClaw behaviours these absences depend on, verified against
// the `openclaw@2026.7.1-2` tarball:
//   - the operator scope set is `operator.read`, `operator.write`,
//     `operator.admin` (which satisfies the others), `operator.pairing`,
//     `operator.approvals`, `operator.talk.secrets`
//     [VERIFIED: package/docs/gateway/operator-scopes.md:32-39], and the
//     shared-secret/trusted-proxy default grant INCLUDES `operator.approvals`,
//     so the shared identity can answer approvals itself
//     [VERIFIED: package/docs/gateway/operator-scopes.md:112-115];
//   - `config.*` — which is what Channels edits and model switching go
//     through — always resolves to `operator.admin`
//     [VERIFIED: package/docs/gateway/protocol.md:238-241,415]. `models.list`
//     is NOT admin-scoped; it is an ordinary read gated by `operator.read`
//     [VERIFIED: package/docs/gateway/protocol.md:238-241];
//   - the first accepted approval response wins and later responders are
//     refused with "approval already resolved"
//     [VERIFIED: package/dist/server-aux-handlers-BfM3vWwc.js:1152-1165,
//     package/dist/approval-shared-BKEyXMsJ.js:282];
//   - an approval that times out DENIES (`deniedReason: "approval-timeout"`),
//     default `DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 1800000`
//     [VERIFIED: package/dist/server-aux-handlers-BfM3vWwc.js:1166-1179,
//     package/dist/exec-approvals-BIKWP8_V.js:187];
//   - automatic model fallback applies only when there is NO session model
//     override [VERIFIED: package/dist/agent-scope-B2Pk_xhT.js:281], and an
//     explicit override returns no fallback candidates — strict until reset,
//     the reset being the chat directive `/model default`
//     [VERIFIED: package/dist/agent-scope-B2Pk_xhT.js:282,
//     package/dist/directive-handling.model-selection-XLicBEnj.js:55].
//
// None of those are GBrain code paths, and that is the point: GBrain must own
// no table, no route, and no projection that would need to reimplement them.
// ===========================================================================

/** Every table the Workspace schema actually created, read from the catalog. */
async function workspaceTableNames(): Promise<string[]> {
  const rows = await engine.executeRaw<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name",
  );
  return rows.map(row => row.table_name);
}

test('the Workspace schema has no GBrain OpenClaw approval or channel tables', async () => {
  const tables = await workspaceTableNames();
  // Anti-vacuous: an empty or unmigrated catalog would make every filter below
  // trivially `[]`, which is how an absence proof reports success on nothing.
  // The two tables named here are the ones this issue actually added, so a
  // reset that silently stopped migrating fails HERE rather than passing.
  expect(tables).toContain('workspace_agent_runtime_bindings');
  expect(tables).toContain('workspace_agent_warning_confirmations');

  expect(tables.filter(name => name.includes('openclaw_approval'))).toEqual([]);
  expect(tables.filter(name => name.includes('openclaw_channel'))).toEqual([]);
  // The names above are the plan's literals. The rule is broader than the two
  // literals, so it is also expressed as the rule: nothing in this schema may
  // be a store of approvals or of channel configuration, whatever it is called.
  expect(tables.filter(name => /approval/i.test(name))).toEqual([]);
  expect(tables.filter(name => /channel/i.test(name))).toEqual([]);
});

/** A single layer of an Express `Router`'s internal `stack`. */
interface RouterLayer {
  route?: { path: unknown; methods: Record<string, boolean> };
  handle?: { stack?: RouterLayer[] };
}

/**
 * The Agent API surface, read out of the router Express actually built.
 *
 * A `fetch` that 404s proves one spelling is absent. This enumerates the whole
 * mounted surface, so a handler added under ANY spelling — `/approvals`,
 * `/exec-approvals`, `/channels/slack` — fails without anyone having guessed
 * its name in advance.
 *
 * `createWorkspaceRouter` mounts every route directly and flatly today
 * (verified: a single `express.Router()` call in `src/web/workspace-router.ts`,
 * with no `router.use(path, subRouter)` anywhere in that file) — so a
 * `layer.handle.stack` found while walking this router's own `stack` is, by
 * construction, a nested router that does not exist yet. A future
 * `router.use('/api/workspace/v1/agent/approvals', sub)` would create exactly
 * such a layer, and the top-level-only scan this function used to do would
 * walk straight past it: `layer.route` is undefined for a `.use()` layer, so
 * it was silently skipped.
 *
 * This walks into every `layer.handle.stack` recursively rather than skipping
 * it. It deliberately does NOT try to recover the nested router's absolute
 * mount path (e.g. reconstruct `/api/workspace/v1/agent/approvals` as a
 * string): Express 5, via the `router` package (router@2.2.0's `Layer`, see
 * node_modules/router/lib/layer.js), compiles each mount path into a
 * path-to-regexp matcher kept in a closure and exposes no literal path on the
 * `Layer` object ahead of a real match — `layer.path` is only populated as a
 * side effect of matching an actual request path, so there is nothing to read
 * statically. Re-deriving it would mean depending on path-to-regexp's compiled
 * output shape, which is exactly the kind of private-internals coupling that
 * breaks silently across router-package bumps.
 *
 * Instead, every route found under ANY nested router — anywhere in this
 * workspace router's tree, not only ones whose (unrecoverable) mount path
 * happens to start with `/agent` — is recorded as a synthetic `NESTED` entry
 * carrying its method and its path *relative to its own router*. Because this
 * router is flat by construction (nothing here mounts a sub-router today),
 * that synthetic entry is on its own enough to break the exact-set assertion
 * below for any sub-router addition, whether or not it happens to be mounted
 * under an agent-ish path — a strictly stronger guarantee than trying to
 * filter nested routes by a reconstructed prefix would have given us.
 */
function mountedAgentRoutes(): string[] {
  const router = createWorkspaceRouter(engine, {
    requestId: () => 'req-agent-policy-1',
    tokenSecret: TOKEN_SECRET,
    allowedOrigin: CUSTOMER_ORIGIN,
  }) as unknown as { stack: RouterLayer[] };
  const routes: string[] = [];
  collectRoutes(router.stack, routes, false);
  return routes.sort();
}

function collectRoutes(stack: RouterLayer[], routes: string[], nested: boolean): void {
  for (const layer of stack) {
    const route = layer.route;
    if (route && typeof route.path === 'string') {
      if (nested) {
        for (const method of Object.keys(route.methods)) {
          routes.push(`NESTED ${method.toUpperCase()} ${route.path}`);
        }
      } else if (/^\/api\/workspace\/v1\/agent(?:\/|$)/.test(route.path)) {
        for (const method of Object.keys(route.methods)) {
          routes.push(`${method.toUpperCase()} ${route.path}`);
        }
      }
      continue;
    }
    const nestedStack = layer.handle?.stack;
    if (Array.isArray(nestedStack)) collectRoutes(nestedStack, routes, true);
  }
}

/**
 * The exact shared-Agent surface. Pinned as a whole set, not as a list of
 * forbidden names: a contract shaped "these must be absent" is defeated by the
 * one spelling nobody thought of, while a contract shaped "the surface is
 * exactly this" refuses every addition, including the well-meaning ones.
 */
const AGENT_API_SURFACE = [
  'GET /api/workspace/v1/agent',
  'GET /api/workspace/v1/agent/authorize',
  'GET /api/workspace/v1/agent/native-access',
  'GET /api/workspace/v1/agent/native-ready',
  'GET /api/workspace/v1/agent/runtime-health',
  'POST /api/workspace/v1/agent/answer-proof',
  'POST /api/workspace/v1/agent/grant/confirm',
  'POST /api/workspace/v1/agent/initialize',
  'POST /api/workspace/v1/agent/native/rotate',
  'POST /api/workspace/v1/agent/operations/:operationId/retry',
  'POST /api/workspace/v1/agent/providers/anthropic',
  'POST /api/workspace/v1/agent/providers/check',
  'POST /api/workspace/v1/agent/providers/openrouter',
  'POST /api/workspace/v1/agent/warning-ack',
  'PUT /api/workspace/v1/agent/grant',
].sort();

test('the shared Agent API is exactly the pinned surface — no approvals, channels, or model-switching handler', () => {
  const mounted = mountedAgentRoutes();
  expect(mounted).toEqual(AGENT_API_SURFACE);
  // And the rule the exact set encodes, stated so a future edit to the list
  // above cannot smuggle one of these past review as "just another route".
  for (const forbidden of [/approval/i, /channel/i, /\/models?(?:\/|$)/i, /session\/model/i]) {
    expect(
      mounted.filter(route => forbidden.test(route)),
      `GBrain must mount no ${forbidden} route: that responsibility is OpenClaw's`,
    ).toEqual([]);
  }
});

test('an Administrator asking GBrain for approvals or channels is answered by nothing at all', async () => {
  await makeReady(1);
  const admin = await issueSession('admin-1');
  await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId: 'admin-1', revision: AGENT_WARNING_REVISION });
  await withCustomerServer(new FakeControl(), async baseUrl => {
    // The status projection is the one place a Member reads Agent state, and it
    // is what a GBrain approval queue or channel list would have to appear in.
    const status = await fetch(`${baseUrl}${API}`, { headers: { cookie: admin.cookie } });
    expect(status.status).toBe(200);
    const body = await status.json() as any;

    // GBrain's `channels` field is a SIGNPOST, not a subsystem: where to go in
    // OpenClaw, and the fact that the external-sender warning applies. Pinned as
    // an exact shape, because the way this grows into a channel configuration
    // API is one harmless-looking extra key at a time — a `connected` list, a
    // `providers` array, a `webhook_url`.
    expect(body.data.channels).toEqual({ path: '/agent/', external_sender_warning_required: true });

    const projection = JSON.stringify(body);
    for (const absent of ['approval', 'pending_exec', 'model_override', 'webhook', 'sender_allowlist']) {
      expect(projection, `the Agent status projection must not carry ${absent}`).not.toContain(absent);
    }

    for (const path of [`${API}/approvals`, `${API}/channels`, `${API}/models`, `${API}/session/model`]) {
      for (const method of ['GET', 'POST'] as const) {
        const response = await fetch(`${baseUrl}${path}`, {
          method,
          headers: authed(admin),
          ...(method === 'GET' ? {} : { body: '{}' }),
        });
        // 404 from the app itself, having matched no handler. Not 401/403 —
        // those would mean a handler exists and merely refused this caller.
        expect(response.status, `${method} ${path} must match no handler`).toBe(404);
      }
    }
  });
});

/**
 * The rejected design, stated as a test.
 *
 * Per-Member OpenClaw RBAC was considered and rejected: the pilot issues ONE
 * shared native password and one shared operator identity, so a Member-specific
 * OpenClaw credential or a role-mapping header would be a promise the runtime
 * cannot keep. What GBrain's browser gate does instead is narrower and honest —
 * it says WHICH Membership is at the door, and nothing about what that
 * Membership may do once inside.
 */
test('all warning-confirmed active Members receive the same browser auth contract', async () => {
  await makeReady(1);
  for (const membershipId of ['admin-1', 'member-1']) {
    await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId, revision: AGENT_WARNING_REVISION });
  }
  const adminSession = await issueSession('admin-1');
  const memberSession = await issueSession('member-1');

  await withServer(new FakeControl(), async baseUrl => {
    const authorizeAgentBrowser = (cookie: string) =>
      fetch(`${baseUrl}${AUTHORIZE}`, { headers: { cookie }, redirect: 'manual' });
    const administrator = await authorizeAgentBrowser(adminSession.cookie);
    const member = await authorizeAgentBrowser(memberSession.cookie);

    // Same answer, same status: the Administrator gets no wider door.
    expect(administrator.status).toBe(204);
    expect(member.status).toBe(204);

    // The one header that differs is the attribution, and it differs because it
    // is the Membership id — not a role, not a scope, not a capability.
    expect(administrator.headers.get('x-gbrain-openclaw-user')).not.toBe(
      member.headers.get('x-gbrain-openclaw-user'),
    );
    expect(administrator.headers.get('x-gbrain-openclaw-user')).toBe('admin-1');
    expect(member.headers.get('x-gbrain-openclaw-user')).toBe('member-1');

    // Every OTHER header is byte-identical. A role-mapping header, a per-Member
    // scope set, or a Member-specific credential would show up here as a
    // difference, whatever it was called.
    const withoutIdentity = (response: Response) =>
      [...response.headers]
        .filter(([name]) => name.toLowerCase() !== 'x-gbrain-openclaw-user' && name.toLowerCase() !== 'date')
        .map(([name, value]) => `${name.toLowerCase()}: ${value}`)
        .sort();
    expect(withoutIdentity(administrator)).toEqual(withoutIdentity(member));
    // Named explicitly, because these are the exact shapes the brief forbids.
    for (const banned of ['x-gbrain-openclaw-role', 'x-openclaw-scopes', 'x-gbrain-openclaw-password']) {
      expect(administrator.headers.get(banned), `${banned} must never be issued`).toBeNull();
      expect(member.headers.get(banned), `${banned} must never be issued`).toBeNull();
    }
  });
});

/**
 * The shared native password is derived from the Workspace and its generation
 * ONLY. A per-Member credential would have to be derived from the Membership,
 * so proving the derivation ignores identity proves the credential is shared —
 * which is the honest, documented pilot behaviour and the reason the product
 * copy has to warn about it.
 */
test('the native credential is one shared secret per generation, never one per Member', async () => {
  await makeReady(2);
  const shared = deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 2);
  const adminSession = await issueSession('admin-1');
  const memberSession = await issueSession('member-1');
  for (const membershipId of ['admin-1', 'member-1']) {
    await confirmAgentWarning(engine, { workspaceId: 'workspace-1', membershipId, revision: AGENT_WARNING_REVISION });
  }

  const control = new FakeControl();
  control.accepted.add(shared);
  await withCustomerServer(control, async baseUrl => {
    const disclosures: any[] = [];
    for (const session of [adminSession, memberSession]) {
      const response = await fetch(`${baseUrl}${API}/native-access`, { headers: { cookie: session.cookie } });
      expect(response.status).toBe(200);
      disclosures.push((await response.json() as any).data);
    }
    // Byte-identical, both of them, and equal to the Workspace-and-generation
    // derivation that carries no Membership input at all.
    expect(disclosures[0].password).toBe(shared);
    expect(disclosures[1].password).toBe(shared);
    expect(disclosures[0].url).toBe(disclosures[1].url);
  });
  // The derivation itself: swap only the Workspace or only the generation and
  // the secret moves; there is no Membership parameter to swap.
  expect(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-1', 3)).not.toBe(shared);
  expect(deriveAgentNativePassword(TOKEN_SECRET, 'workspace-2', 2)).not.toBe(shared);
});
