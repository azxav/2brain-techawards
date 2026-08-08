import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { initializeWorkspaceFoundation } from '../src/workspace/foundation.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  buildWorkspaceExportArchive,
  cancelWorkspaceExport,
  getWorkspaceExport,
  listWorkspaceExports,
  requestWorkspaceExport,
  retrieveWorkspaceExportArtifact,
  retryWorkspaceExport,
  runWorkspaceExportWorkerOnce,
  WORKSPACE_EXPORT_EXCLUDED_SECRET_CLASSES,
  type WorkspaceExportArchive,
} from '../src/workspace/export.ts';
import {
  checkAgentRequiredProvider,
  importAgentAnthropicCredential,
  importAgentOpenRouterCredential,
  proveAgentDefaultAnswer,
} from '../src/workspace/agent-providers.ts';
import { requestNativePasswordRotation } from '../src/workspace/agent-access.ts';
import { runAgentRuntimeOperationWorkerOnce } from '../src/workspace/agent-runtime-queue.ts';
import type { OpenClawControl } from '../src/workspace/openclaw-control.ts';

let engine: PGLiteEngine;

// Values planted in every excluded secret class. None may reach any archive
// filename or content — that is the exfiltration guarantee under test.
const PLANTED_SECRETS = {
  magicLinkHash: 'PLANTED-MAGIC-LINK-HASH-a1',
  sessionHash: 'PLANTED-SESSION-HASH-b2',
  csrfHash: 'PLANTED-CSRF-HASH-c3',
  invitationTokenHash: 'PLANTED-INVITATION-TOKEN-HASH-d4',
  agentTokenHash: 'PLANTED-AGENT-CREDENTIAL-HASH-e5',
  fullParametersPrompt: 'PLANTED-FULL-PARAMETERS-RAW-PROMPT-f6',
  remoteUrlToken: 'PLANTED-GIT-REMOTE-TOKEN-g7',
  bootstrapMaterial: 'PLANTED-BOOTSTRAP-SETUP-HASH-h8',
  providerSecret: 'PLANTED-PROVIDER-API-KEY-i9',
  managedCloneInternal: 'PLANTED-MANAGED-CLONE-PATH-j10',
} as const;

const OPENCLAW_RUNTIME_CANARIES = {
  native: 'native-canary-never-persist',
  claude: 'sk-ant-oat01-canary-never-persist',
  openrouter: 'sk-or-v1-canary-never-persist',
  agent: 'agent-token-canary-never-export',
  prompt: 'prompt-canary-never-persist',
  answer: 'answer-canary-never-persist',
} as const;

function serializeForSecretScan(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
    if (typeof item === 'object' && item !== null) {
      if (seen.has(item)) return '[Circular]';
      seen.add(item);
    }
    return item;
  });
}

async function seedWorkspace(): Promise<void> {
  await engine.executeRaw(
    "INSERT INTO workspace_workspaces (workspace_id, name, setup_completed_at) VALUES ('workspace-1', 'Workspace', now())",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_identities (identity_id, normalized_email, email_confirmed_at) VALUES ('identity-1', 'admin@example.test', now())",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_identities (identity_id, normalized_email) VALUES ('identity-2', 'member@example.test')",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-1', 'workspace-1', 'identity-1', 'administrator')",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_memberships (membership_id, workspace_id, identity_id, role) VALUES ('member-2', 'workspace-1', 'identity-2', 'member')",
  );

  // Retained Knowledge: one Managed Git Source, one Page, one Page Version.
  // The remote URL embeds a credential to exercise re-sanitization.
  await engine.executeRaw(
    `INSERT INTO workspace_sources (source_id, workspace_id, name, remote_url, expected_cadence, provisioning_state, created_by_membership_id)
     VALUES ('handbook', 'workspace-1', 'Team handbook', $1, 'daily', 'completed', 'member-1')`,
    [`https://ci:${PLANTED_SECRETS.remoteUrlToken}@example.test/team/handbook.git`],
  );
  await engine.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('handbook', 'Team handbook', $1)", [
    `/srv/2brain/clones/${PLANTED_SECRETS.managedCloneInternal}`,
  ]);
  await engine.executeRaw(
    `INSERT INTO pages (source_id, slug, type, title, compiled_truth, frontmatter)
     VALUES ('handbook', 'welcome', 'note', 'Welcome', '# Welcome to the handbook', '{"tags":["intro"]}'::jsonb)`,
  );
  await engine.executeRaw(
    `INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
     SELECT id, '# Welcome (draft)', '{"tags":["intro"]}'::jsonb FROM pages WHERE slug='welcome'`,
  );

  // Authorization policy (retained) — Member All, Agent Specific.
  await engine.executeRaw(
    "INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('member', 'member-2', 'specific')",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_source_grants (principal_kind, principal_id, source_id) VALUES ('member', 'member-2', 'handbook')",
  );

  // Agent config (retained) with a credential (excluded).
  await engine.executeRaw(
    `INSERT INTO workspace_agents (agent_id, workspace_id, name, purpose, owner_membership_id, status, scope, created_by_membership_id)
     VALUES ('agent-1', 'workspace-1', 'Indexer', 'Reads the handbook', 'member-1', 'active', 'read', 'member-1')`,
  );
  await engine.executeRaw(
    "INSERT INTO workspace_principal_source_policies (principal_kind, principal_id, access_mode) VALUES ('agent', 'agent-1', 'all')",
  );
  await engine.executeRaw(
    "INSERT INTO workspace_agent_credentials (credential_id, agent_id, token_hash) VALUES ('cred-1', 'agent-1', $1)",
    [PLANTED_SECRETS.agentTokenHash],
  );
  await engine.executeRaw(
    `INSERT INTO workspace_agent_runtime_bindings
       (workspace_id, agent_id, last_error_code, claude_verified_model, answer_verified_target)
     VALUES ('workspace-1', 'agent-1', $1, $2, $3)`,
    ['safe-runtime-error', 'safe-claude-model', 'safe-answer-target'],
  );
  await engine.executeRaw(
    `INSERT INTO workspace_agent_warning_confirmations (workspace_id, membership_id, revision)
     VALUES ('workspace-1', 'member-1', $1)`,
    ['safe-warning-revision'],
  );
  await engine.executeRaw(
    `INSERT INTO workspace_agent_runtime_operations
       (operation_id, workspace_id, operation_type, generation, idempotency_key,
        idempotency_fingerprint, request_id, safe_error_code)
     VALUES ('runtime-op-1', 'workspace-1', 'mcp.configure', 1, $1, $2, $3, $4)`,
    ['safe-operation-key', 'a'.repeat(64), 'safe-operation-request', 'safe-operation-error'],
  );
  await engine.executeRaw(
    "INSERT INTO workspace_agent_activity (activity_id, agent_id, operation, outcome) VALUES ('act-1', 'agent-1', 'search', 'succeeded')",
  );
  await engine.executeRaw(
    `INSERT INTO workspace_agent_request_details (activity_id, redacted_detail, full_parameters, full_parameters_expire_at)
     VALUES ('act-1', '{}'::jsonb, $1::jsonb, now() + interval '7 days')`,
    [JSON.stringify({ raw_prompt: PLANTED_SECRETS.fullParametersPrompt })],
  );

  // Attention history (retained).
  await engine.executeRaw(
    `INSERT INTO workspace_condition_episodes (episode_id, workspace_id, category, condition_type, resource_type, resource_id)
     VALUES ('episode-1', 'workspace-1', 'source_health', 'stale_source', 'source', 'handbook')`,
  );
  await engine.executeRaw(
    `INSERT INTO workspace_attention_items (item_id, workspace_id, episode_id, category, condition_type, resource_type, resource_id, summary)
     VALUES ('item-1', 'workspace-1', 'episode-1', 'source_health', 'stale_source', 'source', 'handbook', 'Handbook is stale')`,
  );
  await engine.executeRaw(
    `INSERT INTO workspace_attention_item_history (history_id, item_id, event, actor_kind, actor_id)
     VALUES ('history-1', 'item-1', 'detected', 'system', 'detector')`,
  );

  // Secret classes that must never appear in the archive.
  await engine.executeRaw(
    "INSERT INTO workspace_setup_tokens (token_hash, purpose, expires_at) VALUES ($1, 'login', now() + interval '1 day')",
    [PLANTED_SECRETS.magicLinkHash],
  );
  await engine.executeRaw(
    "INSERT INTO workspace_sessions (session_hash, membership_id, csrf_hash, expires_at) VALUES ($1, 'member-1', $2, now() + interval '1 day')",
    [PLANTED_SECRETS.sessionHash, PLANTED_SECRETS.csrfHash],
  );
  await engine.executeRaw(
    `INSERT INTO workspace_invitations (invitation_id, workspace_id, normalized_email, role, access_mode, token_hash, invited_by_membership_id, expires_at)
     VALUES ('invitation-1', 'workspace-1', 'invitee@example.test', 'member', 'all', $1, 'member-1', now() + interval '1 day')`,
    [PLANTED_SECRETS.invitationTokenHash],
  );
  // Bootstrap material (first-Administrator setup link) and a provider secret
  // in the legacy config table — neither table is read by the archive builder.
  await engine.executeRaw(
    "INSERT INTO workspace_setup_tokens (token_hash, purpose, expires_at) VALUES ($1, 'setup', now() + interval '1 day')",
    [PLANTED_SECRETS.bootstrapMaterial],
  );
  await engine.executeRaw(
    "INSERT INTO config (key, value) VALUES ('llm_provider_api_key', $1)",
    [PLANTED_SECRETS.providerSecret],
  );
}

async function completedExport(idempotencyKey = 'export-key-1'): Promise<{ exportId: string }> {
  const requested = await requestWorkspaceExport(engine, {
    workspaceId: 'workspace-1', actorMembershipId: 'member-1',
    requestId: `req-${idempotencyKey}`, idempotencyKey,
  });
  const worked = await runWorkspaceExportWorkerOnce(engine, { workerId: 'export-worker-1' });
  expect(worked?.state).toBe('completed');
  return { exportId: requested.exportId };
}

// One shared engine for the whole file (check-test-isolation.sh R3/R4): an
// engine built per test escapes the afterAll disconnect the shard process
// relies on, so connections leak across file boundaries. Order matters —
// initializeWorkspaceFoundation()'s assertCleanStartDatabase() refuses a
// database that already holds non-`workspace_`-prefixed tables, so it must run
// on the still-empty engine BEFORE engine.initSchema() adds the general brain
// schema. Per-test isolation now comes from resetPgliteState() (TRUNCATE, not
// a fresh connection); it must NOT be followed by another
// initializeWorkspaceFoundation() call, because TRUNCATE clears
// workspace_deployments' singleton row and assertCleanStartDatabase would then
// see the still-present general schema and throw. Nothing exercised here reads
// workspace_deployments, so leaving it empty after reset is harmless.
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  await initializeWorkspaceFoundation(engine);
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await seedWorkspace();
});

describe('Workspace Export archive', () => {
  test('setup and check canaries never reach export, storage, events, errors, or logs', async () => {
    const capturedErrors: string[] = [];
    const capturedLogs: unknown[][] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.error = (...args: unknown[]) => { capturedLogs.push(args); };
    console.warn = (...args: unknown[]) => { capturedLogs.push(args); };
    console.log = (...args: unknown[]) => { capturedLogs.push(args); };

    let failImports = true;
    let failModel = true;
    let failPassword = true;
    const control = {
      runtimeHealth: async () => true,
      applyNativePassword: async () => {
        if (failPassword) { failPassword = false; throw new Error(OPENCLAW_RUNTIME_CANARIES.native); }
      },
      verifyNativePassword: async () => true,
      verifyNativePasswordRejected: async () => true,
      configureGBrainMcp: async () => {},
      probeGBrainWhoAmI: async () => ({
        workspaceId: 'workspace-1', agentId: 'agent-1', scopes: ['read'], sourceAccessMode: 'all',
      }),
      importProviderCredential: async ({ credential }: { credential: string }) => {
        if (failImports) throw new Error(`rejected:${credential}`);
      },
      getProviderStatus: async () => ({
        authenticated: true, authStatus: 'ok' as const,
        quota: { state: 'unknown' as const, remainingPercent: null, resetsAt: null },
      }),
      listModels: async () => ['openai/gpt-5.6-sol', 'anthropic/claude-sonnet-5'],
      probeModel: async () => {
        if (failModel) { failModel = false; throw new Error(OPENCLAW_RUNTIME_CANARIES.prompt); }
        return { text: 'model-ok' };
      },
      probeDefaultAnswer: async () => ({ text: OPENCLAW_RUNTIME_CANARIES.answer }),
    } as OpenClawControl;

    try {
      for (const attempt of [
        () => importAgentAnthropicCredential(engine, control, {
          workspaceId: 'workspace-1', setupToken: OPENCLAW_RUNTIME_CANARIES.claude,
          actorMembershipId: 'member-1', requestId: 'canary-claude-fail',
        }),
        () => importAgentOpenRouterCredential(engine, control, {
          workspaceId: 'workspace-1', apiKey: OPENCLAW_RUNTIME_CANARIES.openrouter,
          actorMembershipId: 'member-1', requestId: 'canary-openrouter-fail',
        }),
        () => checkAgentRequiredProvider(engine, control, { workspaceId: 'workspace-1', provider: 'codex' }),
      ]) {
        try { await attempt(); } catch (error) { capturedErrors.push(String(error)); }
      }
      failImports = false;
      await importAgentAnthropicCredential(engine, control, {
        workspaceId: 'workspace-1', setupToken: OPENCLAW_RUNTIME_CANARIES.claude,
        actorMembershipId: 'member-1', requestId: 'canary-claude-ok',
      });
      await importAgentOpenRouterCredential(engine, control, {
        workspaceId: 'workspace-1', apiKey: OPENCLAW_RUNTIME_CANARIES.openrouter,
        actorMembershipId: 'member-1', requestId: 'canary-openrouter-ok',
      });
      await checkAgentRequiredProvider(engine, control, { workspaceId: 'workspace-1', provider: 'codex' });
      await proveAgentDefaultAnswer(engine, control, { workspaceId: 'workspace-1' });
      await requestNativePasswordRotation(engine, {
        workspaceId: 'workspace-1', actorMembershipId: 'member-1', requestId: 'canary-native',
        idempotencyKey: 'canary-native', reason: 'Canary boundary proof.',
      });
      for (let i = 0; i < 4; i += 1) {
        await runAgentRuntimeOperationWorkerOnce(engine, {
          workerId: 'canary-worker', tokenSecret: OPENCLAW_RUNTIME_CANARIES.agent, control,
        });
      }
      const { exportId } = await completedExport('canary-combined');
      const artifact = await retrieveWorkspaceExportArtifact(engine, {
        workspaceId: 'workspace-1', exportId, actorMembershipId: 'member-1', requestId: 'canary-retrieve',
      });
      const tableNames = await engine.executeRaw<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'workspace_%' ORDER BY tablename",
      );
      const database: Record<string, unknown[]> = {};
      for (const { tablename } of tableNames) database[tablename] = await engine.executeRaw(`SELECT * FROM ${tablename}`);
      const audit = await engine.executeRaw('SELECT * FROM workspace_audit_events ORDER BY event_id');
      const changes = await engine.executeRaw('SELECT * FROM workspace_change_events ORDER BY event_id');
      const serialized = serializeForSecretScan({
        export: artifact, database, audit, changes, errors: capturedErrors, logs: capturedLogs,
      });
      for (const canary of Object.values(OPENCLAW_RUNTIME_CANARIES)) expect(serialized).not.toContain(canary);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
      console.log = originalLog;
    }
  });

  test('produces every retained data class and an integrity manifest', async () => {
    const { exportId } = await completedExport();

    const view = await getWorkspaceExport(engine, 'workspace-1', exportId);
    expect(view).toMatchObject({ state: 'completed', progress: 100, retryable: false });
    expect(view?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(view?.byteSize).toBeGreaterThan(0);
    expect(view?.recordCounts).toMatchObject({
      pages: 1, page_versions: 1, sources: 1, members: 2, agents: 1, attention_items: 1,
    });

    const artifact = await retrieveWorkspaceExportArtifact(engine, {
      workspaceId: 'workspace-1', exportId, actorMembershipId: 'member-1', requestId: 'req-retrieve',
    });
    const parsed = JSON.parse(artifact.content) as { entries: { path: string; content: string }[] };
    const paths = parsed.entries.map(entry => entry.path);
    expect(paths).toEqual(expect.arrayContaining([
      'pages/handbook/welcome.md',
      'pages/handbook/welcome.json',
      'page-versions/handbook/welcome.json',
      'sources.json',
      'members.json',
      'agents.json',
      'attention.json',
      'change-events.json',
      'manifest.json',
    ]));

    const manifest = artifact.manifest!;
    expect(manifest.record_counts.pages).toBe(1);
    expect(manifest.retained_data_classes).toContain('page_versions');
    expect(manifest.integrity.algorithm).toBe('sha256');
    expect(manifest.openclaw_state_included).toBe(false);
    expect(manifest.openclaw_backup).toBe(false);
    // Every content entry's manifest hash matches its bytes.
    for (const integrityEntry of manifest.integrity.entries) {
      const entry = parsed.entries.find(candidate => candidate.path === integrityEntry.path)!;
      expect(createHash('sha256').update(entry.content, 'utf8').digest('hex')).toBe(integrityEntry.sha256);
    }
    // The stored artifact checksum addresses the serialized archive.
    expect(artifact.checksum).toBe(createHash('sha256').update(artifact.content, 'utf8').digest('hex'));

    const pageMarkdown = parsed.entries.find(entry => entry.path === 'pages/handbook/welcome.md')!;
    expect(pageMarkdown.content).toBe('# Welcome to the handbook');
  });

  test('excludes every secret class from filenames and content', async () => {
    await engine.executeRaw(
      'UPDATE workspace_agent_runtime_bindings SET last_error_code=$1,claude_verified_model=$2,answer_verified_target=$3',
      [OPENCLAW_RUNTIME_CANARIES.native, OPENCLAW_RUNTIME_CANARIES.claude, OPENCLAW_RUNTIME_CANARIES.answer],
    );
    await engine.executeRaw(
      'UPDATE workspace_agent_warning_confirmations SET revision=$1', [OPENCLAW_RUNTIME_CANARIES.openrouter],
    );
    await engine.executeRaw(
      'UPDATE workspace_agent_runtime_operations SET idempotency_key=$1,request_id=$2,safe_error_code=$3',
      [OPENCLAW_RUNTIME_CANARIES.agent, OPENCLAW_RUNTIME_CANARIES.prompt, OPENCLAW_RUNTIME_CANARIES.native],
    );
    const { exportId } = await completedExport();
    const artifact = await retrieveWorkspaceExportArtifact(engine, {
      workspaceId: 'workspace-1', exportId, actorMembershipId: 'member-1', requestId: 'req-scan',
    });
    const parsed = JSON.parse(artifact.content) as { entries: { path: string; content: string }[] };

    for (const secret of Object.values(PLANTED_SECRETS)) {
      expect(artifact.content).not.toContain(secret);
      for (const entry of parsed.entries) {
        expect(entry.path).not.toContain(secret);
        expect(entry.content).not.toContain(secret);
      }
    }
    for (const canary of Object.values(OPENCLAW_RUNTIME_CANARIES)) {
      expect(artifact.content).not.toContain(canary);
    }

    const manifest = artifact.manifest!;
    expect(manifest.excluded_secret_classes).toEqual(
      expect.arrayContaining([...WORKSPACE_EXPORT_EXCLUDED_SECRET_CLASSES]),
    );
  });

  test('sanitizes credentials embedded in a Source remote URL', async () => {
    const { exportId } = await completedExport();
    const artifact = await retrieveWorkspaceExportArtifact(engine, {
      workspaceId: 'workspace-1', exportId, actorMembershipId: 'member-1', requestId: 'req-remote',
    });
    const parsed = JSON.parse(artifact.content) as { entries: { path: string; content: string }[] };
    const sources = JSON.parse(parsed.entries.find(entry => entry.path === 'sources.json')!.content) as {
      remote_url: string;
      source_id: string;
    }[];
    expect(sources[0]!.remote_url).toBe('https://example.test/team/handbook.git');
    expect(sources[0]!.remote_url).not.toContain(PLANTED_SECRETS.remoteUrlToken);
  });

  test('assembles deterministically for an unchanged snapshot', async () => {
    const build = (): Promise<WorkspaceExportArchive> => buildWorkspaceExportArchive(engine, {
      workspaceId: 'workspace-1', exportId: 'export-fixed', generatedAt: '2026-07-14T00:00:00.000Z',
    });
    const first = await build();
    const second = await build();
    expect(second.checksum).toBe(first.checksum);
    expect(second.content).toBe(first.content);
  });

  test('carries authorization policy without credential material', async () => {
    const { exportId } = await completedExport();
    const artifact = await retrieveWorkspaceExportArtifact(engine, {
      workspaceId: 'workspace-1', exportId, actorMembershipId: 'member-1', requestId: 'req-policy',
    });
    const parsed = JSON.parse(artifact.content) as { entries: { path: string; content: string }[] };
    const members = JSON.parse(parsed.entries.find(entry => entry.path === 'members.json')!.content) as {
      membership_id: string;
      source_access: { mode: string; source_ids: string[] };
    }[];
    const scoped = members.find(member => member.membership_id === 'member-2')!;
    expect(scoped.source_access).toEqual({ mode: 'specific', source_ids: ['handbook'] });

    const agents = JSON.parse(parsed.entries.find(entry => entry.path === 'agents.json')!.content) as {
      agent_id: string;
      source_access: { mode: string };
    }[];
    expect(agents[0]!.source_access.mode).toBe('all');
    // No credential material of any kind appears in the agents entry.
    expect(parsed.entries.find(entry => entry.path === 'agents.json')!.content).not.toContain('token_hash');
  });
});

describe('Workspace Export lifecycle', () => {
  test('is idempotent for a repeated request key and audits the request', async () => {
    const first = await requestWorkspaceExport(engine, {
      workspaceId: 'workspace-1', actorMembershipId: 'member-1', requestId: 'req-1', idempotencyKey: 'key-a',
    });
    const replay = await requestWorkspaceExport(engine, {
      workspaceId: 'workspace-1', actorMembershipId: 'member-1', requestId: 'req-1-replay', idempotencyKey: 'key-a',
    });
    expect(replay.exportId).toBe(first.exportId);
    expect(await engine.executeRaw('SELECT export_id FROM workspace_exports')).toHaveLength(1);

    const audit = await engine.executeRaw<{ action: string }>(
      "SELECT action FROM workspace_audit_events WHERE action='export.request'",
    );
    expect(audit).toHaveLength(1);
    const change = await engine.executeRaw<{ summary: string }>(
      "SELECT summary FROM workspace_change_events WHERE resource_type='workspace_export'",
    );
    expect(change).toHaveLength(1);
  });

  test('audits completion and retrieval of a protected artifact', async () => {
    const { exportId } = await completedExport('key-audit');
    await retrieveWorkspaceExportArtifact(engine, {
      workspaceId: 'workspace-1', exportId, actorMembershipId: 'member-1', requestId: 'req-audit-retrieve',
    });
    const actions = await engine.executeRaw<{ action: string }>(
      "SELECT action FROM workspace_audit_events WHERE action LIKE 'export.%' ORDER BY action",
    );
    expect(actions.map(row => row.action)).toEqual(
      expect.arrayContaining(['export.complete', 'export.request', 'export.retrieve']),
    );
  });

  test('refuses retrieval before completion and after expiry', async () => {
    const requested = await requestWorkspaceExport(engine, {
      workspaceId: 'workspace-1', actorMembershipId: 'member-1', requestId: 'req-early', idempotencyKey: 'key-early',
    });
    await expect(retrieveWorkspaceExportArtifact(engine, {
      workspaceId: 'workspace-1', exportId: requested.exportId, actorMembershipId: 'member-1', requestId: 'req-x',
    })).rejects.toMatchObject({ code: 'export_not_ready' });

    await runWorkspaceExportWorkerOnce(engine, { workerId: 'export-worker-1' });
    await engine.executeRaw(
      "UPDATE workspace_exports SET expires_at = now() - interval '1 hour' WHERE export_id=$1",
      [requested.exportId],
    );
    await expect(retrieveWorkspaceExportArtifact(engine, {
      workspaceId: 'workspace-1', exportId: requested.exportId, actorMembershipId: 'member-1', requestId: 'req-y',
    })).rejects.toMatchObject({ code: 'export_expired' });
  });

  test('cancels a queued export durably and does not requeue it', async () => {
    const queued = await requestWorkspaceExport(engine, {
      workspaceId: 'workspace-1', actorMembershipId: 'member-1', requestId: 'req-cancel', idempotencyKey: 'key-cancel',
    });
    const cancelled = await cancelWorkspaceExport(engine, {
      workspaceId: 'workspace-1', exportId: queued.exportId, actorMembershipId: 'member-1', requestId: 'req-cancel-2',
    });
    // A cancellation is a deliberate stop, not a retryable failure.
    expect(cancelled).toMatchObject({ state: 'failed', retryable: false, error: { code: 'operation_cancelled' } });
    expect(await runWorkspaceExportWorkerOnce(engine, { workerId: 'export-worker-1' })).toBeNull();
    await expect(retryWorkspaceExport(engine, {
      workspaceId: 'workspace-1', exportId: queued.exportId, actorMembershipId: 'member-1', requestId: 'req-cancel-retry',
    })).rejects.toMatchObject({ code: 'export_not_retryable' });
  });

  test('retries a retryable failed export back to completion', async () => {
    const queued = await requestWorkspaceExport(engine, {
      workspaceId: 'workspace-1', actorMembershipId: 'member-1', requestId: 'req-retry', idempotencyKey: 'key-retry',
    });
    // Simulate a transient worker failure that left a retryable Failed export.
    await engine.executeRaw(
      `UPDATE workspace_exports
          SET state='failed', retryable=TRUE, attempt=1, error_code='export_failed',
              error_summary='transient failure'
        WHERE export_id=$1`,
      [queued.exportId],
    );
    const retried = await retryWorkspaceExport(engine, {
      workspaceId: 'workspace-1', exportId: queued.exportId, actorMembershipId: 'member-1', requestId: 'req-retry-2',
    });
    expect(retried).toMatchObject({ state: 'queued', progress: 0, cancelRequested: false });
    const completed = await runWorkspaceExportWorkerOnce(engine, { workerId: 'export-worker-1' });
    expect(completed?.state).toBe('completed');
  });

  test('reclaims an expired running lease and completes on restart', async () => {
    const queued = await requestWorkspaceExport(engine, {
      workspaceId: 'workspace-1', actorMembershipId: 'member-1', requestId: 'req-recover', idempotencyKey: 'key-recover',
    });
    // Simulate a worker that died mid-run: running, lease expired, one attempt spent.
    await engine.executeRaw(
      `UPDATE workspace_exports
          SET state='running', attempt=1, lease_owner='dead-worker',
              lease_expires_at=now() - interval '1 hour', snapshot_at=now()
        WHERE export_id=$1`,
      [queued.exportId],
    );
    const recovered = await runWorkspaceExportWorkerOnce(engine, { workerId: 'export-worker-2' });
    expect(recovered).toMatchObject({ exportId: queued.exportId, state: 'completed', attempt: 2 });
  });

  test('fails durably once attempts are exhausted', async () => {
    const queued = await requestWorkspaceExport(engine, {
      workspaceId: 'workspace-1', actorMembershipId: 'member-1', requestId: 'req-exhaust', idempotencyKey: 'key-exhaust',
    });
    await engine.executeRaw(
      `UPDATE workspace_exports
          SET state='running', attempt=3, max_attempts=3, lease_owner='dead-worker',
              lease_expires_at=now() - interval '1 hour'
        WHERE export_id=$1`,
      [queued.exportId],
    );
    const swept = await runWorkspaceExportWorkerOnce(engine, { workerId: 'export-worker-3' });
    expect(swept).toMatchObject({ state: 'failed', retryable: false, error: { code: 'export_exhausted' } });
  });

  test('lists exports newest first', async () => {
    await completedExport('key-list-1');
    await requestWorkspaceExport(engine, {
      workspaceId: 'workspace-1', actorMembershipId: 'member-1', requestId: 'req-list-2', idempotencyKey: 'key-list-2',
    });
    const listed = await listWorkspaceExports(engine, 'workspace-1');
    expect(listed).toHaveLength(2);
    expect(listed[0]!.state).toBe('queued');
    expect(listed[1]!.state).toBe('completed');
  });
});
