#!/usr/bin/env bun

import express from 'express';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { createOauthConsentRouter } from '../src/web/oauth-consent.ts';
import { createWorkspaceRouter } from '../src/web/workspace-router.ts';
import { issueWorkspaceSetupToken } from '../src/workspace/auth.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { runWorkspaceAttentionDetectors } from '../src/workspace/attention.ts';
import { runWorkspaceRuntime } from '../src/workspace/runtime.ts';
import { deriveAgentNativePassword } from '../src/workspace/agent-access.ts';
import { loadBinding, readinessFromBinding } from '../src/workspace/agent-binding.ts';
import { CLAUDE_FALLBACK_MODEL, CODEX_DEFAULT_MODEL } from '../src/workspace/agent-readiness.ts';
import type {
  OpenClawControl,
  OpenClawGBrainIdentity,
  OpenClawImportableProvider,
  OpenClawProviderId,
  OpenClawProviderStatus,
} from '../src/workspace/openclaw-control.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the Workspace browser release journey.');

const evidenceDir = process.env.WORKSPACE_RELEASE_EVIDENCE_DIR
  ?? join(tmpdir(), `gbrain-issue34-browser-${Date.now()}`);
mkdirSync(evidenceDir, { recursive: true });

async function closeServer(server: Server | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1 });

/**
 * One throwaway Workspace database per journey.
 *
 * The two journeys deliberately do NOT share one: `workspace_workspaces` is a
 * singleton per deployment, and the Agent-tier journey needs an invitation
 * redeemed with the shared-state acknowledgment that Brain tier never sends.
 * Sharing a database would make the second journey inherit the first one's
 * already-consumed setup and already-acknowledged memberships.
 */
async function withWorkspaceDatabase(
  label: string,
  run: (engine: PostgresEngine) => Promise<void>,
): Promise<void> {
  const databaseName = `workspace_release_${label}_${process.pid}_${randomBytes(4).toString('hex')}`;
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  const workspaceUrl = new URL(databaseUrl!);
  workspaceUrl.pathname = `/${databaseName}`;
  const engine = new PostgresEngine();
  try {
    await engine.connect({ engine: 'postgres', database_url: workspaceUrl.toString(), poolSize: 4 });
    await initializeWorkspaceFoundation(engine);
    await engine.initSchema();
    await run(engine);
  } finally {
    await engine.disconnect().catch(() => undefined);
    await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${databaseName}`.catch(() => []);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
  }
}

function spawnClient(env: Record<string, string>): Promise<number> {
  const client = Bun.spawn([
    'node',
    join(import.meta.dir, 'verify-workspace-browser-client.mjs'),
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return client.exited;
}

// ---------------------------------------------------------------------------
// Journey 1 — the Brain-tier release journey. Unchanged behaviour: the Agent
// tier flag is deleted rather than merely unset by omission, so this journey
// proves Brain-tier output even when the environment already carried the flag.
// ---------------------------------------------------------------------------

async function runBrainJourney(): Promise<void> {
  delete process.env.GBRAIN_AGENT_TIER;
  await withWorkspaceDatabase('brain', async engine => {
    let server: Server | null = null;
    let workerAbort: AbortController | null = null;
    let workerRun: Promise<void> | null = null;
    try {
      const oauthProvider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });

      const delivered = new Map<string, string>();
      const app = express();
      app.use(express.json({ limit: '16kb' }));
      app.get('/favicon.ico', (_req, res) => res.status(204).end());
      app.get('/__release/token', (req, res) => {
        const key = `${String(req.query.purpose ?? '')}:${String(req.query.email ?? '')}`;
        const token = delivered.get(key);
        if (!token) return res.status(404).json({ error: 'token_not_delivered' });
        res.json({ token });
      });
      app.get('/__release/oauth-callback', (_req, res) => {
        res.type('html').send('<!doctype html><link rel="icon" href="data:"><title>Connected</title><h1>Connected</h1>');
      });
      app.post('/__release/seed', async (_req, res, next) => {
        try {
          const membership = await engine.executeRaw<{ workspace_id: string; membership_id: string }>(
            `SELECT m.workspace_id,m.membership_id
               FROM workspace_memberships m
               JOIN workspace_identities i ON i.identity_id=m.identity_id
              WHERE i.normalized_email='member@example.test'`,
          );
          if (!membership[0]) return res.status(409).json({ error: 'member_not_ready' });
          await engine.executeRaw(`INSERT INTO sources (id,name,config)
            VALUES ('release-source','Release handbook','{}'::jsonb)
            ON CONFLICT (id) DO NOTHING`);
          await engine.executeRaw(`INSERT INTO pages
            (source_id,slug,type,page_kind,title,compiled_truth,frontmatter,import_filename)
            VALUES
              ('release-source','release-handbook','document','markdown','Release handbook',
               'Evidence-backed verification is required for release.','{}'::jsonb,'release-handbook.md'),
              ('release-source','evidence-gap','document','markdown','Unverified draft',
               'This draft needs supporting evidence.','{}'::jsonb,NULL)
            ON CONFLICT (source_id,slug) DO NOTHING`);
          await engine.executeRaw(`UPDATE workspace_sources
            SET last_verified_at=now(),last_verified_revision='release-revision',last_sync_at=now(),
                last_synced_revision='release-revision'
            WHERE source_id='release-source'`);
          res.json(membership[0]);
        } catch (error) { next(error); }
      });
      app.post('/__release/detect', async (_req, res, next) => {
        try {
          const workspace = await engine.executeRaw<{ workspace_id: string }>(
            'SELECT workspace_id FROM workspace_workspaces WHERE singleton=TRUE',
          );
          if (!workspace[0]) return res.status(409).json({ error: 'workspace_not_ready' });
          await runWorkspaceAttentionDetectors(engine, {
            workspaceId: workspace[0].workspace_id,
            requestId: 'release-browser-detector',
          });
          res.status(204).end();
        } catch (error) { next(error); }
      });
      app.get('/__release/status/:kind', async (req, res, next) => {
        try {
          if (req.params.kind === 'source') {
            const rows = await engine.executeRaw<{ provisioning_state: string }>(
              'SELECT provisioning_state FROM workspace_sources WHERE source_id=$1', ['release-source'],
            );
            return res.json({ value: rows[0]?.provisioning_state ?? null });
          }
          if (req.params.kind === 'access') {
            const rows = await engine.executeRaw<{ access_mode: string }>(`SELECT p.access_mode
              FROM workspace_principal_source_policies p
              JOIN workspace_memberships m ON m.membership_id=p.principal_id
              JOIN workspace_identities i ON i.identity_id=m.identity_id
              WHERE p.principal_kind='member' AND i.normalized_email='member@example.test'`);
            return res.json({ value: rows[0]?.access_mode ?? null });
          }
          if (req.params.kind === 'export') {
            const rows = await engine.executeRaw<{ state: string }>(
              'SELECT state FROM workspace_exports ORDER BY created_at DESC LIMIT 1',
            );
            return res.json({ value: rows[0]?.state ?? null });
          }
          if (req.params.kind === 'deletion') {
            const rows = await engine.executeRaw<{ deleted: boolean; archived: boolean }>(
              'SELECT deleted,archived FROM workspace_sources WHERE source_id=$1', ['release-source'],
            );
            return res.json({ value: rows[0]?.deleted ? 'deleted' : rows[0]?.archived ? 'archived' : 'active' });
          }
          res.status(404).json({ error: 'unknown_status' });
        } catch (error) { next(error); }
      });
      app.use(createWorkspaceRouter(engine, {
        bootstrapCredential: 'release-bootstrap',
        tokenSecret: 'release-token-secret-with-at-least-thirty-two-bytes',
        // The production session-cookie configuration (httpOnly, sameSite=lax,
        // secure). A browser treats 127.0.0.1 as a trustworthy origin, so the
        // journey authenticates against the same cookie flags production serves.
        production: true,
        requestId: () => `release-${randomBytes(6).toString('hex')}`,
        deliverConfirmation: async message => { delivered.set(`${message.purpose}:${message.email}`, message.token); },
        // A supported answer for the real question, and a fabricated claim for the
        // refusal probe, so the journey drives Ask's trust boundary in both
        // directions rather than only its happy path.
        askSynthesizer: async input => (input.question.includes('uptime')
          ? {
            kind: 'answer',
            answer: 'The Workspace guarantees 99.99% uptime for every Member.',
            citations: [{ sourceId: 'release-source', slug: 'release-handbook' }],
          }
          : {
            kind: 'answer',
            answer: 'Evidence-backed verification is required for release.',
            citations: [{ sourceId: 'release-source', slug: 'release-handbook' }],
          }),
      }));
      app.use(createOauthConsentRouter(engine, oauthProvider));
      server = await new Promise<Server>(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Workspace browser server did not expose a TCP address.');
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const oauthRedirectUri = `${baseUrl}/__release/oauth-callback`;
      const omittedScopeClient = await oauthProvider.clientsStore.registerClient!({
        client_name: 'Release Admin-capable Connector',
        redirect_uris: [oauthRedirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      } as Parameters<NonNullable<typeof oauthProvider.clientsStore.registerClient>>[0]);
      const readClient = await oauthProvider.clientsStore.registerClient!({
        client_name: 'Release Read-only Connector',
        redirect_uris: [oauthRedirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        scope: 'read',
        token_endpoint_auth_method: 'none',
      } as Parameters<NonNullable<typeof oauthProvider.clientsStore.registerClient>>[0]);

      workerAbort = new AbortController();
      workerRun = runWorkspaceRuntime(engine, 'worker', {
        signal: workerAbort.signal,
        workerId: 'release-browser-worker',
        executeSourceProvisioning: async () => undefined,
        executeSourceMaintenance: async job => ({
          observedRevision: `release-${job.sourceId}`,
          changed: false,
          applied: job.type === 'source.sync',
        }),
      });

      const setupToken = await issueWorkspaceSetupToken(engine, 'setup');
      const exitCode = await spawnClient({
        WORKSPACE_RELEASE_JOURNEY: 'brain',
        WORKSPACE_RELEASE_BASE_URL: baseUrl,
        WORKSPACE_RELEASE_SETUP_TOKEN: setupToken,
        WORKSPACE_RELEASE_EVIDENCE_DIR: evidenceDir,
        WORKSPACE_RELEASE_OMITTED_SCOPE_CLIENT_ID: omittedScopeClient.client_id,
        WORKSPACE_RELEASE_READ_CLIENT_ID: readClient.client_id,
        WORKSPACE_RELEASE_OAUTH_REDIRECT_URI: oauthRedirectUri,
      });
      if (exitCode !== 0) throw new Error(`Workspace browser client failed with exit ${exitCode}.`);
    } finally {
      workerAbort?.abort();
      await workerRun?.catch(() => undefined);
      await closeServer(server);
    }
  });
}

// ---------------------------------------------------------------------------
// Journey 2 — the Agent-tier customer access journey (#68 Task 14 Step 1).
//
// The colocated OpenClaw runtime is the ONE thing a local release journey
// cannot host, so it is the one thing faked. Everything else — the tier switch,
// the router, the always-on worker, the runtime reconciler, the readiness
// conjunction, the password derivation, and every page — is the shipping code.
// ---------------------------------------------------------------------------

const AGENT_TOKEN_SECRET = 'release-agent-token-secret-with-at-least-thirty-two-bytes';
/** HTTPS and path-free, because `nativeClientUrl()` refuses anything else. */
const AGENT_WORKSPACE_ORIGIN = 'https://agent-workspace.example.test';

/**
 * A fake that behaves like ONE gateway holding ONE password, not like a stub
 * that answers yes.
 *
 * Two properties are load-bearing and neither is cosmetic:
 *
 *  - `listModels()` contains a provider's model only while that provider is
 *    connected, so `Check Codex` genuinely fails before the Codex device flow
 *    and genuinely passes after it. A catalog that always contained both pinned
 *    IDs would make the exact-model readiness proof unfalsifiable.
 *  - `probeGBrainWhoAmI()` resolves the credential the reconciler actually
 *    issued, through GBrain's own credential verification, and reads the bound
 *    Agent's real Source Access policy. It does not echo the binding back, so a
 *    revoked, stale, or wrongly scoped credential answers with a mismatched
 *    identity exactly as a real runtime would.
 */
class ReleaseOpenClawRuntime implements OpenClawControl {
  private applied: string | null = null;
  private mcpToken: string | null = null;
  private codexConnected = false;
  private claudeConnected = false;
  private openRouterConnected = false;
  private hold: { promise: Promise<void>; release: () => void } | null = null;
  private holding = false;

  readonly probedModels: string[] = [];
  readonly importedProviders: string[] = [];
  defaultAnswerProbes = 0;
  mcpConfigureCalls = 0;
  appliedPasswordCount = 0;

  constructor(private readonly resolveIdentity: (token: string) => Promise<OpenClawGBrainIdentity>) {}

  /** Park the NEXT `applyNativePassword` until the client releases it. */
  armApplyHold(): void {
    let release = (): void => {};
    const promise = new Promise<void>(resolve => { release = () => resolve(); });
    this.hold = { promise, release };
  }

  releaseApplyHold(): void {
    this.hold?.release();
  }

  holdState(): { armed: boolean; active: boolean } {
    return { armed: this.hold !== null, active: this.holding };
  }

  connectCodex(): void { this.codexConnected = true; }

  observations(): Record<string, unknown> {
    return {
      mcp_configure_calls: this.mcpConfigureCalls,
      applied_password_count: this.appliedPasswordCount,
      probed_models: [...this.probedModels],
      imported_providers: [...this.importedProviders],
      default_answer_probes: this.defaultAnswerProbes,
    };
  }

  async runtimeHealth(): Promise<boolean> { return true; }

  async applyNativePassword(password: string): Promise<void> {
    const hold = this.hold;
    if (hold) {
      this.holding = true;
      try { await hold.promise; } finally { this.holding = false; this.hold = null; }
    }
    this.applied = password;
    this.appliedPasswordCount += 1;
  }

  async verifyNativePassword(password: string): Promise<boolean> {
    return this.applied !== null && password === this.applied;
  }

  async verifyNativePasswordRejected(password: string): Promise<boolean> {
    return this.applied !== null && password !== this.applied;
  }

  async configureGBrainMcp(input: { token: string }): Promise<void> {
    if (!input.token) throw new Error('openclaw_config_failed');
    this.mcpToken = input.token;
    this.mcpConfigureCalls += 1;
  }

  async probeGBrainWhoAmI(): Promise<OpenClawGBrainIdentity> {
    if (!this.mcpToken) throw new Error('openclaw_mcp_probe_failed');
    return this.resolveIdentity(this.mcpToken);
  }

  async importProviderCredential(
    input: { provider: OpenClawImportableProvider; credential: string },
  ): Promise<void> {
    if (typeof input.credential !== 'string' || input.credential.trim().length === 0) {
      throw new Error('openclaw_provider_import_failed');
    }
    if (input.provider === 'anthropic') this.claudeConnected = true;
    else this.openRouterConnected = true;
    this.importedProviders.push(input.provider);
  }

  async getProviderStatus(provider: OpenClawProviderId): Promise<OpenClawProviderStatus> {
    const connected = provider === 'openai'
      ? this.codexConnected
      : provider === 'anthropic' ? this.claudeConnected : this.openRouterConnected;
    return {
      authenticated: connected,
      authStatus: connected ? 'ok' : 'missing',
      quota: connected
        ? { state: 'known', remainingPercent: 92, resetsAt: null }
        : { state: 'unknown', remainingPercent: null, resetsAt: null },
    };
  }

  async listModels(): Promise<string[]> {
    const models: string[] = [];
    if (this.codexConnected) models.push(CODEX_DEFAULT_MODEL);
    if (this.claudeConnected) models.push(CLAUDE_FALLBACK_MODEL);
    if (this.openRouterConnected) models.push('openrouter/auto');
    return models;
  }

  async probeModel(model: string, prompt: string): Promise<{ text: string }> {
    if (typeof prompt !== 'string' || prompt.length === 0) throw new Error('openclaw_model_probe_failed');
    if (!(await this.listModels()).includes(model)) throw new Error('openclaw_required_model_missing');
    this.probedModels.push(model);
    return { text: '2BRAIN_AGENT_READY' };
  }

  async probeDefaultAnswer(prompt: string): Promise<{ text: string }> {
    if (typeof prompt !== 'string' || prompt.length === 0) throw new Error('openclaw_model_probe_failed');
    // No configured default can answer before a subscription exists.
    if (!this.codexConnected && !this.claudeConnected) throw new Error('openclaw_model_probe_failed');
    this.defaultAnswerProbes += 1;
    return { text: '2BRAIN_AGENT_READY' };
  }
}

async function runAgentJourney(): Promise<void> {
  process.env.GBRAIN_AGENT_TIER = 'true';
  process.env.GBRAIN_WORKSPACE_BASE_URL = AGENT_WORKSPACE_ORIGIN;
  try {
    await withWorkspaceDatabase('agent', async engine => {
      let server: Server | null = null;
      let workerAbort: AbortController | null = null;
      let workerRun: Promise<void> | null = null;
      // Declared out here so the finally can always unpark a worker that the
      // client left waiting inside the fake's rotation hold.
      let runtime: ReleaseOpenClawRuntime | null = null;
      try {
        const oauthProvider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });

        const resolveAgentIdentity = async (token: string): Promise<OpenClawGBrainIdentity> => {
          const auth = await oauthProvider.verifyAccessToken(token) as unknown as {
            scopes: string[]; agentId?: string; workspaceId?: string;
          };
          if (!auth.agentId || !auth.workspaceId || !Array.isArray(auth.scopes)) {
            throw new Error('openclaw_mcp_probe_failed');
          }
          const policies = await engine.executeRaw<{ access_mode: string }>(
            `SELECT access_mode FROM workspace_principal_source_policies
              WHERE principal_kind='agent' AND principal_id=$1`,
            [auth.agentId],
          );
          const mode = policies[0]?.access_mode;
          if (mode !== 'none' && mode !== 'specific' && mode !== 'all') {
            throw new Error('openclaw_mcp_probe_failed');
          }
          return {
            workspaceId: auth.workspaceId,
            agentId: auth.agentId,
            scopes: auth.scopes,
            sourceAccessMode: mode,
          };
        };

        runtime = new ReleaseOpenClawRuntime(resolveAgentIdentity);
        const control = runtime;
        const delivered = new Map<string, string>();
        const app = express();
        // Deliberately NO application-level body parser. `createWorkspaceRouter`
        // mounts its own 16 KiB parser, and an outer parser with a larger limit
        // would run first and quietly raise the ceiling on every Workspace API
        // route. Only the secret scanner below needs a large body, and it gets
        // its own parser on its own path.
        app.get('/favicon.ico', (_req, res) => res.status(204).end());
        app.get('/__release/token', (req, res) => {
          const key = `${String(req.query.purpose ?? '')}:${String(req.query.email ?? '')}`;
          const token = delivered.get(key);
          if (!token) return res.status(404).json({ error: 'token_not_delivered' });
          res.json({ token });
        });

        const boundWorkspaceId = async (): Promise<string | null> => {
          const rows = await engine.executeRaw<{ workspace_id: string }>(
            'SELECT workspace_id FROM workspace_workspaces WHERE singleton=TRUE',
          );
          return rows[0]?.workspace_id ?? null;
        };

        /**
         * Everything the browser cannot observe about the runtime binding.
         * Deliberately no password, no credential, no secret fingerprint — the
         * generation COUNTERS are inputs to a password, not the password.
         */
        app.get('/__release/agent/binding', async (_req, res, next) => {
          try {
            const workspaceId = await boundWorkspaceId();
            if (!workspaceId) return res.json({ value: null });
            const binding = await loadBinding(engine, workspaceId);
            if (!binding) return res.json({ value: null });
            const readiness = readinessFromBinding(binding);
            res.json({
              value: {
                ready: readiness.ready,
                blockers: readiness.blockers,
                mcp_generation: Number(binding.mcp_generation),
                mcp_verified_generation: Number(binding.mcp_verified_generation),
                native_password_generation: Number(binding.native_password_generation),
                native_password_applied_generation: Number(binding.native_password_applied_generation),
              },
            });
          } catch (error) { next(error); }
        });

        /**
         * The Codex device-code flow happens inside OpenClaw, in the customer's
         * own browser, against OpenAI. A local journey cannot drive it, so this
         * is the one fixture that stands in for a step the product never owns.
         */
        app.post('/__release/agent/codex-login', (_req, res) => {
          control.connectCodex();
          res.status(204).end();
        });

        app.post('/__release/agent/hold-apply', (_req, res) => {
          control.armApplyHold();
          res.status(204).end();
        });
        app.get('/__release/agent/hold-apply', (_req, res) => res.json({ value: control.holdState() }));
        app.post('/__release/agent/release-apply', (_req, res) => {
          control.releaseApplyHold();
          res.status(204).end();
        });

        app.get('/__release/agent/runtime-observations', (_req, res) => {
          res.json({ value: control.observations() });
        });

        /**
         * Secret scanning without ever handing the client a secret.
         *
         * The client posts candidate text — serialized DOM, storage dumps, the
         * evidence report — and learns only WHICH sample matched and at which
         * generation. The derived password never leaves this process through
         * this endpoint, so a leak in the journey's own evidence is impossible
         * by construction rather than by discipline.
         */
        // Whole serialized documents, including the injected accessibility
        // engine, arrive here — hence the deliberately generous body limit on
        // this one test-only path.
        app.post('/__release/agent/secret-scan', express.json({ limit: '32mb' }), async (req, res, next) => {
          try {
            const workspaceId = await boundWorkspaceId();
            if (!workspaceId) return res.status(409).json({ error: 'workspace_not_ready' });
            const binding = await loadBinding(engine, workspaceId);
            if (!binding) return res.status(409).json({ error: 'binding_not_ready' });
            const highest = Math.max(1, Number(binding.native_password_generation));
            const passwords: { generation: number; value: string }[] = [];
            for (let generation = 1; generation <= highest + 1; generation += 1) {
              passwords.push({
                generation,
                value: deriveAgentNativePassword(AGENT_TOKEN_SECRET, workspaceId, generation),
              });
            }
            const samples = Array.isArray(req.body?.samples) ? req.body.samples : [];
            const hits: { name: string; generation: number }[] = [];
            for (const sample of samples) {
              const name = String(sample?.name ?? 'unnamed');
              const text = typeof sample?.text === 'string' ? sample.text : JSON.stringify(sample?.text ?? '');
              for (const password of passwords) {
                if (text.includes(password.value)) hits.push({ name, generation: password.generation });
              }
            }
            res.json({ hits, generations: passwords.length });
          } catch (error) { next(error); }
        });

        app.use(createWorkspaceRouter(engine, {
          bootstrapCredential: 'release-agent-bootstrap',
          // The SAME secret the worker receives as `agentPasswordSecret`.
          // Disclosure derives from it and the reconciler applies from it; two
          // different values would make every reveal silently wrong.
          tokenSecret: AGENT_TOKEN_SECRET,
          production: true,
          requestId: () => `release-agent-${randomBytes(6).toString('hex')}`,
          deliverConfirmation: async message => { delivered.set(`${message.purpose}:${message.email}`, message.token); },
          openClawControl: control,
        }));
        server = await new Promise<Server>(resolve => {
          const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
        });
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Agent-tier browser server did not expose a TCP address.');
        }
        const baseUrl = `http://127.0.0.1:${address.port}`;

        workerAbort = new AbortController();
        workerRun = runWorkspaceRuntime(engine, 'worker', {
          signal: workerAbort.signal,
          workerId: 'release-agent-worker',
          executeSourceProvisioning: async () => undefined,
          executeSourceMaintenance: async job => ({
            observedRevision: `release-${job.sourceId}`,
            changed: false,
            applied: job.type === 'source.sync',
          }),
          // Both are required together; either one missing leaves the Agent
          // runtime reconciler out of the loop and rotation stuck at pending.
          openClawControl: control,
          agentPasswordSecret: AGENT_TOKEN_SECRET,
        });

        const setupToken = await issueWorkspaceSetupToken(engine, 'setup');
        const exitCode = await spawnClient({
          WORKSPACE_RELEASE_JOURNEY: 'agent',
          WORKSPACE_RELEASE_BASE_URL: baseUrl,
          WORKSPACE_RELEASE_SETUP_TOKEN: setupToken,
          WORKSPACE_RELEASE_EVIDENCE_DIR: evidenceDir,
          // The pinned model identifiers and the agent-client URL are NOT sent:
          // the client asserts them from its own literals so a change to either
          // product constant fails the journey instead of travelling with it.
        });
        if (exitCode !== 0) throw new Error(`Agent-tier browser client failed with exit ${exitCode}.`);
      } finally {
        // Never leave the worker parked inside the fake if the client died
        // while the rotation hold was armed: `abort()` cannot interrupt an
        // awaited promise, so the hold is released explicitly first.
        runtime?.releaseApplyHold();
        workerAbort?.abort();
        await workerRun?.catch(() => undefined);
        await closeServer(server);
      }
    });
  } finally {
    delete process.env.GBRAIN_AGENT_TIER;
    delete process.env.GBRAIN_WORKSPACE_BASE_URL;
  }
}

try {
  await runBrainJourney();
  await runAgentJourney();
} finally {
  await admin.end({ timeout: 1 });
}
