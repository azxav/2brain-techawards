/**
 * The provisioning and lifecycle state machine.
 *
 * The registry row *is* the state. A tick takes a short lease on one workspace,
 * advances it by exactly one step, persists what that step created, and releases.
 * There is no in-memory machine to lose, so killing the control plane mid-provision
 * costs at most the step in flight: the next tick re-reads the row and resumes.
 *
 *   pending -> credentials -> instance -> dns -> health -> setup_link -> running
 *                                                                     \-> failed (after cleanup)
 *
 * Every external effect is keyed on the workspace id and looked up before it is
 * created, so an effect that succeeded but whose acknowledgement was lost is
 * re-found rather than duplicated.
 *
 * Lifecycle actions ride the same machinery. The API writes an intent state and
 * returns; a tick performs the cloud effects and lands the settled state:
 *
 *   running   -> suspending -> suspended     (instance stopped, DNS left in place)
 *   suspended -> resuming   -> running       (instance started, health re-probed)
 *   any       -> deleting   -> deleted       (everything released, secrets purged)
 *
 * Doing that work in the HTTP handler instead would put a multi-effect teardown
 * somewhere a crash cannot be resumed from, which is exactly how VMs, DNS records
 * and live credentials get orphaned.
 */
import type { SqlExecutor } from './db.ts';
import { ComputeError, type ComputeAdapter } from './adapters/compute.ts';
import { DnsError, type DnsAdapter } from './adapters/dns.ts';
import { EmbeddingKeyError, type EmbeddingKeyAdapter } from './adapters/openrouter.ts';
import { WorkspaceApiError, type WorkspaceAdapter } from './adapters/workspace.ts';
import { mintWorkspaceSecrets, renderCloudInit, type WorkspaceSecrets } from './cloud-init.ts';
import { openSecret, sealSecret } from './secrets.ts';
import {
  advanceProvisioningStep,
  claimNextProvisioningWorkspace,
  clearProvisioningSecrets,
  failWorkspace,
  findWorkspaceById,
  purgeWorkspaceSecrets,
  readProvisioningSecrets,
  recordWorkspaceAddress,
  recordStepAttempt,
  releaseLease,
  settleLifecycleState,
  type WorkspaceRecord,
} from './store.ts';

export class ProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProvisioningError';
  }
}

export interface ProvisioningDeps {
  db: SqlExecutor;
  compute: ComputeAdapter;
  dns: DnsAdapter;
  workspace: WorkspaceAdapter;
  /** Mints the workspace's own spend-limited embedding key. See adapters/openrouter.ts. */
  embeddingKeys: EmbeddingKeyAdapter;
  /** AES key for the sealed columns. See secrets.ts. */
  sealingKey: Buffer;
  resendApiKey: string;
  emailFrom: string;
  /** Identifies this reconciler in the lease. Any stable per-process string. */
  owner: string;
  leaseSeconds?: number;
  /** How many "not yet" ticks a step may take before the provision gives up. */
  maxStepAttempts?: number;
  /**
   * One journal line per provisioning event (#48): every step transition, every
   * wait, every failure. Without this, a stalled reconciler and an idle one look
   * identical from outside — the incident's journal was completely empty.
   */
  log?: (line: string) => void;
}

export type TickOutcome = 'idle' | 'advanced' | 'waiting' | 'failed';

/** Stable across retries and restarts, because the workspace id is. */
export function instanceDisplayName(workspaceId: string): string {
  return `2brain-ws-${workspaceId}`;
}

/**
 * The embedding key's dedupe key, and how an operator finds it in OpenRouter.
 * Deliberately not the instance display name it would otherwise read the same
 * as: two namespaces sharing one literal make a change to either look safe.
 */
export function embeddingKeyName(workspaceId: string): string {
  return `2brain-embedding-${workspaceId}`;
}

/**
 * Release a workspace's embedding key, wherever the provision got to.
 *
 * By handle when one was recorded, by name when it was not: a mint whose
 * acknowledgement was lost left a live, billable key this row never learned the
 * handle of, and it is named after the workspace precisely so this can find it.
 * Shared rather than inlined because every teardown path — failed provision
 * today, workspace deletion later, the smoke run's own cleanup — owes the same
 * duty, and a key that outlives its VM is a bill nobody is watching.
 */
export async function revokeWorkspaceEmbeddingKey(
  embeddingKeys: EmbeddingKeyAdapter,
  workspaceId: string,
  recordedHash: string | null,
): Promise<void> {
  const hash = recordedHash ?? (await embeddingKeys.findKeyByName(embeddingKeyName(workspaceId)))?.hash;
  if (hash) await embeddingKeys.revokeKey(hash);
}

/**
 * Adapter errors are already written to be safe: they carry a status code and a
 * method, never a body, a URL with a token, or a credential. Anything else is
 * summarised away rather than risk putting a secret in an operator-visible
 * column.
 */
function safeSummary(error: unknown): string {
  if (
    error instanceof ComputeError
    || error instanceof DnsError
    || error instanceof EmbeddingKeyError
    || error instanceof WorkspaceApiError
    || error instanceof ProvisioningError
  ) {
    return `${error.name}: ${error.message}`;
  }
  return 'an unexpected error ended provisioning';
}

export async function runProvisioningTick(deps: ProvisioningDeps): Promise<TickOutcome> {
  const claimed = await claimNextProvisioningWorkspace(deps.db, {
    owner: deps.owner,
    leaseSeconds: deps.leaseSeconds ?? 60,
  });
  if (!claimed) return 'idle';

  // A lifecycle action never falls into `abort`. Aborting tears the workspace
  // down, which is the right answer for a provision that cannot finish and a
  // catastrophic one for a resume whose instance was merely slow to boot.
  if (claimed.lifecycleState !== 'provisioning') return runLifecycleAction(deps, claimed);

  try {
    return await advance(deps, claimed);
  } catch (error) {
    return abort(deps, claimed, error);
  }
}

async function runLifecycleAction(deps: ProvisioningDeps, workspace: WorkspaceRecord): Promise<TickOutcome> {
  switch (workspace.lifecycleState) {
    case 'deleting':
      return teardown(deps, workspace);
    case 'suspending':
      return withSetback(deps, workspace, 'running', () => suspend(deps, workspace));
    case 'resuming':
      // A resume that gives up must leave a stopped instance behind, not just a
      // row that says stopped: see `restoreSuspension`.
      return withSetback(deps, workspace, 'suspended', () => resume(deps, workspace), restoreSuspension);
    default:
      // Settled, or a state this reconciler does not own. Do not hold the lease.
      await releaseLease(deps.db, workspace.workspaceId);
      return 'idle';
  }
}

/**
 * Run a lifecycle action, and on failure put the workspace back where it came
 * from rather than leaving it stuck mid-action.
 *
 * A failure is retried until the attempt budget runs out, because most of them
 * are a cloud API having a bad minute. When it does run out the row returns to
 * its previous settled state with the reason attached, so the operator can see
 * what happened and ask again — an unreachable `suspending` row that no longer
 * ticks is worse than a `running` row that says why the suspend did not take.
 */
async function withSetback(
  deps: ProvisioningDeps,
  workspace: WorkspaceRecord,
  revertTo: WorkspaceRecord['lifecycleState'],
  action: () => Promise<TickOutcome>,
  /** Undo whatever the action managed before it gave up. Returns a note if it could not. */
  restore?: (deps: ProvisioningDeps, workspace: WorkspaceRecord) => Promise<string | null>,
): Promise<TickOutcome> {
  try {
    return await action();
  } catch (error) {
    if (!(await spendAttempt(deps, workspace))) return 'waiting';
    const note = restore ? await restore(deps, workspace) : null;
    const attempts = workspace.stepAttempts + 1;
    await settleLifecycleState(
      deps.db,
      workspace.workspaceId,
      revertTo,
      { error: `${safeSummary(error)} (gave up after ${attempts} attempts)${note ? `; ${note}` : ''}` },
      deps.owner,
    );
    return 'failed';
  }
}

/**
 * Count one attempt against the action's budget. Returns true once the budget is
 * spent, which is the caller's signal to settle rather than wait.
 *
 * The retries exist because most lifecycle failures are a cloud API having a bad
 * minute. The bound exists because some of them are not.
 */
async function spendAttempt(deps: ProvisioningDeps, workspace: WorkspaceRecord): Promise<boolean> {
  const attempts = workspace.stepAttempts + 1;
  if (attempts >= (deps.maxStepAttempts ?? 60)) return true;
  await recordStepAttempt(deps.db, workspace.workspaceId, deps.owner);
  return false;
}

/**
 * A resume gave up. Stop the instance again before recording `suspended`.
 *
 * Without this the row would claim the workspace is stopped while the VM it
 * names is running: an honest-looking lie that also disarms the lever, because
 * suspend is only offered from `running` and this row no longer says running.
 * The operator would have no way to stop a machine the control plane started.
 */
async function restoreSuspension(deps: ProvisioningDeps, workspace: WorkspaceRecord): Promise<string | null> {
  if (!workspace.ociInstanceOcid) return null;
  try {
    await deps.compute.stopInstance(workspace.ociInstanceOcid);
    return null;
  } catch {
    // Said plainly, because the row is about to claim otherwise.
    return 'the instance could not be stopped again and may still be running';
  }
}

async function advance(deps: ProvisioningDeps, workspace: WorkspaceRecord): Promise<TickOutcome> {
  const id = workspace.workspaceId;
  const baseUrl = `https://${workspace.subdomain}`;
  // Every transition reaches the journal (#48): a provision that stops moving
  // must leave a last line saying where it stood.
  const moveTo: typeof advanceProvisioningStep = async (...args) => {
    const advanced = await advanceProvisioningStep(...args);
    deps.log?.(`[control-plane] workspace ${id}: ${workspace.provisioningStep} -> ${args[2]}`);
    return advanced;
  };

  switch (workspace.provisioningStep) {
    case 'pending': {
      // Mint before launching, and persist before using: a crash between this
      // step and the launch must not strand a VM holding secrets we forgot.
      //
      // The embedding key is minted here, with the local secrets, rather than
      // later: cloud-init carries it, so it has to exist before the launch that
      // consumes it. OpenRouter hands over the key material exactly once, so a
      // mint whose acknowledgement was lost cannot be recovered — the adapter
      // replaces a same-named predecessor instead, which is safe precisely
      // because no VM has consumed one yet at this point.
      let minted;
      try {
        minted = await deps.embeddingKeys.mintKey({ name: embeddingKeyName(id) });
      } catch (error) {
        // Minting is the first external call the machine makes, so a rate limit
        // or a transport fault here would otherwise fail a workspace create that
        // one more tick completes. A mint that succeeded before the fault leaves
        // a same-named key the retry replaces. Bounded like every other wait.
        if (error instanceof EmbeddingKeyError && error.retryable) {
          return wait(deps, workspace, 'waiting for the embedding key to be minted');
        }
        throw error;
      }
      const secrets: LaunchSecrets = { ...mintWorkspaceSecrets(), openrouterKey: minted.key };
      await moveTo(deps.db, id, 'credentials', {
        bootstrapCredentialRef: sealSecret(secrets.bootstrapCredential, deps.sealingKey),
        // The handle, not the key: it is what revocation and metering address.
        embeddingTokenRef: minted.hash,
        provisioningSecrets: sealSecret(JSON.stringify(secrets), deps.sealingKey),
      }, deps.owner);
      return 'advanced';
    }

    case 'credentials': {
      const secrets = await loadSecrets(deps, id);
      const displayName = instanceDisplayName(id);
      // The lookup that makes a lost launch acknowledgement survivable.
      const existing = await deps.compute.findInstanceByName(displayName);
      const instance = existing ?? await deps.compute.launchInstance({
        displayName,
        cloudInit: renderCloudInit({
          name: workspace.name,
          subdomain: workspace.subdomain,
          tier: workspace.tier,
          secrets,
          resendApiKey: deps.resendApiKey,
          emailFrom: deps.emailFrom,
          openrouterKey: secrets.openrouterKey,
        }),
      });
      await moveTo(deps.db, id, 'instance', { ociInstanceOcid: instance.ocid }, deps.owner);
      return 'advanced';
    }

    case 'instance': {
      if (!workspace.ociInstanceOcid) throw new ProvisioningError('the instance step completed without recording an instance');
      const instance = await deps.compute.getInstance(workspace.ociInstanceOcid);
      if (!instance) throw new ProvisioningError('the launched instance no longer exists');
      if (instance.state === 'terminated') throw new ProvisioningError('the launched instance was terminated outside the control plane');
      if (!instance.publicIp) return wait(deps, workspace, 'waiting for the instance to be assigned an address');
      const record = await deps.dns.upsertRecord(workspace.subdomain, instance.publicIp);
      // Persist the address the DNS record points at: the health and setup-link
      // steps dial it directly rather than resolving the name just created.
      await moveTo(deps.db, id, 'dns', { dnsRecordId: record.id, publicIp: instance.publicIp }, deps.owner);
      return 'advanced';
    }

    case 'dns': {
      // Dial the VM by the address the instance step recorded, not by the name it
      // just published: Caddy completes ACME (tls-alpn-01, over 443) and the cert
      // validates against the hostname via SNI, but no local DNS lookup happens,
      // so an early NXDOMAIN can never be negative-cached past the health window.
      if (!workspace.publicIp) throw new ProvisioningError('the dns step completed without recording an address');
      const healthy = await deps.workspace.probeHealth(baseUrl, workspace.publicIp);
      if (!healthy) return wait(deps, workspace, 'waiting for the workspace to answer over HTTPS');
      await moveTo(deps.db, id, 'health', {}, deps.owner);
      return 'advanced';
    }

    case 'health': {
      if (!workspace.bootstrapCredentialRef) throw new ProvisioningError('no bootstrap credential is recorded for this workspace');
      // Same lane, same reason: dial the recorded IP rather than resolve the name.
      if (!workspace.publicIp) throw new ProvisioningError('no address is recorded for this workspace');
      // Agent tier promises a live OpenClaw service, so readiness must include it
      // (#57): a workspace must never report running while the agent gateway it
      // advertises is down. This gate sits in `health` rather than beside the TLS
      // probe in `dns` because `step_attempts` only resets on a step change, so
      // sharing that step would make one budget cover ACME issuance and gateway
      // boot in series — and exhausting it does not merely stall, it tears the
      // instance down. Brain tier takes the branch it always took.
      if (workspace.tier === 'agent' && !(await deps.workspace.probeAgent(baseUrl, workspace.publicIp))) {
        return wait(deps, workspace, 'waiting for the agent gateway to answer over HTTPS', agentReadinessAttempts(deps));
      }
      const link = await deps.workspace.issueSetupLink({
        baseUrl,
        ip: workspace.publicIp,
        bootstrapCredential: openSecret(workspace.bootstrapCredentialRef, deps.sealingKey),
        // The registry primary key: stable across retries and restarts, so a
        // repeated issuance returns the same link rather than a second one.
        idempotencyKey: id,
      });
      await moveTo(deps.db, id, 'setup_link', { setupLink: link }, deps.owner);
      return 'advanced';
    }

    case 'setup_link': {
      await moveTo(deps.db, id, 'running', { lifecycleState: 'running' }, deps.owner);
      // The launch secrets have done their job; only the bootstrap credential
      // outlives provisioning, because the management lane must present it.
      await clearProvisioningSecrets(deps.db, id);
      return 'advanced';
    }

    default: {
      // Terminal, or a step this reconciler does not own. Do not hold the lease.
      await releaseLease(deps.db, id);
      return 'idle';
    }
  }
}

/**
 * The sealed blob the launch consumes: the locally minted secrets plus the one
 * secret that came from outside. It is cleared once the workspace is running —
 * only the key's handle outlives provisioning, in `embedding_token_ref`.
 */
interface LaunchSecrets extends WorkspaceSecrets {
  openrouterKey: string;
}

async function loadSecrets(deps: ProvisioningDeps, workspaceId: string): Promise<LaunchSecrets> {
  const sealed = await readProvisioningSecrets(deps.db, workspaceId);
  if (!sealed) throw new ProvisioningError('the launch secrets for this workspace are missing');
  return JSON.parse(openSecret(sealed, deps.sealingKey)) as LaunchSecrets;
}

/**
 * A step that is not ready yet: count it, release, and let the next tick retry.
 *
 * The give-up decision happens before the release, so a step that has run out of
 * attempts throws while this reconciler still holds the lease. Releasing first
 * would let another reconciler claim the row and start probing a workspace that
 * `abort` is concurrently tearing down.
 */
async function wait(
  deps: ProvisioningDeps,
  workspace: WorkspaceRecord,
  reason: string,
  /** Overrides the step budget for one slow-by-design operation; see `agentReadinessAttempts`. */
  attemptAllowance?: number,
): Promise<TickOutcome> {
  const attempts = workspace.stepAttempts + 1;
  const maxAttempts = attemptAllowance ?? deps.maxStepAttempts ?? 60;
  if (attempts >= maxAttempts) throw new ProvisioningError(`gave up ${reason} after ${attempts} attempts`);
  deps.log?.(`[control-plane] workspace ${workspace.workspaceId}: ${reason} (attempt ${attempts}/${maxAttempts})`);
  await recordStepAttempt(deps.db, workspace.workspaceId, deps.owner);
  return 'waiting';
}

/**
 * The attempt allowance for the agent gateway gate (#57).
 *
 * The step budget is sized for one operation, and the agent's is unusually long:
 * the clock starts when gbrain-web answers `/health`, which is *before* the agent
 * finalizer has run six `openclaw config set` calls, started the unit, and given
 * the gateway its own 60s to answer. At the production default (20 attempts, 5s
 * apart) the step budget is only ~100s, and exhausting it does not stall the row
 * — `abort` destroys the instance. Four times that is ~6-7 minutes of headroom,
 * comfortably past the finalizer's own limit while still bounded.
 */
const agentReadinessAttempts = (deps: ProvisioningDeps): number => 4 * (deps.maxStepAttempts ?? 60);

/**
 * Release everything this provision created, newest first, then mark the row
 * failed. Cleanup is idempotent, and a step of it that fails is recorded as
 * residue rather than dropped — an orphan the operator does not know about is
 * worse than a failed row that names it.
 */
async function abort(deps: ProvisioningDeps, workspace: WorkspaceRecord, error: unknown): Promise<'failed'> {
  // Re-read: the row may have advanced since it was claimed, and cleanup must
  // release what actually exists rather than what existed at claim time.
  const current = (await findWorkspaceById(deps.db, workspace.workspaceId)) ?? workspace;
  const residue: string[] = [];

  if (current.dnsRecordId) {
    try {
      await deps.dns.deleteRecord(current.dnsRecordId);
    } catch {
      residue.push('DNS record');
    }
  }
  if (current.ociInstanceOcid) {
    try {
      await deps.compute.terminateInstance(current.ociInstanceOcid);
    } catch {
      residue.push('compute instance');
    }
  }
  try {
    await revokeWorkspaceEmbeddingKey(deps.embeddingKeys, workspace.workspaceId, current.embeddingTokenRef);
  } catch {
    residue.push('OpenRouter embedding key');
  }
  // The launch secrets are released unconditionally: no launch will consume them
  // now. The bootstrap credential goes with them once cleanup actually finished —
  // it grants access to a machine that no longer exists. It is kept only when an
  // instance survived, because an operator still needs a way in to finish the
  // teardown by hand.
  await clearProvisioningSecrets(deps.db, workspace.workspaceId, { keepBootstrapCredential: residue.length > 0 });

  const summary = safeSummary(error);
  const recorded = residue.length > 0 ? `${summary} (manual cleanup still required: ${residue.join(', ')})` : summary;
  deps.log?.(`[control-plane] workspace ${workspace.workspaceId}: provisioning failed — ${recorded}`);
  await failWorkspace(deps.db, workspace.workspaceId, recorded);
  return 'failed';
}

/**
 * Delete: release everything this workspace holds, then mark the row deleted.
 *
 * Credentials are revoked first and unconditionally. They are the one piece of
 * teardown that cannot fail, and the user has already been told the workspace is
 * gone — a live bootstrap credential outliving that promise because Cloudflare
 * was down is not a trade worth making.
 *
 * The instance is looked up by display name when no OCID was ever recorded, which
 * is the shape of a delete arriving at a provision whose launch succeeded but
 * whose acknowledgement was lost. Without the lookup that VM is invisible to the
 * registry and runs forever.
 */
async function teardown(deps: ProvisioningDeps, workspace: WorkspaceRecord): Promise<TickOutcome> {
  const id = workspace.workspaceId;
  // Re-read: a provisioning tick may have persisted another handle between the
  // delete request and this one, and teardown must release what exists now.
  const current = (await findWorkspaceById(deps.db, id)) ?? workspace;
  await purgeWorkspaceSecrets(deps.db, id);

  const residue: string[] = [];
  if (current.dnsRecordId) {
    try {
      await deps.dns.deleteRecord(current.dnsRecordId);
    } catch {
      residue.push('DNS record');
    }
  }
  try {
    const ocid = current.ociInstanceOcid ?? (await deps.compute.findInstanceByName(instanceDisplayName(id)))?.ocid;
    if (ocid) await deps.compute.terminateInstance(ocid);
  } catch {
    residue.push('compute instance');
  }

  if (residue.length === 0) {
    await settleLifecycleState(deps.db, id, 'deleted', { error: null }, deps.owner);
    return 'advanced';
  }

  // Cleanup is idempotent, so a failed pass is simply retried. The retries are
  // bounded: a resource that cannot be released after the budget is spent is
  // named on the deleted row instead, because an orphan the operator does not
  // know about is worse than a deleted row that tells them where to look.
  if (!(await spendAttempt(deps, workspace))) return 'waiting';
  await settleLifecycleState(
    deps.db,
    id,
    'deleted',
    { error: `manual cleanup still required: ${residue.join(', ')}` },
    deps.owner,
  );
  return 'advanced';
}

/**
 * Suspend: stop the instance and leave everything else standing.
 *
 * The DNS record stays, so the subdomain resolves to a machine that answers
 * nothing — dark, not reassigned. The boot volume, and with it every Source,
 * member and grant, is untouched, which is what makes this the lever short of
 * deletion.
 */
async function suspend(deps: ProvisioningDeps, workspace: WorkspaceRecord): Promise<TickOutcome> {
  // A workspace that never got as far as an instance is already dark. Recording
  // it as suspended is honest, and refusing would strand the row mid-action.
  if (workspace.ociInstanceOcid) await deps.compute.stopInstance(workspace.ociInstanceOcid);
  await settleLifecycleState(deps.db, workspace.workspaceId, 'suspended', { error: null }, deps.owner);
  return 'advanced';
}

/**
 * Resume: start the instance and wait for it to serve again before saying so.
 *
 * The health probe is the point. A row that flips to `running` the moment OCI
 * accepts the start call tells the owner their workspace is back while it is
 * still booting Postgres, and the first thing they do is reload and see nothing.
 */
async function resume(deps: ProvisioningDeps, workspace: WorkspaceRecord): Promise<TickOutcome> {
  const id = workspace.workspaceId;
  if (!workspace.ociInstanceOcid) throw new ProvisioningError('no instance is recorded for this workspace');

  const instance = await deps.compute.getInstance(workspace.ociInstanceOcid);
  // Nothing to start. Retrying cannot help, so fail the action immediately
  // rather than burning the whole attempt budget on a machine that is gone.
  if (!instance || instance.state === 'terminated') {
    await settleLifecycleState(
      deps.db,
      id,
      'suspended',
      { error: 'the instance for this workspace no longer exists; it cannot be resumed' },
      deps.owner,
    );
    return 'failed';
  }

  if (instance.state !== 'running') {
    await deps.compute.startInstance(workspace.ociInstanceOcid);
    return wait(deps, workspace, 'waiting for the instance to start');
  }

  // OCI keeps an ephemeral public address across stop/start, so this is normally
  // a no-op. It is checked anyway: a resume that silently left DNS pointing at
  // someone else's address is the one failure here that is worse than not
  // resuming at all.
  if (instance.publicIp && instance.publicIp !== workspace.publicIp) {
    const record = await deps.dns.upsertRecord(workspace.subdomain, instance.publicIp);
    await recordWorkspaceAddress(deps.db, id, { dnsRecordId: record.id, publicIp: instance.publicIp }, deps.owner);
    // Real progress, so this is an advance rather than a wait: the next tick
    // re-reads the row and probes the address just published.
    return 'advanced';
  }

  if (!workspace.publicIp) throw new ProvisioningError('no address is recorded for this workspace');
  const healthy = await deps.workspace.probeHealth(`https://${workspace.subdomain}`, workspace.publicIp);
  if (!healthy) return wait(deps, workspace, 'waiting for the workspace to answer over HTTPS again');
  // Resume is the likelier place for the agent to miss its comeback: its state,
  // browser profile, and schedules all have to restore. Same promise as the
  // provision (#57), so the same gate — running must not mean "the gateway this
  // workspace advertises is down".
  if (workspace.tier === 'agent' && !(await deps.workspace.probeAgent(`https://${workspace.subdomain}`, workspace.publicIp))) {
    return wait(deps, workspace, 'waiting for the agent gateway to answer again', agentReadinessAttempts(deps));
  }

  await settleLifecycleState(deps.db, id, 'running', { error: null }, deps.owner);
  return 'advanced';
}

/**
 * Drive ticks until there is nothing left to do. Production runs this on an
 * interval; tests call it directly so a provision advances deterministically
 * instead of on a timer.
 */
export async function drainProvisioning(deps: ProvisioningDeps, maxTicks = 100): Promise<TickOutcome[]> {
  const outcomes: TickOutcome[] = [];
  for (let tick = 0; tick < maxTicks; tick += 1) {
    const outcome = await runProvisioningTick(deps);
    outcomes.push(outcome);
    if (outcome === 'idle') break;
  }
  return outcomes;
}
