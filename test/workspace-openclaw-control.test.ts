/**
 * Closed OpenClaw loopback control adapter contract (#68 Task 4).
 *
 * Every test drives the real adapter against a real loopback HTTP server so
 * the assertions observe the exact method / path / header / body combinations
 * that reach OpenClaw. Nothing here mocks the adapter itself.
 */

import { test, expect, describe, afterEach } from 'bun:test';
import {
  LoopbackOpenClawControl,
  OpenClawControlError,
} from '../src/workspace/openclaw-control.ts';
import { CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL } from '../src/workspace/agent-access.ts';

interface CapturedCall {
  path: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: CapturedCall) => Response | Promise<Response>;

const servers: { stop(force?: boolean): void }[] = [];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function startServer(handler: Handler) {
  const calls: CapturedCall[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      const headers: Record<string, string> = {};
      req.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      const raw = await req.text();
      let body: unknown;
      try { body = raw.length > 0 ? JSON.parse(raw) : undefined; } catch { body = raw; }
      const call: CapturedCall = { path: url.pathname, method: req.method, headers, body };
      calls.push(call);
      return handler(call);
    },
  });
  servers.push(server);
  return { calls, baseUrl: `http://127.0.0.1:${server.port}` };
}

function controlFor(handler: Handler, timeoutMs = 2000) {
  const { calls, baseUrl } = startServer(handler);
  const control = new LoopbackOpenClawControl({
    baseUrl,
    internalUser: 'gbrain-control',
    requiredHeader: 'gbrain-loopback-v1',
    timeoutMs,
  });
  return { control, calls };
}

/**
 * These fixtures are the REAL pinned openclaw@2026.7.1-2 wire shapes.
 *
 * - admin RPC (`/api/v1/admin/rpc`) success is `{ id, ok: true, payload }`;
 * - `/tools/invoke` success is `{ ok: true, result }` — a different envelope;
 * - admin RPC errors carry UPPERCASE codes;
 * - the 401 body has no `ok` and no `error.code`, only `error.type`.
 *
 * An earlier revision of this suite encoded an invented protocol, which is why
 * it passed against an adapter that could not have worked. Do not "simplify"
 * these back into one shared shape.
 */
const HEALTH_SUMMARY = { ok: true, ts: 1_785_000_000_000, durationMs: 3, defaultAgentId: 'main' };
const HEALTH_OK = { id: 'rpc-1', ok: true, payload: HEALTH_SUMMARY };
const AUTH_REFUSAL = { error: { message: 'Unauthorized', type: 'unauthorized' } };
const RATE_LIMITED = {
  error: { message: 'Too many failed authentication attempts. Please try again later.', type: 'rate_limited' },
};
const BASE_HASH_CONFLICT = {
  id: 'rpc-1',
  ok: false,
  error: { code: 'INVALID_REQUEST', message: 'config changed since last load; re-run config.get and retry' },
};

function rpcOk(payload: unknown) {
  return json({ id: 'rpc-1', ok: true, payload });
}

function rpcError(code: string, message = 'failed', status = 500) {
  return json({ id: 'rpc-1', ok: false, error: { code, message } }, status);
}

/** The pinned redacted `config.get` snapshot shape, trimmed to what we read. */
function configSnapshot(hash: string, config: Record<string, unknown>) {
  return { path: '/etc/openclaw/openclaw.json5', exists: true, valid: true, hash, raw: '{}', parsed: {}, config };
}

/** A config.get/config.patch pair that always accepts the first patch. */
function configServer(options: {
  hash?: string;
  toolsConfig?: unknown;
  onPatch?: (params: Record<string, unknown>, attempt: number) => Response | undefined;
} = {}) {
  let attempt = 0;
  return controlFor(call => {
    const body = call.body as { method?: string; params?: Record<string, unknown> };
    if (call.path === '/api/v1/admin/rpc' && body?.method === 'config.get') {
      return rpcOk(configSnapshot(options.hash ?? 'hash-1', {
        tools: options.toolsConfig ?? { profile: 'full' },
      }));
    }
    if (call.path === '/api/v1/admin/rpc' && body?.method === 'config.patch') {
      attempt += 1;
      const override = options.onPatch?.(body.params ?? {}, attempt);
      if (override) return override;
      return rpcOk({ ok: true, path: '/etc/openclaw/openclaw.json5' });
    }
    return rpcError('UNAVAILABLE', 'unexpected', 503);
  });
}

afterEach(() => {
  while (servers.length > 0) servers.pop()!.stop(true);
});

describe('loopback confinement', () => {
  test('a non-loopback base URL is refused at construction', () => {
    expect(() => new LoopbackOpenClawControl({ baseUrl: 'http://openclaw.example.com:3334' }))
      .toThrow('openclaw_base_url_not_loopback');
    expect(() => new LoopbackOpenClawControl({ baseUrl: 'https://127.0.0.1:3334' }))
      .toThrow('openclaw_base_url_not_loopback');
    expect(() => new LoopbackOpenClawControl({ baseUrl: 'http://localhost:3334' }))
      .toThrow('openclaw_base_url_not_loopback');
  });

  test('the default target is the pinned loopback gateway', async () => {
    // Parsing successfully is not the claim; the claim is 127.0.0.1:3334. The
    // only externally observable proof is where the adapter actually connects,
    // so bind that exact port and watch the default instance arrive there.
    let hit = false;
    const server = Bun.serve({
      port: 3334,
      hostname: '127.0.0.1',
      fetch() { hit = true; return json(HEALTH_OK); },
    });
    servers.push(server);
    expect(await new LoopbackOpenClawControl().runtimeHealth()).toBe(true);
    expect(hit).toBe(true);
  });
});

describe('timeout clamping', () => {
  test('a non-positive timeout is refused rather than aborting every call instantly', () => {
    // `AbortSignal.timeout(0)` aborts synchronously, which would turn every
    // call into `openclaw_unreachable` — a self-inflicted outage.
    for (const timeoutMs of [0, -1, -15_000, Number.NaN]) {
      expect(() => new LoopbackOpenClawControl({ timeoutMs }))
        .toThrow('openclaw_timeout_not_positive');
    }
  });
});

describe('trusted internal operator identity', () => {
  test('the adapter authenticates as the internal trusted operator and never forwards cookies', async () => {
    const { control, calls } = controlFor(() => json(HEALTH_OK));
    await control.runtimeHealth();
    expect(calls[0]!.path).toBe('/api/v1/admin/rpc');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.cookie).toBeUndefined();
    expect(calls[0]!.headers['x-gbrain-openclaw-user']).toBe('gbrain-control');
    expect(calls[0]!.headers['x-gbrain-openclaw-proxy']).toBe('gbrain-loopback-v1');
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(calls[0]!.body).toEqual({ method: 'health', params: {} });
  });
});

describe('runtimeHealth fails closed', () => {
  test('only the pinned successful health response is healthy', async () => {
    const { control } = controlFor(() => json(HEALTH_OK));
    expect(await control.runtimeHealth()).toBe(true);
  });

  test('a non-2xx response is not healthy', async () => {
    const { control } = controlFor(() => json(HEALTH_OK, 503));
    expect(await control.runtimeHealth()).toBe(false);
  });

  test('an RPC-level error is not healthy', async () => {
    const { control } = controlFor(() => rpcError('UNAVAILABLE', 'boom', 503));
    expect(await control.runtimeHealth()).toBe(false);
  });

  test('a non-JSON response is not healthy', async () => {
    const { control } = controlFor(() => new Response('<html>gateway starting</html>'));
    expect(await control.runtimeHealth()).toBe(false);
  });

  test('a 200 without the pinned HealthSummary payload is not healthy', async () => {
    // `HealthSummary` is `{ ok: true, ts, durationMs, ... }`. A bare 200, an
    // envelope with no payload, the unauthenticated `GET /health` liveness body,
    // and a `/tools/invoke`-shaped envelope must all read as unhealthy.
    for (const body of [
      { id: 'rpc-1', ok: true, payload: { version: '2026.7.1-2' } },
      { id: 'rpc-1', ok: true, payload: { ok: true } },
      { id: 'rpc-1', ok: true, payload: { status: 'ok' } },
      { id: 'rpc-1', ok: true },
      { ok: true, result: HEALTH_SUMMARY },
      { ok: true },
      {},
    ]) {
      const { control } = controlFor(() => json(body));
      expect(await control.runtimeHealth()).toBe(false);
    }
  });

  test('an unreachable gateway is not healthy', async () => {
    const control = new LoopbackOpenClawControl({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
    expect(await control.runtimeHealth()).toBe(false);
  });

  test('a hung gateway times out rather than hanging the caller', async () => {
    const { control } = controlFor(async () => {
      await new Promise(resolve => setTimeout(resolve, 5000));
      return json(HEALTH_OK);
    }, 150);
    const started = Date.now();
    expect(await control.runtimeHealth()).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe('bounded response bodies and RPC error mapping', () => {
  test('an oversized response body is refused instead of buffered', async () => {
    const { control } = controlFor(() => new Response('x'.repeat(2 * 1024 * 1024), {
      headers: { 'content-type': 'application/json' },
    }));
    await expect(control.listModels()).rejects.toThrow('openclaw_invalid_response');
  });

  test('a non-JSON body maps to openclaw_invalid_response', async () => {
    const { control } = controlFor(() => new Response('not json'));
    await expect(control.listModels()).rejects.toThrow('openclaw_invalid_response');
  });

  test('an admin-RPC unwrapper refuses a /tools/invoke-shaped body', async () => {
    // `{ ok: true, result }` is the /tools/invoke envelope, never the admin one.
    const { control } = controlFor(() => json({ ok: true, result: { models: [] } }));
    await expect(control.listModels()).rejects.toThrow('openclaw_unavailable');
  });

  test('an RPC error maps to a safe code and never relays upstream text', async () => {
    const { control } = controlFor(() => rpcError('UNAVAILABLE', 'panic in /home/openclaw/secret-path', 503));
    try {
      await control.listModels();
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenClawControlError);
      expect((error as OpenClawControlError).code).toBe('openclaw_unavailable');
      expect(String(error)).not.toContain('secret-path');
      expect(String(error)).not.toContain('panic');
    }
  });

  test('an unreachable gateway maps to openclaw_unavailable', async () => {
    const control = new LoopbackOpenClawControl({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
    await expect(control.listModels()).rejects.toThrow('openclaw_unavailable');
  });
});

describe('native password proof', () => {
  test('password probes cannot authenticate through trusted-proxy identity', async () => {
    const { control, calls } = controlFor(() => json(HEALTH_OK));
    await control.verifyNativePassword('candidate-password');
    const call = calls.at(-1)!;
    expect(call.path).toBe('/api/v1/admin/rpc');
    expect(call.body).toEqual({ method: 'health', params: {} });
    expect(call.headers.authorization).toBe('Bearer candidate-password');
    for (const name of [
      'x-gbrain-openclaw-user', 'x-gbrain-openclaw-proxy', 'forwarded',
      'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
      'cookie',
    ]) {
      expect(call.headers[name]).toBeUndefined();
    }
  });

  test('a password is accepted only on the pinned successful health response', async () => {
    const good = controlFor(call =>
      call.headers.authorization === 'Bearer right' ? json(HEALTH_OK) : json(AUTH_REFUSAL, 401));
    expect(await good.control.verifyNativePassword('right')).toBe(true);
    expect(await good.control.verifyNativePassword('wrong')).toBe(false);
  });

  test('a 200 that is not the pinned HealthSummary is never a valid password', async () => {
    // HTTP 200 alone proves nothing: only the pinned `{ ok: true, ts, durationMs }`
    // payload under the admin envelope counts.
    for (const payload of [
      AUTH_REFUSAL,
      { id: 'r', ok: true, payload: {} },
      { id: 'r', ok: true, payload: { ok: false, ts: 1, durationMs: 1 } },
      { id: 'r', ok: true, payload: { status: 'ok' } },
      { id: 'r', ok: true, payload: { ok: true } },
      { id: 'r', ok: true },
      { ok: true, result: HEALTH_SUMMARY },
      { ok: true, status: 'live' },
      {},
    ]) {
      const { control } = controlFor(() => json(payload));
      expect(await control.verifyNativePassword('candidate')).toBe(false);
    }
  });

  test('a server error is never mistaken for a valid password', async () => {
    const { control } = controlFor(() => rpcError('UNAVAILABLE', 'internal', 503));
    expect(await control.verifyNativePassword('anything')).toBe(false);
  });

  test('a rate-limited probe is neither acceptance nor rejection', async () => {
    // Repeated auth failures rate-limit the endpoint BEFORE the credential is
    // evaluated, so 429 is "unknown" in both directions and both probes must
    // fail closed. Reading it as rejection would let a rotation falsely claim
    // the old password was retired.
    const { control } = controlFor(() => new Response(JSON.stringify(RATE_LIMITED), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '30' },
    }));
    expect(await control.verifyNativePassword('candidate')).toBe(false);
    expect(await control.verifyNativePasswordRejected('candidate')).toBe(false);
  });

  test('an unreachable gateway is never mistaken for a valid password', async () => {
    const control = new LoopbackOpenClawControl({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
    expect(await control.verifyNativePassword('anything')).toBe(false);
  });

  test('rejection is proven only by the pinned auth refusal', async () => {
    const refusing = controlFor(() => json(AUTH_REFUSAL, 401));
    expect(await refusing.control.verifyNativePasswordRejected('old')).toBe(true);
  });

  test('a 401 that is not the pinned refusal body is not proof of rejection', async () => {
    for (const body of [
      {},
      { error: {} },
      { error: { type: 'rate_limited', message: 'slow down' } },
      { ok: false, error: { code: 'unauthorized' } },
    ]) {
      const { control } = controlFor(() => json(body, 401));
      expect(await control.verifyNativePasswordRejected('old')).toBe(false);
    }
  });

  test('a still-valid password is not reported as rejected', async () => {
    const { control } = controlFor(() => json(HEALTH_OK));
    expect(await control.verifyNativePasswordRejected('old')).toBe(false);
  });

  test('a network failure is not proof of rejection', async () => {
    const control = new LoopbackOpenClawControl({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
    expect(await control.verifyNativePasswordRejected('old')).toBe(false);
  });

  test('a timeout is not proof of rejection', async () => {
    const { control } = controlFor(async () => {
      await new Promise(resolve => setTimeout(resolve, 5000));
      return json(AUTH_REFUSAL, 401);
    }, 150);
    expect(await control.verifyNativePasswordRejected('old')).toBe(false);
  });

  test('a parse failure is not proof of rejection', async () => {
    const { control } = controlFor(() => new Response('<html>401</html>', { status: 401 }));
    expect(await control.verifyNativePasswordRejected('old')).toBe(false);
  });

  test('an unrelated 5xx is not proof of rejection', async () => {
    const { control } = controlFor(() => rpcError('UNAVAILABLE', 'internal', 503));
    expect(await control.verifyNativePasswordRejected('old')).toBe(false);
  });

  test('the rejection probe also carries no trusted-proxy identity', async () => {
    const { control, calls } = controlFor(() => json(AUTH_REFUSAL, 401));
    await control.verifyNativePasswordRejected('old-password');
    const call = calls.at(-1)!;
    expect(call.headers.authorization).toBe('Bearer old-password');
    expect(call.headers['x-gbrain-openclaw-user']).toBeUndefined();
    expect(call.headers['x-gbrain-openclaw-proxy']).toBeUndefined();
  });
});

describe('configuration writes go through get + hash-checked patch', () => {
  test('applying the native password patches only the pinned paths', async () => {
    const { control, calls } = configServer();
    await control.applyNativePassword('shared-native-password');
    expect(calls.map(c => (c.body as { method: string }).method))
      .toEqual(['config.get', 'config.patch']);
    const patch = calls[1]!.body as { method: string; params: Record<string, unknown> };
    expect(patch.params.baseHash).toBe('hash-1');
    expect(patch.params.replacePaths).toEqual([]);
    expect(JSON.parse(String(patch.params.raw))).toEqual({
      gateway: {
        reload: { mode: 'hybrid' },
        auth: { password: 'shared-native-password' },
      },
    });
    expect(calls[1]!.headers['x-gbrain-openclaw-user']).toBe('gbrain-control');
  });

  test('a base-hash conflict is retried against a refetched hash', async () => {
    // The gateway reports a stale baseHash as a plain 400 INVALID_REQUEST; the
    // exact message is the only distinguishing signal.
    let hash = 'hash-1';
    const { control, calls } = controlFor(call => {
      const body = call.body as { method?: string; params?: Record<string, unknown> };
      if (body?.method === 'config.get') return rpcOk(configSnapshot(hash, {}));
      if (body?.method === 'config.patch') {
        if (body.params?.baseHash === 'hash-1') { hash = 'hash-2'; return json(BASE_HASH_CONFLICT, 400); }
        return rpcOk({ ok: true });
      }
      return rpcError('UNAVAILABLE', 'unexpected', 503);
    });
    await control.applyNativePassword('pw');
    const methods = calls.map(c => (c.body as { method: string }).method);
    expect(methods).toEqual(['config.get', 'config.patch', 'config.get', 'config.patch']);
    expect((calls[3]!.body as { params: Record<string, unknown> }).params.baseHash).toBe('hash-2');
  });

  test('an INVALID_REQUEST that is not the conflict message fails closed instead of retrying', async () => {
    // Every rejected patch shares the INVALID_REQUEST code. Only the exact
    // pinned conflict message is retry-eligible; anything else must not cause a
    // blind rewrite.
    for (const error of [
      { code: 'INVALID_REQUEST', message: 'invalid config; fix before patching' },
      { code: 'INVALID_REQUEST', message: 'config base hash required; re-run config.get and retry' },
      { code: 'INVALID_REQUEST', message: 'config changed since last load' },
      { code: 'base_hash_conflict', message: 'config changed since last load; re-run config.get and retry' },
    ]) {
      const { control, calls } = configServer({
        onPatch: () => json({ id: 'r', ok: false, error }, 400),
      });
      await expect(control.applyNativePassword('pw')).rejects.toThrow('openclaw_config_failed');
      expect(calls.filter(c => (c.body as { method: string }).method === 'config.patch').length).toBe(1);
    }
  });

  test('an unbounded conflict loop terminates with a safe code', async () => {
    const { control, calls } = configServer({
      onPatch: () => json(BASE_HASH_CONFLICT, 400),
    });
    await expect(control.applyNativePassword('pw')).rejects.toThrow('openclaw_config_failed');
    expect(calls.filter(c => (c.body as { method: string }).method === 'config.patch').length)
      .toBeLessThanOrEqual(3);
  });

  test('a snapshot without a usable hash is refused rather than guessed', async () => {
    // `hash` is optional in the pinned snapshot type; the gateway then derives it
    // from `raw`, which reaches us REDACTED and would hash to the wrong value.
    const { control, calls } = controlFor(call => {
      const body = call.body as { method?: string };
      if (body?.method === 'config.get') {
        return rpcOk({ path: '/etc/openclaw/openclaw.json5', exists: true, valid: true, raw: '{redacted}', config: {} });
      }
      return rpcOk({ ok: true });
    });
    await expect(control.applyNativePassword('pw')).rejects.toThrow('openclaw_config_failed');
    expect(calls.some(c => (c.body as { method: string }).method === 'config.patch')).toBe(false);
  });

  test('no redacted snapshot value is ever written back', async () => {
    // config.get is secret-redacted; the patch must contain only the keys this
    // adapter intends to change, built from its own arguments.
    const { control, calls } = configServer({
      toolsConfig: { profile: 'full' },
    });
    await control.applyNativePassword('fresh-password');
    const raw = JSON.parse(String((calls.at(-1)!.body as { params: Record<string, unknown> }).params.raw));
    expect(Object.keys(raw)).toEqual(['gateway']);
    expect(JSON.stringify(raw)).not.toContain('REDACTED');
    expect(JSON.stringify(raw)).not.toContain('tools');
  });

  test('config.apply is never called', async () => {
    const { control, calls } = configServer();
    await control.configureGBrainMcp({ token: 'gbrain-agent-token' });
    expect(calls.map(c => (c.body as { method: string }).method)).not.toContain('config.apply');
  });

  test('the GBrain MCP entry is written with the pinned transport and bearer token', async () => {
    const { control, calls } = configServer();
    await control.configureGBrainMcp({ token: 'gbrain-agent-token' });
    const patch = calls.at(-1)!.body as { params: Record<string, unknown> };
    expect(JSON.parse(String(patch.params.raw))).toEqual({
      mcp: {
        servers: {
          gbrain: {
            url: 'http://127.0.0.1:3131/mcp',
            transport: 'streamable-http',
            headers: { Authorization: 'Bearer gbrain-agent-token' },
          },
        },
      },
    });
  });

  test('a rejected patch never leaks the configured secret into the error', async () => {
    const { control } = configServer({
      onPatch: params => json({ id: 'r', ok: false, error: { code: 'INVALID_REQUEST', message: String(params.raw) } }, 400),
    });
    try {
      await control.applyNativePassword('super-secret-native-password');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(OpenClawControlError);
      expect(String(error)).not.toContain('super-secret-native-password');
    }
  });
});

describe('GBrain MCP identity probe', () => {
  const AGENT_IDENTITY = {
    transport: 'agent',
    agent_id: 'agent-1',
    workspace_id: 'ws-1',
    scopes: ['read'],
    source_access_mode: 'specific',
  };

  /** `config` here is the whole redacted snapshot config, not just `tools`. */
  function whoAmIServer(whoami: unknown, config: Record<string, unknown> = { tools: { profile: 'full' } }) {
    return controlFor(call => {
      const body = call.body as Record<string, unknown>;
      if (call.path === '/api/v1/admin/rpc' && body?.method === 'config.get') {
        return rpcOk(configSnapshot('h', config));
      }
      // /tools/invoke uses `{ ok, result }` — NOT the admin RPC `payload` shape.
      if (call.path === '/tools/invoke') return json({ ok: true, result: whoami });
      return rpcError('UNAVAILABLE', 'unexpected', 503);
    });
  }

  test('the agent transport maps to the closed identity shape', async () => {
    const { control, calls } = whoAmIServer(AGENT_IDENTITY);
    expect(await control.probeGBrainWhoAmI()).toEqual({
      workspaceId: 'ws-1',
      agentId: 'agent-1',
      scopes: ['read'],
      sourceAccessMode: 'specific',
    });
    const invoke = calls.find(c => c.path === '/tools/invoke')!;
    expect(invoke.body).toEqual({ tool: 'gbrain__whoami', args: {} });
    expect(invoke.headers['x-gbrain-openclaw-user']).toBe('gbrain-control');
  });

  test('every non-agent transport is rejected', async () => {
    for (const transport of ['oauth', 'legacy', 'local', undefined]) {
      const { control } = whoAmIServer({ ...AGENT_IDENTITY, transport });
      await expect(control.probeGBrainWhoAmI()).rejects.toThrow('openclaw_mcp_probe_failed');
    }
  });

  test('a malformed agent identity is rejected', async () => {
    for (const broken of [
      { ...AGENT_IDENTITY, agent_id: '' },
      { ...AGENT_IDENTITY, workspace_id: null },
      { ...AGENT_IDENTITY, scopes: 'read' },
      { ...AGENT_IDENTITY, source_access_mode: 'everything' },
    ]) {
      const { control } = whoAmIServer(broken);
      await expect(control.probeGBrainWhoAmI()).rejects.toThrow('openclaw_mcp_probe_failed');
    }
  });

  test('a tool policy that hides the projected tool fails as unavailable, not as runtime failure', async () => {
    for (const config of [
      { tools: { profile: 'minimal' } },
      { tools: { profile: 'full', deny: ['gbrain__whoami'] } },
      { tools: { profile: 'full', deny: ['bundle-mcp'] } },
      { tools: { profile: 'full', allow: ['bundle-fs'] } },
      // An unrecognized profile is not assumed to be permissive.
      { tools: { profile: 'experimental' } },
      { tools: { profile: 42 } },
      // `gateway.tools.deny` is a separate hard-deny list that also gates
      // /tools/invoke even when the session policy allows the tool.
      { tools: { profile: 'full' }, gateway: { tools: { deny: ['bundle-mcp'] } } },
      { tools: { profile: 'coding' }, gateway: { tools: { deny: ['gbrain__whoami'] } } },
    ]) {
      const { control, calls } = whoAmIServer(AGENT_IDENTITY, config);
      await expect(control.probeGBrainWhoAmI()).rejects.toThrow('openclaw_mcp_probe_failed');
      expect(calls.some(c => c.path === '/tools/invoke')).toBe(false);
    }
  });

  test('a malformed tool policy is never coerced into an unrestricted one', async () => {
    // Each of these has the key PRESENT but of the wrong type. Degrading them to
    // `{}` / `[]` / "no allowlist" would read a broken policy as "nothing is
    // denied, therefore the tool is exposed" — the exact fail-open this file
    // avoids everywhere else. Absence stays absent; presence must be well typed.
    for (const config of [
      // `config.tools` is not a record.
      { tools: [] },
      { tools: ['bundle-mcp'] },
      { tools: 'full' },
      // `tools.deny` is present but not an array.
      { tools: { profile: 'full', deny: 'gbrain__whoami' } },
      { tools: { profile: 'full', deny: { 'bundle-mcp': true } } },
      // `tools.allow` is present but not an array.
      { tools: { profile: 'full', allow: 'bundle-fs' } },
      { tools: { profile: 'full', allow: {} } },
      // `gateway.tools.deny` is present but not an array.
      { tools: { profile: 'full' }, gateway: { tools: { deny: 'bundle-mcp' } } },
      // `gateway` / `gateway.tools` present but not records — same family.
      { tools: { profile: 'full' }, gateway: ['tools'] },
      { tools: { profile: 'full' }, gateway: { tools: 'deny-everything' } },
    ]) {
      const { control, calls } = whoAmIServer(AGENT_IDENTITY, config);
      await expect(control.probeGBrainWhoAmI()).rejects.toThrow('openclaw_mcp_probe_failed');
      expect(calls.some(c => c.path === '/tools/invoke')).toBe(false);
    }
  });

  test('an invalid config snapshot is never read as an unrestricted policy', async () => {
    // On an invalid config the gateway redacts `config` to `{}`, which would
    // otherwise look exactly like "no tool restrictions at all".
    const { control, calls } = controlFor(call => {
      const body = call.body as Record<string, unknown>;
      if (body?.method === 'config.get') {
        return rpcOk({ path: '/etc/openclaw/openclaw.json5', exists: true, valid: false, hash: 'h', config: {} });
      }
      return json({ ok: true, result: AGENT_IDENTITY });
    });
    await expect(control.probeGBrainWhoAmI()).rejects.toThrow('openclaw_mcp_probe_failed');
    expect(calls.some(c => c.path === '/tools/invoke')).toBe(false);
  });

  test('the default (unset) tools profile exposes the projected bundle', async () => {
    // An absent `tools.profile` is the `full` profile — "No restriction (same as
    // unset)" — so the default configuration must reach the tool, and `coding`
    // and `messaging` implicitly allow `bundle-mcp`.
    for (const config of [
      {},
      { tools: {} },
      { tools: { profile: 'coding' } },
      { tools: { profile: 'messaging' } },
      { tools: { profile: 'full', allow: ['bundle-mcp'] } },
    ]) {
      const { control } = whoAmIServer(AGENT_IDENTITY, config);
      expect((await control.probeGBrainWhoAmI()).agentId).toBe('agent-1');
    }
  });

  test('the whoami probe refuses an admin-RPC-shaped body', async () => {
    // `{ ok: true, payload }` is the admin envelope; /tools/invoke never uses it.
    const { control } = controlFor(call => {
      const body = call.body as Record<string, unknown>;
      if (body?.method === 'config.get') return rpcOk(configSnapshot('h', {}));
      return json({ id: 'r', ok: true, payload: AGENT_IDENTITY });
    });
    await expect(control.probeGBrainWhoAmI()).rejects.toThrow('openclaw_mcp_probe_failed');
  });
});

describe('model catalog and probes', () => {
  /** `models.list` answers catalog ENTRIES (`{ id, name, provider, ... }`). */
  function catalogEntry(key: string) {
    const [provider, id] = key.split('/');
    return { id, name: id, provider, contextWindow: 200_000 };
  }

  function modelServer(options: {
    models?: unknown;
    respond?: (call: CapturedCall) => Response;
  }) {
    return controlFor(call => {
      const body = call.body as Record<string, unknown>;
      if (call.path === '/api/v1/admin/rpc' && body?.method === 'models.list') {
        const models = 'models' in options
          ? options.models
          : [catalogEntry(CODEX_DEFAULT_MODEL), catalogEntry(CLAUDE_FALLBACK_MODEL)];
        return rpcOk({ models });
      }
      if (call.path === '/v1/responses' && options.respond) return options.respond(call);
      return rpcError('UNAVAILABLE', 'unexpected', 503);
    });
  }

  /** The pinned `/v1/responses` answer shape: text lives in output[].content[]. */
  function responseWith(text: string, extra: Record<string, unknown> = {}) {
    return {
      id: 'resp_1',
      object: 'response',
      created_at: 1_785_000_000,
      status: 'completed',
      model: CODEX_DEFAULT_MODEL,
      usage: {},
      output: [{
        type: 'message',
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      }],
      ...extra,
    };
  }

  test('listModels projects catalog entries to provider/model keys', async () => {
    const { control } = modelServer({});
    expect(await control.listModels()).toEqual([CODEX_DEFAULT_MODEL, CLAUDE_FALLBACK_MODEL]);
  });

  test('an entry whose id already carries the provider prefix is not doubled', async () => {
    const { control } = modelServer({ models: [{ id: CODEX_DEFAULT_MODEL, provider: 'openai' }] });
    expect(await control.listModels()).toEqual([CODEX_DEFAULT_MODEL]);
  });

  test('a malformed catalog is refused rather than coerced', async () => {
    for (const models of [
      null,
      'a,b',
      [1, 2],
      [{ id: 'x' }],
      [{ provider: 'openai' }],
      [CODEX_DEFAULT_MODEL],
      [{ id: 'x', provider: '' }],
    ]) {
      const { control } = modelServer({ models });
      await expect(control.listModels()).rejects.toThrow('openclaw_invalid_response');
    }
  });

  test('a model outside the catalog never reaches the responses endpoint', async () => {
    const { control, calls } = modelServer({ respond: () => json(responseWith('hi')) });
    await expect(control.probeModel('anthropic/not-installed', 'ping'))
      .rejects.toThrow('openclaw_required_model_missing');
    expect(calls.some(c => c.path === '/v1/responses')).toBe(false);
  });

  test('the Codex probe pins the explicit outbound model override', async () => {
    const { control, calls } = modelServer({ respond: () => json(responseWith('codex answer')) });
    expect(await control.probeModel(CODEX_DEFAULT_MODEL, 'ping')).toEqual({ text: 'codex answer' });
    const probe = calls.find(c => c.path === '/v1/responses')!;
    expect(probe.headers['x-openclaw-model']).toBe(CODEX_DEFAULT_MODEL);
    expect(probe.headers['x-gbrain-openclaw-user']).toBe('gbrain-control');
    // `model` is required by the strict schema and must be an AGENT target;
    // the backend selection lives only in the header above.
    expect(probe.body).toEqual({ model: 'openclaw/default', input: 'ping', stream: false });
  });

  test('the Claude probe pins its own explicit outbound model override', async () => {
    const { control, calls } = modelServer({ respond: () => json(responseWith('claude answer')) });
    expect(await control.probeModel(CLAUDE_FALLBACK_MODEL, 'ping')).toEqual({ text: 'claude answer' });
    expect(calls.find(c => c.path === '/v1/responses')!.headers['x-openclaw-model'])
      .toBe(CLAUDE_FALLBACK_MODEL);
  });

  test('a misleading echoed response.model is not evidence of the backend', async () => {
    // The catalog does not contain the requested model, but the gateway echoes
    // it back anyway. Catalog membership decides; the echo is ignored.
    const { control } = modelServer({
      models: [catalogEntry(CLAUDE_FALLBACK_MODEL)],
      respond: () => json(responseWith('answer', { model: CODEX_DEFAULT_MODEL })),
    });
    await expect(control.probeModel(CODEX_DEFAULT_MODEL, 'ping'))
      .rejects.toThrow('openclaw_required_model_missing');
  });

  test('an echoed model that disagrees with a catalogued request does not fail the probe', async () => {
    const { control } = modelServer({
      respond: () => json(responseWith('answer', { model: 'something/else' })),
    });
    expect(await control.probeModel(CODEX_DEFAULT_MODEL, 'ping')).toEqual({ text: 'answer' });
  });

  test('an empty answer is not proof of a working provider', async () => {
    for (const payload of [
      responseWith(''),
      responseWith('   '),
      {},
      { output: [] },
      // There is no top-level `output_text` in the pinned response resource.
      { output_text: 'answer' },
      // A non-text content part is not an answer.
      { output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] },
      { output: [{ content: [{ text: 'untyped' }] }] },
      // Only `completed` is proof. A denylist of terminal failures would let a
      // still-running or truncated run's partial text count as an answer, and
      // probeModel feeds the *_verified readiness blockers.
      responseWith('answer', { status: 'failed' }),
      responseWith('answer', { status: 'cancelled' }),
      responseWith('answer', { status: 'in_progress' }),
      responseWith('answer', { status: 'incomplete' }),
      responseWith('answer', { status: 'queued' }),
      // An absent status is not evidence of completion either.
      { output: [{ content: [{ type: 'output_text', text: 'answer' }] }] },
    ]) {
      const { control } = modelServer({ respond: () => json(payload) });
      await expect(control.probeModel(CODEX_DEFAULT_MODEL, 'ping'))
        .rejects.toThrow('openclaw_model_probe_failed');
    }
  });

  test('a non-2xx probe never relays upstream error text', async () => {
    const { control } = modelServer({
      respond: () => json({ error: { message: 'quota for account acct_9912 exhausted' } }, 429),
    });
    try {
      await control.probeModel(CODEX_DEFAULT_MODEL, 'ping');
      throw new Error('expected throw');
    } catch (error) {
      expect((error as OpenClawControlError).code).toBe('openclaw_model_probe_failed');
      expect(String(error)).not.toContain('acct_9912');
    }
  });

  test('the output_text content part is read as the answer', async () => {
    const { control } = modelServer({
      respond: () => json({
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: 'structured' }] }],
      }),
    });
    expect(await control.probeModel(CODEX_DEFAULT_MODEL, 'ping')).toEqual({ text: 'structured' });
  });

  // -- the default-chain probe (#68 Task 10) --------------------------------
  //
  // VERIFIED against the pinned openclaw@2026.7.1-2 build, not assumed:
  //   dist/http-utils-B0BcglUl.js:62-63 — `resolveOpenAiCompatModelOverride`
  //     reads `x-openclaw-model` and, when it is absent or blank, returns `{}`
  //     with NO `modelOverride` and NO `errorMessage`.
  //   dist/openresponses-http-DPyXZf-A.js:652-663 — only a truthy `errorMessage`
  //     produces a 400; an absent override is simply carried through.
  //   dist/openresponses-http-DPyXZf-A.js:592,599 — the run is then dispatched
  //     with `model: undefined` and `allowModelOverride: false`, i.e. the
  //     selected agent's own configured model and fallback chain.
  //   docs/gateway/openai-http-api.md:97 states the same in prose.
  // So omitting the header is NOT an error and NOT a hardcoded default: it is
  // exactly the configured default/fallback chain this proof is meant to cover.

  test('the default-answer probe omits the model override entirely', async () => {
    const { control, calls } = modelServer({ respond: () => json(responseWith('2BRAIN_AGENT_READY')) });
    expect(await control.probeDefaultAnswer('ping')).toEqual({ text: '2BRAIN_AGENT_READY' });
    const probe = calls.find(c => c.path === '/v1/responses')!;
    // Absent, not empty: a blank header is a different wire fact, and only a
    // truly absent one exercises the pinned `if (!raw) return {}` branch.
    expect(Object.hasOwn(probe.headers, 'x-openclaw-model')).toBe(false);
    expect(probe.headers['x-gbrain-openclaw-user']).toBe('gbrain-control');
    expect(probe.body).toEqual({ model: 'openclaw/default', input: 'ping', stream: false });
  });

  test('the default-answer probe never asks for the model catalog', async () => {
    // It proves the CONFIGURED chain, so there is no requested backend model to
    // check membership for. Listing one would imply a selection it never makes.
    const { control, calls } = modelServer({ respond: () => json(responseWith('ok')) });
    await control.probeDefaultAnswer('ping');
    expect(calls.some(c => (c.body as { method?: string })?.method === 'models.list')).toBe(false);
  });

  test('the default-answer probe ignores the echoed response.model', async () => {
    // OpenResponses echoes the REQUEST target, so `response.model` says nothing
    // about which backend answered.
    const { control } = modelServer({
      respond: () => json(responseWith('answered', { model: 'openclaw/default' })),
    });
    expect(await control.probeDefaultAnswer('ping')).toEqual({ text: 'answered' });
  });

  test('an empty or unfinished default answer is not proof', async () => {
    for (const payload of [
      responseWith(''),
      responseWith('   '),
      responseWith('answer', { status: 'in_progress' }),
      responseWith('answer', { status: 'failed' }),
      {},
    ]) {
      const { control } = modelServer({ respond: () => json(payload) });
      await expect(control.probeDefaultAnswer('ping')).rejects.toThrow('openclaw_model_probe_failed');
    }
  });

  test('a failing default-answer probe never relays upstream error text', async () => {
    const { control } = modelServer({
      respond: () => json({ error: { message: 'plan trial-9912 has no remaining credit' } }, 402),
    });
    try {
      await control.probeDefaultAnswer('ping');
      throw new Error('expected throw');
    } catch (error) {
      expect((error as OpenClawControlError).code).toBe('openclaw_model_probe_failed');
      expect(String(error)).not.toContain('trial-9912');
    }
  });
});

/**
 * Verified against the pinned openclaw@2026.7.1-2 `models.authStatus` payload.
 *
 * `payload.providers` is an ARRAY of `{ provider, displayName, status, expiry?,
 * profiles[], usage? }` — NOT a map. There is no `connected` boolean and no
 * `models` list anywhere in it. Quota lives in the EMBEDDED `usage` field, whose
 * windows carry USED percent and a numeric epoch-ms `resetAt`.
 *
 * An earlier revision of this suite encoded a guessed map shape, which is why it
 * passed against an adapter that could never have read a single field.
 */
describe('provider status projection', () => {
  const UNKNOWN_QUOTA = { state: 'unknown', remainingPercent: null, resetsAt: null } as const;

  function statusServer(payload: unknown) {
    return controlFor(call => {
      const body = call.body as { method?: string };
      if (body?.method === 'models.authStatus') return rpcOk(payload);
      return rpcError('UNAVAILABLE', 'unexpected', 503);
    });
  }

  test('the authenticated status and embedded quota are projected from the array entry', async () => {
    const { control, calls } = statusServer({
      ts: 1_785_000_000_000,
      providers: [
        { provider: 'openai', displayName: 'OpenAI', status: 'missing', profiles: [] },
        {
          provider: 'anthropic',
          displayName: 'Claude',
          status: 'ok',
          profiles: [{ profileId: 'default', type: 'token', status: 'ok' }],
          usage: {
            windows: [
              { label: '5h', usedPercent: 12.5, resetAt: 1_785_000_600_000 },
              { label: 'week', usedPercent: 40 },
            ],
          },
        },
      ],
    });
    expect(await control.getProviderStatus('anthropic')).toEqual({
      authenticated: true,
      authStatus: 'ok',
      // 100 - max(12.5, 40); the busiest window is the binding one and it has no resetAt.
      quota: { state: 'known', remainingPercent: 60, resetsAt: null },
    });
    // The 60s auth cache is bypassed so a logout is not masked by stale "ok".
    expect((calls[0]!.body as { params?: unknown }).params).toEqual({ refresh: true });
  });

  test('a numeric epoch-ms resetAt is carried through as a number', async () => {
    const { control } = statusServer({
      providers: [{
        provider: 'openai',
        status: 'expiring',
        usage: { windows: [{ label: '5h', usedPercent: 90, resetAt: 1_785_000_600_000 }] },
      }],
    });
    expect(await control.getProviderStatus('openai')).toEqual({
      authenticated: true,
      authStatus: 'expiring',
      quota: { state: 'known', remainingPercent: 10, resetsAt: 1_785_000_600_000 },
    });
  });

  test('providers is an array, so map indexing must not be how the entry is found', async () => {
    // A guessed `providers['anthropic']` yields undefined against this payload.
    const { control } = statusServer({
      providers: [{ provider: 'anthropic', status: 'ok', usage: { windows: [{ label: '5h', usedPercent: 0 }] } }],
    });
    const status = await control.getProviderStatus('anthropic');
    expect(status.authenticated).toBe(true);
    expect(status.quota).toEqual({ state: 'known', remainingPercent: 100, resetsAt: null });
  });

  test('a static api_key entry is not authentication', async () => {
    const { control } = statusServer({
      providers: [{ provider: 'anthropic', status: 'static', profiles: [{ profileId: 'p', type: 'api_key', status: 'static' }] }],
    });
    expect(await control.getProviderStatus('anthropic')).toEqual({
      authenticated: false,
      authStatus: 'static',
      quota: UNKNOWN_QUOTA,
    });
  });

  test.each([['expired'], ['missing']] as const)('a %s credential is not authenticated', async status => {
    const { control } = statusServer({ providers: [{ provider: 'openai', status }] });
    const result = await control.getProviderStatus('openai');
    expect(result.authenticated).toBe(false);
    expect(result.authStatus).toBe(status);
  });

  test('an unrecognized status string fails closed to unknown', async () => {
    const { control } = statusServer({ providers: [{ provider: 'openai', status: 'BILLING_HOLD' }] });
    expect(await control.getProviderStatus('openai')).toEqual({
      authenticated: false,
      authStatus: 'unknown',
      quota: UNKNOWN_QUOTA,
    });
  });

  test('an absent provider entry fails closed rather than reading as fine', async () => {
    const { control } = statusServer({ providers: [{ provider: 'anthropic', status: 'ok' }] });
    expect(await control.getProviderStatus('openai')).toEqual({
      authenticated: false,
      authStatus: 'unknown',
      quota: UNKNOWN_QUOTA,
    });
  });

  test('an empty providers array fails closed', async () => {
    const { control } = statusServer({ ts: 1, providers: [] });
    expect(await control.getProviderStatus('anthropic')).toEqual({
      authenticated: false,
      authStatus: 'unknown',
      quota: UNKNOWN_QUOTA,
    });
  });

  test.each([
    ['a map', { anthropic: { status: 'ok' } }],
    ['a string', 'ok'],
    ['null', null],
    ['absent', undefined],
  ])('a non-array providers value (%s) fails closed', async (_label, providers) => {
    const { control } = statusServer({ providers });
    expect(await control.getProviderStatus('anthropic')).toEqual({
      authenticated: false,
      authStatus: 'unknown',
      quota: UNKNOWN_QUOTA,
    });
  });

  test('a usage error inside an ok envelope is unknown quota, not healthy', async () => {
    const { control } = statusServer({
      providers: [{ provider: 'anthropic', status: 'ok', usage: { windows: [], error: 'Timeout' } }],
    });
    const status = await control.getProviderStatus('anthropic');
    // Authentication is still known; only quota degrades.
    expect(status.authenticated).toBe(true);
    expect(status.quota).toEqual(UNKNOWN_QUOTA);
    expect(JSON.stringify(status)).not.toContain('Timeout');
  });

  test('a zero usedPercent alongside an error is not read as 100% remaining', async () => {
    const { control } = statusServer({
      providers: [{
        provider: 'anthropic',
        status: 'ok',
        usage: { windows: [{ label: '5h', usedPercent: 0 }], error: 'Fetch failed' },
      }],
    });
    expect((await control.getProviderStatus('anthropic')).quota).toEqual(UNKNOWN_QUOTA);
  });

  test('an absent or empty usage field is unknown quota, never unlimited', async () => {
    const { control } = statusServer({
      providers: [
        { provider: 'anthropic', status: 'ok' },
        { provider: 'openai', status: 'ok', usage: { windows: [] } },
      ],
    });
    expect((await control.getProviderStatus('anthropic')).quota).toEqual(UNKNOWN_QUOTA);
    expect((await control.getProviderStatus('openai')).quota).toEqual(UNKNOWN_QUOTA);
  });

  test.each([
    ['budget', [{ type: 'budget', used: 9, limit: 10, unit: 'USD' }]],
    ['balance', [{ type: 'balance', amount: 4.2, unit: 'USD' }]],
    ['spend', [{ type: 'spend', amount: 12, unit: 'USD' }]],
  ])('billing (%s) never becomes a quota number', async (_label, billing) => {
    const { control } = statusServer({
      providers: [{ provider: 'openrouter', status: 'ok', usage: { windows: [], billing } }],
    });
    // `limit` exists only on `budget`; `used / limit` on the others is NaN.
    expect((await control.getProviderStatus('openrouter')).quota).toEqual(UNKNOWN_QUOTA);
  });

  test.each([
    ['a non-numeric usedPercent', [{ label: '5h', usedPercent: 'lots' }]],
    ['an out-of-range usedPercent', [{ label: '5h', usedPercent: 340 }]],
    ['a negative usedPercent', [{ label: '5h', usedPercent: -5 }]],
    ['a NaN usedPercent', [{ label: '5h', usedPercent: null }]],
    ['a non-object window', ['5h']],
    ['one malformed window among good ones', [{ label: '5h', usedPercent: 10 }, { label: 'w' }]],
    ['a non-object window among good ones', [{ label: '5h', usedPercent: 10 }, '5h']],
  ])('%s fails the whole quota closed', async (_label, windows) => {
    const { control } = statusServer({
      providers: [{ provider: 'anthropic', status: 'ok', usage: { windows } }],
    });
    expect((await control.getProviderStatus('anthropic')).quota).toEqual(UNKNOWN_QUOTA);
  });

  test('a string resetAt is dropped rather than projected', async () => {
    const { control } = statusServer({
      providers: [{
        provider: 'anthropic',
        status: 'ok',
        usage: { windows: [{ label: '5h', usedPercent: 25, resetAt: '2026-08-01T00:00:00Z' }] },
      }],
    });
    expect((await control.getProviderStatus('anthropic')).quota)
      .toEqual({ state: 'known', remainingPercent: 75, resetsAt: null });
  });

  test('arbitrary upstream plan, account and summary text is never projected', async () => {
    const { control } = statusServer({
      providers: [{
        provider: 'anthropic',
        displayName: 'Claude',
        status: 'ok',
        account: 'acct_9912',
        profiles: [{ profileId: 'acct_9912', type: 'oauth', status: 'ok', reasonCode: 'contact billing@example.com' }],
        usage: {
          windows: [{ label: '5h', usedPercent: 20 }],
          plan: 'Claude Max 20x',
          summary: 'contact billing@example.com',
        },
      }],
    });
    const status = await control.getProviderStatus('anthropic');
    expect(status).toEqual({
      authenticated: true,
      authStatus: 'ok',
      quota: { state: 'known', remainingPercent: 80, resetsAt: null },
    });
    expect(JSON.stringify(status)).not.toContain('acct_9912');
    expect(JSON.stringify(status)).not.toContain('Claude Max');
    expect(JSON.stringify(status)).not.toContain('billing@example.com');
  });

  test('an Anthropic setup token is a token profile, not oauth, and still authenticates', async () => {
    const { control } = statusServer({
      providers: [
        { provider: 'anthropic', status: 'ok', profiles: [{ profileId: 'setup', type: 'token', status: 'ok' }] },
        { provider: 'openai', status: 'ok', profiles: [{ profileId: 'codex', type: 'oauth', status: 'ok' }] },
      ],
    });
    expect((await control.getProviderStatus('anthropic')).authenticated).toBe(true);
    expect((await control.getProviderStatus('openai')).authenticated).toBe(true);
  });

  test('a failing authStatus call is an error, not a silent disconnected answer', async () => {
    const { control } = controlFor(() => rpcError('UNAVAILABLE', 'internal', 503));
    await expect(control.getProviderStatus('anthropic')).rejects.toThrow('openclaw_unavailable');
  });

  test('quota is read from the embedded usage field, so usage.status is never called', async () => {
    const { control, calls } = statusServer({
      providers: [{ provider: 'anthropic', status: 'ok', usage: { windows: [{ label: '5h', usedPercent: 5 }] } }],
    });
    await control.getProviderStatus('anthropic');
    expect(calls).toHaveLength(1);
    expect((calls[0]!.body as { method?: string }).method).toBe('models.authStatus');
  });
});

describe('provider credential import', () => {
  function failingControlServer(echo: string) {
    return controlFor(() => json({ ok: false, error: { code: 'import_failed', message: `rejected ${echo}` } }, 400)).control;
  }

  test('sensitive request bodies never appear in thrown errors', async () => {
    const control = failingControlServer('sk-ant-oat01-secret-value');
    await expect(control.importProviderCredential({
      provider: 'anthropic',
      credential: 'sk-ant-oat01-secret-value',
    })).rejects.toThrow('openclaw_provider_import_failed');
    try {
      await control.importProviderCredential({
        provider: 'anthropic',
        credential: 'sk-ant-oat01-secret-value',
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(String(error)).not.toContain('sk-ant-oat01-secret-value');
      expect(JSON.stringify((error as Error).stack ?? '')).not.toContain('sk-ant-oat01');
    }
  });

  test('the import posts to the pinned plugin route as the internal operator', async () => {
    const { control, calls } = controlFor(() => json({ ok: true, result: {} }));
    await control.importProviderCredential({ provider: 'openrouter', credential: 'or-key' });
    expect(calls[0]!.path).toBe('/api/v1/gbrain/provider');
    expect(calls[0]!.body).toEqual({ provider: 'openrouter', credential: 'or-key' });
    expect(calls[0]!.headers['x-gbrain-openclaw-proxy']).toBe('gbrain-loopback-v1');
    expect(calls[0]!.headers.cookie).toBeUndefined();
  });

  test('a 200 that is not a pinned success is still a failure', async () => {
    const { control } = controlFor(() => json({ ok: false, error: { code: 'nope' } }));
    await expect(control.importProviderCredential({ provider: 'anthropic', credential: 'x' }))
      .rejects.toThrow('openclaw_provider_import_failed');
  });

  test('an unreachable gateway is an import failure, not a silent success', async () => {
    const control = new LoopbackOpenClawControl({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
    await expect(control.importProviderCredential({ provider: 'anthropic', credential: 'x' }))
      .rejects.toThrow('openclaw_provider_import_failed');
  });
});

describe('safe adapter failure contract', () => {
  test('transport and RPC failures expose only closed safe codes', async () => {
    const unreachable = new LoopbackOpenClawControl({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 100 });
    await expect(unreachable.runtimeHealth()).resolves.toBe(false);

    const { control } = controlFor(() => rpcError('UNAVAILABLE', 'upstream-canary-never-leak', 503));
    await expect(control.getProviderStatus('anthropic')).rejects.toMatchObject({
      name: 'OpenClawControlError',
      code: 'openclaw_unavailable',
      message: 'openclaw_unavailable',
    });
  });
});
