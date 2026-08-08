/**
 * Composition root: env-configured real adapters, real Postgres, listen, and
 * run the provisioning reconciler on an interval.
 *
 * Required env:
 *   CP_DATABASE_URL          Postgres connection string (the control plane's own DB)
 *   CP_GITHUB_CLIENT_ID      GitHub OAuth app client id
 *   CP_GITHUB_CLIENT_SECRET  GitHub OAuth app client secret
 *   CP_BASE_URL              Public origin, e.g. https://cloud.yourapp.example
 *   CP_SECRET_KEY            base64 32-byte key sealing the per-workspace
 *                            bootstrap credentials in the registry
 *   CP_WORKSPACE_DOMAIN      Zone workspace subdomains are minted under
 *   CP_CLOUDFLARE_API_TOKEN  Token scoped to Zone:DNS:Edit on that zone alone
 *   CP_CLOUDFLARE_ZONE_ID    The zone's id
 *   CP_EMAIL_RESEND_API_KEY  Resend key injected into each workspace VM
 *   CP_EMAIL_FROM            Sender identity injected into each workspace VM
 *   CP_OPENROUTER_PROVISIONING_KEY
 *                            OpenRouter *provisioning* key. Mints and revokes the
 *                            per-workspace embedding keys and never leaves this
 *                            process; no VM ever carries it
 *   OCI_REGION, OCI_TENANCY_OCID, OCI_USER_OCID, OCI_KEY_FINGERPRINT,
 *   OCI_PRIVATE_KEY_PATH, OCI_COMPARTMENT_OCID, OCI_AVAILABILITY_DOMAIN,
 *   OCI_SUBNET_OCID, OCI_WORKSPACE_NSG_OCID, OCI_WORKSPACE_IMAGE_OCID
 *
 * Required by src/backup.ts, not by this file. The deploy installs both
 * entrypoints from one env file, so this block is the list for both; grepping
 * for these two here is meant to come up empty:
 *   CP_BACKUP_BUCKET         Private Object Storage bucket the nightly registry
 *                            dump is sealed into; retention is that bucket's own
 *                            lifecycle rule, never code
 *   CP_BACKUP_NAMESPACE      Object Storage namespace (tenancy-specific)
 * backup.ts also reads CP_DATABASE_URL, CP_SECRET_KEY, and the OCI_* set above.
 *
 * Optional env:
 *   CP_OPERATOR_GITHUB_IDS   Comma-separated immutable GitHub ids eligible to
 *                            claim the one-time operator bootstrap
 *   CP_PORT                  Listen port (default 8080)
 *   CP_COOKIE_SECURE         Set to "false" only for plain-HTTP local runs
 *   CP_FLEET_CAP             Upper bound on live workspaces (default 20)
 *   CP_OPENROUTER_KEY_LIMIT_USD
 *                            Per-workspace embedding spend cap, whole USD (default 5)
 *   CP_RECONCILE_INTERVAL_MS Reconciler tick interval (default 5000)
 *   CP_MAX_STEP_ATTEMPTS     "Not yet" ticks a provisioning step may take before
 *                            the provision gives up (default 20; raise it if
 *                            first boots — image pull, cloud-init, ACME — start
 *                            outrunning the window)
 *   OCI_INSTANCE_SHAPE       Workspace shape (default VM.Standard.A2.Flex)
 *   OCI_INSTANCE_OCPUS       Workspace OCPUs (default 1)
 *   OCI_INSTANCE_MEMORY_GB   Workspace memory in GB (default 4)
 *   OCI_INSTANCE_BOOT_VOLUME_GB
 *                            Workspace boot volume in GB (default 50)
 *
 * cloud/deploy/bin/gbrain-cp-verify-env enumerates these names and refuses an env
 * file carrying one it does not know, so a variable added to this block must be
 * added to that validator too, or the next deploy exits 2 on a stray key.
 */
import { hostname } from 'node:os';
import { readFileSync } from 'node:fs';
import { createControlPlaneApp } from './app.ts';
import { migrateControlPlaneSchema } from './db.ts';
import { createPostgresExecutor } from './db-postgres.ts';
import { HttpGitHubOAuth } from './adapters/github.ts';
import { OciCompute, parseOciCapacityOverride, parseOciShapeOverride } from './adapters/compute.ts';
import { CloudflareDns } from './adapters/dns.ts';
import { HttpOpenRouterKeys, parseEmbeddingKeyLimitUsd } from './adapters/openrouter.ts';
import { HttpWorkspace } from './adapters/workspace.ts';
import { parseSealingKey } from './secrets.ts';
import { createReconciler } from './reconciler.ts';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[control-plane] missing required env: ${name}`);
    process.exit(1);
  }
  return value;
}

const databaseUrl = requireEnv('CP_DATABASE_URL');
const baseUrl = requireEnv('CP_BASE_URL').replace(/\/$/, '');
const workspaceDomain = requireEnv('CP_WORKSPACE_DOMAIN');

let sealingKey: Buffer;
try {
  sealingKey = parseSealingKey(requireEnv('CP_SECRET_KEY'));
} catch (error) {
  // Booting with a weak or malformed key would silently seal nothing.
  console.error(`[control-plane] CP_SECRET_KEY is unusable: ${(error as Error).message}`);
  process.exit(1);
}

const github = new HttpGitHubOAuth({
  clientId: requireEnv('CP_GITHUB_CLIENT_ID'),
  clientSecret: requireEnv('CP_GITHUB_CLIENT_SECRET'),
  redirectUri: `${baseUrl}/auth/github/callback`,
});

const compute = new OciCompute({
  credentials: {
    tenancyOcid: requireEnv('OCI_TENANCY_OCID'),
    userOcid: requireEnv('OCI_USER_OCID'),
    fingerprint: requireEnv('OCI_KEY_FINGERPRINT'),
    privateKeyPem: readFileSync(requireEnv('OCI_PRIVATE_KEY_PATH'), 'utf8'),
  },
  region: requireEnv('OCI_REGION'),
  compartmentOcid: requireEnv('OCI_COMPARTMENT_OCID'),
  availabilityDomain: requireEnv('OCI_AVAILABILITY_DOMAIN'),
  subnetOcid: requireEnv('OCI_SUBNET_OCID'),
  nsgOcid: requireEnv('OCI_WORKSPACE_NSG_OCID'),
  imageOcid: requireEnv('OCI_WORKSPACE_IMAGE_OCID'),
  shape: parseOciShapeOverride(process.env.OCI_INSTANCE_SHAPE),
  ocpus: parseOciCapacityOverride('OCI_INSTANCE_OCPUS', process.env.OCI_INSTANCE_OCPUS),
  memoryInGbs: parseOciCapacityOverride('OCI_INSTANCE_MEMORY_GB', process.env.OCI_INSTANCE_MEMORY_GB),
  bootVolumeSizeInGbs: parseOciCapacityOverride('OCI_INSTANCE_BOOT_VOLUME_GB', process.env.OCI_INSTANCE_BOOT_VOLUME_GB),
});

const dns = new CloudflareDns({
  apiToken: requireEnv('CP_CLOUDFLARE_API_TOKEN'),
  zoneId: requireEnv('CP_CLOUDFLARE_ZONE_ID'),
});

// The provisioning key stays here. What reaches a VM is a per-workspace key
// minted from it, capped by CP_OPENROUTER_KEY_LIMIT_USD.
let embeddingKeyLimitUsd: number;
try {
  // A zero, empty or malformed cap would mint keys with no spend limit at all,
  // which is the one property that bounds the blast radius of a key read off a
  // VM. Same parse the smoke run uses, so neither can drift from the deploy's
  // env validator.
  embeddingKeyLimitUsd = parseEmbeddingKeyLimitUsd(process.env.CP_OPENROUTER_KEY_LIMIT_USD);
} catch (error) {
  console.error(`[control-plane] CP_OPENROUTER_KEY_LIMIT_USD is unusable: ${(error as Error).message}`);
  process.exit(1);
}
const embeddingKeys = new HttpOpenRouterKeys({
  provisioningKey: requireEnv('CP_OPENROUTER_PROVISIONING_KEY'),
  limitUsd: embeddingKeyLimitUsd,
});

const db = createPostgresExecutor(databaseUrl);
await migrateControlPlaneSchema(db);

const operatorGithubIds = (process.env.CP_OPERATOR_GITHUB_IDS ?? '')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(id => Number.isSafeInteger(id) && id > 0);

const app = createControlPlaneApp({
  db,
  github,
  operatorGithubIds,
  secureCookies: process.env.CP_COOKIE_SECURE !== 'false',
  workspaceDomain,
  fleetCap: Number(process.env.CP_FLEET_CAP ?? 20),
  embeddingKeys,
});

const provisioningDeps = {
  db,
  compute,
  dns,
  embeddingKeys,
  workspace: new HttpWorkspace(),
  sealingKey,
  resendApiKey: requireEnv('CP_EMAIL_RESEND_API_KEY'),
  emailFrom: requireEnv('CP_EMAIL_FROM'),
  owner: `${hostname()}:${process.pid}`,
  // 20 "not yet" ticks × 5s ≈ 100s of health window. The last validated boot
  // answered in ~3 probes; if first boots (image pull, cloud-init, ACME) start
  // outrunning this, raise CP_MAX_STEP_ATTEMPTS rather than letting healthy
  // workspaces roll back (#48).
  maxStepAttempts: Number(process.env.CP_MAX_STEP_ATTEMPTS ?? 20),
  // Step transitions, waits, and failures land in the journal: a provision that
  // stops moving must leave a last line saying where it stood (#48).
  log: (line: string) => console.log(line),
};

const port = Number(process.env.CP_PORT ?? 8080);
// Localhost only, by construction rather than by NSG rule: Caddy terminates TLS
// and proxies here, so a directly reachable port would serve plain HTTP carrying
// real sessions. Hardcoded because the pilot is one VM with no containers, and a
// bind-address env var is one more thing that silently fails open when set wrong.
app.listen(port, '127.0.0.1', () => {
  console.log(`[control-plane] listening on 127.0.0.1:${port} (${baseUrl})`);
});

// One tick advances at most one workspace by one step. Ticks are serialised so a
// slow adapter call cannot overlap itself; the lease makes a second process safe
// regardless. The reconciler's watchdog (#48) bounds each tick in wall-clock
// time, so an adapter promise that never settles costs one tick, never the loop.
const intervalMs = Number(process.env.CP_RECONCILE_INTERVAL_MS ?? 5000);
createReconciler(provisioningDeps).start(intervalMs);
