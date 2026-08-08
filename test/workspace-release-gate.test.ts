import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  evaluateWorkspaceRelease,
  verifyWorkspaceReleaseFile,
  type WorkspaceReleaseManifest,
} from '../scripts/verify-workspace-release.ts';

function passingManifest(): WorkspaceReleaseManifest {
  return {
    issue: 34,
    release: '2Brain v1',
    generated_at: '2026-07-14T00:00:00.000Z',
    evidence: {
      full_test_run: { path: 'docs/verification/full-test-run.md', status: 'pass' },
      trust_evidence: { path: 'docs/verification/trust-evidence.md', status: 'pass' },
      security_matrix: { path: 'docs/verification/security-matrix.md', status: 'pass' },
      design_evidence_ledger: { path: 'docs/designs/2brain-notion-evidence-matrix.md', status: 'pass' },
      accessibility_report: { path: 'docs/verification/accessibility-report.md', status: 'pass' },
      performance_report: { path: 'docs/verification/performance-report.md', status: 'pass' },
      export_inspection: { path: 'docs/verification/export-inspection.md', status: 'pass' },
      retention_evidence: { path: 'docs/verification/retention-evidence.md', status: 'pass' },
      recovery_evidence: { path: 'docs/verification/recovery-evidence.md', status: 'pass' },
      rollback_evidence: { path: 'docs/verification/rollback-evidence.md', status: 'pass' },
      primary_browser_journey: { path: 'docs/verification/browser-journey.md', status: 'pass' },
      postgres_parity: { path: 'docs/verification/postgres-parity.md', status: 'pass' },
    },
    gates: {
      functional: { status: 'pass', evidence: ['full_test_run', 'primary_browser_journey', 'postgres_parity'] },
      trust: { status: 'pass', evidence: ['trust_evidence', 'full_test_run', 'postgres_parity'] },
      security: { status: 'pass', evidence: ['security_matrix', 'export_inspection', 'postgres_parity'] },
      experience: { status: 'pass', evidence: ['design_evidence_ledger', 'accessibility_report', 'performance_report', 'primary_browser_journey'] },
      operations: { status: 'pass', evidence: ['retention_evidence', 'recovery_evidence', 'rollback_evidence', 'export_inspection', 'performance_report', 'postgres_parity'] },
    },
  };
}

describe('2Brain five-gate release verification', () => {
  test('one failed gate blocks an otherwise passing release without changing the other verdicts', () => {
    const manifest = passingManifest();
    manifest.gates.trust.status = 'fail';

    const verdict = evaluateWorkspaceRelease(manifest, () => true);

    expect(verdict.status).toBe('blocked');
    expect(verdict.gates).toEqual({
      functional: 'pass',
      trust: 'fail',
      security: 'pass',
      experience: 'pass',
      operations: 'pass',
    });
  });

  test('a missing evidence file fails every gate that relies on it', () => {
    const manifest = passingManifest();

    const verdict = evaluateWorkspaceRelease(
      manifest,
      path => path !== manifest.evidence.postgres_parity.path,
    );

    expect(verdict.status).toBe('blocked');
    expect(verdict.gates).toEqual({
      functional: 'fail',
      trust: 'fail',
      security: 'fail',
      experience: 'pass',
      operations: 'fail',
    });
    expect(verdict.findings).toContainEqual({
      code: 'evidence_file_missing',
      evidence: 'postgres_parity',
      path: 'docs/verification/postgres-parity.md',
    });
  });

  test('omitting a required release artifact fails its owning gate', () => {
    const manifest = passingManifest();
    delete manifest.evidence.accessibility_report;
    manifest.gates.experience.evidence = manifest.gates.experience.evidence
      .filter(evidence => evidence !== 'accessibility_report');

    const verdict = evaluateWorkspaceRelease(manifest, () => true);

    expect(verdict.status).toBe('blocked');
    expect(verdict.gates.experience).toBe('fail');
    expect(verdict.findings).toContainEqual({
      code: 'required_evidence_missing',
      evidence: 'accessibility_report',
      gate: 'experience',
    });
  });

  test('a failed evidence report cannot be overridden by a passing gate declaration', () => {
    const manifest = passingManifest();
    manifest.evidence.design_evidence_ledger.status = 'fail';

    const verdict = evaluateWorkspaceRelease(manifest, () => true);

    expect(verdict.status).toBe('blocked');
    expect(verdict.gates.experience).toBe('fail');
    expect(verdict.findings).toContainEqual({
      code: 'evidence_failed',
      evidence: 'design_evidence_ledger',
      path: 'docs/designs/2brain-notion-evidence-matrix.md',
    });
  });

  test('evidence paths cannot escape the repository', () => {
    const manifest = passingManifest();
    manifest.evidence.full_test_run.path = '../outside.md';

    const verdict = evaluateWorkspaceRelease(manifest, () => true);

    expect(verdict.status).toBe('blocked');
    expect(verdict.gates.functional).toBe('fail');
    expect(verdict.findings).toContainEqual({
      code: 'evidence_path_invalid',
      evidence: 'full_test_run',
      path: '../outside.md',
    });
  });

  test('the command reports all five passing gates and exits successfully', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'workspace-release-'));
    try {
      const manifest = passingManifest();
      for (const evidence of Object.values(manifest.evidence)) {
        const path = join(repoRoot, evidence.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, '# Verified\n');
      }
      const manifestPath = join(repoRoot, 'release.json');
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const result = spawnSync(process.execPath, [
        join(import.meta.dir, '..', 'scripts', 'verify-workspace-release.ts'),
        manifestPath,
        '--repo-root',
        repoRoot,
      ], { encoding: 'utf8' });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Functional: PASS');
      expect(result.stdout).toContain('Trust: PASS');
      expect(result.stdout).toContain('Security: PASS');
      expect(result.stdout).toContain('Experience: PASS');
      expect(result.stdout).toContain('Operations: PASS');
      expect(result.stdout).toContain('2Brain v1 RELEASE PASS');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  // The tests above prove the evaluator's rules against a fixture. This one
  // proves the release this repository actually ships satisfies them, so a
  // renamed or deleted evidence file fails here instead of at release time.
  test('the committed release manifest passes every gate against the real evidence files', () => {
    const repoRoot = join(import.meta.dir, '..');
    const { manifest, verdict } = verifyWorkspaceReleaseFile(
      join(repoRoot, 'docs', 'verification', '2brain-release.json'),
      repoRoot,
    );

    expect(manifest.issue).toBe(34);
    expect(verdict.findings).toEqual([]);
    expect(verdict.gates).toEqual({
      functional: 'pass',
      trust: 'pass',
      security: 'pass',
      experience: 'pass',
      operations: 'pass',
    });
    expect(verdict.status).toBe('pass');
  });

  test('required evidence must be linked from every gate that owns it', () => {
    const manifest = passingManifest();
    manifest.gates.security.evidence = manifest.gates.security.evidence
      .filter(evidence => evidence !== 'export_inspection');

    const verdict = evaluateWorkspaceRelease(manifest, () => true);

    expect(verdict.status).toBe('blocked');
    expect(verdict.gates.security).toBe('fail');
    expect(verdict.findings).toContainEqual({
      code: 'required_evidence_unlinked',
      evidence: 'export_inspection',
      gate: 'security',
    });
  });
});
