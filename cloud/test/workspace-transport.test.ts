/**
 * The default direct-HTTPS transport, exercised against real local sockets under
 * the runtime the control plane actually ships on (bun test IS Bun). Every other
 * suite injects `httpsImpl` fakes, so a Node-vs-Bun divergence in the real
 * transport's event plumbing is invisible to them by construction — this suite
 * exists because exactly such a divergence froze the fleet (#48): under Bun,
 * `ClientRequest.destroy(err)` emits no 'error', so a timed-out request's
 * promise never settled and the reconciler hung forever.
 *
 * The one property under test: **the transport settles on every path**. A slow
 * or dead workspace may cost the reconciler one bounded call, never the tick.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer } from 'node:https';
import { HttpWorkspace, WorkspaceApiError } from '../src/adapters/workspace.ts';
import { AGENT_RUNTIME_HEALTH_PATH } from '../src/agent-ingress-contract.ts';

const openServers: Server[] = [];
const openSockets: Socket[] = [];

afterEach(() => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  for (const server of openServers.splice(0)) server.close();
});

/** A TCP listener that accepts connections and hands each socket to `onSocket`. */
function listen(onSocket: (socket: Socket) => void): Promise<number> {
  const server = createServer(socket => {
    openSockets.push(socket);
    onSocket(socket);
  });
  openServers.push(server);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

/**
 * The assertion this whole file is about. The sentinel makes a hang fail the
 * test cleanly with its own message instead of tripping bun's opaque test
 * timeout.
 */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sentinel = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the transport never settled (waited ${ms}ms)`)), ms);
  });
  try {
    return await Promise.race([promise, sentinel]);
  } finally {
    clearTimeout(timer);
  }
}

describe('default direct-HTTPS transport (real sockets, Bun runtime)', () => {
  // The first minutes of every workspace boot look exactly like this: the
  // address answers TCP but nothing completes a TLS handshake or responds.
  test('a server that accepts and never responds: the probe settles false within the timeout budget', async () => {
    const port = await listen(() => {
      // Accept and say nothing, forever — a black hole with an open socket.
    });
    const workspace = new HttpWorkspace({ timeoutMs: 300 });

    const healthy = await settlesWithin(workspace.probeHealth(`https://localhost:${port}`, '127.0.0.1'), 2_300);

    expect(healthy).toBe(false);
  });

  test('a server that accepts and never responds: the setup link rejects retryable within the timeout budget', async () => {
    const port = await listen(() => {});
    const workspace = new HttpWorkspace({ timeoutMs: 300 });

    const error = await settlesWithin(
      workspace
        .issueSetupLink({
          baseUrl: `https://localhost:${port}`,
          ip: '127.0.0.1',
          bootstrapCredential: 'bootstrap-secret',
          idempotencyKey: 'workspace-uuid',
        })
        .catch(e => e),
      2_300,
    );

    // Retryable: a timeout says nothing about whether the workspace acted, and
    // the endpoint is idempotent on the key, so the next tick asks again.
    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect((error as WorkspaceApiError).retryable).toBe(true);
  });

  // Caddy mid-restart, a connection reset, an abandoned handshake: the socket
  // dies without a response. That must settle promptly — well before even the
  // request timeout — never hang.
  test('a server that closes the socket without responding: the probe settles false', async () => {
    const port = await listen(socket => socket.destroy());
    const workspace = new HttpWorkspace({ timeoutMs: 5_000 });

    const healthy = await settlesWithin(workspace.probeHealth(`https://localhost:${port}`, '127.0.0.1'), 2_000);

    expect(healthy).toBe(false);
  });

  // The success path, over a real TLS handshake and a real certificate check —
  // the one production path no fake can stand in for. Found live (#48): under
  // Bun the request's 'close' event fires BEFORE the response's 'end', so an
  // error path plumbed on 'close' alone silently discards every successful
  // response and a perfectly healthy workspace probes false forever.
  test('a healthy workspace answering 200 over TLS: the probe is true', async () => {
    const key = readFileSync(new URL('./fixtures/localhost-key.pem', import.meta.url));
    const cert = readFileSync(new URL('./fixtures/localhost-cert.pem', import.meta.url));
    const server = createTlsServer({ key, cert }, (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end('{"ok":true}');
    });
    openServers.push(server as unknown as Server);
    const port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    // The fixture cert is the trust anchor for this one client, standing in for
    // the system roots that vouch for Let's Encrypt in production. Verification
    // itself stays strict: a name mismatch would still fail.
    const workspace = new HttpWorkspace({ timeoutMs: 3_000, caCertPem: cert.toString('utf8') });

    const healthy = await settlesWithin(workspace.probeHealth(`https://localhost:${port}`, '127.0.0.1'), 4_000);

    expect(healthy).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #68 Task 12 — what the control plane is allowed to ask a Workspace.
//
// This transport is the ONLY channel the control plane has into a Workspace VM.
// If GBrain ever grew a competing approvals, Channels, or model-switching
// subsystem, it would have to reach the runtime through here — so pinning what
// this adapter can say is a real fence around that whole class of feature, not
// a naming convention.
//
// Approvals, Channels, and model switching stay inside OpenClaw, where their
// fail-closed semantics actually live: `config.*` (the path Channels edits and
// model switching take) always resolves to `operator.admin`
// [VERIFIED: package/docs/gateway/protocol.md:238-241,415]; the first accepted
// approval wins and later responders are refused
// [VERIFIED: package/dist/server-aux-handlers-BfM3vWwc.js:1152-1165]; and an
// approval that times out DENIES
// [VERIFIED: package/dist/server-aux-handlers-BfM3vWwc.js:1166-1179,
// package/dist/exec-approvals-BIKWP8_V.js:187]. Reimplementing any of that on
// this side of the wire would be a second, weaker copy.
// ---------------------------------------------------------------------------

describe('#68 Task 12 — the control-plane Workspace surface stays out of OpenClaw territory', () => {
  /** Every request path the adapter emitted, in order, over real TLS. */
  async function drivenPaths(): Promise<string[]> {
    const key = readFileSync(new URL('./fixtures/localhost-key.pem', import.meta.url));
    const cert = readFileSync(new URL('./fixtures/localhost-cert.pem', import.meta.url));
    const paths: string[] = [];
    const server = createTlsServer({ key, cert }, (request, response) => {
      paths.push(request.url ?? '');
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end('{"data":{"token":"setup-token"}}');
    });
    openServers.push(server as unknown as Server);
    const port = await new Promise<number>(resolve => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    const base = `https://localhost:${port}`;
    const workspace = new HttpWorkspace({ timeoutMs: 3_000, caCertPem: cert.toString('utf8') });

    // Every public call on the adapter interface, driven for real.
    await workspace.probeHealth(base, '127.0.0.1');
    await workspace.probeAgent(base, '127.0.0.1');
    await workspace.issueSetupLink({
      baseUrl: base,
      ip: '127.0.0.1',
      bootstrapCredential: 'bootstrap-secret',
      idempotencyKey: 'workspace-uuid',
    });
    return paths;
  }

  test('driving every adapter call reaches exactly three paths, none of them an OpenClaw responsibility', async () => {
    const paths = await settlesWithin(drivenPaths(), 15_000);

    // Anti-vacuous: an adapter that silently sent nothing would make every
    // filter below trivially empty.
    expect(paths).toHaveLength(3);
    expect(paths.sort()).toEqual(
      ['/api/workspace/v1/operator/links', '/health', AGENT_RUNTIME_HEALTH_PATH].sort(),
    );
    for (const forbidden of [/approval/i, /channel/i, /model/i, /config/i]) {
      expect(
        paths.filter(path => forbidden.test(path)),
        `the control plane must never ask a Workspace about ${forbidden}`,
      ).toEqual([]);
    }
  }, 20_000);

  test('the adapter exposes no call that could carry an approval, a channel, or a model switch', () => {
    // The whole runtime surface, including TypeScript `private` members — which
    // are not private at runtime and so cannot be relied on to hide a method.
    // An exact set rather than a deny-list: a `listApprovals` added tomorrow
    // fails here without anyone having predicted its name.
    const surface = Object.getOwnPropertyNames(HttpWorkspace.prototype)
      .filter(name => name !== 'constructor')
      .sort();
    expect(surface).toEqual(['issueSetupLink', 'port', 'probeAgent', 'probeHealth']);
  });
});
