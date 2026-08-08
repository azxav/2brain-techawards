import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  AGENT_PILOT_EVIDENCE_KEYS,
  AGENT_PILOT_RELEASE_NAME,
  evaluateAgentPilotRelease,
  verifyAgentPilotReleaseFile,
  type AgentPilotArtifactInspection,
  type AgentPilotEvidenceKey,
  type AgentPilotReleaseManifest,
} from '../scripts/verify-agent-pilot-release.ts';
import {
  evaluateWorkspaceRelease,
  REQUIRED_WORKSPACE_RELEASE_EVIDENCE,
  type WorkspaceReleaseManifest,
} from '../scripts/verify-workspace-release.ts';

const SUBJECT_SHA = '4f1c2b9a7d0e6a35c81b04f9d27e5a63c9081bfe';

function passingAgentPilotManifest(): AgentPilotReleaseManifest {
  return {
    release: '2Brain Agent customer pilot',
    generated_at: '2026-07-29T12:00:00.000Z',
    vm_started_at: '2026-07-29T09:00:00.000Z',
    subject_commit_sha: SUBJECT_SHA,
    openclaw_version: '2026.7.1-2',
    issues: {
      61: { state: 'closed', checked_at: '2026-07-29T11:55:00.000Z' },
      68: { state: 'closed', checked_at: '2026-07-29T11:56:00.000Z' },
    },
    evidence: {
      subject_commit_sha: SUBJECT_SHA,
      artifacts: {
        full_test_run: { path: 'docs/verification/agent-pilot-full-test.md', status: 'pass' },
        postgres_parity: { path: 'docs/verification/agent-pilot-postgres.md', status: 'pass' },
        browser_native: { path: 'docs/verification/agent-pilot-browser-native.md', status: 'pass' },
        provider_models: { path: 'docs/verification/agent-pilot-browser-native.md', status: 'pass' },
        approvals: { path: 'docs/verification/agent-pilot-browser-native.md', status: 'pass' },
        member_revocation: { path: 'docs/verification/agent-pilot-browser-native.md', status: 'pass' },
        export_redaction: { path: 'docs/verification/agent-pilot-browser-native.md', status: 'pass' },
        network_isolation: { path: 'docs/verification/agent-pilot-vm-isolation.md', status: 'pass' },
        public_loopback_dependencies: { path: 'docs/verification/agent-pilot-vm-isolation.md', status: 'pass' },
        vm_updates: { path: 'docs/verification/agent-pilot-vm-isolation.md', status: 'pass' },
      },
    },
  };
}

function passingArtifactInspector(
  manifest: AgentPilotReleaseManifest,
): (path: string) => AgentPilotArtifactInspection {
  const known = new Set(
    Object.values(manifest.evidence.artifacts).map(artifact => artifact.path),
  );
  return path => known.has(path)
    ? { exists: true, status: 'pass', subjectCommitSha: manifest.evidence.subject_commit_sha }
    : { exists: false, status: null, subjectCommitSha: null };
}

function evidenceHeader(options: {
  status?: string;
  sha?: string;
  verifiedAt?: string;
} = {}): string {
  return [
    '```yaml',
    `status: ${options.status ?? 'pass'}`,
    `subject_commit_sha: ${options.sha ?? SUBJECT_SHA}`,
    `verified_at: ${options.verifiedAt ?? '2026-07-29T11:00:00.000Z'}`,
    '```',
    '',
    '# Agent pilot evidence',
    '',
    'Every listed check passed on the disposable VM.',
    '',
  ].join('\n');
}

function writeAgentPilotRepo(options: {
  manifest?: AgentPilotReleaseManifest;
  reports?: Record<string, string>;
} = {}): { repoRoot: string; manifestPath: string; manifest: AgentPilotReleaseManifest } {
  const manifest = options.manifest ?? passingAgentPilotManifest();
  const repoRoot = mkdtempSync(join(tmpdir(), 'agent-pilot-release-'));
  const paths = new Set(Object.values(manifest.evidence.artifacts).map(artifact => artifact.path));
  for (const path of paths) {
    const absolute = join(repoRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, options.reports?.[path] ?? evidenceHeader());
  }
  for (const [path, body] of Object.entries(options.reports ?? {})) {
    if (paths.has(path)) continue;
    const absolute = join(repoRoot, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, body);
  }
  const manifestPath = join(repoRoot, 'docs', 'verification', 'agent-pilot-release.json');
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { repoRoot, manifestPath, manifest };
}

// The manifest type requires every evidence key, which is the point of the
// gate; dropping one is what a hand-edited manifest does.
function dropEvidence(
  manifest: AgentPilotReleaseManifest,
  key: AgentPilotEvidenceKey,
): AgentPilotReleaseManifest {
  delete (manifest.evidence.artifacts as Partial<Record<AgentPilotEvidenceKey, unknown>>)[key];
  return manifest;
}

function findingCodes(manifest: AgentPilotReleaseManifest): string[] {
  return evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest))
    .findings.map(finding => finding.code);
}

describe('2Brain Agent customer pilot release gate', () => {
  test('the passing fixture authorizes release, so every later block is caused by its own mutation', () => {
    const manifest = passingAgentPilotManifest();

    expect(evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest))).toEqual({
      status: 'pass',
      findings: [],
    });
  });

  test('issue 61 open blocks an otherwise passing pilot', () => {
    const manifest = passingAgentPilotManifest();
    manifest.issues[61].state = 'open';

    expect(evaluateAgentPilotRelease(
      manifest, passingArtifactInspector(manifest),
    )).toMatchObject({
      status: 'blocked',
      findings: expect.arrayContaining([{ code: 'ship_gate_issue_open', issue: 61 }]),
    });
  });

  test('issue 68 open blocks an otherwise passing pilot', () => {
    const manifest = passingAgentPilotManifest();
    manifest.issues[68].state = 'open';

    const verdict = evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'ship_gate_issue_open', issue: 68 });
  });

  test('recording the dependency under a different issue number blocks the pilot', () => {
    const manifest = passingAgentPilotManifest();
    const issues = manifest.issues as unknown as Record<string, unknown>;
    issues['69'] = issues['68'];
    delete issues['68'];

    const verdict = evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'ship_gate_issue_missing', issue: 68 });
  });

  test('an unrecognized issue state blocks instead of counting as closed', () => {
    const manifest = passingAgentPilotManifest();
    (manifest.issues[68] as { state: string }).state = 'merged';

    const verdict = evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'ship_gate_issue_state_invalid', issue: 68 });
  });

  test('a missing issue check timestamp blocks the pilot', () => {
    const manifest = passingAgentPilotManifest();
    (manifest.issues[61] as { checked_at?: string }).checked_at = undefined;

    const verdict = evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'ship_gate_issue_check_invalid', issue: 61 });
  });

  test('a different OpenClaw version blocks the pilot', () => {
    const manifest = passingAgentPilotManifest();
    (manifest as { openclaw_version: string }).openclaw_version = '2026.7.1-3';

    const verdict = evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'openclaw_version_mismatch' });
  });

  test('a different release name blocks the pilot', () => {
    const manifest = passingAgentPilotManifest();
    (manifest as { release: string }).release = '2Brain v1';

    const verdict = evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'release_mismatch' });
  });

  test.each([
    ['all zeroes', '0'.repeat(40)],
    ['uppercase', SUBJECT_SHA.toUpperCase()],
    ['abbreviated', SUBJECT_SHA.slice(0, 12)],
    ['a branch name', 'agent-tier'],
    ['empty', ''],
  ])('a subject commit SHA that is %s blocks the pilot', (_label, sha) => {
    const manifest = passingAgentPilotManifest();
    manifest.subject_commit_sha = sha;
    manifest.evidence.subject_commit_sha = sha;

    const verdict = evaluateAgentPilotRelease(manifest, path => ({
      exists: true,
      status: 'pass',
      subjectCommitSha: sha,
    }));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'subject_commit_sha_invalid' });
  });

  test('evidence recorded against a different subject commit blocks the pilot', () => {
    const manifest = passingAgentPilotManifest();
    manifest.evidence.subject_commit_sha = 'a'.repeat(40);

    const verdict = evaluateAgentPilotRelease(manifest, path => ({
      exists: true,
      status: 'pass',
      subjectCommitSha: manifest.evidence.subject_commit_sha,
    }));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'subject_commit_sha_mismatch' });
  });

  test('missing VM-update evidence blocks the pilot', () => {
    const manifest = dropEvidence(passingAgentPilotManifest(), 'vm_updates');

    expect(evaluateAgentPilotRelease(
      manifest, passingArtifactInspector(manifest),
    ).status).toBe('blocked');
  });

  test.each([...AGENT_PILOT_EVIDENCE_KEYS])('omitting %s evidence blocks the pilot', key => {
    const manifest = dropEvidence(passingAgentPilotManifest(), key);

    const verdict = evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'evidence_missing', evidence: key });
  });

  test.each([...AGENT_PILOT_EVIDENCE_KEYS])('a failed %s report blocks the pilot', key => {
    const manifest = passingAgentPilotManifest();
    manifest.evidence.artifacts[key].status = 'fail';

    const verdict = evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'evidence_failed', evidence: key });
  });

  test.each([
    ['absolute posix', '/etc/passwd'],
    ['absolute windows', 'C:/secrets/report.md'],
    ['parent traversal', '../outside/report.md'],
    ['nested traversal', 'docs/../../outside/report.md'],
    ['empty', ''],
  ])('an evidence path that is %s blocks the pilot', (_label, path) => {
    const manifest = passingAgentPilotManifest();
    manifest.evidence.artifacts.network_isolation.path = path;

    const verdict = evaluateAgentPilotRelease(manifest, () => ({
      exists: true,
      status: 'pass',
      subjectCommitSha: SUBJECT_SHA,
    }));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({
      code: 'evidence_path_invalid',
      evidence: 'network_isolation',
    });
  });

  test('an evidence file that does not exist blocks the pilot', () => {
    const manifest = passingAgentPilotManifest();
    const inspect = passingArtifactInspector(manifest);

    const verdict = evaluateAgentPilotRelease(manifest, path =>
      path === manifest.evidence.artifacts.postgres_parity.path
        ? { exists: false, status: null, subjectCommitSha: null }
        : inspect(path));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({
      code: 'evidence_file_missing',
      evidence: 'postgres_parity',
    });
  });

  test('a manifest cannot declare a report passing when the report says it failed', () => {
    const manifest = passingAgentPilotManifest();
    const inspect = passingArtifactInspector(manifest);

    const verdict = evaluateAgentPilotRelease(manifest, path =>
      path === manifest.evidence.artifacts.browser_native.path
        ? { exists: true, status: 'fail', subjectCommitSha: SUBJECT_SHA }
        : inspect(path));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({
      code: 'evidence_report_failed',
      evidence: 'browser_native',
    });
    expect(verdict.findings).toContainEqual({
      code: 'evidence_report_failed',
      evidence: 'provider_models',
    });
  });

  test('an unreadable report header blocks rather than passing vacuously', () => {
    const manifest = passingAgentPilotManifest();
    const inspect = passingArtifactInspector(manifest);

    const verdict = evaluateAgentPilotRelease(manifest, path =>
      path === manifest.evidence.artifacts.vm_updates.path
        ? { exists: true, status: null, subjectCommitSha: null }
        : inspect(path));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({
      code: 'evidence_report_header_unreadable',
      evidence: 'vm_updates',
    });
  });

  test('a report written against another subject commit blocks the pilot', () => {
    const manifest = passingAgentPilotManifest();
    const inspect = passingArtifactInspector(manifest);

    const verdict = evaluateAgentPilotRelease(manifest, path =>
      path === manifest.evidence.artifacts.full_test_run.path
        ? { exists: true, status: 'pass', subjectCommitSha: 'b'.repeat(40) }
        : inspect(path));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({
      code: 'evidence_report_sha_mismatch',
      evidence: 'full_test_run',
    });
  });

  test.each([
    ['generated_at', 'not-a-timestamp', 'generated_at_invalid'],
    ['vm_started_at', '2026-07-29', 'vm_started_at_invalid'],
  ])('an invalid %s blocks the pilot', (field, value, code) => {
    const manifest = passingAgentPilotManifest();
    (manifest as unknown as Record<string, string>)[field] = value;

    const verdict = evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code });
  });

  test('a manifest generated before the VM started blocks the pilot', () => {
    const manifest = passingAgentPilotManifest();
    manifest.generated_at = '2026-07-29T08:00:00.000Z';

    const verdict = evaluateAgentPilotRelease(manifest, passingArtifactInspector(manifest));

    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'generated_at_before_vm_start' });
  });

  test('the file verifier passes on real reports carrying the matching header', () => {
    const { repoRoot, manifestPath } = writeAgentPilotRepo();
    try {
      const { manifest, verdict } = verifyAgentPilotReleaseFile(manifestPath, repoRoot);

      expect(manifest.subject_commit_sha).toBe(SUBJECT_SHA);
      expect(verdict).toEqual({ status: 'pass', findings: [] });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('report prose after the header cannot supply the verified status', () => {
    const { repoRoot, manifestPath } = writeAgentPilotRepo({
      reports: {
        'docs/verification/agent-pilot-vm-isolation.md': [
          '# Agent pilot VM isolation',
          '',
          'The operator confirmed the following.',
          '',
          '```yaml',
          'status: pass',
          `subject_commit_sha: ${SUBJECT_SHA}`,
          'verified_at: 2026-07-29T11:00:00.000Z',
          '```',
          '',
        ].join('\n'),
      },
    });
    try {
      const { verdict } = verifyAgentPilotReleaseFile(manifestPath, repoRoot);

      expect(verdict.status).toBe('blocked');
      expect(verdict.findings).toContainEqual({
        code: 'evidence_report_header_unreadable',
        evidence: 'network_isolation',
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('a header carrying extra fields is not trusted as configuration', () => {
    const { repoRoot, manifestPath } = writeAgentPilotRepo({
      reports: {
        'docs/verification/agent-pilot-postgres.md': [
          '```yaml',
          'status: fail',
          'override_status: pass',
          `subject_commit_sha: ${SUBJECT_SHA}`,
          'verified_at: 2026-07-29T11:00:00.000Z',
          '```',
          '',
        ].join('\n'),
      },
    });
    try {
      const { verdict } = verifyAgentPilotReleaseFile(manifestPath, repoRoot);

      expect(verdict.status).toBe('blocked');
      expect(verdict.findings).toContainEqual({
        code: 'evidence_report_header_unreadable',
        evidence: 'postgres_parity',
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('a report whose header says fail blocks through the file verifier', () => {
    const { repoRoot, manifestPath } = writeAgentPilotRepo({
      reports: {
        'docs/verification/agent-pilot-browser-native.md': evidenceHeader({ status: 'fail' }),
      },
    });
    try {
      const { verdict } = verifyAgentPilotReleaseFile(manifestPath, repoRoot);

      expect(verdict.status).toBe('blocked');
      expect(verdict.findings).toContainEqual({
        code: 'evidence_report_failed',
        evidence: 'browser_native',
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('the file verifier never reads an evidence path outside the repository', () => {
    const { repoRoot, manifestPath, manifest } = writeAgentPilotRepo();
    const outside = mkdtempSync(join(tmpdir(), 'agent-pilot-outside-'));
    try {
      writeFileSync(join(outside, 'report.md'), evidenceHeader());
      manifest.evidence.artifacts.vm_updates.path = join(outside, 'report.md').replaceAll('\\', '/');
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const { verdict } = verifyAgentPilotReleaseFile(manifestPath, repoRoot);

      expect(verdict.status).toBe('blocked');
      expect(verdict.findings).toContainEqual({
        code: 'evidence_path_invalid',
        evidence: 'vm_updates',
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('the command reports the pass verdict and exits successfully', () => {
    const { repoRoot, manifestPath } = writeAgentPilotRepo();
    try {
      const result = spawnSync(process.execPath, [
        join(import.meta.dir, '..', 'scripts', 'verify-agent-pilot-release.ts'),
        manifestPath,
        '--repo-root',
        repoRoot,
      ], { encoding: 'utf8' });

      expect(result.status).toBe(0);
      expect(result.stdout.trimEnd().split('\n').at(-1))
        .toBe(`${AGENT_PILOT_RELEASE_NAME} RELEASE PASS`);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  test('the command blocks and exits non-zero on the committed non-release example', () => {
    const repoRoot = join(import.meta.dir, '..');

    const result = spawnSync(process.execPath, [
      join(repoRoot, 'scripts', 'verify-agent-pilot-release.ts'),
      join(repoRoot, 'docs', 'verification', 'agent-pilot-release.example.json'),
      '--repo-root',
      repoRoot,
    ], { encoding: 'utf8' });

    expect(result.status).not.toBe(0);
    expect(result.stdout.trimEnd().split('\n').at(-1))
      .toBe(`${AGENT_PILOT_RELEASE_NAME} RELEASE BLOCKED`);
  });

  test('the committed example manifest can never authorize a customer release', () => {
    const repoRoot = join(import.meta.dir, '..');

    const { manifest, verdict } = verifyAgentPilotReleaseFile(
      join(repoRoot, 'docs', 'verification', 'agent-pilot-release.example.json'),
      repoRoot,
    );

    expect(manifest.subject_commit_sha).toBe('0'.repeat(40));
    expect(verdict.status).toBe('blocked');
    expect(verdict.findings).toContainEqual({ code: 'subject_commit_sha_invalid' });
  });

  // Before Task 16 this file does not exist, and its absence is what keeps
  // customer Agent provisioning disabled. Once it lands, a renamed, failed or
  // re-verified-against-a-different-commit evidence report fails here instead
  // of at release time.
  test('a committed pilot manifest, when present, still passes against the real evidence', () => {
    const repoRoot = join(import.meta.dir, '..');
    const manifestPath = join(repoRoot, 'docs', 'verification', 'agent-pilot-release.json');
    if (!existsSync(manifestPath)) {
      expect(existsSync(join(repoRoot, 'docs', 'verification', 'agent-pilot-release.example.json')))
        .toBe(true);
      return;
    }

    const { verdict } = verifyAgentPilotReleaseFile(manifestPath, repoRoot);

    expect(verdict.findings).toEqual([]);
    expect(verdict.status).toBe('pass');
  });

  test('the pilot gate leaves the issue-34 release verifier alone', () => {
    const workspaceManifest: WorkspaceReleaseManifest = {
      issue: 34,
      release: '2Brain v1',
      generated_at: '2026-07-14T00:00:00.000Z',
      evidence: Object.fromEntries(
        Object.keys(REQUIRED_WORKSPACE_RELEASE_EVIDENCE)
          .map(evidence => [evidence, { path: `docs/verification/${evidence}.md`, status: 'pass' as const }]),
      ),
      gates: {
        functional: { status: 'pass', evidence: [] },
        trust: { status: 'pass', evidence: [] },
        security: { status: 'pass', evidence: [] },
        experience: { status: 'pass', evidence: [] },
        operations: { status: 'pass', evidence: [] },
      },
    };
    for (const [evidence, gates] of Object.entries(REQUIRED_WORKSPACE_RELEASE_EVIDENCE)) {
      for (const gate of gates) workspaceManifest.gates[gate].evidence.push(evidence);
    }

    expect(evaluateWorkspaceRelease(workspaceManifest, () => true).status).toBe('pass');
    // The v1 gate keeps its own twelve artifacts; the pilot adds none to it.
    expect(Object.keys(REQUIRED_WORKSPACE_RELEASE_EVIDENCE).sort()).toEqual([
      'accessibility_report',
      'design_evidence_ledger',
      'export_inspection',
      'full_test_run',
      'performance_report',
      'postgres_parity',
      'primary_browser_journey',
      'recovery_evidence',
      'retention_evidence',
      'rollback_evidence',
      'security_matrix',
      'trust_evidence',
    ]);
  });

  test('every required pilot evidence key is enforced', () => {
    const required: AgentPilotEvidenceKey[] = [
      'full_test_run',
      'postgres_parity',
      'browser_native',
      'provider_models',
      'approvals',
      'member_revocation',
      'export_redaction',
      'network_isolation',
      'public_loopback_dependencies',
      'vm_updates',
    ];

    expect([...AGENT_PILOT_EVIDENCE_KEYS].sort()).toEqual([...required].sort());
    for (const key of required) {
      expect(findingCodes(dropEvidence(passingAgentPilotManifest(), key)))
        .toContain('evidence_missing');
    }
  });
});
