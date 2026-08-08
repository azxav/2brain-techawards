/**
 * Real-cloud provisioning smoke run: provision -> health -> setup -> delete.
 *
 * Manual, per image release. This is the only place #40's code meets the real
 * OCI and Cloudflare APIs; the unit suites bind fakes behind the same
 * interfaces, so nothing here is covered by `bun test`.
 *
 * The registry is a throwaway in-memory PGlite: real cloud effects, disposable
 * state. That keeps the run off the production control plane's database while
 * still exercising the real reconciler and the real adapters.
 *
 * Teardown runs from a `finally`, so a failure anywhere still releases the VM
 * and the DNS record. A run that cannot tear down says so and exits non-zero.
 *
 *   bun run image/smoke-provision.ts
 *
 * Env: everything src/index.ts needs, minus the GitHub OAuth and web bits.
 * Credentials are read from the environment and never printed.
 */
import { PGlite } from '@electric-sql/pglite';
import { migrateControlPlaneSchema, type SqlExecutor } from '../src/db.ts';
import { OciCompute, parseOciCapacityOverride, parseOciShapeOverride } from '../src/adapters/compute.ts';
import { CloudflareDns } from '../src/adapters/dns.ts';
import { HttpWorkspace } from '../src/adapters/workspace.ts';
import { HttpOpenRouterKeys, parseEmbeddingKeyLimitUsd } from '../src/adapters/openrouter.ts';
import { parseSealingKey, openSecret, randomSealingKey } from '../src/secrets.ts';
import { drainProvisioning, revokeWorkspaceEmbeddingKey, type ProvisioningDeps } from '../src/provisioning.ts';
import { createUser, createWorkspaceRecord, findWorkspaceById } from '../src/store.ts';
import { latestBuiltImageOcid, resolveOci } from './oci-config.ts';

/**
 * Accept the first name that is set. The existing verification env predates this
 * script and uses its own spellings; making the script bend avoids a mismatch
 * that would surface as a confusing mid-run failure rather than a clear one.
 */
function requireEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  console.error(`[smoke] missing required env: ${names.join(' or ')}`);
  process.exit(2);
}

function pgliteExecutor(pg: PGlite): SqlExecutor {
  type Queryable = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  const wrap = (q: Queryable, canStartTransaction: boolean): SqlExecutor => {
    const executor: SqlExecutor = {
      async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
        return (await q.query(text, params)).rows as T[];
      },
      async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
        if (!canStartTransaction) return fn(executor);
        return pg.transaction(async tx => fn(wrap(tx, false)));
      },
    };
    return executor;
  };
  return wrap(pg, true);
}

const workspaceDomain = requireEnv('CP_WORKSPACE_DOMAIN', 'WORKSPACE_DOMAIN');
const administratorEmail = requireEnv('SMOKE_ADMINISTRATOR_EMAIL', 'FIRST_ADMIN_EMAIL');
const label = `smoke-${Date.now().toString(36)}`;
const subdomain = `${label}.${workspaceDomain}`;

const sealingKey = parseSealingKey(process.env.CP_SECRET_KEY ?? randomSealingKey());
const pg = new PGlite();
const db = pgliteExecutor(pg);
await migrateControlPlaneSchema(db);

const oci = resolveOci();
const imageOcid = latestBuiltImageOcid();
if (!imageOcid) {
  console.error('[smoke] no workspace image: set OCI_WORKSPACE_IMAGE_OCID or build one first');
  process.exit(2);
}

const deps: ProvisioningDeps = {
  db,
  compute: new OciCompute({
    credentials: oci.credentials,
    region: oci.region,
    compartmentOcid: oci.compartmentOcid,
    availabilityDomain: requireEnv('OCI_AVAILABILITY_DOMAIN'),
    subnetOcid: requireEnv('OCI_SUBNET_OCID'),
    nsgOcid: requireEnv('OCI_WORKSPACE_NSG_OCID'),
    imageOcid,
    // The shape a workspace runs on, not the one Packer built the image on.
    shape: parseOciShapeOverride(process.env.OCI_INSTANCE_SHAPE),
    ocpus: parseOciCapacityOverride('OCI_INSTANCE_OCPUS', process.env.OCI_INSTANCE_OCPUS),
    memoryInGbs: parseOciCapacityOverride('OCI_INSTANCE_MEMORY_GB', process.env.OCI_INSTANCE_MEMORY_GB),
    bootVolumeSizeInGbs: parseOciCapacityOverride('OCI_INSTANCE_BOOT_VOLUME_GB', process.env.OCI_INSTANCE_BOOT_VOLUME_GB),
  }),
  dns: new CloudflareDns({
    apiToken: requireEnv('CP_CLOUDFLARE_API_TOKEN'),
    zoneId: requireEnv('CP_CLOUDFLARE_ZONE_ID'),
  }),
  workspace: new HttpWorkspace({ timeoutMs: 15_000 }),
  // A real key against the platform's real OpenRouter account: minting and
  // revoking it is exactly what no fake can prove, and a smoke run that skipped
  // it would leave the VM's embedding path untested on every image release.
  embeddingKeys: new HttpOpenRouterKeys({
    provisioningKey: requireEnv('CP_OPENROUTER_PROVISIONING_KEY'),
    // Parsed, not coerced: this run mints a real key against the platform's real
    // account, and `Number('')` would send OpenRouter a NaN limit — no cap at all.
    limitUsd: parseEmbeddingKeyLimitUsd(process.env.CP_OPENROUTER_KEY_LIMIT_USD),
  }),
  sealingKey,
  resendApiKey: requireEnv('CP_EMAIL_RESEND_API_KEY', 'GBRAIN_EMAIL_RESEND_API_KEY'),
  emailFrom: requireEnv('CP_EMAIL_FROM', 'GBRAIN_EMAIL_FROM'),
  owner: 'smoke-run',
  // Matches the production default; the waiting loop sleeps 10s per attempt, so
  // this is ≈200s of first-boot window here.
  maxStepAttempts: 20,
  // The same narration the service writes to its journal (#48), so a smoke run
  // shows every transition and wait the way production does.
  log: line => console.log(line),
};

const owner = await createUser(db, { githubId: 1, login: 'smoke-operator', name: null, avatarUrl: null }, { isOperator: true });
const workspace = await createWorkspaceRecord(db, { ownerUserId: owner.userId, name: `Smoke ${label}`, subdomain });

/** The whole run, end to end. A first boot is minutes; this is not a tight bound. */
const RUN_DEADLINE_MS = Number(process.env.SMOKE_DEADLINE_MS ?? 30 * 60_000);
/**
 * One reconciler tick. Every adapter now bounds its own calls, so a tick that
 * outlives this is something the adapters do not know about — a wedged engine, a
 * future unbounded call. The run says which step it died on and tears down,
 * rather than pinning a CPU in silence while a billed VM keeps running.
 */
const ROUND_DEADLINE_MS = Number(process.env.SMOKE_ROUND_DEADLINE_MS ?? 3 * 60_000);
const startedAt = Date.now();

/** Read before the tick, so a tick that never returns is still named. */
async function currentStep(): Promise<string> {
  return (await findWorkspaceById(db, workspace.workspaceId))?.provisioningStep ?? 'unknown';
}

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} made no progress for ${ms}ms`)), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer)) as Promise<T>;
}

let failed = false;
let tornDown = false;

/**
 * Release everything this run created. Idempotent and bounded: it runs from the
 * `finally`, and also from SIGINT/SIGTERM, because the failure mode that costs
 * real money is an operator killing a run that has stopped making progress. A
 * `finally` does not run for a signal, so before this the kill that ended a
 * wedged run was exactly the path that orphaned the VM and the DNS record.
 */
async function teardown(): Promise<void> {
  if (tornDown) return;
  tornDown = true;
  const current = (await findWorkspaceById(db, workspace.workspaceId)) ?? workspace;
  const residue: string[] = [];
  if (current.dnsRecordId) {
    try {
      await withDeadline(deps.dns.deleteRecord(current.dnsRecordId), 60_000, 'releasing the DNS record');
      console.log('[smoke] DNS record released');
    } catch (error) {
      residue.push(`DNS record ${current.dnsRecordId}: ${(error as Error).message}`);
    }
  }
  if (current.ociInstanceOcid) {
    try {
      await withDeadline(deps.compute.terminateInstance(current.ociInstanceOcid), 60_000, 'terminating the instance');
      console.log('[smoke] instance terminated');
    } catch (error) {
      residue.push(`instance ${current.ociInstanceOcid}: ${(error as Error).message}`);
    }
  }
  // A live provisioned key outlasting the VM it was minted for is a credential
  // nobody is watching and a bill nobody expects.
  try {
    await withDeadline(
      revokeWorkspaceEmbeddingKey(deps.embeddingKeys, current.workspaceId, current.embeddingTokenRef),
      60_000,
      'revoking the embedding key',
    );
    console.log('[smoke] embedding key revoked');
  } catch (error) {
    residue.push(`OpenRouter key for ${current.workspaceId}: ${(error as Error).message}`);
  }
  await pg.close();
  if (residue.length > 0) {
    console.error('[smoke] MANUAL CLEANUP REQUIRED:');
    for (const item of residue) console.error(`  - ${item}`);
    failed = true;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.error(`\n[smoke] ${signal} received — releasing the VM and the DNS record before exiting.`);
    void teardown()
      .catch(error => console.error('[smoke] teardown itself failed:', (error as Error).message))
      .finally(() => process.exit(130));
  });
}

try {
  console.log(`[smoke] provisioning ${subdomain}`);
  for (let round = 0; round < 200; round += 1) {
    if (Date.now() - startedAt > RUN_DEADLINE_MS) {
      const stuck = await findWorkspaceById(db, workspace.workspaceId);
      throw new Error(`the run exceeded ${RUN_DEADLINE_MS}ms at step '${stuck?.provisioningStep}' (attempt ${stuck?.stepAttempts})`);
    }
    const outcomes = await withDeadline(drainProvisioning(deps, 1), ROUND_DEADLINE_MS, `the '${await currentStep()}' step`);
    const current = await findWorkspaceById(db, workspace.workspaceId);
    if (current?.lifecycleState === 'running') break;
    if (current?.lifecycleState === 'failed') throw new Error(`provisioning failed: ${current.provisioningError}`);
    // Sleep on anything that is not forward progress. 'idle' means the row was
    // not claimable this tick (a lease still live); spinning on it burns a core
    // and exhausts the round budget in milliseconds without waiting for the
    // thing that would actually clear it.
    if (outcomes[0] !== 'advanced') {
      console.log(`[smoke] ${current?.provisioningStep} (attempt ${current?.stepAttempts}, ${outcomes[0]})`);
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
  }

  const provisioned = await findWorkspaceById(db, workspace.workspaceId);
  if (provisioned?.lifecycleState !== 'running') throw new Error(`workspace never reached running (last step: ${provisioned?.provisioningStep})`);
  if (!provisioned.setupLink) throw new Error('workspace is running but no setup link was recorded');
  console.log('[smoke] running; setup link issued');

  // The link is single-use, so fetch it rather than complete it, then complete
  // setup through the API the way the setup page does.
  const linkPage = await fetch(provisioned.setupLink);
  if (!linkPage.ok) throw new Error(`the setup link was not accepted: ${linkPage.status}`);

  const credential = openSecret(provisioned.bootstrapCredentialRef!, sealingKey);
  const token = provisioned.setupLink.split('/setup/')[1];
  const setup = await fetch(`https://${subdomain}/api/workspace/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${subdomain}` },
    body: JSON.stringify({ token, workspace_name: `Smoke ${label}`, administrator_email: administratorEmail }),
  });
  if (setup.status !== 202) throw new Error(`setup was not accepted: ${setup.status}`);
  const accepted = (await setup.json()) as { data?: { state?: string }; request_id?: string };
  console.log('[smoke] setup accepted (202)');

  // 202 does not mean an email went out. A workspace with no deliverer wired
  // answers 202 with state 'delivery_queued' and sends nothing, so asserting the
  // status alone would pass on a VM whose email env cloud-init never set — the
  // exact misconfiguration this run exists to catch. Only
  // 'email_confirmation_required' means deliverConfirmation ran and Resend
  // returned ok.
  if (accepted.data?.state !== 'email_confirmation_required') {
    throw new Error(
      `setup returned state '${accepted.data?.state}' rather than 'email_confirmation_required': `
      + 'the workspace accepted setup but delivered no email. The usual cause is cloud-init not setting '
      + 'GBRAIN_EMAIL_RESEND_API_KEY and GBRAIN_EMAIL_FROM on the VM.',
    );
  }

  // Independent confirmation through a different code path: the operator outbox
  // records what delivery actually did. 'sent' means Resend's API accepted the
  // send. Nothing here proves the mail reached the mailbox — no bounce/delivered
  // webhook is consumed anywhere — so this is deliberately not called delivered.
  const outbox = await fetch(`https://${subdomain}/api/workspace/v1/operator/outbox?request_id=${encodeURIComponent(accepted.request_id ?? '')}`, {
    headers: { authorization: `Bootstrap ${credential}` },
  });
  if (!outbox.ok) throw new Error(`the operator outbox refused the bootstrap credential: ${outbox.status}`);
  const rows = ((await outbox.json()) as { data?: Array<{ delivery_state: string }> }).data ?? [];
  if (rows.length === 0) throw new Error('setup reported a delivery but the outbox recorded none');
  if (rows[0]!.delivery_state !== 'sent') throw new Error(`the outbox records delivery_state '${rows[0]!.delivery_state}', not 'sent'`);
  console.log(`[smoke] Resend accepted the send to ${administratorEmail} (outbox: sent; mailbox arrival not asserted)`);

  // Idempotency is the property #40 turns on: the same key must return the same
  // link. Re-issue against the live workspace and compare.
  // Dial the recorded address, as the reconciler's own issuance did. Omitting it
  // does not fail to compile — image/ was outside the typecheck's include — it
  // dials node:https's default host instead, so the comparison below would have
  // been against whatever answers on localhost:443.
  if (!provisioned.publicIp) throw new Error('the workspace is running but no address was recorded');
  const reissued = await deps.workspace.issueSetupLink({
    baseUrl: `https://${subdomain}`,
    ip: provisioned.publicIp,
    bootstrapCredential: credential,
    idempotencyKey: workspace.workspaceId,
  });
  if (reissued !== provisioned.setupLink) {
    // Almost always the image, not the control plane. The workspace only honours
    // idempotency_key from the commit that added it; an image baked before that
    // ignores the key and mints a fresh random token per call, which is exactly
    // what this comparison sees. Say so, because "returned a different link"
    // reads like a control-plane bug and sends the reader to the wrong file.
    throw new Error(
      'a repeated setup-link request returned a different link. '
      + 'The usual cause is a baked image older than the workspace change that honours idempotency_key: '
      + 'check the image\'s gbrain_git_sha in image/.artifacts/packer-manifest.json and rebuild from a commit that contains it.',
    );
  }

  // The control the match above needs: a workspace that ignored the key entirely
  // and returned one fixed token per purpose would satisfy it too. Only a
  // different key producing a different link proves the key is actually read.
  const control = await deps.workspace.issueSetupLink({
    baseUrl: `https://${subdomain}`,
    ip: provisioned.publicIp,
    bootstrapCredential: credential,
    idempotencyKey: `${workspace.workspaceId}-control`,
  });
  if (control === provisioned.setupLink) {
    throw new Error('a different idempotency key returned the same link: the workspace is ignoring the key, so the match above proves nothing');
  }
  console.log('[smoke] setup-link issuance is idempotent against the real workspace (and a different key differs)');

  // The one link in the chain nothing here can observe. 'sent' is Resend's API
  // accepting the send; arrival depends on the domain's DNS records, the sender
  // reputation and the receiving mailbox, none of which report back without a
  // webhook consumer this repo does not have. Per-release manual check, named as
  // an action rather than left as a caveat.
  console.log('');
  console.log(`MANUAL (per image release): confirm the email actually reached ${administratorEmail}.`);
  console.log('Everything above proves Resend accepted it; arrival itself is not observable from here.');
  console.log('');
  console.log('MANUAL (per image release): finish setup, add a Source, and run a search on the workspace.');
  console.log('The provisioned embedding key is injected and capped, but only a real search proves the VM can');
  console.log('reach OpenRouter and embed with it — no request from here exercises that path.');
} catch (error) {
  failed = true;
  console.error('[smoke] FAILED:', (error as Error).message);
} finally {
  await teardown();
  process.exit(failed ? 1 : 0);
}
