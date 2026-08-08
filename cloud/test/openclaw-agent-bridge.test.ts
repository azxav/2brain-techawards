import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The GBrain provider bridge (#68) — the one GBrain-owned surface inside the
 * pinned OpenClaw runtime.
 *
 * Most of this file drives the REAL handler rather than reading its source. The
 * bridge imports two bare `openclaw/plugin-sdk/*` specifiers that are not
 * installed in this repository, so the plugin is copied into a temporary
 * package whose `node_modules` supplies recording stubs for exactly those two
 * subpaths. That makes the route descriptor and every refusal an observed
 * behavior instead of a substring that happens to appear.
 *
 * The stubs are the ONLY place this file simulates OpenClaw. Their exported
 * names are the ones verified against the pinned `openclaw@2026.7.1-2` tarball;
 * `verify-contract.ts` and `gbrain-agent-finalize` prove the real subpath still
 * exports them on the image itself, which a stub can never do.
 */
const BRIDGE_DIR = join(import.meta.dir, '..', 'image', 'files', 'openclaw', 'gbrain-agent-bridge');

interface RecordedRoute {
  path: string;
  auth: string;
  match: string;
  gatewayRuntimeScopeSurface: string;
  handler: (req: unknown, res: unknown) => Promise<boolean>;
}

interface StubCalls {
  upserts: Array<{ profileId: string; credential: Record<string, unknown>; agentDir: string }>;
  validated: string[];
}

/** Minimal `http.IncomingMessage` stand-in: headers, method, and a body stream. */
function fakeRequest(options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  chunked?: boolean;
}): AsyncIterable<Buffer> & { method: string; headers: Record<string, string> } {
  const raw = options.body === undefined ? Buffer.alloc(0) : Buffer.from(options.body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(options.chunked ? {} : { 'content-length': String(raw.length) }),
    ...options.headers,
  };
  return {
    method: options.method ?? 'POST',
    headers,
    async *[Symbol.asyncIterator]() {
      // Two chunks so the streaming bound is exercised rather than one buffer.
      yield raw.subarray(0, Math.ceil(raw.length / 2));
      yield raw.subarray(Math.ceil(raw.length / 2));
    },
  };
}

function fakeResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    payload: undefined as unknown,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk: string) {
      this.payload = JSON.parse(chunk);
    },
  };
}

describe('the GBrain provider bridge plugin', () => {
  let manifest: Record<string, unknown>;
  let packageManifest: Record<string, unknown>;
  let source: string;
  let route: RecordedRoute;
  let calls: StubCalls;
  /** Set by the stub before each invocation to steer the fake SDK. */
  let anthropicProblem: string | undefined;
  let upsertResult: unknown;
  let sandbox: string;

  beforeAll(async () => {
    manifest = JSON.parse(await readFile(join(BRIDGE_DIR, 'openclaw.plugin.json'), 'utf8'));
    packageManifest = JSON.parse(await readFile(join(BRIDGE_DIR, 'package.json'), 'utf8'));
    source = (await readFile(join(BRIDGE_DIR, 'index.js'), 'utf8')).replace(/\r\n/g, '\n');

    sandbox = await mkdtemp(join(tmpdir(), 'gbrain-agent-bridge-'));
    const plugin = join(sandbox, 'plugin');
    await cp(BRIDGE_DIR, plugin, { recursive: true });
    const sdk = join(plugin, 'node_modules', 'openclaw', 'plugin-sdk');
    await mkdir(sdk, { recursive: true });
    await writeFile(
      join(plugin, 'node_modules', 'openclaw', 'package.json'),
      JSON.stringify({
        name: 'openclaw',
        version: '2026.7.1-2',
        type: 'module',
        exports: {
          './plugin-sdk/plugin-entry': './plugin-sdk/plugin-entry.js',
          './plugin-sdk/provider-auth': './plugin-sdk/provider-auth.js',
        },
      }),
    );
    // Identity, matching the pinned release's own `definePluginEntry`.
    await writeFile(
      join(sdk, 'plugin-entry.js'),
      'export function definePluginEntry(options) { return { ...options }; }\n',
    );
    await writeFile(
      join(sdk, 'provider-auth.js'),
      `export const calls = { upserts: [], validated: [] };
export const control = { anthropicProblem: undefined, upsertResult: {} };
export function resolveOpenClawAgentDir(env) {
  return env.OPENCLAW_STATE_DIR ?? '/var/lib/openclaw/.openclaw';
}
export function validateAnthropicSetupToken(raw) {
  calls.validated.push(raw);
  return control.anthropicProblem;
}
export async function upsertAuthProfileWithLock(params) {
  calls.upserts.push(params);
  return control.upsertResult;
}
`,
    );

    const sdkModule = await import(
      pathToFileURL(join(sdk, 'provider-auth.js')).href
    ) as { calls: StubCalls; control: { anthropicProblem?: string; upsertResult: unknown } };
    calls = sdkModule.calls;

    const entry = (await import(pathToFileURL(join(plugin, 'index.js')).href)) as {
      default: { id: string; register: (api: unknown) => void } };
    const routes: RecordedRoute[] = [];
    const registered: string[] = [];
    // A Proxy rather than a hand-written stub: any OTHER capability the plugin
    // reaches for is recorded instead of silently succeeding, so a future edit
    // that registers a tool, command, or second route is visible here.
    const api = new Proxy(
      { registerHttpRoute: (params: RecordedRoute) => void routes.push(params) },
      {
        get(target, property) {
          if (property in target) return Reflect.get(target, property);
          registered.push(String(property));
          return () => undefined;
        },
      },
    );
    entry.default.register(api);
    expect(registered, 'the bridge must use no plugin capability beyond one HTTP route').toEqual([]);
    expect(routes).toHaveLength(1);
    route = routes[0];

    // Route the per-test steering through the same module instance the plugin
    // imported, so the setters below really change what the handler observes.
    Object.defineProperty(globalThis, '__gbrainBridgeControl', { value: sdkModule.control });
  });

  function control() {
    return (globalThis as unknown as {
      __gbrainBridgeControl: { anthropicProblem?: string; upsertResult: unknown };
    }).__gbrainBridgeControl;
  }

  async function invoke(request: ReturnType<typeof fakeRequest>) {
    const res = fakeResponse();
    calls.upserts.length = 0;
    calls.validated.length = 0;
    control().anthropicProblem = anthropicProblem;
    control().upsertResult = upsertResult;
    const handled = await route.handler(request, res);
    return { res, handled };
  }

  beforeAll(() => {
    anthropicProblem = undefined;
    upsertResult = { profiles: {} };
  });

  afterAll(async () => {
    if (sandbox) await rm(sandbox, { recursive: true, force: true });
  });

  test('the manifest is exactly the pinned metadata', () => {
    // Structural: the WHOLE manifest, so an added field (a broader capability,
    // an ownership claim, a second contract) fails rather than passing unseen.
    //
    // `activation.onStartup: true` is load-bearing and is a deliberate
    // deviation from the plan's literal manifest: for openclaw@2026.7.1-2,
    // "Omitting `onStartup` no longer startup-loads the plugin implicitly"
    // (docs/plugins/manifest.md). Plugin HTTP routes register only during
    // plugin startup, so without this the route would never exist and every
    // GBrain call would 404 — the same class of failure as the disabled
    // `admin-http-rpc` plugin this task exists to fix.
    expect(manifest).toEqual({
      id: 'gbrain-agent-bridge',
      name: '2Brain Agent provider bridge',
      version: '1.0.0',
      description: 'Imports supported pilot provider credentials from GBrain loopback control.',
      activation: { onStartup: true },
      configSchema: {},
    });
  });

  test('the package declares one private ESM extension and no dependencies', () => {
    expect(packageManifest).toEqual({
      name: '@gbrain/openclaw-agent-bridge',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: 'index.js',
      openclaw: { extensions: ['./index.js'] },
    });
    // No `dependencies`/`devDependencies` keys at all: nothing is installed for
    // this directory on the image, so a declared dependency would be a runtime
    // module-not-found at gateway startup rather than a build failure.
    expect(Object.keys(packageManifest)).not.toContain('dependencies');
  });

  test('the registered route is exactly the contract Tasks 7 and 10 consume', () => {
    // Effective, not substring: this is the object the pinned plugin loader
    // would receive. `toEqual` on the non-handler fields means an added field
    // (`replaceExisting`, a `handleUpgrade` WebSocket surface, `match: prefix`)
    // fails here.
    const { handler, ...descriptor } = route;
    expect(typeof handler).toBe('function');
    expect(descriptor).toEqual({
      path: '/api/v1/gbrain/provider',
      auth: 'gateway',
      match: 'exact',
      gatewayRuntimeScopeSurface: 'trusted-operator',
    });
  });

  /**
   * Source-level assertions. Each is a genuine substring check and each is
   * listed here with why no structural form exists:
   *
   * - the four route literals: redundant with the structural descriptor test
   *   above, kept because the plan pins them and because they also fail when
   *   the value is computed rather than declared;
   * - the two SDK function names and the subpath specifier: a stub cannot
   *   prove which module the image will resolve, so the STATIC import text is
   *   the only thing this repository can assert. The live counterpart runs on
   *   the image in `gbrain-agent-finalize`;
   * - `child_process` and `console.log`: absence assertions have no structural
   *   form at all — an unexecuted branch is still a real capability.
   */
  test('the source pins the route, the SDK subpath, and the two forbidden capabilities', () => {
    expect(source).toContain("path: '/api/v1/gbrain/provider'");
    expect(source).toContain("auth: 'gateway'");
    expect(source).toContain("match: 'exact'");
    expect(source).toContain("gatewayRuntimeScopeSurface: 'trusted-operator'");
    expect(source).toContain('validateAnthropicSetupToken');
    expect(source).toContain('upsertAuthProfileWithLock');
    expect(source).toContain("from 'openclaw/plugin-sdk/provider-auth'");
    // Never reach into build internals: `dist/` paths are not a public contract
    // and would break on any OpenClaw bump.
    expect(source).not.toContain('dist/');
    expect(source).not.toContain('child_process');
    expect(source).not.toContain('console.log');
  });

  test('the source exposes no read, list, delete, shell, or file operation', () => {
    for (const forbidden of [
      'registerTool',
      'registerCommand',
      'listProfilesForProvider',
      'removeProviderAuthProfilesWithLock',
      'node:fs',
      'node:child_process',
      'spawn',
      'exec(',
    ]) {
      expect(source, `the bridge must not use ${forbidden}`).not.toContain(forbidden);
    }
  });

  test('only POST is accepted', async () => {
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD']) {
      const { res } = await invoke(
        fakeRequest({ method, body: '{"provider":"openrouter","credential":"k"}' }),
      );
      expect(res.statusCode).toBe(405);
      expect(res.payload).toEqual({ ok: false, code: 'method_not_allowed' });
      expect(calls.upserts).toHaveLength(0);
    }
  });

  test('only a JSON content type is accepted', async () => {
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', '']) {
      const { res } = await invoke(
        fakeRequest({
          headers: { 'content-type': contentType },
          body: '{"provider":"openrouter","credential":"k"}',
        }),
      );
      expect(res.statusCode).toBe(415);
      expect(calls.upserts).toHaveLength(0);
    }
    // A charset parameter is still JSON.
    const { res } = await invoke(
      fakeRequest({
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: '{"provider":"openrouter","credential":"k"}',
      }),
    );
    expect(res.statusCode).toBe(200);
  });

  test('an oversized body is refused before it is parsed — declared length or not', async () => {
    const huge = `{"provider":"openrouter","credential":"${'x'.repeat(40 * 1024)}"}`;
    for (const chunked of [false, true]) {
      const { res } = await invoke(fakeRequest({ body: huge, chunked }));
      expect(res.statusCode, `chunked=${chunked}`).toBe(413);
      expect(res.payload).toEqual({ ok: false, code: 'payload_too_large' });
      expect(calls.upserts).toHaveLength(0);
      expect(calls.validated).toHaveLength(0);
    }
  });

  test('only the two pilot providers are accepted', async () => {
    for (const provider of ['openai', 'google', 'anthropic-beta', '', 'ANTHROPIC', 42, null]) {
      const { res } = await invoke(
        fakeRequest({ body: JSON.stringify({ provider, credential: 'k' }) }),
      );
      expect(res.statusCode, `provider=${String(provider)}`).toBe(400);
      expect(res.payload).toEqual({ ok: false, code: 'unsupported_provider' });
      expect(calls.upserts).toHaveLength(0);
    }
  });

  test('the credential must be one non-empty string', async () => {
    for (const credential of ['', '   ', 42, null, ['k'], { k: 1 }, undefined]) {
      const { res } = await invoke(
        fakeRequest({ body: JSON.stringify({ provider: 'openrouter', credential }) }),
      );
      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ ok: false, code: 'invalid_credential' });
      expect(calls.upserts).toHaveLength(0);
    }
  });

  test('a malformed or non-object body is refused', async () => {
    for (const body of ['not json', '[]', '"string"', '3', 'null']) {
      const { res } = await invoke(fakeRequest({ body }));
      expect(res.statusCode).toBe(400);
      expect(calls.upserts).toHaveLength(0);
    }
  });

  test('Anthropic is validated first and stored as a token profile', async () => {
    const { res } = await invoke(
      fakeRequest({ body: JSON.stringify({ provider: 'anthropic', credential: 'sk-ant-real' }) }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true, provider: 'anthropic' });
    expect(calls.validated).toEqual(['sk-ant-real']);
    expect(calls.upserts).toEqual([
      {
        profileId: 'anthropic:gbrain',
        credential: { type: 'token', provider: 'anthropic', token: 'sk-ant-real' },
        agentDir: expect.any(String),
      },
    ]);
  });

  test('a rejected Anthropic token is never stored', async () => {
    anthropicProblem = 'that is not a setup token';
    try {
      const { res } = await invoke(
        fakeRequest({ body: JSON.stringify({ provider: 'anthropic', credential: 'nope' }) }),
      );
      expect(res.statusCode).toBe(400);
      expect(res.payload).toEqual({ ok: false, code: 'invalid_credential' });
      expect(calls.upserts).toHaveLength(0);
    } finally {
      anthropicProblem = undefined;
    }
  });

  test('OpenRouter is stored as an api_key profile and is not Anthropic-validated', async () => {
    const { res } = await invoke(
      fakeRequest({ body: JSON.stringify({ provider: 'openrouter', credential: 'sk-or-real' }) }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ ok: true, provider: 'openrouter' });
    expect(calls.validated).toEqual([]);
    expect(calls.upserts).toEqual([
      {
        profileId: 'openrouter:gbrain',
        credential: { type: 'api_key', provider: 'openrouter', key: 'sk-or-real' },
        agentDir: expect.any(String),
      },
    ]);
  });

  test('a null store return is a FAILED import, not a silent success', async () => {
    // `upsertAuthProfileWithLock` resolves `null` when it did not write. This is
    // the fail-open shape this repository keeps rediscovering: the call
    // "succeeded" (no throw) while nothing was persisted.
    upsertResult = null;
    try {
      const { res } = await invoke(
        fakeRequest({ body: JSON.stringify({ provider: 'openrouter', credential: 'k' }) }),
      );
      expect(res.statusCode).toBe(500);
      expect(res.payload).toEqual({ ok: false, code: 'import_failed' });
    } finally {
      upsertResult = { profiles: {} };
    }
  });

  test('no response body ever echoes the credential', async () => {
    const secret = 'sk-or-supersecret-value';
    for (const provider of ['openrouter', 'anthropic', 'openai']) {
      const { res } = await invoke(
        fakeRequest({ body: JSON.stringify({ provider, credential: secret }) }),
      );
      expect(JSON.stringify(res.payload)).not.toContain(secret);
      // And the whole response is one of the two declared shapes.
      const payload = res.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(payload.ok ? ['ok', 'provider'] : ['code', 'ok']);
    }
  });

  test('the handler always reports that it handled the request', async () => {
    const { handled } = await invoke(
      fakeRequest({ body: JSON.stringify({ provider: 'openrouter', credential: 'k' }) }),
    );
    // Returning falsy would let the Gateway fall through to another route.
    expect(handled).toBe(true);
  });
});
