import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

const deployRoot = join(import.meta.dir, '..', 'deploy');
const imageRoot = join(import.meta.dir, '..', 'image');

function bashPath(path: string): string {
  if (process.platform !== 'win32') return path;
  return path
    .replace(/^([A-Za-z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`)
    .replaceAll('\\', '/');
}

/**
 * Runs `command` under WSL's bash on Windows, the real one elsewhere. Same reason
 * the validator harness below names the shell explicitly: Bun resolves a bare
 * `bash` to Git Bash on this box, which is not the shell install.sh will ever run
 * under and has no python3.
 */
async function runInBash(command: string) {
  const shell =
    process.platform === 'win32'
      ? ['wsl.exe', '-e', 'bash', '-c', command]
      : ['bash', '-c', command];
  const child = Bun.spawn(shell, { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

// The OCI signing key is a precondition install.sh does not create: the operator
// writes it from escrow beside the env file. The path here is a placeholder that
// verifyEnvironment rewrites to a real file, so the existence check is exercised
// rather than skipped.
const KEY_PATH_PLACEHOLDER = '/etc/gbrain-cp/oci-api-key.pem';

// CP_SECRET_KEY must decode to exactly 32 bytes (secrets.ts KEY_BYTES); this is
// base64("sealing-key-example-32-bytes-ok!"), which does.
const validEnvironment = `
CP_DATABASE_URL=postgresql://gbraincp:password-example@127.0.0.1:5432/gbraincp
CP_BASE_URL=https://cloud.example.com
CP_WORKSPACE_DOMAIN=workspaces.example.com
CP_SECRET_KEY=c2VhbGluZy1rZXktZXhhbXBsZS0zMi1ieXRlcy1vayE=
CP_GITHUB_CLIENT_ID=github-client-id-example
CP_GITHUB_CLIENT_SECRET=github-client-secret-example
CP_CLOUDFLARE_API_TOKEN=cloudflare-token-example
CP_CLOUDFLARE_ZONE_ID=cloudflare-zone-example
CP_EMAIL_RESEND_API_KEY=resend-key-example
CP_EMAIL_FROM="2Brain <no-reply@example.com>"
CP_OPENROUTER_PROVISIONING_KEY=openrouter-provisioning-key-example
CP_BACKUP_BUCKET=registry-backups
CP_BACKUP_NAMESPACE=examplenamespace
CP_OPERATOR_GITHUB_IDS=12345
OCI_REGION=eu-frankfurt-1
OCI_TENANCY_OCID=ocid1.tenancy.oc1..example
OCI_USER_OCID=ocid1.user.oc1..example
OCI_KEY_FINGERPRINT=aa:bb:cc
OCI_PRIVATE_KEY_PATH=${KEY_PATH_PLACEHOLDER}
OCI_COMPARTMENT_OCID=ocid1.compartment.oc1..example
OCI_AVAILABILITY_DOMAIN=Abcd:EU-FRANKFURT-1-AD-1
OCI_SUBNET_OCID=ocid1.subnet.oc1..example
OCI_WORKSPACE_NSG_OCID=ocid1.networksecuritygroup.oc1..example
OCI_WORKSPACE_IMAGE_OCID=ocid1.image.oc1..example
OCI_INSTANCE_SHAPE=VM.Standard.A1.Flex
`;

/**
 * Runs the validator against `contents` under bash. On Windows `bash` is WSL's
 * (system32\bash.exe precedes Git's on PATH), so paths are translated to /mnt/<drive>
 * and the env file is copied into WSL's own filesystem: a DrvFs file under /mnt/c
 * cannot carry a real 0640, and the mode check is one of the things under test.
 *
 * The signing key is copied in beside it, into the same directory. That is not
 * incidental tidiness -- the validator pins OCI_PRIVATE_KEY_PATH to a sibling of
 * the env file, so a key left behind on /mnt/c while the env file moved to /tmp
 * would fail every case here for the wrong reason.
 *
 * `forbiddenPath`, when given, must not exist after the validator runs. It is
 * checked inside the same shell, as the last command, so its failure becomes the
 * exit code the assertions see.
 *
 * `ambientEnv` names variables the *caller* has set, to stand in for an operator's
 * `sudo -E` or root shell. They go on the validator's command as assignment
 * prefixes, which is what an export reaches the child as, so the validator sees
 * them exactly as it would there.
 */
async function verifyEnvironment(
  contents: string,
  mode = 0o640,
  forbiddenPath?: string,
  {
    withKeyFile = true,
    ambientEnv = {},
  }: { withKeyFile?: boolean; ambientEnv?: Record<string, string> } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'gbrain-cp-env-'));
  const keyFile = join(root, 'oci-api-key.pem');
  if (withKeyFile) {
    await writeFile(
      keyFile,
      '-----BEGIN PRIVATE KEY-----\nexample-not-a-real-key\n-----END PRIVATE KEY-----\n',
    );
  }

  // Where the validator will read them from, which on Windows is not where node
  // wrote them. Both files must share a directory there, so it is a directory that
  // gets copied across, not a file.
  const runRoot = process.platform === 'win32' ? `/tmp/${basename(root)}` : bashPath(root);
  const runEnvFile = `${runRoot}/control-plane.env`;
  const runKeyFile = `${runRoot}/oci-api-key.pem`;

  const envFile = join(root, 'control-plane.env');
  await writeFile(envFile, contents.replace(KEY_PATH_PLACEHOLDER, runKeyFile));
  await chmod(envFile, mode);

  const validator = bashPath(join(deployRoot, 'bin', 'gbrain-cp-verify-env'));
  const forbiddenSetup = forbiddenPath ? `rm -f '${forbiddenPath}'; ` : '';
  const forbiddenCheck = forbiddenPath ? `; test ! -e '${forbiddenPath}'` : '';
  const cleanupPaths = forbiddenPath ? `"${runRoot}" "${forbiddenPath}"` : `"${runRoot}"`;
  const ambient = Object.entries(ambientEnv)
    .map(([name, value]) => `${name}='${value}' `)
    .join('');
  const stageKey = withKeyFile
    ? ` install -m 0600 '${bashPath(keyFile)}' '${runKeyFile}';`
    : '';
  const command =
    process.platform === 'win32'
      ? `set -e; ${forbiddenSetup}trap 'rm -rf ${cleanupPaths}' EXIT; install -d -m 0700 '${runRoot}'; install -m ${mode
          .toString(8)
          .padStart(4, '0')} '${bashPath(envFile)}' '${runEnvFile}';${stageKey} CP_ENV_FILE='${runEnvFile}' ${ambient}'${validator}'${forbiddenCheck}`
      : forbiddenPath
        ? `set -e; ${forbiddenSetup}trap 'rm -f "${forbiddenPath}"' EXIT; CP_ENV_FILE='${runEnvFile}' ${ambient}'${validator}'${forbiddenCheck}`
        : `CP_ENV_FILE='${runEnvFile}' ${ambient}'${validator}'`;

  // WSL's bash, not Git Bash: bashPath() emits /mnt/<drive> paths, and Git Bash has
  // neither those nor python3. Bun resolves a bare `bash` to Git Bash on this box, so
  // name the shell explicitly rather than depending on PATH order.
  const shell =
    process.platform === 'win32'
      ? ['wsl.exe', '-e', 'bash', '-c', command]
      : ['bash', '-c', command];
  const child = Bun.spawn(shell, { stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await rm(root, { recursive: true, force: true });
  return { exitCode, stdout, stderr };
}

describe('control-plane deploy env contract', () => {
  test('a complete env passes', async () => {
    const result = await verifyEnvironment(validEnvironment);

    expect(result).toEqual({
      exitCode: 0,
      stdout: '2Brain control-plane env contract: OK\n',
      stderr: '',
    });
  }, 15_000);

  test('a missing required value fails closed and names it', async () => {
    const result = await verifyEnvironment(
      validEnvironment.replace(/^CP_SECRET_KEY=.*$/m, 'CP_SECRET_KEY='),
    );

    expect(result.exitCode).toBe(2);
    // Assert the reason, not just the name: an empty value is the parser's one
    // deliberate divergence from the precedent (it keeps the no-fields case rather
    // than erroring), and a syntax error would exit 2 naming CP_SECRET_KEY too.
    // Without this line the test passes even with that divergence mutated away.
    expect(result.stderr).toContain('missing or still a placeholder');
    expect(result.stderr).toContain('CP_SECRET_KEY');
  }, 15_000);

  test('a missing workspace NSG fails closed and names it', async () => {
    // The NSG is the only thing that enforces per-workspace ingress; a launch
    // without it falls back to the shared subnet security list. index.ts
    // requireEnv's it, so the validator must refuse an env file that omits it
    // rather than let the deploy discover the crash loop after everything is up.
    const result = await verifyEnvironment(
      validEnvironment.replace(/^OCI_WORKSPACE_NSG_OCID=.*$/m, ''),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('missing or still a placeholder');
    expect(result.stderr).toContain('OCI_WORKSPACE_NSG_OCID');
  }, 15_000);

  test('an unreplaced placeholder fails closed', async () => {
    const result = await verifyEnvironment(
      validEnvironment.replace(/^CP_GITHUB_CLIENT_SECRET=.*$/m, 'CP_GITHUB_CLIENT_SECRET=REPLACE_ME'),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('CP_GITHUB_CLIENT_SECRET');
  }, 15_000);

  test('a sealing key of the wrong length fails closed', async () => {
    const result = await verifyEnvironment(
      validEnvironment.replace(/^CP_SECRET_KEY=.*$/m, 'CP_SECRET_KEY=dG9vLXNob3J0'),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('32 bytes');
  }, 15_000);

  test('a world-readable env file is refused', async () => {
    const result = await verifyEnvironment(validEnvironment, 0o644);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('must not be readable by unprivileged users');
  }, 15_000);

  test('never evaluates operator-supplied values as shell', async () => {
    const sentinel = '/tmp/gbrain-cp-injection-test';
    const malicious = validEnvironment.replace(
      'CP_EMAIL_FROM="2Brain <no-reply@example.com>"',
      `CP_EMAIL_FROM="2Brain $(touch ${sentinel})"`,
    );

    const result = await verifyEnvironment(malicious, 0o640, sentinel);

    // Both assertions carry weight, and the sentinel is why — it is checked inside
    // the validator's own shell (it lives in WSL's /tmp, unreachable from node:fs),
    // spliced on as `test ! -e` after the run, so it surfaces here as an exit code:
    //   exitCode 1 => the payload ran and touched the sentinel (the bug this catches)
    //   exitCode 2 => the validator refused the value outright
    //   exitCode 0 => accepted as a literal AND nothing was executed
    // stdout pins the "accepted as a literal" half on its own: a validator that
    // rejected every `$` would leave the sentinel absent too, while being weaker
    // and more brittle than one that treats the value as inert text.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('2Brain control-plane env contract: OK\n');
  }, 15_000);

  test('CP_BASE_URL must be https', async () => {
    const result = await verifyEnvironment(
      validEnvironment.replace(/^CP_BASE_URL=.*$/m, 'CP_BASE_URL=http://cloud.example.com'),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('https');
  }, 15_000);

  test('an absent OCI signing key fails closed', async () => {
    // install.sh does not create this file; the operator writes it from escrow.
    // Both entrypoints readFileSync it at boot, so its absence is a crash loop.
    const result = await verifyEnvironment(validEnvironment, 0o640, undefined, {
      withKeyFile: false,
    });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('OCI_PRIVATE_KEY_PATH');
  }, 15_000);

  test('an OCI signing key outside the env directory is refused though it exists', async () => {
    // The pin, not the existence check -- openssl.cnf is a real, root-readable file,
    // so `-f` passes and only the path comparison can refuse this.
    //
    // Why pin at all: this validator runs as root, and root can stat a file the
    // service will never open. install.sh chowns exactly one path into the service
    // group, and a key anywhere else stays root-only -- or, under /root or /home,
    // is invisible to the unit at any mode (ProtectHome=true). Both land as a crash
    // loop after everything is installed, which is the failure this file exists to
    // pull forward. Same move as the local-Postgres check below.
    const result = await verifyEnvironment(
      validEnvironment.replace(
        /^OCI_PRIVATE_KEY_PATH=.*$/m,
        'OCI_PRIVATE_KEY_PATH=/etc/ssl/openssl.cnf',
      ),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('OCI_PRIVATE_KEY_PATH must be');
  }, 15_000);

  // `Number(process.env.CP_PORT ?? 8080)` and its two siblings in index.ts. `??`
  // fires on null/undefined only, never on the empty string an EnvironmentFile line
  // like `CP_PORT=` delivers intact -- so the default never applies, Number('') is
  // 0, and Express reads 0 as "bind any free port". The control plane comes up
  // healthy on a port nothing is pointed at while install.sh polls 8080 for a
  // minute. It fails closed, but late and pointing nowhere near the cause.
  //
  // The empty case is the one that actually happens; the others are the same
  // expansion failing in the remaining available directions and cost a line each.
  test.each([
    ['CP_PORT=', 'CP_PORT'],
    ['CP_PORT=0', 'CP_PORT'],
    ['CP_PORT=65536', 'CP_PORT'],
    ['CP_PORT=http', 'CP_PORT'],
    ['CP_PORT=-1', 'CP_PORT'],
    ['CP_FLEET_CAP=', 'CP_FLEET_CAP'],
    ['CP_FLEET_CAP=0', 'CP_FLEET_CAP'],
    ['CP_RECONCILE_INTERVAL_MS=', 'CP_RECONCILE_INTERVAL_MS'],
    ['CP_MAX_STEP_ATTEMPTS=', 'CP_MAX_STEP_ATTEMPTS'],
    ['CP_MAX_STEP_ATTEMPTS=0', 'CP_MAX_STEP_ATTEMPTS'],
    // An uncapped or zero embedding key is the same shape with a bill attached:
    // the per-key spend limit is what bounds a credential read off a VM.
    ['CP_OPENROUTER_KEY_LIMIT_USD=', 'CP_OPENROUTER_KEY_LIMIT_USD'],
    ['CP_OPENROUTER_KEY_LIMIT_USD=0', 'CP_OPENROUTER_KEY_LIMIT_USD'],
    ['OCI_INSTANCE_OCPUS=0', 'OCI_INSTANCE_OCPUS'],
    ['OCI_INSTANCE_OCPUS=1e2', 'OCI_INSTANCE_OCPUS'],
    ['OCI_INSTANCE_OCPUS=0x10', 'OCI_INSTANCE_OCPUS'],
    ['OCI_INSTANCE_MEMORY_GB=', 'OCI_INSTANCE_MEMORY_GB'],
    ['OCI_INSTANCE_BOOT_VOLUME_GB=forty', 'OCI_INSTANCE_BOOT_VOLUME_GB'],
  ])('%s reaches Number() as 0 or NaN, never the default, so it is refused', async (line, name) => {
    const result = await verifyEnvironment(`${validEnvironment}${line}\n`);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(name);
  }, 15_000);

  test('an explicitly empty workspace shape is refused instead of bypassing the default', async () => {
    const result = await verifyEnvironment(validEnvironment.replace(
      'OCI_INSTANCE_SHAPE=VM.Standard.A1.Flex',
      'OCI_INSTANCE_SHAPE=',
    ));
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('OCI_INSTANCE_SHAPE');
  }, 15_000);

  test.each(['CP_PORT=8080', 'CP_PORT=08080', 'CP_FLEET_CAP=20', 'CP_RECONCILE_INTERVAL_MS=5000', 'CP_MAX_STEP_ATTEMPTS=120', 'CP_OPENROUTER_KEY_LIMIT_USD=5', 'OCI_INSTANCE_OCPUS=1', 'OCI_INSTANCE_MEMORY_GB=4', 'OCI_INSTANCE_BOOT_VOLUME_GB=50'])(
    '%s is accepted',
    async (line) => {
      // The other half of the check above: it must refuse the values that break the
      // box without refusing the ones an operator actually writes. 08080 is here for
      // the `10#` in the validator's arithmetic -- without it bash reads a leading
      // zero as octal and errors on the 8, refusing a value Number() reads as 8080.
      const result = await verifyEnvironment(`${validEnvironment}${line}\n`);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('2Brain control-plane env contract: OK\n');
    },
    15_000,
  );

  // The file is the contract, not the process environment. The systemd units read
  // only EnvironmentFile, so a value the validator saw solely because an operator
  // had it exported (`sudo -E`, a root shell, CI) would pass here and then
  // crash-loop the unit — the half-built box the validator exists to prevent.
  test('a required value absent from the file fails closed though the caller exports it', async () => {
    const result = await verifyEnvironment(
      validEnvironment.replace(/^CP_CLOUDFLARE_ZONE_ID=.*$/m, ''),
      0o640,
      undefined,
      { ambientEnv: { CP_CLOUDFLARE_ZONE_ID: 'leaked-from-the-operator-shell' } },
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('missing or still a placeholder');
    expect(result.stderr).toContain('CP_CLOUDFLARE_ZONE_ID');
  }, 15_000);

  test('an optional value set only in the caller environment does not refuse a valid file', async () => {
    // The mirror of the case above, and the one that proves the validator reads the
    // file rather than merging it with the environment: this env file is valid, so
    // an ambient CP_COOKIE_SECURE=false must not be able to refuse it.
    const result = await verifyEnvironment(validEnvironment, 0o640, undefined, {
      ambientEnv: { CP_COOKIE_SECURE: 'false' },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('2Brain control-plane env contract: OK\n');
  }, 15_000);

  test('a non-local CP_DATABASE_URL is refused', async () => {
    // install.sh sets up Postgres on the box itself; a remote URL means the app and
    // the backup timer are pointed somewhere install.sh never provisioned.
    const result = await verifyEnvironment(
      validEnvironment.replace(
        /^CP_DATABASE_URL=.*$/m,
        'CP_DATABASE_URL=postgresql://u:pw@db.example.com:5432/x',
      ),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('must target local Postgres');
  }, 15_000);

  test('a non-postgres CP_DATABASE_URL scheme is refused', async () => {
    const result = await verifyEnvironment(
      validEnvironment.replace(
        /^CP_DATABASE_URL=.*$/m,
        'CP_DATABASE_URL=mysql://u:pw@127.0.0.1:5432/x',
      ),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('postgres://');
  }, 15_000);

  test('a CP_DATABASE_URL on a non-default port is refused', async () => {
    const result = await verifyEnvironment(
      validEnvironment.replace(
        /^CP_DATABASE_URL=.*$/m,
        'CP_DATABASE_URL=postgresql://u:pw@127.0.0.1:5433/x',
      ),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('port 5432');
  }, 15_000);

  test('a CP_DATABASE_URL without credentials is refused', async () => {
    const result = await verifyEnvironment(
      validEnvironment.replace(
        /^CP_DATABASE_URL=.*$/m,
        'CP_DATABASE_URL=postgresql://127.0.0.1:5432/gbraincp',
      ),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('must include database, user, and password');
  }, 15_000);

  test('a CP_DATABASE_URL naming a non-identifier database is refused', async () => {
    // install.sh interpolates these into CREATE ROLE / CREATE DATABASE, which take
    // no placeholders.
    const result = await verifyEnvironment(
      validEnvironment.replace(
        /^CP_DATABASE_URL=.*$/m,
        'CP_DATABASE_URL=postgresql://u:pw@127.0.0.1:5432/gbrain-cp',
      ),
    );

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('simple SQL identifiers');
  }, 15_000);
});

// --- the env generator --------------------------------------------------------
//
// build-env.sh mints the two machine secrets and writes control-plane.env for the
// operator to escrow and copy to the VM. It is not run here (it needs openssl and
// the operator's seven values); these pin the two decisions that were invisible in
// review and cost a real deploy each.
const generatorPath = join(deployRoot, 'build-env.sh');

describe('control-plane env generator', () => {
  // The defect that failed the first deploy: CP_EMAIL_FROM's value carries a space
  // (and <>), and an unquoted EnvironmentFile value splits on it, so verify-env's
  // shlex.split saw three fields and exited 2. The quotes are the whole fix.
  test('quotes CP_EMAIL_FROM, whose value legitimately contains a space', async () => {
    const generator = await readFile(generatorPath, 'utf8');
    expect(generator).toContain('CP_EMAIL_FROM="${CP_EMAIL_FROM}"');
    expect(generator).not.toMatch(/^CP_EMAIL_FROM=\$\{CP_EMAIL_FROM\}$/m);
  });

  // The generator's output must satisfy the same contract verify-env enforces, so a
  // key the validator now requires has to be one the generator actually emits — or
  // every freshly generated env fails closed at deploy time.
  test('emits the workspace NSG the validator now requires', async () => {
    const generator = await readFile(generatorPath, 'utf8');
    expect(generator).toMatch(/^OCI_WORKSPACE_NSG_OCID=ocid1\.networksecuritygroup\./m);
  });

  test('emits the pilot workspace A2 sizing defaults', async () => {
    const generator = await readFile(generatorPath, 'utf8');
    expect(generator).toMatch(/^OCI_INSTANCE_SHAPE=VM\.Standard\.A2\.Flex$/m);
    expect(generator).toMatch(/^OCI_INSTANCE_OCPUS=1$/m);
    expect(generator).toMatch(/^OCI_INSTANCE_MEMORY_GB=4$/m);
    expect(generator).toMatch(/^OCI_INSTANCE_BOOT_VOLUME_GB=50$/m);
  });

  test('is syntactically valid bash', async () => {
    const result = await runInBash(`bash -n '${bashPath(generatorPath)}'`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  }, 15_000);
});

describe('control-plane instance launcher', () => {
  const launcherPath = join(deployRoot, 'launch-control-plane.sh');

  test('hard-defaults the pilot control plane to A2, 1 OCPU, 4 GB, and 50 GB', async () => {
    const launcher = await readFile(launcherPath, 'utf8');
    expect(launcher).toContain('OCI_CONTROL_PLANE_SHAPE:-VM.Standard.A2.Flex');
    expect(launcher).toContain('OCI_CONTROL_PLANE_OCPUS:-1');
    expect(launcher).toContain('OCI_CONTROL_PLANE_MEMORY_GB:-4');
    expect(launcher).toContain('OCI_CONTROL_PLANE_BOOT_VOLUME_GB:-50');
  });

  test('is idempotent by display name and refuses a non-ARM image', async () => {
    const launcher = await readFile(launcherPath, 'utf8');
    expect(launcher).toMatch(/compute instance list[\s\S]*--display-name/);
    expect(launcher).toMatch(/aarch64/);
    expect(launcher).toContain('--boot-volume-size-in-gbs');
  });

  test('binds the fleet reserved public IP instead of allocating an ephemeral address', async () => {
    const launcher = await readFile(launcherPath, 'utf8');
    expect(launcher).toContain('OCI_CONTROL_PLANE_PUBLIC_IP_OCID');
    expect(launcher).toContain('--assign-public-ip false');
    expect(launcher).toMatch(/network public-ip update[\s\S]*--private-ip-id/);
  });

  test('is syntactically valid bash', async () => {
    const result = await runInBash(`bash -n '${bashPath(launcherPath)}'`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  }, 15_000);
});

describe('control-plane live smoke', () => {
  const smokePath = join(deployRoot, 'smoke-control-plane.sh');

  test('verifies the live A2 capacity before probing control-plane health', async () => {
    const smoke = await readFile(smokePath, 'utf8');
    const instanceCheck = smoke.indexOf('compute instance get');
    const healthCheck = smoke.indexOf('/healthz');
    expect(instanceCheck).toBeGreaterThan(-1);
    expect(smoke).toContain('VM.Standard.A2.Flex');
    expect(smoke).toContain('shape-config');
    expect(smoke).toContain('boot-volume');
    expect(healthCheck).toBeGreaterThan(instanceCheck);
  });

  test('is syntactically valid bash', async () => {
    const result = await runInBash(`bash -n '${bashPath(smokePath)}'`);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  }, 15_000);
});

const systemdRoot = join(deployRoot, 'files', 'systemd');

// --- systemd unit parsing ----------------------------------------------------
//
// A minimal parser for the three unit files below -- not a general systemd
// implementation, just enough for files we author ourselves. It understands:
// `[Section]` headers; `Key=Value` lines, scoped to whichever section most
// recently opened; leading/trailing whitespace; and comment lines starting
// with `#` or `;` (systemd only treats those as comments at the start of a
// trimmed line, never inline after a value, so neither does this). Any other
// non-blank line inside a section -- one that is not a comment, a section
// header, or `Key=Value` -- is malformed and `parseSystemdUnit` throws. That
// is the only "validation" this buys: it checks the file matches the syntax
// we and systemd both expect, not that any directive name or value is
// semantically meaningful (see the parses-cleanly test below).
//
// Duplicate keys are meaningful. For the scalar directives these tests check
// (User=, Restart=, ExecStart=, ...), systemd keeps only the *last* value a
// unit file sets -- so `User=gbrain-cp` followed later by `User=root` runs
// the unit as root. `unitValue` models that: it is last-value-wins, not
// first-value-wins, so a stray later override is exactly what it catches.
// `Environment=` and, in some configurations, `ExecStart{Pre,Post}=` instead
// *accumulate* in real systemd (each occurrence adds rather than replaces).
// This parser does not special-case that: it keeps every raw value for a key,
// in file order, so a caller who needs true list semantics can read the array
// directly instead of going through `unitValue`. None of the units under test
// repeat `Environment=` or `ExecStart=` in a way that would change the
// last-value-wins answer, so `unitValue` happens to be correct for our single
// `ExecStart=` line too.
type ParsedUnit = Record<string, Record<string, string[]>>;

function parseSystemdUnit(contents: string): ParsedUnit {
  const unit: ParsedUnit = {};
  let section: string | null = null;
  for (const raw of contents.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1];
      unit[section] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (!section || eq <= 0) {
      throw new Error(
        `malformed systemd unit line (expected a comment, [Section], or Key=Value): ${JSON.stringify(raw)}`,
      );
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    (unit[section][key] ??= []).push(value);
  }
  return unit;
}

/** Last-value-wins read of a scalar directive; `undefined` if never set. */
function unitValue(unit: ParsedUnit, section: string, key: string): string | undefined {
  return unit[section]?.[key]?.at(-1);
}

// The web service and the backup oneshot are hand-copied siblings: every
// directive below is asserted, byte-for-byte, in *both* unit files. That
// duplication at the file level is exactly why the check is factored out
// once here rather than typed twice into the two `test()` bodies below --
// two 12-line copies is how a review misses that an edit stripped hardening
// from only one sibling. Called from inside each unit's own `test()`, so a
// failure's test name still says which unit ("the service..." vs "the
// backup unit...") and the printed source line still names the directive
// (`unitValue(unit, 'Service', 'ProtectSystem')`, not a bare boolean) --
// nothing here is hidden behind the helper, only repeated less.
function expectHardenedControlPlaneUnit(unit: ParsedUnit): void {
  expect(unitValue(unit, 'Unit', 'Requires')).toBe('postgresql.service');
  expect(unitValue(unit, 'Service', 'WorkingDirectory')).toBe('/opt/gbrain-cp/cloud');
  expect(unitValue(unit, 'Service', 'StateDirectory')).toBe('gbrain-cp');
  expect(unitValue(unit, 'Service', 'UMask')).toBe('0027');
  // The hardening set.
  expect(unitValue(unit, 'Service', 'NoNewPrivileges')).toBe('true');
  expect(unitValue(unit, 'Service', 'PrivateTmp')).toBe('true');
  expect(unitValue(unit, 'Service', 'ProtectSystem')).toBe('strict');
  expect(unitValue(unit, 'Service', 'ProtectHome')).toBe('true');
  expect(unitValue(unit, 'Service', 'ProtectKernelTunables')).toBe('true');
  expect(unitValue(unit, 'Service', 'ProtectKernelModules')).toBe('true');
  expect(unitValue(unit, 'Service', 'ProtectControlGroups')).toBe('true');
  expect(unitValue(unit, 'Service', 'RestrictSUIDSGID')).toBe('true');
}

describe('control-plane systemd units', () => {
  test('the service runs unprivileged from a root-owned env file and always restarts', async () => {
    const contents = await readFile(join(systemdRoot, 'gbrain-control-plane.service'), 'utf8');
    const unit = parseSystemdUnit(contents);

    // Exact equality against the parsed value, not substring search on the raw
    // text: a deleted `User=` line reads as `undefined` here and fails the
    // assertion, where `toContain('User=gbrain-cp')` would have missed it only
    // if a *different* line still matched, and `not.toContain('User=root')`
    // never exercised the "key is actually set" half at all.
    expect(unitValue(unit, 'Service', 'User')).toBe('gbrain-cp');
    expect(unitValue(unit, 'Service', 'Group')).toBe('gbrain-cp');
    expect(unitValue(unit, 'Service', 'EnvironmentFile')).toBe('/etc/gbrain-cp/control-plane.env');
    expect(unitValue(unit, 'Service', 'Restart')).toBe('always');
    // The reconciler's lease (#40) is what makes restart-mid-provision safe.
    expect(unitValue(unit, 'Service', 'ExecStart')).toBe('/usr/local/bin/bun run src/index.ts');
    expectHardenedControlPlaneUnit(unit);
  });

  test('the backup unit is oneshot, shares the service identity, and carries no [Install]', async () => {
    const contents = await readFile(join(systemdRoot, 'gbrain-control-plane-backup.service'), 'utf8');
    const unit = parseSystemdUnit(contents);

    expect(unitValue(unit, 'Service', 'Type')).toBe('oneshot');
    expect(unitValue(unit, 'Service', 'User')).toBe('gbrain-cp');
    expect(unitValue(unit, 'Service', 'Group')).toBe('gbrain-cp');
    expect(unitValue(unit, 'Service', 'EnvironmentFile')).toBe('/etc/gbrain-cp/control-plane.env');
    expect(unitValue(unit, 'Service', 'ExecStart')).toBe('/usr/local/bin/bun run src/backup.ts');
    // Genuinely unset, not "no line reads Restart=always": that phrasing would
    // still pass if a line read `Restart=on-failure`, or if `Restart=` were
    // present but empty. undefined is what actually leaves systemd's no-restart
    // default in force for this oneshot unit.
    expect(unitValue(unit, 'Service', 'Restart')).toBeUndefined();
    // This unit holds an unsealed database dump in memory and makes a signed
    // HTTPS call to object storage -- it deserves the same hardening scrutiny
    // as the web service, not less, so it gets the identical assertion set.
    expectHardenedControlPlaneUnit(unit);
    // A oneshot driven exclusively by the timer must not carry its own [Install]
    // section, and the absence is what makes it un-enablable: with no WantedBy=
    // there is no symlink for `systemctl enable` to create, so the only thing that
    // can pull this unit in is the timer's Unit=. Give it an [Install] and enabling
    // it would run a backup on every boot in addition to the nightly timer.
    expect(unit['Install']).toBeUndefined();
  });

  test('the timer is nightly, jittered, and catches up after downtime', async () => {
    const contents = await readFile(join(systemdRoot, 'gbrain-control-plane-backup.timer'), 'utf8');
    const unit = parseSystemdUnit(contents);

    expect(unitValue(unit, 'Timer', 'OnCalendar')).toBe('*-*-* 03:00:00 UTC');
    expect(unitValue(unit, 'Timer', 'RandomizedDelaySec')).toBe('900');
    // Without this a VM that was down at 03:00 silently skips the day.
    expect(unitValue(unit, 'Timer', 'Persistent')).toBe('true');
    expect(unitValue(unit, 'Install', 'WantedBy')).toBe('timers.target');
  });

  test.each([
    'gbrain-control-plane.service',
    'gbrain-control-plane-backup.service',
    'gbrain-control-plane-backup.timer',
  ])('%s is well-formed systemd key/value syntax', async (file) => {
    const contents = await readFile(join(systemdRoot, file), 'utf8');

    // This only proves the file matches the [Section]/Key=Value/comment shape
    // the parser (and systemd) both expect -- it is not `systemd-analyze verify`
    // and asserts nothing about whether a directive name or value is actually
    // meaningful to systemd. There is no `systemd-analyze` on this Windows box;
    // this closes the "obviously malformed line" slice of that gap, no more.
    expect(() => parseSystemdUnit(contents)).not.toThrow();
  });
});

// --- the installer ------------------------------------------------------------
//
// install.sh needs root on Ubuntu 24.04, so nothing here runs it. These are
// mostly string assertions against a shell script -- the weakest kind of test,
// and worth being explicit about: they pin the handful of decisions that are
// invisible in review and expensive on a real box, and they prove nothing about
// whether the script works. The two that do execute something are the bash
// syntax check and the python-heredoc compile below; those are the only
// mechanical verification this artifact gets anywhere.
const installPath = join(deployRoot, 'install.sh');

/**
 * Drops whole-line `#` comments so an assertion about what the script *does* is not
 * satisfied -- or broken -- by prose about what it must not do. Several comments
 * below quote the wrong spelling they exist to warn against, which is exactly the
 * case a raw `not.toContain` gets wrong in both directions.
 *
 * Whole-line only, and that is all install.sh needs: no `#` appears inside its
 * heredocs (python, SQL, Caddyfile) or its strings. A trailing `# comment` after
 * code would survive this, deliberately -- stripping those needs a shell parser.
 */
function installedCode(source: string): string {
  return source.replace(/^\s*#.*$/gm, '');
}

describe('control-plane installer', () => {
  // The bug that killed every first run, and the one the plan got wrong: apt has
  // no postgresql-16-client and never has. `postgresql-N-<name>` is the *extension*
  // naming shape -- postgresql-16-pgvector, which the workspace image one directory
  // over installs in exactly that form -- so the wrong spelling looks like it is
  // following a local precedent. Nothing else here would catch it: there is no apt
  // in this test, so the first symptom is "Unable to locate package" on a real box,
  // a dozen packages deep, on a first run that cannot be retried cleanly.
  test('installs the Postgres client under a package name that exists', async () => {
    const code = installedCode(await readFile(installPath, 'utf8'));

    expect(code).toContain('"postgresql-client-${POSTGRES_MAJOR}"');
    // Both shapes of the mistake: the interpolated one a copy of the pgvector line
    // produces, and a hardcoded postgresql-16-client.
    expect(code).not.toMatch(/postgresql-\$\{POSTGRES_MAJOR\}-client/);
    expect(code).not.toMatch(/postgresql-\d+-client/);
  });

  // The unit file's missing [Install] is asserted above. This is the other half,
  // and the half where the habit that comment warns about actually lands: enabling
  // a `.service` is what everyone's fingers type. Getting it wrong here does not
  // start nightly backups -- it stops them, silently: `systemctl enable` on a unit
  // with no [Install] does not fail. It exits 0, advises on stderr, and creates no
  // symlink, so the mistake reads as success and nothing is ever scheduled.
  test('enables the backup timer and never the backup service', async () => {
    const code = installedCode(await readFile(installPath, 'utf8'));

    expect(code).toMatch(/systemctl enable --now gbrain-control-plane-backup\.timer/);
    expect(code).not.toMatch(/systemctl\s+enable[^\n]*gbrain-control-plane-backup\.service/);
  });

  // The header promises "exit 2 means ... nothing was changed". That promise is
  // worth what its weakest refusal is worth, and it was worth nothing: the deploy
  // key and the not-a-checkout refusals both fired after apt had installed a dozen
  // packages, Bun was on the box, and the service user existed. Hoisting them fixed
  // it once; this is what keeps it fixed, because the natural place to write the
  // next refusal is beside whatever first needs it.
  test('every refusal fires before the first line that changes the box', async () => {
    const code = installedCode(await readFile(installPath, 'utf8'));
    const firstMutation = code.indexOf('run_apt update');
    expect(firstMutation).toBeGreaterThan(-1);

    const refusals = [...code.matchAll(/^\s*exit 2$/gm)].map((match) => match.index ?? -1);
    // Guards the regex: a reformat that stopped matching would make this vacuous.
    expect(refusals.length).toBeGreaterThan(0);
    expect(refusals.filter((index) => index > firstMutation)).toEqual([]);
  });

  test('checks the operator-supplied preconditions it does not create', async () => {
    const code = installedCode(await readFile(installPath, 'utf8'));
    const firstMutation = code.indexOf('run_apt update');

    // Each of these is written from escrow by the operator, or is a file this copy
    // of deploy/ is supposed to carry. All are used far below; all are worthless to
    // discover there.
    for (const precondition of [
      '"$DEPLOY_KEY"',
      '"$CHECKOUT/.git"',
      'gbrain-cp-verify-env',
      'files/systemd/gbrain-control-plane.service',
      'files/systemd/gbrain-control-plane-backup.service',
      'files/systemd/gbrain-control-plane-backup.timer',
    ]) {
      expect(code.indexOf(precondition)).toBeGreaterThan(-1);
      expect(code.indexOf(precondition)).toBeLessThan(firstMutation);
    }
  });

  // `cmp` compares bytes on disk; daemon-reload mutates systemd's in-memory copy.
  // Reloading only when the bytes changed keeps those in sync only if every run
  // that wrote also reloaded -- and a run ends between the two whenever `caddy
  // validate` fails, SSH drops, or someone hits Ctrl-C. The next run then compares
  // equal, skips the reload nobody performed, and restarts the stale unit. Health
  // passes. The deploy reports success. ~50ms is not worth that.
  test('reloads systemd unconditionally rather than only when the unit bytes changed', async () => {
    const code = installedCode(await readFile(installPath, 'utf8'));

    expect(code).toMatch(/^systemctl daemon-reload$/m);
    expect(code).not.toContain('units_changed');
  });

  // [0]=user [1]=password [2]=name, against the parser's print(user)/print(password)
  // /print(name). A swap creates a role named after the password and hands the app a
  // password that is its own database name; the arity check cannot see it, because
  // three lines are three lines in any order, and CREATE ROLE succeeds either way.
  // The first symptom is a control plane that cannot log in to the database it just
  // created.
  test('reads the database URL parts in the order the parser prints them', async () => {
    const install = await readFile(installPath, 'utf8');

    expect(install).toMatch(/print\(user\)\nprint\(password\)\nprint\(name\)/);
    expect(install).toContain('DB_USER="${db_parts[0]}"');
    expect(install).toContain('DB_PASSWORD="${db_parts[1]}"');
    expect(install).toContain('DB_NAME="${db_parts[2]}"');
  });

  test('pins Bun and Postgres to exactly the workspace image versions', async () => {
    const install = await readFile(installPath, 'utf8');
    const provision = await readFile(join(imageRoot, 'scripts', 'provision.sh'), 'utf8');

    const pin = (source: string, name: string) =>
      source.match(new RegExp(`^${name}="\\$\\{${name}:-([^}]+)\\}"`, 'm'))?.[1];

    // Drift here means the control plane runs a different Bun than the fleet it
    // provisions, which is exactly the class of bug nobody finds until a deploy.
    // The toBeDefined lines are not redundant with the equality: two undefineds
    // compare equal, so without them a rename on both sides passes vacuously.
    expect(pin(install, 'BUN_VERSION')).toBe(pin(provision, 'BUN_VERSION'));
    expect(pin(install, 'POSTGRES_MAJOR')).toBe(pin(provision, 'POSTGRES_MAJOR'));
    expect(pin(install, 'BUN_VERSION')).toBeDefined();
    expect(pin(install, 'POSTGRES_MAJOR')).toBeDefined();
  });

  // A stale REPO_REF default is silent and destructive: `git reset --hard`
  // succeeds against whatever it fetched, and the wrong tree has no
  // cloud/src/index.ts, so the unit crash-loops "Module not found" on a box that
  // was healthy a minute earlier. The default has to name a tree that actually
  // carries the control plane — the renamed repo, and the branch it lives on until
  // #46 lands on master.
  test('the repo defaults name a tree that contains the control plane', async () => {
    const install = await readFile(installPath, 'utf8');
    expect(install).toMatch(/^REPO_URL="\$\{REPO_URL:-git@github\.com:azxav\/2brain\.git\}"$/m);
    // Flip to master in the same change that merges #46; until then dashboard is
    // the only ref with cloud/src/index.ts.
    expect(install).toMatch(/^REPO_REF="\$\{REPO_REF:-dashboard\}"$/m);
    // The rename is permanent: the old name must not linger and lean on the 301.
    expect(install).not.toContain('azxav/gbrain.git');
  });

  test('validates the env before installing anything', async () => {
    const install = await readFile(installPath, 'utf8');
    const validation = install.indexOf('gbrain-cp-verify-env');
    const firstApt = install.indexOf('run_apt update');
    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeLessThan(firstApt);
  });

  test('reuses the image apt lock retry rather than calling apt-get raw', async () => {
    const install = await readFile(installPath, 'utf8');
    expect(install).toMatch(/run_apt\(\)[\s\S]*Could not get lock/);
    expect(install).toMatch(/run_apt\(\)[\s\S]*Unable to acquire/);
    // Narrow: this only catches an `apt-get ...` that begins a line. `sudo apt-get`,
    // `DEBIAN_FRONTEND=x apt-get`, and plain `apt` all slip through, and run_apt's
    // own `command apt-get "$@"` is deliberately not a match. It is a lint, not a proof.
    expect(install).not.toMatch(/^\s*apt-get\s/m);
  });

  test('creates the database role idempotently and without interpolating SQL', async () => {
    const install = await readFile(installPath, 'utf8');
    // %I/%L quote the identifier and the literal, so a password containing a quote
    // is data rather than syntax; psql's :'var' does the same on the way in. The
    // values come from an operator's env file, so both halves matter.
    expect(install).toContain("format('CREATE ROLE %I LOGIN PASSWORD %L'");
    expect(install).toContain('WHERE NOT EXISTS (SELECT 1 FROM pg_roles');
    expect(install).toContain("format('CREATE DATABASE %I OWNER %I'");
    expect(install).toContain('WHERE NOT EXISTS (SELECT 1 FROM pg_database');
  });

  test('is idempotent about the checkout rather than assuming a fresh clone', async () => {
    const install = await readFile(installPath, 'utf8');
    expect(install).toContain('git -C "$CHECKOUT" fetch');
    expect(install).toContain('reset --hard');
  });

  // The checkout is the one place where re-running is not merely wasteful but
  // fatal if the ownership is wrong. git has refused to operate on a repository
  // owned by another user since 2.35.2 ("detected dubious ownership"), and that
  // check is not waived for root: verified against git 2.43 that root fetching a
  // service-user-owned repo exits 128, both with and without SUDO_UID set. So a
  // run that handed $CHECKOUT to gbrain-cp would clone fine the first time and
  // then break every subsequent run -- i.e. the upgrade path, which is the whole
  // reason this script is idempotent. The fix is ownership, not safe.directory:
  // marking a service-user-owned tree safe would let that user plant a .git/config
  // (core.pager, core.fsmonitor) that runs as root on the next fetch.
  test("leaves the checkout root-owned so a re-run's git does not trip dubious ownership", async () => {
    const install = await readFile(installPath, 'utf8');
    const chowns = install.match(/^\s*chown.*$/gm) ?? [];
    expect(chowns.filter((line) => line.includes('CHECKOUT'))).toEqual([]);
    expect(install).not.toContain('safe.directory');
  });

  test('validates the Caddyfile before enabling Caddy', async () => {
    const install = await readFile(installPath, 'utf8');
    const validate = install.indexOf('caddy validate');
    const enable = install.indexOf('systemctl enable --now caddy.service');
    expect(validate).toBeGreaterThan(-1);
    expect(enable).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(enable);
  });

  // Oracle's stock Ubuntu image ships a host INPUT chain that ACCEPTs SSH and
  // REJECTs every other new connection, so 80/443 are blocked at the OS firewall
  // even when the NSG allows them — and Caddy's ACME challenge (tls-alpn-01, over
  // 443) then never completes, so no certificate issues. The workspace image opens
  // these in provision.sh before it bakes; the control-plane box has no equivalent
  // and every first deploy hit it. Nothing else here catches it: there is no
  // iptables in this test, so the first symptom is a public 443 that never answers.
  test('opens 80 and 443 at the OS firewall, idempotently and persisted, before Caddy serves', async () => {
    const install = await readFile(installPath, 'utf8');
    const code = installedCode(install);

    // netfilter-persistent (which persists the rules across reboot) comes from the
    // iptables-persistent package, so it has to be installed for `save` to exist.
    expect(install).toMatch(/^\s*iptables-persistent/m);
    // The image's own idempotent pattern: check-then-insert, never a blind append.
    expect(code).toContain('iptables -C INPUT -p tcp --dport "$port" -j ACCEPT');
    expect(code).toContain('iptables -I INPUT 1 -p tcp --dport "$port" -j ACCEPT');
    expect(code).toContain('netfilter-persistent save');
    // The ports must be open before Caddy is asked to serve, or the first ACME
    // attempt races a closed 443.
    expect(code.indexOf('netfilter-persistent save')).toBeGreaterThan(-1);
    expect(code.indexOf('netfilter-persistent save')).toBeLessThan(code.indexOf('caddy validate'));
  });

  // The localhost poll proves the app process is up; it cannot see the firewall,
  // the NSG, the DNS record, or ACME. A first deploy passed the localhost check
  // and reported success while public 443 was dead and no cert had issued. The
  // public check closes that gap: it exercises the real origin over real DNS and
  // TLS and fails the install if it never answers.
  test('verifies the public HTTPS origin, not just localhost, and fails closed', async () => {
    const code = installedCode(await readFile(installPath, 'utf8'));

    const localhostCheck = code.indexOf('http://127.0.0.1:${CP_PORT_VALUE}/healthz');
    const publicCheck = code.indexOf('https://${CP_ORIGIN}/healthz');
    expect(localhostCheck).toBeGreaterThan(-1);
    // The public check comes after the localhost one, and after Caddy is serving.
    expect(publicCheck).toBeGreaterThan(localhostCheck);
    expect(publicCheck).toBeGreaterThan(code.indexOf('systemctl enable --now caddy.service'));
    // Fail closed: a public origin that never answers must abort the deploy, not
    // be reported as success. The exit lives after the public poll.
    expect(code.indexOf('exit 1', publicCheck)).toBeGreaterThan(publicCheck);
  });

  test('refuses to run anywhere but Ubuntu 24.04 as root', async () => {
    const install = await readFile(installPath, 'utf8');
    expect(install).toContain('must run as root');
    expect(install).toContain('VERSION_ID:-}" != "24.04"');
  });

  // The database URL is parsed by python and consumed by CREATE ROLE. mapfile
  // returns 0 even when the process substitution feeding it died, so nothing
  // upstream of these lines can fail the script on a bad parse. Verified under
  // bash 5.2: an empty array does trip `set -u` at ${db_parts[0]} -- but only
  // exits 1, not the 2 this codebase reserves for contract failures -- while
  // three lines with an empty middle sail straight through into a role with an
  // empty password. The arity check covers the first case, the parser's own
  // refusal covers the second.
  test('cannot reach CREATE ROLE with a half-parsed database URL', async () => {
    const install = await readFile(installPath, 'utf8');
    const arity = install.indexOf('"${#db_parts[@]}" -ne 3');
    const createRole = install.indexOf("format('CREATE ROLE");
    expect(arity).toBeGreaterThan(-1);
    expect(arity).toBeLessThan(createRole);
    expect(install).toContain('database URL must include database, user, and password');
  });

  test('is syntactically valid bash', async () => {
    // The only mechanical check this script gets: it cannot be run here, and
    // shellcheck is not installed on this box (checked). `bash -n` at least
    // proves the file parses -- including that every heredoc is terminated.
    const result = await runInBash(`bash -n '${bashPath(installPath)}'`);

    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  }, 15_000);

  test('every embedded python heredoc is syntactically valid python', async () => {
    // `bash -n` treats a heredoc body as an opaque blob, so a typo in the python
    // that parses the operator's database URL would first surface on a real box,
    // mid-deploy, as a SystemExit from a script that had already run apt and git.
    const install = await readFile(installPath, 'utf8');
    const blocks = [...install.matchAll(/<<'PY'\n([\s\S]*?)\nPY\n/g)].map((match) => match[1]);

    // Guards the regex itself: a reformat that stopped matching would otherwise
    // turn this test into a loop over nothing.
    expect(blocks.length).toBe(3);

    for (const block of blocks) {
      const root = await mkdtemp(join(tmpdir(), 'gbrain-cp-py-'));
      const file = join(root, 'block.py');
      await writeFile(file, block);
      const result = await runInBash(
        `python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' '${bashPath(file)}'`,
      );
      await rm(root, { recursive: true, force: true });

      expect(result.stderr).toBe('');
      expect(result.exitCode).toBe(0);
    }
  }, 30_000);
});
