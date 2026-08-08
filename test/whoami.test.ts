/**
 * whoami op contract tests — pins the v0.28 transport-detection shape.
 *
 * The test surface is the op's handler called against synthesized
 * OperationContext rather than the full HTTP stack — keeps the test pure
 * and fast. End-to-end coverage (real HTTP MCP) lives in
 * test/e2e/serve-http-oauth.test.ts and test/e2e/sources-remote-mcp.test.ts.
 */

import { test, expect, describe } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, AuthInfo } from '../src/core/operations.ts';

const whoami = operations.find(o => o.name === 'whoami')!;

function ctxWith(overrides: Partial<OperationContext>): OperationContext {
  // Shape exposes only what whoami reads. Every required field gets a
  // safe stub; the test-relevant overrides come last to win.
  return {
    engine: {} as any,
    config: {} as any,
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: true, // default for tests; specific cases override
    ...overrides,
  } as OperationContext;
}

describe('whoami op contract', () => {
  test('local transport (ctx.remote === false) returns empty scopes', async () => {
    const result = (await whoami.handler(
      ctxWith({ remote: false }),
      {},
    )) as any;
    expect(result.transport).toBe('local');
    expect(result.scopes).toEqual([]);
  });

  test('local transport ignores ctx.auth even if a stale value leaked through', async () => {
    // Defense in depth: even if some buggy transport set both remote=false
    // AND a stale auth blob, the local return shape stays explicit.
    const result = (await whoami.handler(
      ctxWith({
        remote: false,
        auth: {
          token: 'x',
          clientId: 'gbrain_cl_123',
          scopes: ['admin'],
          expiresAt: 999999,
        } as AuthInfo,
      }),
      {},
    )) as any;
    expect(result.transport).toBe('local');
    expect(result.scopes).toEqual([]);
  });

  test('oauth transport returns full client identity', async () => {
    const auth: AuthInfo = {
      token: 'gbrain_at_xxx',
      clientId: 'gbrain_cl_abc',
      clientName: 'gstack-test',
      scopes: ['read', 'sources_admin'],
      expiresAt: 1234567890,
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth }),
      {},
    )) as any;
    expect(result.transport).toBe('oauth');
    expect(result.client_id).toBe('gbrain_cl_abc');
    expect(result.client_name).toBe('gstack-test');
    expect(result.scopes).toEqual(['read', 'sources_admin']);
    expect(result.expires_at).toBe(1234567890);
  });

  test('legacy transport (token name as clientId, no gbrain_cl_ prefix)', async () => {
    const auth: AuthInfo = {
      token: 'legacy-token',
      clientId: 'my-personal-token',
      clientName: 'my-personal-token',
      scopes: ['read', 'write', 'admin'],
      // Legacy tokens have a synthetic 1y expiry — whoami exposes null
      // since legacy tokens don't actually expire.
      expiresAt: 999999999,
    };
    const result = (await whoami.handler(
      ctxWith({ remote: true, auth }),
      {},
    )) as any;
    expect(result.transport).toBe('legacy');
    expect(result.token_name).toBe('my-personal-token');
    expect(result.scopes).toEqual(['read', 'write', 'admin']);
    expect(result.expires_at).toBeNull();
  });

  // Q3: ambiguous transport — fail-closed. The footgun this guards against
  // is a future transport that lands without threading auth, where a buggy
  // caller might trust whoami's output to gate sensitive ops.
  test('unknown_transport throws when remote=true AND auth is missing', async () => {
    try {
      await whoami.handler(ctxWith({ remote: true, auth: undefined }), {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).message).toMatch(/unknown_transport|did not thread/);
    }
  });

  test('unknown_transport throws when remote is undefined (cast bypass guard)', async () => {
    // F7b contract: ctx.remote is REQUIRED. If a caller widens the type to
    // Partial<> and passes through undefined, whoami should treat it as
    // remote (the fail-closed default) and throw because auth is missing.
    try {
      await whoami.handler(ctxWith({ remote: undefined as any, auth: undefined }), {});
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
    }
  });
});

// #68: the Agent transport is resolved from live Workspace state, so these
// cases drive the handler against a stub engine that answers the two queries
// whoami issues. Rows are keyed by SQL so the test observes the handler's real
// query behavior rather than a private helper.
//
// The stub is deliberately PARAMETER-AWARE: the Agent row set is returned only
// when the query binds the Workspace this fixture belongs to. A stub that
// ignored `params` would make the cross-Workspace case below indistinguishable
// from "no Agent row exists", and would keep passing if the `workspace_id`
// predicate were deleted from the real query.
const STUB_WORKSPACE_ID = 'ws-1';

function agentEngine(rows: {
  agents?: { status: string }[];
  policies?: { access_mode: string }[];
  fail?: boolean;
}) {
  return {
    async executeRaw(sql: string, params?: unknown[]) {
      if (rows.fail) throw new Error('relation "workspace_agents" does not exist');
      if (sql.includes('workspace_agents')) {
        // Simulate the WHERE clause the handler actually wrote, not the one we
        // hope it wrote: the Agent row lives in `ws-1`, so it is filtered out
        // only if the query BOTH carries the `workspace_id` predicate and binds
        // a different Workspace. Drop the predicate from the real query and the
        // cross-Workspace case below stops failing closed.
        const filtersByWorkspace = /workspace_id\s*=\s*\$2/.test(sql);
        if (filtersByWorkspace && params?.[1] !== STUB_WORKSPACE_ID) return [];
        return rows.agents ?? [];
      }
      if (sql.includes('workspace_principal_source_policies')) return rows.policies ?? [];
      return [];
    },
  } as any;
}

const agentAuth: AuthInfo = {
  token: 'gbrain_agent_token',
  clientId: 'agent-1',
  scopes: ['read', 'write'],
  agentId: 'agent-1',
  workspaceId: 'ws-1',
};

describe('whoami agent transport', () => {
  test('an active Agent with a canonical policy returns the closed agent shape', async () => {
    const result = (await whoami.handler(
      ctxWith({
        remote: true,
        auth: agentAuth,
        engine: agentEngine({ agents: [{ status: 'active' }], policies: [{ access_mode: 'specific' }] }),
      }),
      {},
    )) as any;
    expect(result).toEqual({
      transport: 'agent',
      agent_id: 'agent-1',
      workspace_id: 'ws-1',
      scopes: ['read', 'write'],
      source_access_mode: 'specific',
    });
  });

  test('each canonical access mode is projected verbatim', async () => {
    for (const mode of ['none', 'specific', 'all']) {
      const result = (await whoami.handler(
        ctxWith({
          remote: true,
          auth: agentAuth,
          engine: agentEngine({ agents: [{ status: 'active' }], policies: [{ access_mode: mode }] }),
        }),
        {},
      )) as any;
      expect(result.source_access_mode).toBe(mode);
    }
  });

  test('the Agent branch wins over the OAuth/legacy client-id heuristic', async () => {
    // An Agent credential whose clientId happens to carry the OAuth prefix must
    // still resolve as an Agent, never as an OAuth client.
    const result = (await whoami.handler(
      ctxWith({
        remote: true,
        auth: { ...agentAuth, clientId: 'gbrain_cl_agent', clientName: 'looks-like-oauth' },
        engine: agentEngine({ agents: [{ status: 'active' }], policies: [{ access_mode: 'all' }] }),
      }),
      {},
    )) as any;
    expect(result.transport).toBe('agent');
    expect(result.client_id).toBeUndefined();
  });

  test('a revoked Agent fails closed', async () => {
    await expect(whoami.handler(
      ctxWith({
        remote: true,
        auth: agentAuth,
        engine: agentEngine({ agents: [{ status: 'revoked' }], policies: [{ access_mode: 'all' }] }),
      }),
      {},
    )).rejects.toBeInstanceOf(OperationError);
  });

  test('a cross-Workspace Agent credential fails closed', async () => {
    // The Agent row EXISTS and is active — but it belongs to `ws-1`. The stub
    // returns it only when the query binds that Workspace, so this case fails
    // solely because the real query carries `AND workspace_id = $2`.
    await expect(whoami.handler(
      ctxWith({
        remote: true,
        auth: { ...agentAuth, workspaceId: 'ws-other' },
        engine: agentEngine({ agents: [{ status: 'active' }], policies: [{ access_mode: 'all' }] }),
      }),
      {},
    )).rejects.toBeInstanceOf(OperationError);
  });

  test('a missing Agent row fails closed', async () => {
    await expect(whoami.handler(
      ctxWith({
        remote: true,
        auth: agentAuth,
        engine: agentEngine({ agents: [], policies: [{ access_mode: 'all' }] }),
      }),
      {},
    )).rejects.toBeInstanceOf(OperationError);
  });

  test('a missing or malformed canonical policy fails closed', async () => {
    for (const policies of [[], [{ access_mode: 'everything' }], [{ access_mode: '' }]]) {
      await expect(whoami.handler(
        ctxWith({
          remote: true,
          auth: agentAuth,
          engine: agentEngine({ agents: [{ status: 'active' }], policies: policies as any }),
        }),
        {},
      )).rejects.toBeInstanceOf(OperationError);
    }
  });

  test('a malformed Agent credential fails closed instead of degrading to legacy', async () => {
    for (const auth of [
      { ...agentAuth, workspaceId: undefined },
      { ...agentAuth, workspaceId: '' },
      { ...agentAuth, agentId: '' },
    ]) {
      await expect(whoami.handler(
        ctxWith({
          remote: true,
          auth: auth as AuthInfo,
          engine: agentEngine({ agents: [{ status: 'active' }], policies: [{ access_mode: 'all' }] }),
        }),
        {},
      )).rejects.toBeInstanceOf(OperationError);
    }
  });

  test('a storage failure is not evidence of an Agent identity', async () => {
    await expect(whoami.handler(
      ctxWith({ remote: true, auth: agentAuth, engine: agentEngine({ fail: true }) }),
      {},
    )).rejects.toBeInstanceOf(OperationError);
  });

  test('the trusted local transport still ignores a leaked Agent credential', async () => {
    const result = (await whoami.handler(
      ctxWith({ remote: false, auth: agentAuth, engine: agentEngine({}) }),
      {},
    )) as any;
    expect(result).toEqual({ transport: 'local', scopes: [] });
  });

  test('OAuth and legacy credentials without agentId are unaffected', async () => {
    const oauth = (await whoami.handler(
      ctxWith({
        remote: true,
        auth: { token: 't', clientId: 'gbrain_cl_x', clientName: 'x', scopes: ['read'] },
        engine: agentEngine({ agents: [{ status: 'active' }], policies: [{ access_mode: 'all' }] }),
      }),
      {},
    )) as any;
    expect(oauth.transport).toBe('oauth');
    const legacy = (await whoami.handler(
      ctxWith({
        remote: true,
        auth: { token: 't', clientId: 'plain-token', scopes: ['read'] },
        engine: agentEngine({ agents: [{ status: 'active' }], policies: [{ access_mode: 'all' }] }),
      }),
      {},
    )) as any;
    expect(legacy.transport).toBe('legacy');
  });
});

describe('whoami op metadata', () => {
  test('scope is read (any authenticated caller can introspect itself)', () => {
    expect(whoami.scope).toBe('read');
  });

  test('not localOnly (must work over HTTP MCP for gstack /setup-gbrain)', () => {
    expect(whoami.localOnly).toBeFalsy();
  });

  test('mutating is false', () => {
    expect(whoami.mutating).toBeFalsy();
  });
});
