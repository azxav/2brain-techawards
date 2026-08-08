/**
 * Render the workspace VM launch contract.
 *
 * The shape and the required keys are owned by the image, not by this file:
 * REQUIRED_CLOUD_INIT_KEYS is imported from the image's own contract verifier so
 * that adding a key there fails this renderer's test rather than silently
 * shipping a VM that refuses to finish booting.
 */
import { randomBytes } from 'node:crypto';
import { REQUIRED_CLOUD_INIT_KEYS } from '../image/verify-contract.ts';

export interface WorkspaceSecrets {
  tokenSecret: string;
  bootstrapCredential: string;
  postgresPassword: string;
}

export interface CloudInitInput {
  name: string;
  subdomain: string;
  secrets: WorkspaceSecrets;
  resendApiKey: string;
  emailFrom: string;
  /**
   * This workspace's own OpenRouter provisioned key, minted by the provisioning
   * machine before the launch that consumes it. Never a fleet-wide key: see
   * adapters/openrouter.ts.
   */
  openrouterKey: string;
  /**
   * Deployment tier (#57). Optional and defaulting to brain so every caller
   * that predates tiers renders the exact bytes it always did. Agent tier
   * appends one runcmd entry: the Brain-tier finalizer runs first and
   * unchanged — every #56 inert-agent proof still holds at that instant —
   * then gbrain-agent-finalize flips the agent on.
   */
  tier?: 'brain' | 'agent';
}

/**
 * The agent ingress literals now live in `agent-ingress-contract.ts` — most of
 * them exist only so a test can pin the standalone finalizer bash, which is the
 * wrong thing to keep in the module that renders launch bytes. Re-exported here
 * so existing importers keep working; new code should import from that module.
 */
export {
  AGENT_BASE_PATH,
  AGENT_CLIENT_BASE_PATH,
  AGENT_GATEWAY_PORT,
  AGENT_RUNTIME_HEALTH_PATH,
  GBRAIN_WEB_PORT,
} from './agent-ingress-contract.ts';

/**
 * Base64url throughout, per the image's contract comment: the values land in a
 * systemd EnvironmentFile that a root-owned shell finalizer also reads, so no
 * generated secret may contain a quote, a backslash, or a dollar sign.
 */
export function mintWorkspaceSecrets(): WorkspaceSecrets {
  return {
    tokenSecret: randomBytes(32).toString('base64url'),
    bootstrapCredential: randomBytes(32).toString('base64url'),
    postgresPassword: randomBytes(24).toString('base64url'),
  };
}

/**
 * The workspace name is the one operator-supplied string that reaches the VM's
 * environment file. Strip it to a charset that cannot terminate a quoted value,
 * open a shell substitution, or break the YAML block scalar it is embedded in.
 * The API validates the name too; this is the layer that must not be trusted to.
 */
export function sanitizeWorkspaceName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9 _.\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return cleaned.length > 0 ? cleaned : 'Workspace';
}

export function renderCloudInit(input: CloudInitInput): string {
  // The finalizer parses this file with an exact key=value grammar and exits 2
  // on a blank value. Catching it here costs one error; missing it costs a VM
  // that boots, never becomes healthy, and is torn down an hour later.
  for (const [field, value] of [
    ['resendApiKey', input.resendApiKey],
    ['emailFrom', input.emailFrom],
    ['openrouterKey', input.openrouterKey],
  ] as const) {
    if (!value.trim()) throw new Error(`cloud-init render requires a non-empty ${field}`);
  }
  // Unquoted in the env file, and the finalizer's grammar is one field per line.
  // OpenRouter's keys are `sk-or-v1-<hex>`, so this rejects nothing real — it is
  // here so that a mangled or attacker-influenced value fails the render rather
  // than becoming a second assignment on a VM.
  if (!/^[A-Za-z0-9._~+/=-]+$/.test(input.openrouterKey)) {
    throw new Error('cloud-init render requires an openrouterKey of URL-safe characters only');
  }
  const name = sanitizeWorkspaceName(input.name);
  const baseUrl = `https://${input.subdomain}`;
  // Base64url is already URL-safe, so this encode is a no-op today; it stays so
  // that changing how the password is minted cannot quietly corrupt the DSN.
  const password = encodeURIComponent(input.secrets.postgresPassword);
  const databaseUrl = `postgresql://gbrain:${password}@127.0.0.1:5432/gbrain`;

  const env: Record<(typeof REQUIRED_CLOUD_INIT_KEYS)[number] | string, string> = {
    GBRAIN_WORKSPACE_NAME: `"${name}"`,
    GBRAIN_SUBDOMAIN: input.subdomain,
    GBRAIN_WORKSPACE_BASE_URL: baseUrl,
    GBRAIN_WORKSPACE_TOKEN_SECRET: input.secrets.tokenSecret,
    GBRAIN_BOOTSTRAP_CREDENTIAL: input.secrets.bootstrapCredential,
    GBRAIN_EMAIL_RESEND_API_KEY: input.resendApiKey,
    GBRAIN_EMAIL_FROM: `"${input.emailFrom.replace(/["\\$`\r\n]/g, '')}"`,
    GBRAIN_WORKSPACE_PRODUCTION: 'true',
    // This workspace's own spend-limited provisioned key. The parent spec forbids
    // a fleet-wide embedding key on a customer VM: a key read off this box is
    // capped at its own limit and revocable without touching any other workspace.
    OPENROUTER_API_KEY: input.openrouterKey,
    OPENROUTER_REFERER: baseUrl,
    OPENROUTER_TITLE: '"2Brain Workspace"',
    GBRAIN_EMBEDDING_MODEL: 'openrouter:openai/text-embedding-3-small',
    GBRAIN_EMBEDDING_DIMENSIONS: '1536',
    GBRAIN_DATABASE_URL: databaseUrl,
    TWO_BRAIN_DATABASE_URL: databaseUrl,
  };

  // #58 (D3): the agent tier — and only the agent tier — is told what it is.
  // GBrain reads this to surface the OpenClaw connection endpoint in the
  // Agents panel; brain-tier cloud-init stays byte-identical. A flag, never a
  // secret: the value is the literal `true` and carries no credential.
  if (input.tier === 'agent') env.GBRAIN_AGENT_TIER = 'true';

  const missing = REQUIRED_CLOUD_INIT_KEYS.filter(key => !(key in env));
  if (missing.length > 0) throw new Error(`cloud-init render is missing required keys: ${missing.join(', ')}`);

  // Order is load-bearing: the Brain-tier finalizer performs the #56 inert-agent
  // proofs, so it must complete before the agent finalizer switches the agent on.
  const finalizers = ['/usr/local/sbin/gbrain-cloud-init-finalize'];
  if (input.tier === 'agent') finalizers.push('/usr/local/sbin/gbrain-agent-finalize');
  const runcmd = `runcmd:\n${finalizers.map(path => `  - [${path}]`).join('\n')}`;

  const lines = Object.entries(env).map(([key, value]) => `      ${key}=${value}`).join('\n');
  return `#cloud-config
write_files:
  - path: /etc/gbrain/workspace.env
    owner: root:gbrain
    permissions: '0640'
    content: |
${lines}

${runcmd}
`;
}
