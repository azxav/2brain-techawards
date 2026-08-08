#!/usr/bin/env bun

import { createEngine } from '../core/engine-factory.ts';
import { currentExitCode, flushThenExit, setCliExitVerdict } from '../core/cli-force-exit.ts';
import { configureGateway } from '../core/ai/gateway.ts';
import { buildGatewayConfig } from '../core/ai/build-gateway-config.ts';
import { loadConfig, type GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig } from '../core/types.ts';
import {
  initializeWorkspaceFoundation,
  recordWorkspaceRuntimeHeartbeat,
  type WorkspaceRuntimeRole,
} from './foundation.ts';
import {
  provisionManagedGitSource,
  runBackgroundOperationWorkerOnce,
  type SourceProvisioningJob,
} from './source-provisioning.ts';
import { performSync } from '../commands/sync.ts';
import {
  runSourceMaintenanceWorkerOnce,
  type SourceMaintenanceJob,
  type SourceMaintenanceResult,
} from './source-synchronization.ts';
import { runSourceDeletionWorkerOnce } from './source-deletion.ts';
import { runWorkspaceExportWorkerOnce } from './export.ts';
import { runWorkspaceAttentionDetectors } from './attention.ts';
import { enqueueWorkspaceRetention, runWorkspaceRetentionWorkerOnce } from './retention.ts';
import {
  reconcileAgentRuntimeDriftOnce,
  runAgentRuntimeOperationWorkerOnce,
} from './agent-access.ts';
import { LoopbackOpenClawControl, type OpenClawControl } from './openclaw-control.ts';

const HEARTBEAT_INTERVAL_MS = 15_000;

function isRuntimeRole(value: string | undefined): value is WorkspaceRuntimeRole {
  return value === 'worker' || value === 'scheduler';
}

function waitForNextHeartbeat(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, HEARTBEAT_INTERVAL_MS);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function configureWorkspaceRuntimeGateway(): void {
  // Runtime database routing is independent from the gateway. In production
  // the worker may receive only TWO_BRAIN_DATABASE_URL; local development may
  // use --pglite with no database environment at all. When there is no normal
  // gbrain config, construct only the AI-facing fields from env and let the
  // shared gateway builder apply provider URLs, keys, and defaults.
  const config = loadConfig() ?? {
    engine: 'pglite',
    embedding_model: process.env.GBRAIN_EMBEDDING_MODEL,
    embedding_dimensions: process.env.GBRAIN_EMBEDDING_DIMENSIONS
      ? Number.parseInt(process.env.GBRAIN_EMBEDDING_DIMENSIONS, 10)
      : undefined,
    embedding_multimodal_model: process.env.GBRAIN_EMBEDDING_MULTIMODAL_MODEL,
    expansion_model: process.env.GBRAIN_EXPANSION_MODEL,
    chat_model: process.env.GBRAIN_CHAT_MODEL,
    chat_fallback_chain: process.env.GBRAIN_CHAT_FALLBACK_CHAIN
      ?.split(',').map(model => model.trim()).filter(Boolean),
  } satisfies GBrainConfig;
  configureGateway(buildGatewayConfig(config));
}

export async function runWorkspaceRuntime(
  engine: BrainEngine,
  role: WorkspaceRuntimeRole,
  opts: {
    signal?: AbortSignal;
    once?: boolean;
    workerId?: string;
    now?: string;
    executeSourceProvisioning?: (job: SourceProvisioningJob) => Promise<void>;
    executeSourceMaintenance?: (job: SourceMaintenanceJob) => Promise<SourceMaintenanceResult>;
    /**
     * #68: the Agent runtime reconciler runs only where BOTH an OpenClaw runtime
     * and a deployment password secret exist. Either one missing leaves the
     * reconciler out of the loop entirely rather than half-configured.
     */
    openClawControl?: OpenClawControl;
    agentPasswordSecret?: string;
  } = {},
): Promise<void> {
  const controller = opts.signal ? null : new AbortController();
  const signal = opts.signal ?? controller!.signal;

  await initializeWorkspaceFoundation(engine);
  if (role === 'worker') await engine.initSchema();
  do {
    await recordWorkspaceRuntimeHeartbeat(engine, role);
    if (role === 'scheduler') {
      const now = opts.now ?? new Date().toISOString();
      const date = new Date(now);
      if (!Number.isFinite(date.getTime())) throw new Error('Invalid Workspace scheduler clock.');
      const day = date.toISOString().slice(0, 10);
      const workspace = await engine.executeRaw<{ workspace_id: string }>(
        'SELECT workspace_id FROM workspace_workspaces WHERE singleton=TRUE',
      );
      if (workspace[0]) {
        await enqueueWorkspaceRetention(engine, {
          workspaceId: workspace[0].workspace_id,
          requestId: `retention:${day}`,
          idempotencyKey: `daily:${day}`,
        });
      }
    }
    let operation: { requestId: string } | null = role === 'worker'
      ? await runBackgroundOperationWorkerOnce(engine, {
        workerId: opts.workerId ?? `workspace-worker-${process.pid}`,
        executeSourceProvisioning: opts.executeSourceProvisioning
          ?? (job => provisionManagedGitSource(engine, job)),
      })
      : null;
    if (role === 'worker' && !operation) {
      operation = await runSourceMaintenanceWorkerOnce(engine, {
        workerId: opts.workerId ?? `workspace-worker-${process.pid}`,
        execute: opts.executeSourceMaintenance ?? (async job => {
          const result = await performSync(engine, {
            sourceId: job.sourceId, dryRun: job.type === 'source.verify', signal: job.signal,
          });
          if (result.status === 'partial' || result.status === 'blocked_by_failures') {
            throw new Error('source_sync_incomplete');
          }
          return {
            observedRevision: result.toCommit,
            changed: result.fromCommit !== result.toCommit,
            applied: job.type === 'source.sync' && result.status !== 'up_to_date' && result.status !== 'dry_run',
          };
        }),
      });
    }
    if (role === 'worker' && !operation) {
      operation = await runSourceDeletionWorkerOnce(engine, {
        workerId: opts.workerId ?? `workspace-worker-${process.pid}`,
      });
    }
    const openClawControl = opts.openClawControl;
    const agentPasswordSecret = opts.agentPasswordSecret;
    if (role === 'worker' && openClawControl && agentPasswordSecret) {
      const agentWorker = {
        workerId: opts.workerId ?? `workspace-worker-${process.pid}`,
        tokenSecret: agentPasswordSecret,
        control: openClawControl,
      };
      if (!operation) {
        operation = await runAgentRuntimeOperationWorkerOnce(engine, { ...agentWorker, now: opts.now });
      }
      // One bounded drift pass, and only once the queue is quiet: probing the
      // runtime we just reconfigured would prove nothing new, and the queue is
      // the faster repair path anyway. A probe failure must not stall the rest
      // of the loop, but it also never counts as proof — the reconciler itself
      // fails closed and simply leaves the existing state in place.
      if (!operation) {
        try {
          await reconcileAgentRuntimeDriftOnce(engine, agentWorker);
        } catch (error) {
          console.warn(`Agent runtime drift reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    if (role === 'worker' && !operation) {
      operation = await runWorkspaceExportWorkerOnce(engine, {
        workerId: opts.workerId ?? `workspace-worker-${process.pid}`,
      });
    }
    if (role === 'worker' && !operation) {
      operation = await runWorkspaceRetentionWorkerOnce(engine, {
        workerId: opts.workerId ?? `workspace-worker-${process.pid}`,
        now: opts.now,
      });
    }
    if (role === 'worker' && operation) {
      // Detector execution after relevant events (design §13.2): a completed
      // or failed worker outcome immediately reconciles Attention state across
      // every category (Source health, Knowledge quality, Agent access, and
      // Automation health). The Attention queue read remains the backstop, so
      // a detector failure is logged without stopping the worker loop.
      try {
        const workspace = await engine.executeRaw<{ workspace_id: string }>(
          'SELECT workspace_id FROM workspace_workspaces WHERE singleton=TRUE',
        );
        if (workspace[0]) {
          await runWorkspaceAttentionDetectors(engine, {
            workspaceId: workspace[0].workspace_id, requestId: operation.requestId,
          });
        }
      } catch (error) {
        console.warn(`Attention detection failed after worker operation: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (opts.once || signal.aborted) return;
    if (operation) continue;
    await waitForNextHeartbeat(signal);
  } while (!signal.aborted);
}

function parseRuntimeConfig(args: string[]): { role: WorkspaceRuntimeRole; once: boolean; config: EngineConfig } {
  const [role, ...flags] = args;
  if (!isRuntimeRole(role)) {
    throw new Error('Usage: gbrain workspace-runtime <worker|scheduler> [--once] [--pglite <path>]');
  }

  const pgliteIndex = flags.indexOf('--pglite');
  const pglitePath = pgliteIndex === -1 ? undefined : flags[pgliteIndex + 1];
  if (pgliteIndex !== -1 && !pglitePath) {
    throw new Error('--pglite requires a database path');
  }
  if (pglitePath && process.env.TWO_BRAIN_DATABASE_URL) {
    throw new Error('Use either --pglite for local development or TWO_BRAIN_DATABASE_URL for Postgres, not both.');
  }
  if (!pglitePath && !process.env.TWO_BRAIN_DATABASE_URL) {
    throw new Error('TWO_BRAIN_DATABASE_URL is required for a shared 2Brain runtime. Use --pglite <path> only for local development.');
  }

  return {
    role,
    once: flags.includes('--once'),
    config: pglitePath
      ? { engine: 'pglite', database_path: pglitePath }
      : { engine: 'postgres', database_url: process.env.TWO_BRAIN_DATABASE_URL },
  };
}

export async function runWorkspaceRuntimeMain(args: string[]): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, abort);
  }

  let engine: BrainEngine | null = null;
  try {
    const { role, once, config } = parseRuntimeConfig(args);
    configureWorkspaceRuntimeGateway();
    engine = await createEngine(config);
    await engine.connect(config);
    // #68: the worker process — not the web process — owns the loopback adapter
    // that drives OpenClaw. It exists only on an Agent-tier VM, which carries
    // GBRAIN_AGENT_TIER=true in workspace.env. The web process composes its own
    // adapter separately in runServeHttp.
    const agentTier = process.env.GBRAIN_AGENT_TIER?.trim().toLowerCase() === 'true';
    const agentPasswordSecret = process.env.GBRAIN_WORKSPACE_TOKEN_SECRET?.trim();
    await runWorkspaceRuntime(engine, role, {
      signal: controller.signal,
      once,
      openClawControl: agentTier ? new LoopbackOpenClawControl() : undefined,
      agentPasswordSecret: agentTier ? agentPasswordSecret : undefined,
    });
  } finally {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.off(signal, abort);
    }
    try {
      await engine?.disconnect();
    } catch (error) {
      console.warn(`2Brain runtime disconnect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (import.meta.main) {
  try {
    await runWorkspaceRuntimeMain(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    setCliExitVerdict(1);
  } finally {
    // PGLite can write process.exitCode while closing. Use the gbrain-owned
    // verdict and the shared flush seam so a failed one-shot runtime cannot
    // naturally exit with that unrelated value.
    flushThenExit(currentExitCode());
  }
}
