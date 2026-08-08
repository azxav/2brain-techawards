import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const REQUIRED_CLOUD_INIT_KEYS = [
  'GBRAIN_WORKSPACE_NAME',
  'GBRAIN_SUBDOMAIN',
  'GBRAIN_WORKSPACE_BASE_URL',
  'GBRAIN_WORKSPACE_TOKEN_SECRET',
  'GBRAIN_BOOTSTRAP_CREDENTIAL',
  'GBRAIN_EMAIL_RESEND_API_KEY',
  'GBRAIN_EMAIL_FROM',
  'OPENROUTER_API_KEY',
  'GBRAIN_EMBEDDING_MODEL',
  'GBRAIN_EMBEDDING_DIMENSIONS',
  'GBRAIN_DATABASE_URL',
  'TWO_BRAIN_DATABASE_URL',
] as const;

export const AGENT_RUNTIME_CONTRACT = {
  nodeVersion: '24.15.0',
  nodeArchive: 'node-v24.15.0-linux-arm64.tar.xz',
  nodeSha256: 'f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0',
  openclawVersion: '2026.7.1-2',
  user: 'openclaw',
  group: 'openclaw',
  home: '/var/lib/openclaw',
  stateDirectory: '/var/lib/openclaw/.openclaw',
  browserDirectory: '/var/lib/openclaw/browser',
  workspaceDirectory: '/var/lib/openclaw/workspace',
  storageLimitBytes: 10 * 1024 * 1024 * 1024,
  cpuQuota: '150%',
  memoryHigh: '2G',
  memoryMax: '3G',
  tasksMax: 512,
} as const;

export interface AgentUnitRequirement {
  /** systemd ignores a directive placed outside the section that defines it. */
  readonly section: 'Unit' | 'Service';
  readonly directive: string;
  readonly value: string;
  /**
   * `once` means systemd must see exactly one assignment in that section:
   * it applies the LAST assignment of a single-value directive and UNIONS
   * repeated list values, so a boundary is removed by addition as easily as by
   * deletion — and a relocated directive leaves zero assignments behind.
   *
   * `any` permits repeats but then only checks that THIS value is present; it
   * cannot reject an extra assignment, which is why it is used solely for
   * `[Unit]` conditions. Adding a genuinely repeatable `[Service]` directive is
   * NOT a case for `any`: pin its complete set with an exact-set constant next
   * to AGENT_ENVIRONMENT instead, the way Environment= and TemporaryFileSystem=
   * are pinned, and add the directive to REPEATABLE_SERVICE_DIRECTIVES.
   */
  readonly cardinality: 'once' | 'any';
  readonly message: string;
}

/**
 * `[Service]` directives allowed to carry `cardinality: 'any'`. Empty on
 * purpose: flipping a row to `any` silently disables its cardinality check and
 * drops it from the derived re-assignment matrix, so the contract test forces
 * that to be a deliberate, reviewed edit here rather than a one-word change.
 */
export const REPEATABLE_SERVICE_DIRECTIVES: readonly string[] = [];

// The single source of truth for the agent unit. The verifier derives its
// presence and cardinality checks from this table and the tests derive their
// mutation matrices from it, so ONE new record here is enough to pin a new
// directive end to end.
export const AGENT_UNIT_REQUIREMENTS = [
  {
    section: 'Unit',
    directive: 'RequiresMountsFor',
    value: AGENT_RUNTIME_CONTRACT.home,
    cardinality: 'any',
    message: 'gbrain-agent.service must require the bounded agent storage mount',
  },
  {
    section: 'Unit',
    directive: 'ConditionPathExists',
    value: '/usr/local/bin/openclaw',
    cardinality: 'any',
    message: 'gbrain-agent.service must require the root-owned OpenClaw launcher to exist',
  },
  {
    section: 'Unit',
    directive: 'ConditionPathExists',
    value: '/etc/openclaw/agent.env',
    cardinality: 'any',
    message: 'gbrain-agent.service must require the agent-scoped environment to exist',
  },
  {
    section: 'Service',
    directive: 'User',
    value: AGENT_RUNTIME_CONTRACT.user,
    cardinality: 'once',
    message: `gbrain-agent.service must run as ${AGENT_RUNTIME_CONTRACT.user}`,
  },
  {
    section: 'Service',
    directive: 'Group',
    value: AGENT_RUNTIME_CONTRACT.group,
    cardinality: 'once',
    message: `gbrain-agent.service must use the ${AGENT_RUNTIME_CONTRACT.group} group`,
  },
  {
    section: 'Service',
    directive: 'WorkingDirectory',
    value: AGENT_RUNTIME_CONTRACT.workspaceDirectory,
    cardinality: 'once',
    message: 'gbrain-agent.service must work inside the agent workspace directory',
  },
  {
    section: 'Service',
    directive: 'EnvironmentFile',
    value: '/etc/openclaw/agent.env',
    cardinality: 'once',
    message: 'gbrain-agent.service must consume only the agent-scoped environment',
  },
  {
    section: 'Service',
    directive: 'ExecStart',
    // `openclaw gateway` already runs in the foreground; the pinned release has
    // no `--foreground` option and exits 1 on it ("OpenClaw does not recognize
    // option"). Anything appended here has to exist in `openclaw gateway --help`
    // for 2026.7.1-2 — a plausible-looking flag is a restart loop, not a typo.
    value: '/usr/local/bin/openclaw gateway',
    cardinality: 'once',
    message: 'gbrain-agent.service must execute the root-owned OpenClaw launcher',
  },
  {
    section: 'Service',
    directive: 'Type',
    value: 'simple',
    cardinality: 'once',
    message: 'gbrain-agent.service must run as a simple foreground service',
  },
  {
    section: 'Service',
    directive: 'Restart',
    value: 'always',
    cardinality: 'once',
    message: 'gbrain-agent.service must restart after failure',
  },
  {
    section: 'Service',
    directive: 'RestartSec',
    value: '10s',
    cardinality: 'once',
    message: 'gbrain-agent.service must back off between restarts',
  },
  {
    section: 'Service',
    directive: 'TimeoutStopSec',
    value: '30s',
    cardinality: 'once',
    message: 'gbrain-agent.service must bound how long it may take to stop',
  },
  {
    section: 'Service',
    directive: 'UMask',
    value: '0077',
    cardinality: 'once',
    message: 'gbrain-agent.service must create files private to the agent',
  },
  {
    section: 'Service',
    directive: 'NoNewPrivileges',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must never acquire new privileges',
  },
  {
    section: 'Service',
    directive: 'CapabilityBoundingSet',
    value: '',
    cardinality: 'once',
    message: 'gbrain-agent.service must have no Linux capabilities',
  },
  {
    section: 'Service',
    directive: 'AmbientCapabilities',
    value: '',
    cardinality: 'once',
    message: 'gbrain-agent.service must have no ambient capabilities',
  },
  {
    section: 'Service',
    directive: 'ProtectSystem',
    value: 'strict',
    cardinality: 'once',
    message: 'gbrain-agent.service must keep the system read-only',
  },
  {
    section: 'Service',
    directive: 'ProtectHome',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must not reach other home directories',
  },
  {
    section: 'Service',
    directive: 'PrivateDevices',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must run without host device nodes',
  },
  {
    section: 'Service',
    directive: 'ProtectProc',
    value: 'invisible',
    cardinality: 'once',
    message: 'gbrain-agent.service must not observe other processes',
  },
  {
    section: 'Service',
    directive: 'ProcSubset',
    value: 'pid',
    cardinality: 'once',
    message: 'gbrain-agent.service must not read kernel /proc interfaces',
  },
  {
    section: 'Service',
    directive: 'ProtectKernelTunables',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must not write kernel tunables',
  },
  {
    section: 'Service',
    directive: 'ProtectKernelModules',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must not load or unload kernel modules',
  },
  {
    section: 'Service',
    directive: 'ProtectKernelLogs',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must not read the kernel log',
  },
  {
    section: 'Service',
    directive: 'ProtectControlGroups',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must not write its own control groups',
  },
  {
    section: 'Service',
    directive: 'ProtectClock',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must not change the system clock',
  },
  {
    section: 'Service',
    directive: 'ProtectHostname',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must not change the hostname',
  },
  {
    section: 'Service',
    directive: 'RestrictSUIDSGID',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must not create setuid or setgid files',
  },
  {
    section: 'Service',
    directive: 'RestrictRealtime',
    value: 'true',
    cardinality: 'once',
    message: 'gbrain-agent.service must not obtain realtime scheduling',
  },
  {
    section: 'Service',
    directive: 'SystemCallArchitectures',
    value: 'native',
    cardinality: 'once',
    message: 'gbrain-agent.service must refuse non-native system call architectures',
  },
  {
    section: 'Service',
    directive: 'RestrictAddressFamilies',
    value: 'AF_UNIX AF_INET AF_INET6',
    cardinality: 'once',
    message: 'gbrain-agent.service must restrict sockets to UNIX and IP address families',
  },
  {
    section: 'Service',
    directive: 'ReadWritePaths',
    value: [
      AGENT_RUNTIME_CONTRACT.stateDirectory,
      AGENT_RUNTIME_CONTRACT.browserDirectory,
      AGENT_RUNTIME_CONTRACT.workspaceDirectory,
    ].join(' '),
    cardinality: 'once',
    message: 'gbrain-agent.service must confine persistent writes to agent-owned paths',
  },
  {
    section: 'Service',
    directive: 'InaccessiblePaths',
    // Every entry carries systemd's `-` prefix so a path the image does not
    // create cannot refuse the namespace at startup (status=226/NAMESPACE).
    // The prefix does not weaken the block: an existing path is still hidden.
    //
    // The service-manager sockets are named individually. Masking the whole of
    // `/run/systemd` is what systemd itself builds the unit's namespace out of,
    // so it fails the namespace outright — and, being the last mount applied,
    // it fails with no message at all. Naming the two control sockets blocks
    // the same escape (both are verified mode 0 inside the live namespace).
    value:
      '-/etc/gbrain -/var/lib/gbrain -/opt/gbrain -/usr/local/bin/gbrain -/var/lib/postgresql -/run/postgresql -/run/docker.sock -/var/run/docker.sock -/run/systemd/private -/run/systemd/io.systemd.Manager -/run/dbus/system_bus_socket',
    cardinality: 'once',
    message:
      'gbrain-agent.service must block GBrain, PostgreSQL, Docker, and service manager paths',
  },
  {
    section: 'Service',
    directive: 'CPUQuota',
    value: AGENT_RUNTIME_CONTRACT.cpuQuota,
    cardinality: 'once',
    message: `gbrain-agent.service must cap CPU at ${AGENT_RUNTIME_CONTRACT.cpuQuota}`,
  },
  {
    section: 'Service',
    directive: 'MemoryHigh',
    value: AGENT_RUNTIME_CONTRACT.memoryHigh,
    cardinality: 'once',
    message: `gbrain-agent.service must throttle memory at ${AGENT_RUNTIME_CONTRACT.memoryHigh}`,
  },
  {
    section: 'Service',
    directive: 'MemoryMax',
    value: AGENT_RUNTIME_CONTRACT.memoryMax,
    cardinality: 'once',
    message: `gbrain-agent.service must cap memory at ${AGENT_RUNTIME_CONTRACT.memoryMax}`,
  },
  {
    section: 'Service',
    directive: 'TasksMax',
    value: `${AGENT_RUNTIME_CONTRACT.tasksMax}`,
    cardinality: 'once',
    message: `gbrain-agent.service must cap tasks at ${AGENT_RUNTIME_CONTRACT.tasksMax}`,
  },
  {
    section: 'Service',
    directive: 'CPUWeight',
    value: '25',
    cardinality: 'once',
    message: 'gbrain-agent.service must yield CPU priority to core services',
  },
  {
    section: 'Service',
    directive: 'IOWeight',
    value: '25',
    cardinality: 'once',
    message: 'gbrain-agent.service must yield IO priority to core services',
  },
  {
    section: 'Service',
    directive: 'OOMScoreAdjust',
    value: '750',
    cardinality: 'once',
    message: 'gbrain-agent.service must be the preferred OOM victim',
  },
  {
    section: 'Service',
    directive: 'LogRateLimitIntervalSec',
    value: '30s',
    cardinality: 'once',
    message: 'gbrain-agent.service must rate limit its journal output',
  },
  {
    section: 'Service',
    directive: 'LogRateLimitBurst',
    value: '200',
    cardinality: 'once',
    message: 'gbrain-agent.service must bound its journal burst',
  },
] as const satisfies readonly AgentUnitRequirement[];

// The agent unit runs exactly one unprefixed ExecStart. Every other exec hook is
// banned outright: systemd runs `+`, `!`, and `!!` commands outside the sandbox,
// and #57 can lift a specific ban with an explicit decision if it needs one.
const AGENT_FORBIDDEN_EXEC_DIRECTIVES = [
  'ExecStartPre',
  'ExecStartPost',
  'ExecStop',
  'ExecStopPost',
  'ExecReload',
  'ExecCondition',
] as const;

// Not hardening: these break the runtime the agent tier must ship.
const AGENT_FORBIDDEN_DIRECTIVES = [
  [
    'MemoryDenyWriteExecute',
    'gbrain-agent.service must not set MemoryDenyWriteExecute; the Node runtime requires JIT pages',
  ],
  [
    'RestrictNamespaces',
    'gbrain-agent.service must not set RestrictNamespaces; the managed browser requires user namespaces',
  ],
] as const;

// Environment= and TemporaryFileSystem= legitimately repeat, so they are pinned
// as complete sets here instead of as cardinality-checked rows above: a per-row
// presence check cannot reject a fifth Environment= line, and `cardinality:
// 'any'` would only assert that one expected value is present. Read the
// cardinality doc on AgentUnitRequirement before adding a repeatable directive.
const AGENT_ENVIRONMENT = [
  `Environment=HOME=${AGENT_RUNTIME_CONTRACT.home}`,
  `Environment=OPENCLAW_HOME=${AGENT_RUNTIME_CONTRACT.home}`,
  `Environment=OPENCLAW_STATE_DIR=${AGENT_RUNTIME_CONTRACT.stateDirectory}`,
  `Environment=OPENCLAW_WORKSPACE_DIR=${AGENT_RUNTIME_CONTRACT.workspaceDirectory}`,
] as const;

// `mode=1777` is what makes these usable by the unprivileged agent identity.
// A tmpfs mounted at systemd's 0755 default is root-owned, so OpenClaw cannot
// create its own temp directory and exits 1 — a private /tmp the service cannot
// write to is not isolation, it is an outage. 1777 is the sticky-bit mode /tmp
// carries on every Linux system, and the mount is private to this service.
const AGENT_TEMPORARY_FILESYSTEMS = [
  'TemporaryFileSystem=/tmp:rw,nosuid,nodev,size=256M,mode=1777',
  'TemporaryFileSystem=/var/tmp:rw,nosuid,nodev,size=256M,mode=1777',
] as const;

export interface BrainTierAgentProof {
  /**
   * Every pattern must match, so a proof that needs several cooperating lines
   * (target, size, and mount options) stays one reviewable row.
   *
   * Patterns are anchored with `^[^#\n]*` so a proof commented out is a missing
   * proof, and terminated with `$` or a closing delimiter wherever a suffix
   * (`|| true`, a longer path) would defeat the command while still containing
   * the expected text. Presence alone is never fail-closed: additive
   * re-activation is caught separately by FORBIDDEN_AGENT_ACTIVATION.
   */
  readonly patterns: readonly RegExp[];
  readonly message: string;
}

/**
 * Brain-tier cloud-init must actively PROVE the pinned OpenClaw runtime is
 * inert and walled off from Platform Credentials — it is the only place the
 * static bundle contract meets a real VM. #57 owns enablement, so nothing here
 * may read, create, or require /etc/openclaw/agent.env.
 */
export const BRAIN_TIER_AGENT_PROOFS = [
  {
    // `[ \t]*$` rather than `\s*$`: `|| true` turns a fail-closed stop into a
    // best-effort one, which is exactly the weakening this row exists to catch.
    patterns: [/^[ \t]*systemctl disable --now gbrain-agent\.service[ \t]*$/m],
    message: 'gbrain-agent.service must remain disabled after Brain-tier cloud-init',
  },
  {
    // The commands alone are not the proof. Pinning `is-enabled` without its
    // `!= "disabled"` comparison leaves a one-character inversion to `==` that
    // keeps every pinned string intact, and `if !` does the same to `is-active`.
    patterns: [
      /^[^#\n]*systemctl is-enabled gbrain-agent\.service/m,
      /^[^#\n]*systemctl is-active --quiet gbrain-agent\.service/m,
      /^[ \t]*if \[\[ "\$agent_enabled_state" != "disabled" \]\]; then$/m,
      /^[ \t]*if systemctl is-active --quiet gbrain-agent\.service; then$/m,
    ],
    message: 'Brain-tier cloud-init must prove the agent service is disabled and inactive',
  },
  {
    // Pinned with its `if` so `if !` cannot invert the proof, and with the
    // positive control that stops a broken sudo from satisfying it vacuously.
    patterns: [
      /^[^#\n]*sudo -u openclaw test -r "\$ENV_FILE"/m,
      /^[ \t]*if sudo -u openclaw test -r "\$ENV_FILE"; then$/m,
      /^[ \t]*sudo -u openclaw true[ \t]*$/m,
    ],
    message: 'Brain-tier cloud-init must prove openclaw cannot read Platform Credentials',
  },
  {
    // The exact-set form, not a `gbrain`-only denial: an extra group is a new
    // path to shared authority whatever it is called.
    patterns: [
      /^[^#\n]*id -nG openclaw\)"/m,
      /^[^#\n]*\[\[ "\$openclaw_groups" != "openclaw" \]\]/m,
    ],
    message: 'Brain-tier cloud-init must prove openclaw belongs only to the openclaw group',
  },
  {
    // The mount target is spelled literally. A `--target "$var"` form would let
    // the variable be repointed at any filesystem while this check still passed.
    patterns: [
      /^[^#\n]*findmnt -n -o SOURCE --target \/var\/lib\/openclaw\)/m,
      /^[^#\n]*findmnt -n -o FSTYPE --target \/var\/lib\/openclaw\)/m,
      /^[^#\n]*findmnt -n -o OPTIONS --target \/var\/lib\/openclaw\)/m,
      /^[^#\n]*blockdev --getsize64 "\$openclaw_source"\)/m,
      /^[^#\n]*\[\[ "\$openclaw_fstype" != "ext4" \]\]/m,
      // Built from the contract constant, so the bound cannot drift here
      // independently of AGENT_RUNTIME_CONTRACT, provision.sh, and the unit.
      new RegExp(
        String.raw`^[^#\n]*\[\[ "\$openclaw_size" -ne ${AGENT_RUNTIME_CONTRACT.storageLimitBytes} \]\]`,
        'm',
      ),
      /^[^#\n]*\[\[ ",\$openclaw_options," != \*,nodev,\* \]\]/m,
      /^[^#\n]*\[\[ ",\$openclaw_options," != \*,nosuid,\* \]\]/m,
    ],
    message: 'Brain-tier cloud-init must verify bounded OpenClaw storage',
  },
  {
    patterns: [
      /^[^#\n]*iptables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d 127\.0\.0\.0\/8 -j REJECT$/m,
      /^[^#\n]*ip6tables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d ::1\/128 -j REJECT$/m,
    ],
    message: 'Brain-tier cloud-init must verify direct PostgreSQL denial',
  },
] as const satisfies readonly BrainTierAgentProof[];

/**
 * Every systemctl verb that leaves the agent running or enabled. `preset`
 * applies the default `enable *` policy, `add-wants`/`add-requires`/`link`
 * install the unit without ever saying "enable", and `reenable` would slip past
 * an alternation anchored on the verb's first character.
 */
const AGENT_ACTIVATION_VERBS = [
  'enable',
  'reenable',
  'preset',
  'preset-all',
  'link',
  'add-wants',
  'add-requires',
  'start',
  'restart',
  'reload-or-restart',
  'try-restart',
  'try-reload-or-restart',
] as const;

export interface BrainTierAgentProhibition {
  /** Any match is an error, so these are the mirror image of the proofs. */
  readonly pattern: RegExp;
  readonly message: string;
}

/**
 * The proofs above assert what cloud-init DOES; these assert what it must never
 * do. Presence checking alone is not fail-closed: systemd state is
 * last-write-wins and shell is last-line-wins, so a proof is defeated as easily
 * by addition as by deletion, with every pinned character left intact.
 *
 * Patterns run against the finalizer with backslash continuations joined, so a
 * line split cannot hide a verb from its unit name. Spans are `[^#\n]` rather
 * than `\s`/`[^\n]` so a match stays inside one logical line and a comment
 * cannot be stitched onto a preceding real command — #57 will legitimately
 * mention enablement in prose. The re-activation row narrows its INTERIOR spans
 * further, to `[^#\n;&|]`, so a match also stays inside one COMMAND: joining
 * continuations puts `systemctl daemon-reload && echo "will restart
 * gbrain-agent in #57"` on one line, and only a separator-crossing span reads
 * that hand-off note as an activation. Crossing separators buys nothing either,
 * because a real second command carries its own `systemctl` for the leading
 * span to anchor on.
 *
 * The `.service` suffix is optional throughout: systemd resolves a bare unit
 * name to its `.service` unit. The trailing lookahead keeps that leniency from
 * spilling onto an unrelated `gbrain-agent-*` name.
 */
export const BRAIN_TIER_AGENT_PROHIBITIONS = [
  {
    pattern: new RegExp(
      String.raw`^[^#\n]*\bsystemctl[ \t]+[^#\n;&|]*(?<![\w-])(?:${AGENT_ACTIVATION_VERBS.join('|')})`
        + String.raw`(?![\w-])[^#\n;&|]*\bgbrain-agent(?:\.service)?(?![\w.-])`,
      'm',
    ),
    message: 'Brain-tier cloud-init must never re-activate gbrain-agent.service',
  },
  {
    // systemd needs no systemctl to enable a unit: the wants symlink IS the
    // enablement, so the verb list alone would leave `ln -s` wide open.
    pattern:
      /^[^#\n]*(?:\.target\.wants[^#\n]*\bgbrain-agent|\bgbrain-agent[^#\n]*\.target\.wants)/m,
    message: 'Brain-tier cloud-init must never install gbrain-agent.service into a systemd target',
  },
  {
    // #57 owns the agent-scoped environment. Brain-tier creating or reading it
    // would both leak an agent surface and satisfy the unit's
    // ConditionPathExists. Unanchored on purpose: naming the path at all, even
    // in a comment, is close enough to the mistake to be worth refusing.
    pattern: /\/etc\/openclaw\/agent\.env/,
    message: 'Brain-tier cloud-init must not create or require the agent-scoped environment',
  },
  {
    // #68 owns the Agent gateway's auth and its GBrain-owned plugin. Brain-tier
    // cloud-init configuring either would give a Brain Workspace an agent
    // control surface, and would do it on a VM whose unit is disabled — so the
    // regression would ship silently. Unanchored, like the agent.env row:
    // naming these at all in the Brain finalizer is close enough to the
    // mistake to refuse.
    pattern: /gbrain-agent-bridge|admin-http-rpc|gateway\.auth\b/,
    message: 'Brain-tier cloud-init must not configure Agent gateway auth or the GBrain bridge',
  },
  {
    // The iptables probes fail closed only because errexit aborts on them, and
    // the substitutions above them likewise. `set +e` silently unmakes both.
    pattern: /^[^#\n]*\bset[ \t]+\+(?:[a-zA-Z]*e[a-zA-Z]*\b|o[ \t]+errexit\b)/m,
    message: 'Brain-tier cloud-init must never disable shell error exits',
  },
  {
    // Wrapping the proof block in `if false; then … fi` keeps every pinned
    // character and executes none of it.
    pattern: /^[ \t]*if[ \t]+(?:![ \t]*)?(?:false|true)\b/m,
    message: 'Brain-tier cloud-init must never wrap the agent proofs in a constant condition',
  },
  {
    // Re-granting group membership after the exact-group-set proof has run.
    pattern: /^[^#\n]*\b(?:usermod|gpasswd|adduser)\b[^#\n]*\bopenclaw\b/m,
    message: 'Brain-tier cloud-init must never add openclaw to another group',
  },
  {
    // A shell function takes precedence over an external command, so one
    // `systemctl() { :; }` neuters the disable, both state proofs, and every
    // activation this table forbids, with all their pinned text left intact.
    pattern: /^[ \t]*(?:function[ \t]+)?systemctl[ \t]*(?:\(\)|\{)/m,
    message: 'Brain-tier cloud-init must never shadow systemctl with a shell function',
  },
] as const satisfies readonly BrainTierAgentProhibition[];

/**
 * Normalizes CRLF and joins backslash continuations so a line-anchored pattern
 * sees one logical line. CRLF normalization has to happen HERE and first: a
 * continuation under a CRLF checkout is `\` CR LF, which a `\\\n` join would
 * miss entirely, and every downstream line-oriented check — `topLevelShell`,
 * the pinned-span scan, the prohibitions — is defined over this output.
 */
function joinShellContinuations(source: string): string {
  return source.replace(/\r\n/g, '\n').replace(/\\\n[ \t]*/g, ' ');
}

/**
 * Blanks shell function bodies and heredoc bodies, keeping line offsets so
 * ordering comparisons stay meaningful. Moving the proof block into a function
 * that is never called, or into heredoc DATA, leaves all of its text in the
 * file while executing none of it; against this view such a proof correctly
 * reads as absent.
 *
 * What this is NOT: a shell parser. It recognizes exactly three things — both
 * function header forms (`name() {`, `function name {`, and the redundant
 * `function name() {`), a running brace DEPTH so the first lone `}` cannot end
 * a nested body early, and heredoc bodies, which are skipped entirely so that
 * neither a `}` nor a function header appearing in DATA steers the scan. Brace
 * counting only counts a brace that stands as its own shell word, which is why
 * `${VAR}` and `${#db_parts[@]}` do not perturb the depth. Anything subtler — command
 * substitution, `eval`, arithmetic — is out of reach here by design, and is why
 * this view is defence in depth behind `verifyPinnedProofSpan`, which pins the
 * proof block's shape directly and needs no shell semantics at all.
 *
 * This deliberately also rejects extracting the proofs into a function that IS
 * called: distinguishing the two would mean tracing shell call graphs, and the
 * block is required to stay one visible top-level sequence anyway so that its
 * position relative to the first live service remains checkable at all.
 *
 * Expects `joinShellContinuations` output: a header or heredoc opener split
 * across a continuation is one line by then.
 */
function topLevelShell(source: string): string {
  const header =
    /^[ \t]*(?:function[ \t]+[A-Za-z_][A-Za-z0-9_-]*[ \t]*(?:\([ \t]*\)[ \t]*)?|[A-Za-z_][A-Za-z0-9_-]*[ \t]*\([ \t]*\)[ \t]*)\{[ \t]*$/;
  // `(?<!<)` so a herestring (`<<<WORD`) is not mistaken for a heredoc opener:
  // its third `<` would otherwise let `<<` match at offset 1 and latch a
  // delimiter that never closes, blanking the rest of the file. Comment lines
  // are skipped by the caller, so a `<<WORD` inside prose cannot latch either.
  const heredocOpener =
    /(?<!<)<<-?[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/;
  // Braces that stand as their own word. `|| {` opens, a lone `}` closes, and
  // `${VAR}` is neither because its `}` is glued to the preceding character.
  // Both run only once inside a body (`depth > 0`); at top level a group command
  // runs, so depth is not tracked there.
  const opens = /(?:^|[\s;&|])\{(?=[\s;]|$)/g;
  const closes = /(?:^|[\s;])\}(?=[\s;&|]|$)/g;

  let depth = 0;
  let heredocDelimiter: string | null = null;
  return source
    .split('\n')
    .map(line => {
      if (heredocDelimiter !== null) {
        if (line.trim() === heredocDelimiter) heredocDelimiter = null;
        return '';
      }
      const blanked = depth > 0;
      if (depth === 0 && header.test(line)) {
        depth = 1;
        return '';
      }
      if (depth > 0) {
        depth += (line.match(opens)?.length ?? 0) - (line.match(closes)?.length ?? 0);
        if (depth < 0) depth = 0;
      }
      // A `<<WORD` inside a comment is prose, not a heredoc opener: treating it
      // as one latches a delimiter that never closes and blanks the rest of the
      // file. #57 will legitimately mention heredocs in comments.
      // A `<<WORD` inside a comment is prose, not a heredoc opener: treating it
      // as one latches a delimiter that never closes and blanks the rest of the
      // file. #57 will legitimately mention heredocs in comments.
      if (!line.trimStart().startsWith('#')) {
        const opener = heredocOpener.exec(line);
        if (opener) heredocDelimiter = opener[1] ?? opener[2] ?? opener[3] ?? null;
      }
      return blanked ? '' : line;
    })
    .join('\n');
}

const SUPERVISED_SERVICES = [
  'gbrain-web.service',
  'gbrain-worker.service',
  'gbrain-scheduler.service',
] as const;

const SERVICE_COMMANDS: Record<(typeof SUPERVISED_SERVICES)[number], string> = {
  // #47: --enable-dcr lands in the SAME image change as the session-gated
  // /authorize consent gate — registration is never enabled without the gate.
  'gbrain-web.service':
    '/usr/local/bin/gbrain serve --http --bind 127.0.0.1 --port 3131 --public-url ${GBRAIN_WORKSPACE_BASE_URL} --suppress-bootstrap-token --enable-dcr',
  'gbrain-worker.service': '/usr/local/bin/gbrain workspace-runtime worker',
  'gbrain-scheduler.service': '/usr/local/bin/gbrain workspace-runtime scheduler',
};

/**
 * The complete, exact set of `openclaw config set` assignments Agent-tier
 * finalization performs, keyed by config path and holding the RAW shell token
 * the script passes as the value.
 *
 * This is an exact set, not a checklist. `openclaw config set` is last-writer
 * wins, so a contract expressed as "these lines appear" is defeated by ADDITION
 * as easily as by deletion: appending `openclaw_config_set gateway.auth.mode
 * token` leaves every pinned line intact and reverts the auth model. The
 * verifier below therefore parses the finalizer into (key, value) pairs and
 * requires this map exactly — no missing key, no extra key, and exactly one
 * assignment per key.
 *
 * The subdomain-bearing value is the one entry whose text is a shell expansion;
 * it is pinned verbatim including the expansion so it cannot quietly widen to
 * a wildcard origin.
 */
export const AGENT_GATEWAY_CONFIG: Readonly<Record<string, string>> = {
  'gateway.mode': 'local',
  'gateway.bind': 'loopback',
  'gateway.port': '3334',
  // NOT `token`. Token auth is mutually exclusive with trusted-proxy mode in
  // the pinned release, and GBrain's adapter sends identity headers only.
  'gateway.auth.mode': 'trusted-proxy',
  'gateway.auth.trustedProxy.userHeader': 'X-GBrain-OpenClaw-User',
  // A PRESENCE check in the pinned release: OpenClaw never compares the value.
  // This header is a routing marker, not a shared secret.
  'gateway.auth.trustedProxy.requiredHeaders': '\'["X-GBrain-OpenClaw-Proxy"]\'',
  'gateway.auth.trustedProxy.allowLoopback': 'true',
  'gateway.reload.mode': 'hybrid',
  'gateway.terminal.enabled': 'false',
  'gateway.http.endpoints.responses.enabled': 'true',
  'gateway.http.endpoints.responses.files.allowUrl': 'false',
  'gateway.http.endpoints.responses.images.allowUrl': 'false',
  'gateway.controlUi.basePath': '/agent',
  'gateway.controlUi.allowedOrigins': '"[\\"https://${GBRAIN_SUBDOMAIN}\\"]"',
  'gateway.trustedProxies': '\'["127.0.0.1"]\'',
  // Pins the OpenAI provider to OpenClaw's own harness. Without it the pinned
  // release routes `openai` to the CODEX runtime, which lives in an official
  // EXTERNAL plugin the image does not ship; the boot-time install it triggers
  // needs an npm cache under a $HOME that ProtectSystem=strict keeps read-only,
  // so the gateway never reports ready and the unit crash-loops. Shipping the
  // plugin does not help — `npm view` precedes any local lookup.
  'models.providers.openai.agentRuntime.id': 'openclaw',
  'agents.defaults.model.primary': 'openai/gpt-5.6-sol',
  'agents.defaults.model.fallbacks': '\'["anthropic/claude-sonnet-5"]\'',
  'agents.defaults.models': '\'{"openai/*":{},"anthropic/*":{},"openrouter/*":{}}\'',
  'plugins.load.paths': '\'["/usr/local/share/openclaw/gbrain-agent-bridge"]\'',
  'plugins.entries.gbrain-agent-bridge.enabled': 'true',
  // Bundled but DISABLED by default in the pinned release; with it disabled the
  // /api/v1/admin/rpc route is never registered and every control call 404s.
  'plugins.entries.admin-http-rpc.enabled': 'true',
};

/** The plugin bundle installed at /usr/local/share/openclaw/gbrain-agent-bridge. */
export const AGENT_BRIDGE_FILES = ['package.json', 'openclaw.plugin.json', 'index.js'] as const;

/**
 * The agent-scoped environment file is a MARKER, not a secret store: the whole
 * of its content, so a token, password, or Workspace service variable added
 * later fails here rather than shipping.
 */
export const AGENT_ENV_MARKER = 'GBRAIN_AGENT_RUNTIME_ENABLED=true';

/**
 * Every text that must NOT appear in Agent-tier finalization. Gateway tokens
 * are the headline case: `gateway.auth.token` is mutually exclusive with
 * trusted-proxy mode, so a leftover token turns the gateway's config invalid
 * and, worse, a leftover generated token is a second, unrotatable credential.
 */
const AGENT_FINALIZE_PROHIBITIONS = [
  ['OPENCLAW_GATEWAY_TOKEN', 'must not generate or install a Gateway token'],
  ['openssl rand', 'must not mint a Gateway credential on the VM'],
] as const;
// `gateway.auth.token` and `gateway.auth.password` are NOT in that list: the
// finalizer names both, deliberately, inside the live absence probe. They are
// forbidden as CONFIG ASSIGNMENTS instead, which the exact-set check above and
// the escape-hatch check below both enforce.

/**
 * Parses `openclaw_config_set <key> <value>` assignments from a shell script
 * into ordered (key, raw value) pairs.
 *
 * Line-oriented over the TOP-LEVEL view, so heredoc data and function bodies
 * are not read as assignments. Be precise about the limit that creates:
 * `topLevelShell` blanks EVERY function body, called or not, so an
 * `openclaw_config_set` hidden inside a helper this script really invokes is
 * invisible to this parser and therefore to the unreviewed-key check. That is
 * why `verifyAgentFinalization` separately refuses any raw `openclaw_run config
 * set` and any function body containing `openclaw_config_set`: this parser
 * cannot see either, so they are banned outright rather than relied upon.
 *
 * The value is kept as its raw shell token — quoting and all — because the
 * quoting is part of the contract: dropping the single quotes around a JSON
 * value changes what the shell passes.
 */
export function parseOpenclawConfigSets(source: string): Array<[string, string]> {
  const assignments: Array<[string, string]> = [];
  for (const raw of topLevelShell(joinShellContinuations(source)).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    const match = /^openclaw_config_set[ \t]+([^ \t]+)[ \t]+(.+?)[ \t]*$/.exec(line);
    if (match) assignments.push([match[1], match[2]]);
  }
  return assignments;
}

/**
 * Verifies the Agent-tier finalizer, the bridge plugin bundle, and the
 * provisioner rules that install it. Appends to `errors`; never throws.
 */
async function verifyAgentFinalization(root: string, provision: string, errors: string[]): Promise<void> {
  const finalizer = await text(join(root, 'files', 'bin', 'gbrain-agent-finalize'), errors);

  // The exact config set, keyed and cardinality-checked. See AGENT_GATEWAY_CONFIG.
  const assignments = parseOpenclawConfigSets(finalizer);
  const seen = new Map<string, string[]>();
  for (const [key, value] of assignments) {
    seen.set(key, [...(seen.get(key) ?? []), value]);
  }
  for (const [key, expected] of Object.entries(AGENT_GATEWAY_CONFIG)) {
    const values = seen.get(key);
    if (values === undefined) {
      errors.push(`gbrain-agent-finalize must set ${key} to ${expected}`);
      continue;
    }
    if (values.length !== 1) {
      errors.push(`gbrain-agent-finalize must set ${key} exactly once`);
    }
    if (values[0] !== expected) {
      errors.push(`gbrain-agent-finalize must set ${key} to ${expected}, not ${values[0]}`);
    }
  }
  for (const key of seen.keys()) {
    if (!(key in AGENT_GATEWAY_CONFIG)) {
      errors.push(`gbrain-agent-finalize sets an unreviewed OpenClaw config key: ${key}`);
    }
  }
  // `parseOpenclawConfigSets` reads the top-level view, which blanks every
  // function body — CALLED or not. So an assignment hidden inside a helper this
  // script really invokes would never reach the unreviewed-key check above.
  // Rather than teach the parser shell call graphs, require every invocation to
  // be visible at top level: the counts must agree.
  const codeLines = joinShellContinuations(finalizer)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'));
  const invocations = codeLines.filter(line => /^openclaw_config_set[ \t]+[^ \t]/.test(line));
  if (invocations.length !== assignments.length) {
    errors.push('gbrain-agent-finalize must invoke openclaw_config_set only at top level');
  }
  // And the wrapper must be the only way config is written. A raw
  // `openclaw_run config set k v` sets a key that no parser above can see.
  for (const line of codeLines.filter(line => /openclaw_run[ \t]+config[ \t]+set\b/.test(line))) {
    if (line !== 'openclaw_run config set "$@"') {
      errors.push(`gbrain-agent-finalize must write config only through openclaw_config_set: \`${line}\``);
    }
  }

  // The marker file: written, and written with nothing but the marker.
  if (!finalizer.includes(`printf '${AGENT_ENV_MARKER}\\n' >/etc/openclaw/agent.env.tmp`)) {
    errors.push('gbrain-agent-finalize must write the agent runtime marker and nothing else');
  }
  if (!finalizer.includes('mv /etc/openclaw/agent.env.tmp /etc/openclaw/agent.env')) {
    errors.push('gbrain-agent-finalize must install the agent marker atomically');
  }
  const writesToEnvFile = finalizer
    .split('\n')
    .filter(line => !line.trimStart().startsWith('#'))
    .filter(line => /^[ \t]*(?:printf|echo|cat|tee)\b[^\n]*\/etc\/openclaw\/agent\.env/.test(line));
  if (writesToEnvFile.length !== 1) {
    errors.push('gbrain-agent-finalize must write the agent-scoped environment exactly once');
  }
  for (const [text_, message] of AGENT_FINALIZE_PROHIBITIONS) {
    if (finalizer.includes(text_)) errors.push(`gbrain-agent-finalize ${message}`);
  }

  // Live validation. Written keys prove nothing; these are what prove behavior
  // on the VM, and each names a failure the static contract cannot see.
  const liveProbes: Array<[string, string]> = [
    ['openclaw_run config validate', 'must validate the configuration it wrote'],
    [
      "await import('openclaw/plugin-sdk/provider-auth')",
      'must prove the plugin SDK subpath the bridge imports still resolves',
    ],
    ['validateAnthropicSetupToken', 'must prove the SDK exports the bridge validator'],
    ['upsertAuthProfileWithLock', 'must prove the SDK exports the bridge profile writer'],
    [
      'openclaw_run plugins inspect gbrain-agent-bridge --runtime --json',
      'must load the bridge through the pinned OpenClaw plugin loader',
    ],
    ['openclaw_run plugins list --enabled', 'must prove the required plugins are enabled'],
    [
      'http://127.0.0.1:3334/api/v1/gbrain/provider',
      'must live-probe the bridge route GBrain posts to',
    ],
    [
      'http://127.0.0.1:3334/api/v1/admin/rpc',
      'must live-probe the bundled admin RPC route',
    ],
    ['openclaw_run config file', 'must read back the effective configuration'],
    ["expectValue('gateway.auth.mode', 'trusted-proxy')", 'must assert the effective auth mode'],
    [
      "expectValue('gateway.terminal.enabled', false)",
      'must assert the terminal stays disabled in effect',
    ],
    [
      "expectValue('agents.defaults.model.primary', 'openai/gpt-5.6-sol')",
      'must assert the effective primary model',
    ],
    [
      "expectValue('agents.defaults.model.fallbacks', ['anthropic/claude-sonnet-5'])",
      'must assert the effective fallback model',
    ],
    [
      "expectValue('gateway.http.endpoints.responses.files.allowUrl', false)",
      'must assert Responses file URL fetching stays disabled in effect',
    ],
    [
      "expectValue('gateway.http.endpoints.responses.images.allowUrl', false)",
      'must assert Responses image URL fetching stays disabled in effect',
    ],
    ["expectValue('gateway.reload.mode', 'hybrid')", 'must assert the effective reload mode'],
    ["expectValue('gateway.controlUi.basePath', '/agent')", 'must assert the effective control-UI base path'],
    // The one read-back whose value is per-workspace, so it has no literal to
    // pin and is asserted by SHAPE inside the probe instead. The three clauses
    // are named individually because each alone is the whole guard: dropping
    // the length check admits a second origin, dropping the pattern admits a
    // wildcard, and dropping `Array.isArray` admits any truthy value.
    ['!Array.isArray(allowedOrigins)', 'must require a real origin list'],
    ['allowedOrigins.length !== 1', 'must require exactly one control-UI origin'],
    [String.raw`!/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(allowedOrigins[0])`,
      'must require the control-UI origin be an exact https host'],
    ["profile !== 'full'", 'must refuse a tool profile that cannot project bundle-mcp'],
    ['tools.allow', 'must refuse a tool allow-list that narrows the projected MCP tools'],
    ['tools.deny', 'must refuse a tool deny-list that hides the projected MCP tools'],
  ];
  for (const [probe, message] of liveProbes) {
    if (!finalizer.includes(probe)) errors.push(`gbrain-agent-finalize ${message}`);
  }
  // The config path the read-back probe is handed must be a FILESYSTEM path.
  //
  // `openclaw config file` prints a DISPLAY path: with OPENCLAW_HOME set — and
  // openclaw_run always sets it — the pinned release substitutes the literal
  // prefix `$OPENCLAW_HOME`. Passed through unexpanded, node opened a directory
  // named `$OPENCLAW_HOME` and the probe died ENOENT on a real VM, which this
  // script then reported as a CONTRACT MISMATCH. The config was correct; the
  // path never was, and the probe had therefore never validated anything.
  //
  // Both halves are required and neither implies the other: the expansion makes
  // the path real, and the existence check is what turns any future way of
  // getting it wrong into its own message instead of a misdirected audit of a
  // correct configuration. Matched against CODE, so the comment that explains
  // the trap upstream cannot satisfy the check that prevents it.
  // Single-quoted and backslash-escaped on purpose: the shell line escapes the
  // dollar as `//\$OPENCLAW_HOME/` so the pattern is not expanded, and a check
  // written without that backslash matches nothing and fails on a correct file.
  if (!codeLines.some(line => line.includes('${openclaw_config_path//\\$OPENCLAW_HOME/'))) {
    errors.push(
      'gbrain-agent-finalize must expand the $OPENCLAW_HOME display prefix that `openclaw config file` returns',
    );
  }
  if (!codeLines.some(line => line.includes('! -f "$openclaw_config_path"'))) {
    errors.push(
      'gbrain-agent-finalize must fail closed when the effective config file does not exist',
    );
  }
  // Every key the finalizer WRITES must also be read back from the effective
  // config. The hand-listed probes above cannot express that: `gateway.reload.mode`
  // shipped written-but-unverified precisely because nothing tied the two lists
  // together, and it is load-bearing — the auth-generation reload it triggers is
  // what restarts the Gateway after a password patch and disconnects already
  // established native WebSocket clients. Derived, so a key added to
  // AGENT_GATEWAY_CONFIG without a matching read-back fails closed here.
  //
  // Matched against CODE only. `finalizer.includes(...)` is comment-blind: a
  // deleted `expectValue` line whose key is still quoted in a nearby comment
  // would satisfy it, which is precisely the "derived, so it fails closed"
  // claim not holding. No key relies on that today; this keeps it true.
  // `//` as well as `#`: the read-back probe is JavaScript inside a heredoc, so
  // its comments are the ones that would actually hide a deleted assertion.
  const readBackCode = codeLines.filter(line => !line.startsWith('//')).join('\n');
  for (const key of Object.keys(AGENT_GATEWAY_CONFIG)) {
    if (!readBackCode.includes(`'${key}'`)) {
      errors.push(`gbrain-agent-finalize must read back the effective value of ${key}`);
    }
  }
  // The escape hatches are named ONLY inside the effective-config absence list.
  // A `dangerously*` key reached through an assignment would be an enablement.
  if (assignments.some(([key]) => /dangerously|allowInsecureAuth/i.test(key))) {
    errors.push('gbrain-agent-finalize must never configure a Gateway escape hatch');
  }
  for (const escapeHatch of [
    'gateway.auth.token',
    'gateway.auth.password',
    'gateway.controlUi.dangerouslyDisableDeviceAuth',
    'gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback',
    'gateway.controlUi.allowInsecureAuth',
  ]) {
    if (!finalizer.includes(`'${escapeHatch}',`)) {
      errors.push(`gbrain-agent-finalize must prove ${escapeHatch} is absent from the live config`);
    }
  }
  // Plugin routes register at plugin startup only, so a gateway already running
  // from an earlier partial run would keep serving the plugin-less route table.
  if (!/^systemctl restart gbrain-agent\.service$/m.test(finalizer)) {
    errors.push('gbrain-agent-finalize must restart the gateway after writing plugin config');
  }

  // The bridge bundle, and the provisioner rules that keep it out of the
  // agent's reach. Root-owned and non-writable by openclaw is the whole point:
  // a bridge the agent can rewrite is a credential-import route the agent owns.
  for (const file of AGENT_BRIDGE_FILES) {
    const path = join(root, 'files', 'openclaw', 'gbrain-agent-bridge', file);
    if (!(await exists(path))) errors.push(`missing required image artifact: ${path}`);
    if (!provision.includes(`for bridge_file in ${AGENT_BRIDGE_FILES.join(' ')}; do`)) {
      errors.push(`provision.sh must install the bridge plugin file ${file}`);
      break;
    }
  }
  if (
    !/install -m 0644 -o root -g root[\s\\\n]+"\$IMAGE_FILES\/openclaw\/gbrain-agent-bridge\/\$bridge_file"/.test(
      provision,
    )
  ) {
    errors.push('provision.sh must install the bridge plugin files root-owned at mode 0644');
  }
  // BOTH directories, parent included. Write permission on the parent alone
  // lets the openclaw identity `mv` the bridge aside and substitute its own
  // credential-import route, which the child directory's own mode cannot
  // prevent — so pinning only the child was a real hole, not a redundancy.
  for (const directory of [
    '/usr/local/share/openclaw',
    '/usr/local/share/openclaw/gbrain-agent-bridge',
  ]) {
    if (!provision.includes(`install -d -m 0755 -o root -g root ${directory}\n`)) {
      errors.push(`provision.sh must install ${directory} root-owned at mode 0755`);
    }
  }
  // The `install` modes are the only thing standing between the agent identity
  // and its own credential-import route, and one later `chmod`/`setfacl` undoes
  // them while every other check — the verifier, the contract tests, and every
  // live probe, since the plugin still loads — stays green. So the whole path
  // is treated as an ALLOW-LIST: these two safeguard lines are permitted, and
  // any other ownership or permission statement naming the path is refused.
  for (const safeguard of [
    'chown -R root:root /usr/local/share/openclaw',
    'chmod -R go-w /usr/local/share/openclaw',
  ]) {
    if (!provision.includes(`${safeguard}\n`)) {
      errors.push(`provision.sh must re-assert bridge plugin permissions with \`${safeguard}\``);
    }
  }
  const permissionStatements = provision
    .split('\n')
    .map(line => line.trim())
    .filter(line => !line.startsWith('#'))
    .filter(line => /\b(?:chmod|chown|chgrp|setfacl)\b/.test(line))
    .filter(line => /\/usr\/local\/share\/openclaw/.test(line));
  for (const statement of permissionStatements) {
    if (
      statement !== 'chown -R root:root /usr/local/share/openclaw'
      && statement !== 'chmod -R go-w /usr/local/share/openclaw'
    ) {
      errors.push(`provision.sh must not alter bridge plugin permissions: \`${statement}\``);
    }
  }

  const manifestText = await text(
    join(root, 'files', 'openclaw', 'gbrain-agent-bridge', 'openclaw.plugin.json'),
    errors,
  );
  let manifest: { id?: string; activation?: { onStartup?: boolean } } = {};
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    errors.push('the bridge plugin manifest must be valid JSON');
  }
  if (manifest.id !== 'gbrain-agent-bridge') {
    errors.push('the bridge plugin manifest must declare the gbrain-agent-bridge id');
  }
  // Omitting onStartup no longer startup-loads a plugin in the pinned release,
  // and an HTTP route registers only during plugin startup.
  if (manifest.activation?.onStartup !== true) {
    errors.push('the bridge plugin manifest must activate on Gateway startup');
  }
  const bridgeSource = await text(
    join(root, 'files', 'openclaw', 'gbrain-agent-bridge', 'index.js'),
    errors,
  );
  for (const required of [
    "path: '/api/v1/gbrain/provider'",
    "auth: 'gateway'",
    "match: 'exact'",
    "gatewayRuntimeScopeSurface: 'trusted-operator'",
    "from 'openclaw/plugin-sdk/provider-auth'",
  ]) {
    if (!bridgeSource.includes(required)) {
      errors.push(`the bridge plugin must declare ${required}`);
    }
  }
  for (const forbidden of ['child_process', 'console.log', 'dist/']) {
    if (bridgeSource.includes(forbidden)) {
      errors.push(`the bridge plugin must not use ${forbidden}`);
    }
  }
}

export interface ImageBundleReport {
  builder: string | null;
  requiredCloudInitKeys: readonly string[];
  supervisedServices: readonly string[];
  disabledServices: readonly string[];
  agentRuntime: typeof AGENT_RUNTIME_CONTRACT;
  hasCredentialHelper: boolean;
  hasUpdateScript: boolean;
  errors: string[];
}

async function text(path: string, errors: string[]): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    errors.push(`missing required image artifact: ${path}`);
    return '';
  }
}

interface UnitDirective {
  section: string;
  key: string;
  value: string;
}

// Mirrors systemd's conf-parser: a section merges wherever its header repeats,
// each line splits on the FIRST `=`, and key and value are stripped
// independently — so `User = root` is a real assignment, not an inert line.
// Directive names stay case-SENSITIVE because systemd compares them with streq.
// This does NOT join systemd's backslash line continuations: a continued value
// simply fails its exact-value check, so the unit must keep one directive per
// line for the contract to stay readable as well as enforced.
export function parseUnitDirectives(unit: string): UnitDirective[] {
  const directives: UnitDirective[] = [];
  let section = '';
  for (const raw of unit.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    directives.push({
      section,
      key: line.slice(0, separator).trim(),
      value: line.slice(separator + 1).trim(),
    });
  }
  return directives;
}

// Total on any input: trims before unwrapping so it does not silently depend on
// parseUnitDirectives having already stripped the value. This helper is exactly
// where a whitespace-padding bypass would land.
function environmentFilePath(value: string): string {
  const unwrapped = value.trim().replace(/^[-+"']+/, '').replace(/["']+$/, '');
  const resolved: string[] = [];
  for (const segment of unwrapped.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') resolved.pop();
    else resolved.push(segment);
  }
  return `${unwrapped.startsWith('/') ? '/' : ''}${resolved.join('/')}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

// Verifies the inert OpenClaw unit against AGENT_UNIT_REQUIREMENTS and the
// directives that are banned outright. Appends to `errors`; never throws.
async function verifyAgentUnit(agentServicePath: string, errors: string[]): Promise<void> {
  const agentUnit = await text(agentServicePath, errors);
  const agentDirectives = parseUnitDirectives(agentUnit);
  const serviceDirectives = agentDirectives.filter(directive => directive.section === 'Service');

  // One loop covers presence and cardinality, so a new record in the table is
  // fully enforced without a second edit anywhere.
  for (const requirement of AGENT_UNIT_REQUIREMENTS) {
    const assignments = agentDirectives.filter(
      directive =>
        directive.section === requirement.section && directive.key === requirement.directive,
    );
    if (!assignments.some(({ value }) => value === requirement.value)) {
      errors.push(requirement.message);
    }
    if (requirement.cardinality === 'once' && assignments.length !== 1) {
      errors.push(`gbrain-agent.service must assign ${requirement.directive} exactly once`);
    }
  }

  const declaredIn = (key: string): string[] =>
    serviceDirectives
      .filter(directive => directive.key === key)
      .map(directive => `${directive.key}=${directive.value}`)
      .sort();
  if (declaredIn('Environment').join('\n') !== [...AGENT_ENVIRONMENT].sort().join('\n')) {
    errors.push('gbrain-agent.service must declare exactly the agent-scoped environment variables');
  }
  if (
    declaredIn('TemporaryFileSystem').join('\n')
    !== [...AGENT_TEMPORARY_FILESYSTEMS].sort().join('\n')
  ) {
    errors.push('gbrain-agent.service must declare exactly the bounded temporary filesystems');
  }

  for (const directive of AGENT_FORBIDDEN_EXEC_DIRECTIVES) {
    if (serviceDirectives.some(({ key }) => key === directive)) {
      errors.push(`gbrain-agent.service must declare no ${directive} directive`);
    }
  }
  if (serviceDirectives.some(({ key, value }) => key.startsWith('Exec') && /^[!+]/.test(value))) {
    errors.push('gbrain-agent.service must never run exec directives with elevated privileges');
  }

  for (const [directive, message] of AGENT_FORBIDDEN_DIRECTIVES) {
    if (serviceDirectives.some(({ key }) => key === directive)) errors.push(message);
  }

  if (
    serviceDirectives.some(
      ({ key, value }) =>
        key === 'EnvironmentFile'
        && /^\/(?:etc|opt|var\/lib)\/gbrain(?:\/|$)/.test(environmentFilePath(value)),
    )
  ) {
    errors.push('gbrain-agent.service must never inherit the Workspace environment');
  }
  if (
    serviceDirectives.some(
      ({ key, value }) => (key === 'User' || key === 'Group') && value === 'gbrain',
    )
  ) {
    errors.push('gbrain-agent.service must never share the GBrain service identity');
  }
}

// Reused from the proof table so the disable line cannot drift from the proof
// that pins it. The lone consumer below reads `.source` to build its own global
// copy for occurrence counting, so this constant needs no flags of its own.
const AGENT_DISABLE_LINE = BRAIN_TIER_AGENT_PROOFS[0].patterns[0];

/**
 * The first live service, spelled ONCE so the span's trailing anchor and the
 * ordering search cannot drift to two different literals for the same concept.
 * Consumers wrap it in their own anchors: the span anchor pins the whole line,
 * while the ordering search uses a `^[^#\n]*` prefix so it still locates the
 * service in the top-level view when other tokens precede it.
 */
export const FIRST_LIVE_SERVICE = String.raw`systemctl enable --now postgresql\.service`;

/**
 * The agent proofs are pinned BETWEEN these two lines, both inclusive.
 *
 * The leading anchor is the last statement that gives "$ENV_FILE" its final
 * root:gbrain 0640 ownership and mode: the readability proof is a statement
 * about exactly those permissions, so a proof that ran before this line would
 * prove the wrong thing. The trailing anchor is the first live service: every
 * proof says nothing useful once PostgreSQL holds real credentials.
 */
const PROOF_SPAN_ANCHORS = {
  start: /^[ \t]*chmod 0640 "\$ENV_FILE"[ \t]*$/m,
  end: new RegExp(String.raw`^[ \t]*${FIRST_LIVE_SERVICE}[ \t]*$`, 'm'),
} as const;

/**
 * Structural lines the pinned span may contain beyond the proofs themselves:
 * the two anchors, the fatal diagnostics, and the block terminators that the
 * proofs' own `if`/`|| {` forms require. Everything else in the span is a line
 * the contract never authorized.
 */
export const PROOF_SPAN_STRUCTURE = [
  PROOF_SPAN_ANCHORS.start,
  PROOF_SPAN_ANCHORS.end,
  /^[ \t]*echo "[^"]*" >&2[ \t]*$/m,
  /^[ \t]*exit 2[ \t]*$/m,
  /^[ \t]*fi[ \t]*$/m,
  /^[ \t]*\}[ \t]*$/m,
] as const;

/**
 * The span allow-list, FULLY ANCHORED — this is the whole point of the file's
 * headline mechanism and it must not be a presence probe. `BRAIN_TIER_AGENT_PROOFS`
 * patterns are prefix probes (`^[^#\n]*…` with no end anchor): reused verbatim as
 * an allow-list they authorize any statement appended after the pinned text, so
 * `openclaw_groups="$(id -nG openclaw)"; openclaw_groups=openclaw` matches the
 * prefix, runs the proof, then overwrites its result — addition, not deletion,
 * which is exactly the class this file exists to catch.
 *
 * Every line the pinned span may legitimately contain is therefore spelled here
 * to its WHOLE real form: each leading wildcard is narrowed to `[^#\n;&|]*` so it
 * cannot swallow a separator-joined second command, and each line is terminated
 * (`[ \t]*$`, or the exact trailing `; then` / `|| {` / redirect it really ends
 * with) so nothing may follow the proof on its line. The bounded-storage row is
 * one logical line after `joinShellContinuations`, so its four `||`-joined
 * comparisons are pinned as a single anchored line here.
 *
 * This mirrors the finalizer proof block line-for-line rather than deriving from
 * the prefix probes, because a prefix probe cannot be mechanically anchored to a
 * line whose real tail varies. A new proof that lands in the finalizer without a
 * matching row here fails closed: its line reads as unauthorized until the row
 * is added, which is the safe direction.
 */
// The proof lines that capture a command's output into a variable. Their
// prefix is anchored to a BARE variable assignment — `^[ \t]*NAME="$(` — rather
// than the permissive `[^#\n;&|]*`. That wildcard blocked a `;`/`&`/`|`-joined
// second command but still admitted a leading backtick or `$(…)` command
// substitution, which needs no separator: `` `touch x` openclaw_groups="$(id
// -nG openclaw)"`` ran an arbitrary command inside the sealed span while still
// counting as an authorized proof line. Requiring a bare assignment first makes
// a leading command substitution impossible while preserving the legitimate
// `$(…)` on the assignment's RHS.
const ASSIGNMENT_CAPTURE_PREFIX = String.raw`^[ \t]*[A-Za-z_][A-Za-z0-9_]*="\$\(`;

const PROOF_SPAN_PROOF_LINES = [
  /^[ \t]*systemctl disable --now gbrain-agent\.service[ \t]*$/m,
  new RegExp(
    ASSIGNMENT_CAPTURE_PREFIX
      + String.raw`systemctl is-enabled gbrain-agent\.service 2>/dev/null \|\| true\)"[ \t]*$`,
    'm',
  ),
  /^[ \t]*if \[\[ "\$agent_enabled_state" != "disabled" \]\]; then[ \t]*$/m,
  /^[ \t]*if systemctl is-active --quiet gbrain-agent\.service; then[ \t]*$/m,
  new RegExp(ASSIGNMENT_CAPTURE_PREFIX + String.raw`id -nG openclaw\)"[ \t]*$`, 'm'),
  /^[ \t]*if \[\[ "\$openclaw_groups" != "openclaw" \]\]; then[ \t]*$/m,
  /^[ \t]*sudo -u openclaw true[ \t]*$/m,
  /^[ \t]*if sudo -u openclaw test -r "\$ENV_FILE"; then[ \t]*$/m,
  new RegExp(
    ASSIGNMENT_CAPTURE_PREFIX + String.raw`findmnt -n -o SOURCE --target /var/lib/openclaw\)" \|\| \{[ \t]*$`,
    'm',
  ),
  new RegExp(
    ASSIGNMENT_CAPTURE_PREFIX + String.raw`findmnt -n -o FSTYPE --target /var/lib/openclaw\)"[ \t]*$`,
    'm',
  ),
  new RegExp(
    ASSIGNMENT_CAPTURE_PREFIX + String.raw`findmnt -n -o OPTIONS --target /var/lib/openclaw\)"[ \t]*$`,
    'm',
  ),
  new RegExp(
    ASSIGNMENT_CAPTURE_PREFIX + String.raw`blockdev --getsize64 "\$openclaw_source"\)" \|\| \{[ \t]*$`,
    'm',
  ),
  // The bounded-storage comparison, joined from four backslash-continued `||`
  // clauses into one logical line. The four `||`-joined comparisons are pinned
  // in this exact order, so reordering them for readability requires updating
  // this pattern too. The size bound is built from the contract constant so it
  // cannot drift here independently of the proof table.
  new RegExp(
    String.raw`^[ \t]*if \[\[ "\$openclaw_fstype" != "ext4" \]\][ \t]+\|\| \[\[ "\$openclaw_size" -ne `
      + `${AGENT_RUNTIME_CONTRACT.storageLimitBytes}`
      + String.raw` \]\][ \t]+\|\| \[\[ ",\$openclaw_options," != \*,nodev,\* \]\][ \t]+`
      + String.raw`\|\| \[\[ ",\$openclaw_options," != \*,nosuid,\* \]\]; then[ \t]*$`,
    'm',
  ),
  /^[ \t]*iptables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d 127\.0\.0\.0\/8 -j REJECT[ \t]*$/m,
  /^[ \t]*ip6tables -C OUTPUT -m owner --uid-owner openclaw -p tcp --dport 5432 -d ::1\/128 -j REJECT[ \t]*$/m,
] as const;

// Shared PREFIX for the three distinct span failures below, so existing
// assertions that match on this prefix still recognize every span error while
// each pushed message also names the specific offending text.
export const PINNED_SPAN_ERROR =
  'Brain-tier cloud-init must keep the agent proofs in one pinned top-level block';

/**
 * Every proof guard inside the span must ABORT on its failure branch. A proof
 * is either an `if …; then … exit 2; fi` guard or a `… || { … exit 2; }` guard;
 * the terminating `exit 2` is what turns a failed proof into a stopped
 * provisioning run. Deleting that lone `exit 2` — leaving the opener, the
 * `echo … >&2` diagnostic, and the closing `fi`/`}` — keeps every pinned
 * character and every pinned condition intact, so neither the anchored
 * allow-list nor the completeness check notices, yet cloud-init would then warn
 * and CONTINUE past a failed proof instead of failing closed.
 *
 * This ties each guard's mandatory abort to its opener by walking the span and
 * requiring every `if …; then` / `… || {` opener to reach an `exit 2` before
 * its matching `fi` / `}`. A stack handles the (currently flat) nesting so an
 * `exit 2` credits only the innermost open guard — a nested guard cannot borrow
 * an outer abort it never reaches. Expects the joined, span-sliced source: the
 * bounded-storage `if` is one line by then.
 */
function verifyProofGuardsAbort(span: string, errors: string[]): void {
  const opensGuard = /(?:;[ \t]*then|\|\|[ \t]*\{)$/;
  const closesGuard = /^(?:fi|\})$/;
  const isExit2 = /^exit 2$/;
  const openGuardsSawExit: boolean[] = [];
  for (const raw of span.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (opensGuard.test(line)) {
      openGuardsSawExit.push(false);
      continue;
    }
    if (closesGuard.test(line)) {
      // A closer with no matching opener is a structural error the anchored
      // allow-list already reports; ignore it here rather than underflow.
      if (openGuardsSawExit.length === 0) continue;
      if (!openGuardsSawExit.pop()) {
        errors.push(
          `${PINNED_SPAN_ERROR}: a proof guard does not abort with exit 2 before its close`,
        );
      }
      continue;
    }
    if (isExit2.test(line) && openGuardsSawExit.length > 0) {
      openGuardsSawExit[openGuardsSawExit.length - 1] = true;
    }
  }
}

/**
 * Pins the proof block's SHAPE rather than reasoning about shell semantics.
 *
 * Presence and ordering searches both answer questions about text that happens
 * to appear somewhere; neither can tell live code from an uncalled function
 * body, heredoc data, or a decoy copy left early so a first-occurrence search
 * finds it. The finalizer must keep the proofs as one contiguous, visible,
 * top-level sequence between its anchors anyway, so this asserts that directly:
 * every code line between the anchors is either a proof pattern or an
 * authorized structural line, and every proof row is complete WITHIN the span.
 *
 * That one check catches an inserted `if …; then` opener, a function header of
 * any form, a heredoc opener, and a decoy copy — without any shell analysis.
 */
function verifyPinnedProofSpan(source: string, errors: string[]): void {
  const startAt = source.search(PROOF_SPAN_ANCHORS.start);
  const endAt = source.search(PROOF_SPAN_ANCHORS.end);
  if (startAt < 0 || endAt < 0 || endAt <= startAt) {
    errors.push(`${PINNED_SPAN_ERROR}: the span anchors are missing or out of order`);
    return;
  }
  const endLine = source.slice(endAt).split('\n', 1)[0] ?? '';
  const span = source.slice(startAt, endAt + endLine.length);

  // Fully-anchored allow-list, NOT the prefix probes: see PROOF_SPAN_PROOF_LINES.
  const allowed = [...PROOF_SPAN_STRUCTURE, ...PROOF_SPAN_PROOF_LINES];
  const unauthorized = span
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('#'))
    .filter(line => !allowed.some(pattern => pattern.test(line)));
  for (const line of unauthorized) {
    errors.push(`${PINNED_SPAN_ERROR}: unauthorized line \`${line}\``);
  }
  // Every row must also be complete inside the span, or a block relocated past
  // the first live service would leave an authorized-looking husk behind. The
  // prefix probes are the right tool here: they answer "does this proof appear
  // in the span at all", where the anchored allow-list answers "may this exact
  // line appear".
  const incompleteRows = BRAIN_TIER_AGENT_PROOFS.filter(({ patterns }) =>
    patterns.some(pattern => !pattern.test(span)),
  );
  for (const { message } of incompleteRows) {
    errors.push(`${PINNED_SPAN_ERROR}: \`${message}\` is not complete inside the span`);
  }
  // Neither check above notices a proof whose fatal `exit 2` alone was deleted:
  // every remaining line is authorized and every condition still matches. Pin
  // each guard's abort directly so the terminating `exit 2` cannot be dropped.
  verifyProofGuardsAbort(span, errors);
}

// Verifies that Brain-tier cloud-init proves the agent inert on a real VM.
// Appends to `errors`; never throws.
function verifyBrainTierAgentProofs(finalizer: string, errors: string[]): void {
  const source = joinShellContinuations(finalizer);
  const topLevel = topLevelShell(source);
  verifyPinnedProofSpan(source, errors);
  // Every proof, not just the disable, must land before the first live service:
  // five of the six say nothing useful once PostgreSQL holds real credentials.
  const firstServiceAt = topLevel.search(new RegExp(String.raw`^[^#\n]*${FIRST_LIVE_SERVICE}`, 'm'));
  let orderingReported = false;
  for (const { patterns, message } of BRAIN_TIER_AGENT_PROOFS) {
    let latest = -1;
    for (const pattern of patterns) {
      const at = topLevel.search(pattern);
      if (at < 0) {
        latest = -1;
        break;
      }
      latest = Math.max(latest, at);
    }
    // A missing proof already reports its own cause; adding the ordering error
    // on top would name two failures for one edit.
    if (latest < 0) {
      errors.push(message);
      continue;
    }
    if (!orderingReported && (firstServiceAt < 0 || latest > firstServiceAt)) {
      errors.push('Brain-tier cloud-init must prove the agent is inert before starting services');
      orderingReported = true;
    }
  }
  // Without this, a decoy disable left early satisfies the ordering check while
  // the real block runs late.
  const everyDisableLine = new RegExp(AGENT_DISABLE_LINE.source, 'gm');
  if ((topLevel.match(everyDisableLine)?.length ?? 0) > 1) {
    errors.push('Brain-tier cloud-init must disable gbrain-agent.service exactly once');
  }
  // Prohibitions read the joined source rather than the top-level view: hiding
  // `set +e` or a re-activation inside a function still changes what runs.
  for (const { pattern, message } of BRAIN_TIER_AGENT_PROHIBITIONS) {
    if (pattern.test(source)) errors.push(message);
  }
}

export async function verifyImageBundle(root: string): Promise<ImageBundleReport> {
  const errors: string[] = [];
  const packer = await text(join(root, 'workspace.pkr.hcl'), errors);
  const build = await text(join(root, 'build.sh'), errors);
  const cloudInit = await text(join(root, 'cloud-init.example.yaml'), errors);
  const provision = await text(join(root, 'scripts', 'provision.sh'), errors);
  const finalizer = await text(join(root, 'files', 'bin', 'gbrain-cloud-init-finalize'), errors);
  const openclawLauncher = await text(join(root, 'files', 'bin', 'openclaw'), errors);
  const openclawManifest = await text(join(root, 'openclaw', 'package.json'), errors);
  const openclawLock = await text(join(root, 'openclaw', 'package-lock.json'), errors);
  let manifest: { dependencies?: Record<string, string> } = {};
  let lock: {
    lockfileVersion?: number;
    packages?: Record<string, { version?: string; resolved?: string; integrity?: string }>;
  } = {};
  try {
    manifest = JSON.parse(openclawManifest);
    lock = JSON.parse(openclawLock);
  } catch {
    errors.push('OpenClaw package manifest and lockfile must be valid JSON');
  }
  if (manifest.dependencies?.openclaw !== AGENT_RUNTIME_CONTRACT.openclawVersion) {
    errors.push('OpenClaw package.json must pin openclaw@2026.7.1-2');
  }
  const lockedOpenclaw = lock.packages?.['node_modules/openclaw'];
  if (
    lock.lockfileVersion !== 3
    || lockedOpenclaw?.version !== AGENT_RUNTIME_CONTRACT.openclawVersion
    || !lockedOpenclaw.resolved?.startsWith('https://registry.npmjs.org/openclaw/-/')
    || !lockedOpenclaw.integrity?.startsWith('sha512-')
  ) {
    errors.push('OpenClaw package-lock.json must lock the exact registry artifact with integrity');
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (
      path.startsWith('node_modules/')
      && entry.resolved?.startsWith('https://registry.npmjs.org/')
      && !entry.integrity?.startsWith('sha512-')
    ) {
      errors.push(`OpenClaw lockfile dependency lacks registry integrity: ${path}`);
    }
  }

  const builder = /source\s+"oracle-oci"\s+"[^"]+"/.test(packer) ? 'oracle-oci' : null;
  if (!builder) errors.push('workspace.pkr.hcl does not declare an oracle-oci builder');
  if (!/provision\.sh \/tmp\/gbrain-source\.tar\.gz \/opt\/gbrain-image"/.test(packer)) {
    errors.push('workspace.pkr.hcl must pass the complete image bundle to provision.sh');
  }
  if (!/\bpacker\s+init\b/.test(build) || !/\bpacker\s+build\b/.test(build)) {
    errors.push('build.sh must initialize Packer plugins and build the image in one invocation');
  }
  if (!/git -C "\$REPO_ROOT" status --porcelain --untracked-files=all/.test(build)) {
    errors.push('build.sh must refuse dirty worktrees before deriving image inputs');
  }
  if (
    !/git -C "\$REPO_ROOT" archive[\s\S]*HEAD:cloud\/image[\s\S]*files openclaw scripts\/provision\.sh/.test(
      build,
    )
  ) {
    errors.push('build.sh must archive image files, the OpenClaw lock, and provisioner from one HEAD');
  }

  for (const key of REQUIRED_CLOUD_INIT_KEYS) {
    const declaration = new RegExp(`^\\s*${key}=.+$`, 'm');
    if (!declaration.test(cloudInit)) {
      errors.push(`cloud-init.example.yaml does not declare ${key}`);
    }
    const finalizerRequirement = new RegExp(`^\\s{2}${key}\\s*$`, 'm');
    if (!finalizerRequirement.test(finalizer)) {
      errors.push(`gbrain-cloud-init-finalize does not require ${key}`);
    }
  }
  if (!/runcmd:[\s\S]*gbrain-cloud-init-finalize/.test(cloudInit)) {
    errors.push('cloud-init.example.yaml must run gbrain-cloud-init-finalize');
  }

  if (
    !/"postgresql-\$\{POSTGRES_MAJOR\}"/.test(provision)
    || !/postgresql-\$\{POSTGRES_MAJOR\}-pgvector/.test(provision)
    || !/CREATE EXTENSION IF NOT EXISTS vector/.test(finalizer)
  ) {
    errors.push('provision.sh must install PostgreSQL with pgvector');
  }
  if (!/\bcaddy\b/.test(provision) || !/reverse_proxy 127\.0\.0\.1:3131/.test(finalizer)) {
    errors.push('the image must install Caddy and proxy Workspace over HTTPS');
  }
  if (!/bun build --compile/.test(provision)) {
    errors.push('provision.sh must install a compiled gbrain binary');
  }
  if (!provision.includes(`NODE_VERSION="${AGENT_RUNTIME_CONTRACT.nodeVersion}"`)) {
    errors.push('provision.sh must pin Node.js 24.15.0');
  }
  if (!provision.includes(`NODE_SHA256="${AGENT_RUNTIME_CONTRACT.nodeSha256}"`)) {
    errors.push('provision.sh must verify the pinned Node.js ARM64 archive');
  }
  if (
    !/sha256sum --check/.test(provision)
    || !/npm"[\s\\\n]+ci --omit=dev --no-audit --no-fund/.test(provision)
    || !/installed_openclaw_version/.test(provision)
  ) {
    errors.push('provision.sh must integrity-install and verify the locked OpenClaw runtime');
  }
  if (
    !openclawLauncher.includes('/opt/node-v24.15.0/bin/node')
    || !openclawLauncher.includes('/opt/openclaw/node_modules/openclaw/openclaw.mjs')
    || /\/usr\/bin\/env\s+node/.test(openclawLauncher)
  ) {
    errors.push('the OpenClaw launcher must use absolute root-owned runtime paths');
  }
  if (
    !provision.includes(
      'chown -R root:root "/opt/node-v${NODE_VERSION}" /opt/openclaw /usr/local/bin/openclaw',
    )
  ) {
    errors.push('provision.sh must keep /opt runtime trees and /usr/local/bin/openclaw root-owned');
  }
  if (
    !provision.includes(
      'chmod -R go-w "/opt/node-v${NODE_VERSION}" /opt/openclaw /usr/local/bin/openclaw',
    )
  ) {
    errors.push(
      'provision.sh must keep /opt runtime trees and /usr/local/bin/openclaw non-group/world-writable',
    );
  }
  const identityChecks: Array<[RegExp, string]> = [
    [/groupadd --system openclaw/, 'provision.sh must create the openclaw system group'],
    [
      /useradd --system --gid openclaw --home-dir \/var\/lib\/openclaw[\s\\\n]+--no-create-home --shell \/usr\/sbin\/nologin openclaw/,
      'provision.sh must create the dedicated unprivileged openclaw identity',
    ],
    [
      /openclaw_uid="\$\(id -u openclaw\)"[\s\S]*if \[\[ "\$openclaw_uid" -eq 0 \|\| "\$openclaw_uid" -lt 100 \|\| "\$openclaw_uid" -gt 999 \]\]; then/,
      'provision.sh must require a nonzero Ubuntu system UID for openclaw',
    ],
    [
      /openclaw_primary_group="\$\(id -gn openclaw\)"[\s\S]*openclaw_primary_gid="\$\(getent group "\$openclaw_primary_group" \| cut -d: -f3\)"[\s\S]*if \[\[ "\$openclaw_primary_group" != "openclaw" \]\][\s\\\n]+\|\| \[\[ "\$openclaw_primary_gid" -eq 0 \|\| "\$openclaw_primary_gid" -lt 100 \|\| "\$openclaw_primary_gid" -gt 999 \]\]; then/,
      'provision.sh must require openclaw as the nonzero Ubuntu system primary group',
    ],
    [
      /if \[\[ "\$\(getent passwd openclaw \| cut -d: -f6\)" != "\/var\/lib\/openclaw" \]\]; then[\s\S]*exit 2/,
      'provision.sh must fail unless openclaw uses /var/lib/openclaw as its home directory',
    ],
    [
      /openclaw_groups="\$\(id -nG openclaw\)"[\s\S]*if \[\[ "\$openclaw_groups" != "openclaw" \]\]; then/,
      'provision.sh must require openclaw to belong only to the openclaw group',
    ],
    [
      /for prohibited_group in gbrain sudo; do[\s\S]*id -nG openclaw[\s\S]*grep -Fxq "\$prohibited_group"/,
      'provision.sh must fail if openclaw joins the gbrain group',
    ],
    [
      /for prohibited_group in gbrain sudo; do/,
      'provision.sh must fail if openclaw joins the sudo group',
    ],
    [
      /if \[\[ "\$\(getent passwd openclaw \| cut -d: -f7\)" != "\/usr\/sbin\/nologin" \]\]; then[\s\S]*exit 2/,
      'provision.sh must fail unless openclaw uses /usr/sbin/nologin',
    ],
  ];
  for (const [pattern, message] of identityChecks) {
    if (!pattern.test(provision)) errors.push(message);
  }
  if (
    !/OPENCLAW_STORAGE_BYTES=\$\(\(10 \* 1024 \* 1024 \* 1024\)\)/.test(provision)
    || !/mkfs\.ext4 -F -L openclaw-state/.test(provision)
    || !/\/var\/lib\/openclaw\.img \/var\/lib\/openclaw ext4 loop,nodev,nosuid 0 2/.test(provision)
    || !/blockdev --getsize64/.test(provision)
  ) {
    errors.push('OpenClaw persistent storage must be a 10 GiB nodev,nosuid ext4 loop filesystem');
  }
  const openclawDirectoryChecks: Array<[RegExp, string]> = [
    [
      /install -d -m 0700 -o openclaw -g openclaw[\s\\\n]+\/var\/lib\/openclaw\/\.openclaw[\s\\\n]+\/var\/lib\/openclaw\/browser[\s\\\n]+\/var\/lib\/openclaw\/workspace/,
      'OpenClaw state, browser, and workspace directories must be mode 0700 and owned by openclaw',
    ],
    [
      /ln -sfn \.\.\/browser \/var\/lib\/openclaw\/\.openclaw\/browser[\s\S]*chown -h openclaw:openclaw \/var\/lib\/openclaw\/\.openclaw\/browser/,
      'OpenClaw state must link its browser path to the owned browser directory',
    ],
    [
      /install -d -m 0750 -o root -g openclaw \/etc\/openclaw/,
      '/etc/openclaw must be mode 0750 and owned by root:openclaw',
    ],
  ];
  for (const [pattern, message] of openclawDirectoryChecks) {
    if (!pattern.test(provision)) errors.push(message);
  }
  if (
    !/iptables -C OUTPUT -m owner --uid-owner openclaw[\s\\\n]+-p tcp --dport 5432 -d 127\.0\.0\.0\/8 -j REJECT/.test(provision)
    || !/ip6tables -C OUTPUT -m owner --uid-owner openclaw[\s\\\n]+-p tcp --dport 5432 -d ::1\/128 -j REJECT/.test(provision)
  ) {
    errors.push('the openclaw UID must be denied direct PostgreSQL loopback access');
  }
  if (
    !/systemctl is-active --quiet[\s\\\n]+postgresql\.service[\s\\\n]+gbrain-worker\.service[\s\\\n]+gbrain-scheduler\.service[\s\\\n]+gbrain-web\.service[\s\\\n]+caddy\.service/.test(
      finalizer,
    )
  ) {
    errors.push('cloud-init must verify every required service is active');
  }

  for (const service of SUPERVISED_SERVICES) {
    const unit = await text(join(root, 'files', 'systemd', service), errors);
    if (!/^Restart=always$/m.test(unit)) {
      errors.push(`${service} must restart after failure`);
    }
    if (!/^WantedBy=multi-user\.target$/m.test(unit)) {
      errors.push(`${service} must be installable at boot`);
    }
    if (!/^EnvironmentFile=\/etc\/gbrain\/workspace\.env$/m.test(unit)) {
      errors.push(`${service} must consume the cloud-init environment`);
    }
    if (!unit.includes(`ExecStart=${SERVICE_COMMANDS[service]}`)) {
      errors.push(`${service} must execute the updateable gbrain binary`);
    }
    const enabledByFinalizer = new RegExp(`systemctl\\s+enable\\s+--now\\s+${service.replace('.', '\\.')}`);
    if (!enabledByFinalizer.test(finalizer)) {
      errors.push(`${service} is not enabled by cloud-init`);
    }
  }

  const agentService = join(root, 'files', 'systemd', 'gbrain-agent.service');
  const agentPresent = await exists(agentService);
  if (!agentPresent) errors.push('missing required image artifact: gbrain-agent.service');
  verifyBrainTierAgentProofs(finalizer, errors);
  await verifyAgentFinalization(root, provision, errors);
  // A drop-in directory overrides the shipped unit exactly like an appended line.
  // Bundle scope only: provision.sh installs the four units by name and never
  // copies a `.d/` directory, so this cannot see a drop-in added on a live VM.
  if (await exists(`${agentService}.d`)) {
    errors.push('gbrain-agent.service must have no drop-in overrides');
  }
  if (agentPresent) await verifyAgentUnit(agentService, errors);

  const credentialHelper = await exists(join(root, 'files', 'bin', 'gbrain-git-credential'));
  if (!credentialHelper) errors.push('missing inert git credential helper');
  const updateScriptPath = join(root, 'files', 'bin', 'gbrain-update');
  const updateScript = await text(updateScriptPath, errors);
  const hasUpdateScript = updateScript.length > 0;
  if (!/systemctl is-active --quiet "\$\{services\[@\]\}"/.test(updateScript)) {
    errors.push('the manual updater must verify every supervised service after restart');
  }

  return {
    builder,
    requiredCloudInitKeys: REQUIRED_CLOUD_INIT_KEYS,
    supervisedServices: SUPERVISED_SERVICES,
    disabledServices: agentPresent ? ['gbrain-agent.service'] : [],
    agentRuntime: AGENT_RUNTIME_CONTRACT,
    hasCredentialHelper: credentialHelper,
    hasUpdateScript,
    errors,
  };
}

if (import.meta.main) {
  const root = process.argv.find(arg => arg.startsWith('--root='))?.slice('--root='.length)
    ?? import.meta.dir;
  const report = await verifyImageBundle(root);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.errors.length === 0) {
    console.log('2Brain workspace image contract: OK');
  } else {
    for (const error of report.errors) console.error(`- ${error}`);
  }
  if (report.errors.length > 0) process.exitCode = 1;
}
