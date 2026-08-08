/**
 * The #68 ingress split, proved by running the REAL Caddy against the REAL
 * rendered configuration.
 *
 * Why this file exists rather than more `toContain` assertions: the pinned
 * OpenClaw Gateway's `gateway.auth.trustedProxy.requiredHeaders` is a PRESENCE
 * check — it never compares the header value — and `allowLoopback` is on. So the
 * whole authentication boundary for the browser route is "Caddy deleted the
 * client's copy of two headers and created one of its own". A string assertion
 * proves a line was typed. Only Caddy itself proves the line does what the
 * directive reference says it does, in the order the file puts it, with the
 * matcher that actually matched.
 *
 * The proofs:
 *   1. browser forward_auth still receives the GBrain session cookie;
 *   2. the browser OpenClaw upstream receives exactly one identity header —
 *      Caddy's — and no cookie, scope, or forwarded evidence;
 *   3. native readiness receives no Authorization while the upstream still does;
 *   4. `/agent-client/foo?x=1` reaches the upstream as `/agent/foo?x=1`;
 *   5. a WebSocket upgrade survives both routes; and
 *   6. forged proxy/identity/scope headers never reach either OpenClaw surface.
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { connect, createServer as netServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const imageRoot = fileURLToPath(new URL('../image/', import.meta.url));

// ---------------------------------------------------------------------------
// Locating Caddy.
//
// This suite must never report green without having run Caddy. A `test.skipIf`
// here would be exactly the fail-open this issue's lineage keeps producing: the
// suite would go green on a machine with no Caddy, and the one proof that the
// authentication boundary works would quietly stop existing.
// ---------------------------------------------------------------------------

function locateCaddy(): string | null {
  const explicit = process.env.GBRAIN_CADDY_BIN?.trim();
  if (explicit) {
    const probe = spawnSync(explicit, ['version'], { encoding: 'utf8' });
    if (probe.status === 0) return explicit;
    return null;
  }
  for (const candidate of ['caddy', 'caddy.exe']) {
    const probe = spawnSync(candidate, ['version'], { encoding: 'utf8' });
    if (probe.status === 0) return candidate;
  }
  return null;
}

const caddyBin = locateCaddy();

test('a Caddy binary is available to prove the ingress split', () => {
  expect(
    caddyBin,
    'No Caddy binary found. The #68 ingress split IS a Caddy configuration, and its '
    + 'authentication boundary cannot be proved by reading the file. Install Caddy, or point '
    + 'GBRAIN_CADDY_BIN at a binary, and re-run. This test fails rather than skipping on '
    + 'purpose: a green run without Caddy would mean nothing ever proved that a forged '
    + 'X-GBrain-OpenClaw-User is stripped.',
  ).not.toBeNull();
});

// ---------------------------------------------------------------------------
// Capture servers.
// ---------------------------------------------------------------------------

interface Capture {
  method: string;
  url: string;
  headers: Record<string, string>;
}

interface CaptureServer {
  port: number;
  calls: Capture[];
  /** Status the next request is answered with; reset to defaultStatus per test. */
  status: number;
  /** The status this server was created with, so afterEach can restore it. */
  readonly defaultStatus: number;
  server: Server;
}

const servers: CaptureServer[] = [];
/** Raw upgrade sockets, torn down after each test so none outlives its Caddy. */
const openSockets: Socket[] = [];

/**
 * A byte-level HTTP/1.1 capture server, built on `node:net` rather than
 * `node:http`.
 *
 * `node:http` would be the obvious choice and it is the wrong one HERE. Under
 * Bun — which is what `bun test` runs — a raw `socket.write()` from the server's
 * `'upgrade'` handler is never flushed to the wire, while the identical code
 * under Node works. Isolated directly: Node's client receives the full 101
 * status line, Bun's receives an empty string, with the server's own upgrade
 * handler observably running in both. The consequence was five seconds of
 * silence that this suite reported as "the Caddy WebSocket route is broken"
 * while Caddy was in fact forwarding the upgrade correctly.
 *
 * Speaking HTTP directly removes the runtime from the proof entirely, which is
 * the point of this file: what is under test is the bytes Caddy sends, and a
 * capture layer that behaves differently per runtime cannot witness them.
 */
async function captureServer(defaultStatus: number, body = ''): Promise<CaptureServer> {
  const state = { port: 0, calls: [] as Capture[], status: defaultStatus, defaultStatus } as CaptureServer;
  const server = netServer(socket => {
    let buffer = Buffer.alloc(0);
    // Each socket answers exactly one request. That is only correct because the
    // non-upgrade answer below sets `Connection: close` and ends the socket:
    // drop that header and a keep-alive second request on the same connection
    // would be silently ignored here rather than failing.
    let handled = false;
    socket.on('data', (chunk: Buffer | string) => {
      if (handled) return;
      buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk, 'latin1') : chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString('latin1');
      const [requestLine, ...headerLines] = head.split('\r\n');
      const [method = '', url = ''] = requestLine.split(' ');
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        // Lower-cased keys, matching what node:http exposed, and repeated
        // headers joined rather than dropped — a dropped duplicate could hide a
        // forged header sitting beside a legitimate one.
        const key = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[key] = key in headers ? `${headers[key]},${value}` : value;
      }
      // Drain a declared body before answering, so Caddy never sees a reset.
      // Content-Length only: a `Transfer-Encoding: chunked` request would be
      // answered mid-body. Nothing in this suite sends one, and Caddy forwards
      // the fixed-length bodies these tests use as fixed-length.
      const declared = Number(headers['content-length'] ?? '0');
      if (Number.isFinite(declared) && declared > 0 && buffer.length < end + 4 + declared) return;
      handled = true;

      const upgrading = /websocket/i.test(headers.upgrade ?? '');
      state.calls.push({ method: upgrading ? 'UPGRADE' : method, url, headers });
      if (upgrading) {
        socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
        return;
      }
      // The one header a real forward_auth answer must be able to hand back.
      const identity = state.status === 204 ? 'X-GBrain-OpenClaw-User: membership-from-gbrain\r\n' : '';
      socket.write(
        `HTTP/1.1 ${state.status} X\r\n${identity}Content-Type: text/plain\r\n`
        + `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      socket.end();
    });
    socket.on('error', () => socket.destroy());
  });
  state.server = server;
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  state.port = (server.address() as { port: number }).port;
  servers.push(state);
  return state;
}

// ---------------------------------------------------------------------------
// The configuration under test: the finalizer's own heredoc, with only the
// site address and the two loopback upstream ports rebound to test sockets.
// Nothing else is rewritten — every matcher, directive, and ordering decision is
// the bytes that ship.
// ---------------------------------------------------------------------------

async function renderCaddyfile(input: { listen: number; gbrain: number; openclaw: number }): Promise<string> {
  const finalizer = (await readFile(join(imageRoot, 'files', 'bin', 'gbrain-agent-finalize'), 'utf8'))
    .replace(/\r\n/g, '\n');
  const body = /cat >"\$caddyfile_tmp" <<EOF\n([\s\S]*?)\nEOF\n/.exec(finalizer);
  expect(body, 'the agent finalizer no longer renders a Caddyfile with a heredoc').not.toBeNull();
  return body![1]
    .replace('${GBRAIN_SUBDOMAIN} {', `:${input.listen} {`)
    .replaceAll('127.0.0.1:3131', `127.0.0.1:${input.gbrain}`)
    .replaceAll('127.0.0.1:3334', `127.0.0.1:${input.openclaw}`);
}

let workDir: string;
let caddy: ChildProcess | null = null;
let listenPort = 0;
let gbrain: CaptureServer;
let openclaw: CaptureServer;

async function freePort(): Promise<number> {
  const probe = netServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

beforeAll(async () => {
  if (!caddyBin) return;
  workDir = await mkdtemp(join(tmpdir(), 'gbrain-caddy-'));
  gbrain = await captureServer(204);
  openclaw = await captureServer(200, 'openclaw-upstream');
  listenPort = await freePort();
  const config = await renderCaddyfile({ listen: listenPort, gbrain: gbrain.port, openclaw: openclaw.port });
  const path = join(workDir, 'Caddyfile');
  await writeFile(path, config, 'utf8');

  const validate = spawnSync(caddyBin, ['validate', '--config', path, '--adapter', 'caddyfile'], { encoding: 'utf8' });
  expect(validate.status, `caddy validate failed:\n${validate.stderr}\n${validate.stdout}`).toBe(0);

  caddy = spawn(caddyBin, ['run', '--config', path, '--adapter', 'caddyfile'], {
    cwd: workDir,
    env: { ...process.env, XDG_DATA_HOME: workDir, XDG_CONFIG_HOME: workDir, HOME: workDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for the listener rather than sleeping a fixed interval.
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${listenPort}/`, { redirect: 'manual' });
      break;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`Caddy never started listening on ${listenPort}: ${String(error)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  // The warm-up request must not pollute the per-test capture assertions.
  gbrain.calls.length = 0;
  openclaw.calls.length = 0;
}, 40_000);

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  for (const server of servers) {
    server.calls.length = 0;
    server.status = server.defaultStatus;
  }
});

afterAll(async () => {
  caddy?.kill();
  for (const server of servers) await new Promise<void>(resolve => server.server.close(() => resolve()));
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
});

const live = () => caddyBin !== null;

/** The forward_auth call and the upstream call for the most recent request. */
function lastAuth(): Capture {
  const call = gbrain.calls.at(-1);
  expect(call, 'GBrain received no forward_auth call').toBeDefined();
  return call!;
}
function lastUpstream(): Capture | undefined {
  return openclaw.calls.at(-1);
}

// ---------------------------------------------------------------------------

/**
 * The authoritative ordering proof, and the reason this file exists at all.
 *
 * Caddy REORDERS directives inside a `handle` block into its own standard order
 * at adapt time. Written order is not effective order, so a static test that
 * asserts `request_header -X-GBrain-OpenClaw-User` appears above `forward_auth`
 * in the file is a presence check one level up: it passed while Caddy was
 * emitting the strips AFTER the auth call. The live consequence was the
 * authentication boundary failing in both directions at once — a forged identity
 * reached the gate, and the strips then deleted the very header `copy_headers`
 * had just written, so the real identity never reached OpenClaw.
 *
 * `route { }` is the construct that preserves written order verbatim. This test
 * reads the adapted JSON and asserts the emitted handler SEQUENCE, so the fix
 * cannot silently regress by someone "tidying" the route wrapper away.
 */
test.if(live())('the adapted handler sequence puts the strips before the gate, and the gate before the upstream', async () => {
  const adapt = spawnSync(caddyBin!, ['adapt', '--config', join(workDir, 'Caddyfile'), '--adapter', 'caddyfile'], {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  expect(adapt.status, `caddy adapt failed:\n${adapt.stderr}`).toBe(0);
  const config = JSON.parse(adapt.stdout) as {
    apps: { http: { servers: Record<string, { routes: unknown[] }> } };
  };
  const routes = Object.values(config.apps.http.servers)[0].routes as Array<{
    match?: Array<{ path?: string[] }>;
    handle: Array<{ handler: string; routes?: Array<{ handle: Array<Record<string, unknown>> }> }>;
  }>;

  /** The flat handler list Caddy will actually run for a matched prefix. */
  const sequenceFor = (prefix: string) => {
    const route = routes.find(candidate => candidate.match?.[0]?.path?.includes(prefix));
    expect(route, `no adapted route matches ${prefix}`).toBeDefined();
    const flatten = (handlers: Array<Record<string, unknown>>): Array<Record<string, unknown>> =>
      handlers.flatMap(handler => handler.handler === 'subroute'
        ? (handler.routes as Array<{ handle: Array<Record<string, unknown>> }>).flatMap(sub => flatten(sub.handle))
        : [handler]);
    return flatten(route!.handle as Array<Record<string, unknown>>);
  };

  const browser = sequenceFor('/agent');
  const describe = (handler: Record<string, unknown>) => {
    const headers = handler.headers as { request?: { delete?: string[]; set?: Record<string, unknown> } } | undefined;
    const request = handler.request as { delete?: string[] } | undefined;
    return {
      handler: handler.handler as string,
      deletes: request?.delete ?? headers?.request?.delete ?? [],
      dial: (handler.upstreams as Array<{ dial: string }> | undefined)?.[0]?.dial,
      rewriteUri: (handler.rewrite as { uri?: string } | undefined)?.uri,
    };
  };
  const browserSeq = browser.map(describe);

  // Exactly this shape, in exactly this order.
  expect(browserSeq).toHaveLength(4);
  expect(browserSeq[0]).toMatchObject({ handler: 'headers', deletes: ['X-GBrain-OpenClaw-User'] });
  expect(browserSeq[1]).toMatchObject({ handler: 'headers', deletes: ['X-GBrain-OpenClaw-Proxy'] });
  // The gate: a reverse_proxy to GBrain that rewrites the URI to authorize.
  expect(browserSeq[2].handler).toBe('reverse_proxy');
  expect(browserSeq[2].rewriteUri).toBe('/api/workspace/v1/agent/authorize');
  // The OpenClaw upstream is LAST, so the identity copy_headers writes survives.
  expect(browserSeq[3].handler).toBe('reverse_proxy');
  expect(browserSeq[3].rewriteUri).toBeUndefined();
  expect(browserSeq[3].deletes).toContain('Cookie');
  // The exact regression that shipped: an identity strip emitted AFTER the gate
  // deletes what copy_headers just set.
  const gateIndex = browserSeq.findIndex(step => step.rewriteUri === '/api/workspace/v1/agent/authorize');
  for (const [index, step] of browserSeq.entries()) {
    if (index <= gateIndex) continue;
    expect(
      step.deletes,
      `handler ${index} runs after the gate and would delete the identity it just produced`,
    ).not.toContain('X-GBrain-OpenClaw-User');
  }

  const nativeSeq = sequenceFor('/agent-client').map(describe);
  expect(nativeSeq).toHaveLength(3);
  expect(nativeSeq[0].handler).toBe('reverse_proxy');
  expect(nativeSeq[0].rewriteUri).toBe('/api/workspace/v1/agent/native-ready');
  expect(nativeSeq[0].deletes).toContain('Authorization');
  expect(nativeSeq[1].handler).toBe('rewrite');
  expect(nativeSeq[2].handler).toBe('reverse_proxy');
  // The password strip is scoped to the gate: the upstream must still get it.
  expect(nativeSeq[2].deletes).not.toContain('Authorization');
});

test.if(live())('the browser gate receives the GBrain session cookie', async () => {
  const response = await fetch(`http://127.0.0.1:${listenPort}/agent/`, {
    headers: { cookie: 'workspace_session=abc123' },
    redirect: 'manual',
  });
  expect(response.status).toBe(200);
  const auth = lastAuth();
  expect(auth.url).toBe('/api/workspace/v1/agent/authorize');
  // forward_auth must still authenticate as the browser: stripping Cookie at the
  // top of the handler instead of on the upstream would break every Member.
  expect(auth.headers.cookie).toBe('workspace_session=abc123');
});

test.if(live())('the browser upstream gets exactly one identity header and none of the caller’s', async () => {
  await fetch(`http://127.0.0.1:${listenPort}/agent/ui`, {
    headers: {
      cookie: 'workspace_session=abc123',
      'X-GBrain-OpenClaw-User': 'forged-administrator',
      'X-GBrain-OpenClaw-Proxy': 'forged-proxy',
      'X-OpenClaw-Scopes': 'operator',
      'X-Forwarded-For': '10.0.0.1',
      'X-Real-IP': '10.0.0.1',
      forwarded: 'for=10.0.0.1',
    },
    redirect: 'manual',
  });
  const upstream = lastUpstream();
  expect(upstream, 'the browser route never reached the OpenClaw upstream').toBeDefined();
  // The identity is GBrain's answer, NOT the caller's claim. This single
  // assertion is the authentication boundary for the whole browser route.
  expect(upstream!.headers['x-gbrain-openclaw-user']).toBe('membership-from-gbrain');
  expect(upstream!.headers['x-gbrain-openclaw-user']).not.toBe('forged-administrator');
  expect(upstream!.headers['x-gbrain-openclaw-proxy']).toBe('gbrain-browser-v1');
  expect(upstream!.headers.cookie).toBeUndefined();
  expect(upstream!.headers['x-openclaw-scopes']).toBeUndefined();
  expect(upstream!.headers.forwarded).toBeUndefined();
  expect(upstream!.headers['x-forwarded-for']).toBeUndefined();
  expect(upstream!.headers['x-forwarded-host']).toBeUndefined();
  expect(upstream!.headers['x-forwarded-proto']).toBeUndefined();
  expect(upstream!.headers['x-real-ip']).toBeUndefined();
});

test.if(live())('the browser gate refusing closes the route', async () => {
  gbrain.status = 403;
  const response = await fetch(`http://127.0.0.1:${listenPort}/agent/ui`, {
    headers: { cookie: 'workspace_session=abc123', 'X-GBrain-OpenClaw-User': 'forged' },
    redirect: 'manual',
  });
  expect(response.status).toBe(403);
  expect(openclaw.calls).toHaveLength(0);
});

test.if(live())('the browser gate itself never sees a forged identity header', async () => {
  await fetch(`http://127.0.0.1:${listenPort}/agent/ui`, {
    headers: {
      cookie: 'workspace_session=abc123',
      'X-GBrain-OpenClaw-User': 'forged-administrator',
      'X-GBrain-OpenClaw-Proxy': 'forged-proxy',
    },
    redirect: 'manual',
  });
  const auth = lastAuth();
  // The strip precedes forward_auth, so GBrain cannot be confused by the claim
  // even if it were ever to read the header.
  expect(auth.headers['x-gbrain-openclaw-user']).toBeUndefined();
  expect(auth.headers['x-gbrain-openclaw-proxy']).toBeUndefined();
});

test.if(live())('native readiness is asked without the shared password, which still reaches OpenClaw', async () => {
  await fetch(`http://127.0.0.1:${listenPort}/agent-client/api/v1/responses`, {
    method: 'POST',
    headers: { authorization: 'Bearer shared-native-password', 'content-type': 'application/json' },
    body: '{}',
    redirect: 'manual',
  });
  const auth = lastAuth();
  expect(auth.url).toBe('/api/workspace/v1/agent/native-ready');
  expect(auth.headers.authorization).toBeUndefined();

  const upstream = lastUpstream();
  expect(upstream, 'the native route never reached the OpenClaw upstream').toBeDefined();
  // The password is the native route's whole authentication: the Gateway's
  // direct-loopback password fallback is what authenticates the app or CLI,
  // because this route deliberately carries no proxy identity.
  expect(upstream!.headers.authorization).toBe('Bearer shared-native-password');
  expect(upstream!.headers['x-gbrain-openclaw-user']).toBeUndefined();
  expect(upstream!.headers['x-gbrain-openclaw-proxy']).toBeUndefined();
});

test.if(live())('the native route rewrites its public prefix onto the gateway base path, query intact', async () => {
  await fetch(`http://127.0.0.1:${listenPort}/agent-client/foo?x=1`, { redirect: 'manual' });
  expect(lastUpstream()!.url).toBe('/agent/foo?x=1');
});

test.if(live())('a forged proxy identity never reaches the native OpenClaw surface', async () => {
  await fetch(`http://127.0.0.1:${listenPort}/agent-client/foo`, {
    headers: {
      'X-GBrain-OpenClaw-User': 'forged-administrator',
      'X-GBrain-OpenClaw-Proxy': 'gbrain-browser-v1',
      'X-OpenClaw-Scopes': 'operator',
      cookie: 'workspace_session=abc123',
      forwarded: 'for=10.0.0.1',
      'X-Forwarded-For': '10.0.0.1',
      'X-Real-IP': '10.0.0.1',
    },
    redirect: 'manual',
  });
  const upstream = lastUpstream()!;
  // With no identity headers the pinned Gateway refuses trusted-proxy auth
  // outright, which is the intent: only the password may open this route.
  expect(upstream.headers['x-gbrain-openclaw-user']).toBeUndefined();
  expect(upstream.headers['x-gbrain-openclaw-proxy']).toBeUndefined();
  expect(upstream.headers['x-openclaw-scopes']).toBeUndefined();
  expect(upstream.headers.cookie).toBeUndefined();
  expect(upstream.headers.forwarded).toBeUndefined();
  expect(upstream.headers['x-forwarded-for']).toBeUndefined();
  expect(upstream.headers['x-real-ip']).toBeUndefined();
});

test.if(live())('the native gate refusing closes the route', async () => {
  gbrain.status = 503;
  const response = await fetch(`http://127.0.0.1:${listenPort}/agent-client/foo`, { redirect: 'manual' });
  expect(response.status).toBe(503);
  expect(openclaw.calls).toHaveLength(0);
});

/**
 * Drive a raw upgrade through Caddy and report the status line it produced.
 *
 * A raw TCP socket, NOT `node:http`'s client. Under Bun — which is what `bun
 * test` runs — a `ClientRequest` never emits the `'upgrade'` event, so this
 * whole proof hung for five seconds and then reported the CONFIG broken while
 * Caddy was in fact forwarding the upgrade correctly and the upstream was
 * answering 101. Same Bun-vs-Node divergence family as #48, and the same lesson:
 * the transport under test must be observed at the bytes, not through a client
 * abstraction whose event plumbing differs between runtimes.
 */
function upgrade(path: string, headers: Record<string, string>): Promise<{ status: number; raw: string }> {
  return new Promise((resolve, reject) => {
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${listenPort}`,
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '', '',
    ].join('\r\n');
    const socket = connect(listenPort, '127.0.0.1', () => socket.write(lines));
    openSockets.push(socket);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`the upgrade to ${path} never produced a status line; received ${JSON.stringify(buffer)}`));
    }, 8_000);
    socket.on('data', chunk => {
      buffer += chunk.toString('latin1');
      // Resolve on the end of the status/header block, whatever the status was:
      // a 403 or a 200 must be reportable, not a hang.
      if (!buffer.includes('\r\n\r\n')) return;
      clearTimeout(timer);
      socket.destroy();
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(buffer)?.[1] ?? 0);
      resolve({ status, raw: buffer });
    });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!buffer.includes('\r\n\r\n')) reject(new Error(`the upgrade to ${path} was closed without a response`));
    });
  });
}

test.if(live())('a WebSocket upgrade survives the browser route', async () => {
  const result = await upgrade('/agent/ws', { cookie: 'workspace_session=abc123' });
  expect(result.status).toBe(101);
  const upstream = openclaw.calls.at(-1)!;
  expect(upstream.method).toBe('UPGRADE');
  expect(upstream.headers['x-gbrain-openclaw-proxy']).toBe('gbrain-browser-v1');
  expect(upstream.headers.cookie).toBeUndefined();
});

test.if(live())('a WebSocket upgrade survives the native route, rewritten and unidentified', async () => {
  const result = await upgrade('/agent-client/ws', { authorization: 'Bearer shared-native-password' });
  expect(result.status).toBe(101);
  const upstream = openclaw.calls.at(-1)!;
  expect(upstream.method).toBe('UPGRADE');
  expect(upstream.url).toBe('/agent/ws');
  expect(upstream.headers.authorization).toBe('Bearer shared-native-password');
  expect(upstream.headers['x-gbrain-openclaw-proxy']).toBeUndefined();
});

// ---------------------------------------------------------------------------
// #68 Task 12 — approvals, model switching, and Channels belong to OpenClaw,
// and this ingress is what hands them over intact.
//
// SCOPE, stated plainly so nobody reads more into these than they prove: the
// pinned OpenClaw Gateway is NOT running in this suite. The upstream is a byte
// -level capture server. What is proved here is GBrain's HALF of the contract —
// that a device-bearing connect, an operator-scoped call, and an approval
// response all reach the runtime unmodified and unidentified-by-GBrain, and
// that the preconditions the pinned Gateway's own rules depend on are actually
// produced by this configuration. The Gateway-side behaviours those
// preconditions unlock are third-party runtime facts, verified from the
// `openclaw@2026.7.1-2` tarball and cited inline; observing them end to end is
// the Task 14 real-VM journey's job, not this file's.
//
//   - a WS client needs its own paired device identity for operator scopes;
//     transport auth alone gets its scope list cleared to `[]`
//     [VERIFIED: package/docs/gateway/trusted-proxy-auth.md:124-130];
//   - with forwarded evidence stripped, a fresh device arriving through the
//     proxy is seen as loopback and silently paired
//     [VERIFIED: package/docs/gateway/pairing.md:199-208,
//     package/docs/security/index.md:584];
//   - `config.*` — Channels edits and model switching — always resolves to
//     `operator.admin`; `models.list` is an ordinary `operator.read`
//     [VERIFIED: package/docs/gateway/protocol.md:238-241,415];
//   - the shared identity holds `operator.approvals` by default
//     [VERIFIED: package/docs/gateway/operator-scopes.md:112-115].
// ---------------------------------------------------------------------------

/**
 * The precondition the pinned Gateway's silent loopback pairing depends on.
 *
 * This is the assertion that actually earns the design's most load-bearing
 * third-party claim. The rule is not "a proxy pairs devices"; it is "a loopback
 * socket with NO forwarded-header evidence is auto-approved, and any
 * `Forwarded`, `X-Forwarded-*`, or `X-Real-IP` evidence disqualifies it"
 * [VERIFIED: package/docs/gateway/pairing.md:199-208]. Caddy adds those headers
 * by default. So if a future edit drops one strip, pairing silently starts
 * requiring manual approval that no one in this product can give — the runtime
 * would be reachable and permanently scope-less.
 */
const FORWARDED_EVIDENCE = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
] as const;

test.if(live())('a fresh browser device profile reaches the runtime with the loopback claim intact', async () => {
  // A device-bearing connect, as the Control UI makes it: the device material
  // is in the request, not in a GBrain-issued header.
  const first = await upgrade('/agent/ws', {
    cookie: 'workspace_session=abc123',
    'X-OpenClaw-Device-Id': 'browser-device-alpha',
  });
  expect(first.status).toBe(101);
  const alpha = openclaw.calls.at(-1)!;

  const second = await upgrade('/agent/ws', {
    cookie: 'workspace_session=def456',
    'X-OpenClaw-Device-Id': 'browser-device-beta',
  });
  expect(second.status).toBe(101);
  const beta = openclaw.calls.at(-1)!;

  for (const call of [alpha, beta]) {
    expect(call.method).toBe('UPGRADE');
    // Nothing that would disqualify the loopback locality claim.
    for (const header of FORWARDED_EVIDENCE) {
      expect(call.headers[header], `${header} would disqualify loopback pairing`).toBeUndefined();
    }
    // GBrain names the Membership and nothing else: no scope set, no role.
    expect(call.headers['x-gbrain-openclaw-proxy']).toBe('gbrain-browser-v1');
    expect(call.headers['x-openclaw-scopes']).toBeUndefined();
  }
  // Two FRESH device profiles, each carrying its own identity through unaltered.
  // GBrain neither invents nor rewrites device identity — it has none to give.
  expect(alpha.headers['x-openclaw-device-id']).toBe('browser-device-alpha');
  expect(beta.headers['x-openclaw-device-id']).toBe('browser-device-beta');
  expect(alpha.headers['x-openclaw-device-id']).not.toBe(beta.headers['x-openclaw-device-id']);
});

test.if(live())('a fresh native device profile reaches the runtime with its own credential and no GBrain identity', async () => {
  const result = await upgrade('/agent-client/ws', {
    authorization: 'Bearer shared-native-password',
    'X-OpenClaw-Device-Id': 'native-device-gamma',
  });
  expect(result.status).toBe(101);
  const call = openclaw.calls.at(-1)!;
  expect(call.url).toBe('/agent/ws');
  expect(call.headers['x-openclaw-device-id']).toBe('native-device-gamma');
  // The shared password is the native route's whole authentication; GBrain adds
  // no proxy identity here, so a native client cannot inherit browser trust.
  expect(call.headers.authorization).toBe('Bearer shared-native-password');
  expect(call.headers['x-gbrain-openclaw-proxy']).toBeUndefined();
  expect(call.headers['x-gbrain-openclaw-user']).toBeUndefined();
  for (const header of FORWARDED_EVIDENCE) {
    expect(call.headers[header], `${header} would disqualify loopback pairing`).toBeUndefined();
  }
});

/**
 * One `operator.admin`-scoped call per pairing, on each route.
 *
 * `config.*` is the admin-scoped family — it is what Channels edits and model
 * switching actually go through [VERIFIED: package/docs/gateway/protocol.md:
 * 238-241,415]. `models.list`, despite reading like an administrative call, is
 * an ordinary `operator.read`, so it is NOT the probe: asserting it as
 * admin-scoped would bake a false claim into this suite.
 *
 * What is proved: GBrain's ingress carries an admin-scoped call and an approval
 * response to the runtime UNCHANGED and adds no opinion of its own. GBrain does
 * not filter, queue, mirror, or authorize them — the runtime decides.
 */
test.if(live())('admin-scoped config and approval calls pass through both routes unmodified', async () => {
  const probes = [
    // Channels editing and model switching: `config.*`, always operator.admin.
    { path: '/config/set', body: '{"method":"config.set"}' },
    // Approvals: a distinct scope the shared identity holds by default.
    { path: '/approvals/respond', body: '{"decision":"allow"}' },
  ];

  for (const probe of probes) {
    await fetch(`http://127.0.0.1:${listenPort}/agent${probe.path}`, {
      method: 'POST',
      headers: { cookie: 'workspace_session=abc123', 'content-type': 'application/json' },
      body: probe.body,
      redirect: 'manual',
    });
    const browser = lastUpstream();
    expect(browser, `the browser route never carried ${probe.path} to OpenClaw`).toBeDefined();
    expect(browser!.url).toBe(`/agent${probe.path}`);
    expect(browser!.method).toBe('POST');
    // The identity is GBrain's answer about WHO is at the door. It says nothing
    // about scope, and GBrain issues no scope header at all.
    expect(browser!.headers['x-gbrain-openclaw-user']).toBe('membership-from-gbrain');
    expect(browser!.headers['x-openclaw-scopes']).toBeUndefined();

    await fetch(`http://127.0.0.1:${listenPort}/agent-client${probe.path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer shared-native-password', 'content-type': 'application/json' },
      body: probe.body,
      redirect: 'manual',
    });
    const nativeCall = lastUpstream();
    expect(nativeCall!.url).toBe(`/agent${probe.path}`);
    expect(nativeCall!.headers.authorization).toBe('Bearer shared-native-password');
    expect(nativeCall!.headers['x-gbrain-openclaw-user']).toBeUndefined();
    expect(nativeCall!.headers['x-openclaw-scopes']).toBeUndefined();
  }
});

/**
 * The other half of the ownership claim: GBrain's own API answers none of this.
 *
 * `/api/workspace/v1/agent/approvals` and `/api/workspace/v1/agent/channels`
 * are outside both agent prefixes, so they reach GBrain — where no handler
 * exists. That absence is asserted against the real router in
 * `test/workspace-agent-setup.test.ts`; here the point is only that the ingress
 * does not invent one by routing them to OpenClaw and calling it a GBrain API.
 */
test.if(live())('the GBrain API prefix never becomes a back door onto the runtime', async () => {
  for (const path of [
    '/api/workspace/v1/agent/approvals',
    '/api/workspace/v1/agent/channels',
    '/api/workspace/v1/agent/models',
  ]) {
    await fetch(`http://127.0.0.1:${listenPort}${path}`, { redirect: 'manual' });
    expect(openclaw.calls, `${path} must never reach the OpenClaw upstream`).toHaveLength(0);
    expect(gbrain.calls.at(-1)!.url).toBe(path);
  }
});

test.if(live())('everything outside the two agent prefixes still reaches GBrain unchanged', async () => {
  const response = await fetch(`http://127.0.0.1:${listenPort}/app/home`, {
    headers: { cookie: 'workspace_session=abc123' },
    redirect: 'manual',
  });
  expect(response.status).toBe(204);
  const call = gbrain.calls.at(-1)!;
  expect(call.url).toBe('/app/home');
  // The root route is untouched by #68: no forward_auth, no header surgery.
  expect(call.headers.cookie).toBe('workspace_session=abc123');
  expect(openclaw.calls).toHaveLength(0);
  // A path that merely starts with the same letters is not the agent route.
  const notAgent = await fetch(`http://127.0.0.1:${listenPort}/agentic`, { redirect: 'manual' });
  expect(notAgent.status).toBe(204);
  expect(openclaw.calls).toHaveLength(0);
});
