/**
 * Issue #33 deployment-boundary regression. Spawn `gbrain serve --http`
 * from a fresh directory with no repository-relative frontend assets and
 * prove the server-rendered Workspace/login surfaces still work while the
 * removed administration SPA, assets, cookie, and APIs stay unreachable.
 *
 * No DATABASE_URL needed; PGLite is the engine. Serial because it binds a
 * TCP port and reads/writes a temporary deployment directory.
 */
import { afterAll, beforeAll, describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'node:url';
import type { Subprocess } from 'bun';

const REPO = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\\/]$/, '');
let artifactDir = '';
let executable = '';

beforeAll(() => {
  artifactDir = mkdtempSync(join(tmpdir(), 'gbrain-package-'));
  executable = join(artifactDir, process.platform === 'win32' ? 'gbrain.exe' : 'gbrain');
  const build = Bun.spawnSync([
    'bun',
    'build',
    '--compile',
    '--outfile',
    executable,
    join(REPO, 'src', 'cli.ts'),
  ], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' });
  if (build.exitCode !== 0) {
    throw new Error(`Package compilation failed: ${build.stderr.toString().slice(0, 4000)}`);
  }
}, 90_000);

afterAll(() => {
  if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
});

interface ServeProc {
  proc: Subprocess;
  port: number;
  home: string;
  bootstrapToken: string;
  stop: () => Promise<void>;
  cleanup: () => Promise<void>;
}

function pickPort(): number {
  // High-random port. Collision is unlikely; test reruns get fresh ports.
  return 31000 + Math.floor(Math.random() * 4000);
}

async function spawnServer(existingHome?: string): Promise<ServeProc> {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), 'gbrain-package-deployment-'));
  const configPath = join(home, '.gbrain', 'config.json');
  if (!existsSync(configPath)) {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        engine: 'pglite',
        database_path: join(home, '.gbrain', 'brain.pglite'),
        embedding_dimensions: 1536,
      }) + '\n',
    );
  }

  // Pin the bootstrap token via env so the test doesn't have to scrape it
  // out of the startup banner (and the banner stays predictable across
  // future formatting tweaks).
  const bootstrapToken = 'test-bootstrap-token-aaaaaaaaaaaaaaaaaa'; // 41 chars
  const port = pickPort();
  const serverArgs = [
    'serve',
    '--http',
    '--port',
    String(port),
    '--bind',
    '127.0.0.1',
  ];
  // Bun's Windows uv_spawn path intermittently fails to map the large compiled
  // image from inside a Bun test process. A tiny cmd.exe parent launches the
  // same executable reliably; a batch file avoids cmd.exe's nested-quote rules,
  // and taskkill /T below ensures its child is cleaned up.
  let command = [executable, ...serverArgs];
  if (process.platform === 'win32') {
    const launcher = join(home, 'launch-gbrain-package-test.cmd');
    writeFileSync(
      launcher,
      `@echo off\r\n"${executable.replace(/"/g, '""')}" ${serverArgs.join(' ')}\r\n`,
    );
    command = ['cmd.exe', '/d', '/s', '/c', launcher];
  }

  // CRITICAL: execute the compiled package from the deployment directory,
  // not Bun source from the repository. This catches missing embedded runtime
  // dependencies and accidental cwd-relative frontend fallbacks.
  const proc = Bun.spawn(
    command,
    {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        GBRAIN_HOME: home,
        GBRAIN_BOOTSTRAP_CREDENTIAL: bootstrapToken,
        // Don't let test-process inherit any auth keys it doesn't need.
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );

  // Wait for readiness by polling /health. Bun's readable streams don't
  // give us a synchronous "stderr line" API and the startup banner format
  // is allowed to drift; a /health probe is the contract that matters.
  const deadline = Date.now() + 30_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        ready = true;
        break;
      }
    } catch { /* not ready yet */ }
    await new Promise(r => setTimeout(r, 250));
  }

  const stop = async () => {
    if (process.platform === 'win32') {
      Bun.spawnSync(['taskkill.exe', '/pid', String(proc.pid), '/t', '/f'], {
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await proc.exited;
      return;
    }
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
    // Give it 2s to exit cleanly, then SIGKILL.
    await Promise.race([
      proc.exited,
      new Promise(r => setTimeout(r, 2000)),
    ]);
    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
  };
  const cleanup = async () => {
    await stop();
    try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
  };

  if (!ready) {
    // Capture some diagnostics for the failure message before tearing down.
    const stderrText = await new Response(proc.stderr).text().catch(() => '');
    await cleanup();
    throw new Error(
      `serve --http never became ready on port ${port} after 30s. stderr: ${stderrText.slice(0, 2000)}`,
    );
  }

  return { proc, port, home, bootstrapToken, stop, cleanup };
}

describe('Workspace package E2E — legacy administration surface is contracted', () => {
  test('fresh deployment serves login and sends unauthenticated Workspace visits there', async () => {
    const s = await spawnServer();
    try {
      const login = await fetch(`http://127.0.0.1:${s.port}/login`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(login.status).toBe(200);
      const html = await login.text();
      expect(html).toContain('2Brain');
      expect(html).not.toContain('GBrain Admin');
      expect(html).not.toContain('<div id="root">');

      const app = await fetch(`http://127.0.0.1:${s.port}/app`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      expect(app.status).toBe(303);
      expect(app.headers.get('location')).toBe('/login');

    } finally {
      await s.cleanup();
    }
  }, 90_000);

  test('upgraded deployment ignores but does not delete leftover legacy assets', async () => {
    const initial = await spawnServer();
    const legacyIndex = join(initial.home, 'admin', 'dist', 'index.html');
    const legacyAsset = join(initial.home, 'admin', 'dist', 'assets', 'legacy.js');
    await initial.stop();
    mkdirSync(join(initial.home, 'admin', 'dist', 'assets'), { recursive: true });
    writeFileSync(legacyIndex, '<title>GBrain Admin legacy upgrade sentinel</title>');
    writeFileSync(legacyAsset, 'globalThis.LEGACY_ADMIN_SENTINEL = true;');

    const s = await spawnServer(initial.home);
    try {
      const login = await fetch(`http://127.0.0.1:${s.port}/login`);
      expect(login.status).toBe(200);
      expect(await login.text()).toContain('2Brain');

      for (const path of ['/admin/', '/admin/index.html', '/admin/agents', '/admin/assets/legacy.js']) {
        const response = await fetch(`http://127.0.0.1:${s.port}${path}`, {
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status, path).toBe(303);
        expect(response.headers.get('location'), path).toBe('/login');
        const body = await response.text();
        expect(body, path).not.toContain('GBrain Admin');
        expect(body, path).not.toContain('<div id="root">');
      }
      expect(readFileSync(legacyIndex, 'utf8')).toContain('legacy upgrade sentinel');
      expect(readFileSync(legacyAsset, 'utf8')).toContain('LEGACY_ADMIN_SENTINEL');
    } finally {
      await s.cleanup();
    }
  }, 90_000);

  test('old authentication and API mutations cannot mint a cookie or invoke capability', async () => {
    const s = await spawnServer();
    try {
      for (const path of ['/admin/login', '/admin/api/register-client', '/admin/api/sign-out-everywhere']) {
        const response = await fetch(`http://127.0.0.1:${s.port}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: s.bootstrapToken, name: 'must-not-run' }),
          redirect: 'manual',
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status, path).toBe(404);
        expect(response.headers.get('set-cookie'), path).toBeNull();
        expect(await response.text(), path).not.toContain('gbrain_admin');
      }
    } finally {
      await s.cleanup();
    }
  }, 90_000);
});
