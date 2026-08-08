#!/usr/bin/env bun

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const WORKSPACE_RELEASE_GATES = [
  'functional',
  'trust',
  'security',
  'experience',
  'operations',
] as const;

export type WorkspaceReleaseGate = typeof WORKSPACE_RELEASE_GATES[number];
export type WorkspaceReleaseStatus = 'pass' | 'fail';

export const REQUIRED_WORKSPACE_RELEASE_EVIDENCE: Record<string, WorkspaceReleaseGate[]> = {
  full_test_run: ['functional'],
  trust_evidence: ['trust'],
  security_matrix: ['security'],
  design_evidence_ledger: ['experience'],
  accessibility_report: ['experience'],
  performance_report: ['experience', 'operations'],
  export_inspection: ['security', 'operations'],
  retention_evidence: ['operations'],
  recovery_evidence: ['operations'],
  rollback_evidence: ['operations'],
  primary_browser_journey: ['functional', 'experience'],
  postgres_parity: ['functional', 'trust', 'security', 'operations'],
};

export interface WorkspaceReleaseEvidence {
  path: string;
  status: WorkspaceReleaseStatus;
}

export interface WorkspaceReleaseManifest {
  issue: number;
  release: string;
  generated_at: string;
  evidence: Record<string, WorkspaceReleaseEvidence>;
  gates: Record<WorkspaceReleaseGate, {
    status: WorkspaceReleaseStatus;
    evidence: string[];
  }>;
}

export interface WorkspaceReleaseVerdict {
  status: 'pass' | 'blocked';
  gates: Record<WorkspaceReleaseGate, WorkspaceReleaseStatus>;
  findings: Array<
    | { code: 'evidence_file_missing'; evidence: string; path: string }
    | { code: 'evidence_failed'; evidence: string; path: string }
    | { code: 'evidence_path_invalid'; evidence: string; path: string }
    | { code: 'required_evidence_missing'; evidence: string; gate: WorkspaceReleaseGate }
    | { code: 'required_evidence_unlinked'; evidence: string; gate: WorkspaceReleaseGate }
  >;
}

function isRepositoryRelativePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return normalized.length > 0
    && !normalized.startsWith('/')
    && !/^[a-zA-Z]:\//.test(normalized)
    && !normalized.split('/').includes('..');
}

export function evaluateWorkspaceRelease(
  manifest: WorkspaceReleaseManifest,
  artifactExists: (path: string) => boolean,
): WorkspaceReleaseVerdict {
  const invalidPathFindings = Object.entries(manifest.evidence)
    .filter(([, evidence]) => !isRepositoryRelativePath(evidence.path))
    .map(([evidence, value]) => ({
      code: 'evidence_path_invalid' as const,
      evidence,
      path: value.path,
    }));
  const invalidEvidence = new Set(invalidPathFindings.map(finding => finding.evidence));
  const fileFindings = Object.entries(manifest.evidence)
    .filter(([evidenceId, evidence]) => !invalidEvidence.has(evidenceId) && !artifactExists(evidence.path))
    .map(([evidence, value]) => ({
      code: 'evidence_file_missing' as const,
      evidence,
      path: value.path,
    }));
  const failedEvidenceFindings = Object.entries(manifest.evidence)
    .filter(([, evidence]) => evidence.status === 'fail')
    .map(([evidence, value]) => ({
      code: 'evidence_failed' as const,
      evidence,
      path: value.path,
    }));
  const requiredFindings = Object.entries(REQUIRED_WORKSPACE_RELEASE_EVIDENCE)
    .flatMap(([evidence, gates]) => manifest.evidence[evidence]
      ? []
      : gates.map(gate => ({
        code: 'required_evidence_missing' as const,
        evidence,
        gate,
      })));
  const unlinkedFindings = Object.entries(REQUIRED_WORKSPACE_RELEASE_EVIDENCE)
    .flatMap(([evidence, gates]) => !manifest.evidence[evidence]
      ? []
      : gates
        .filter(gate => !manifest.gates[gate].evidence.includes(evidence))
        .map(gate => ({
          code: 'required_evidence_unlinked' as const,
          evidence,
          gate,
        })));
  const findings = [
    ...invalidPathFindings,
    ...fileFindings,
    ...failedEvidenceFindings,
    ...requiredFindings,
    ...unlinkedFindings,
  ];
  const missingEvidence = new Set(fileFindings.map(finding => finding.evidence));
  const gatesMissingRequiredEvidence = new Set(
    [...requiredFindings, ...unlinkedFindings].map(finding => finding.gate),
  );
  const gates = Object.fromEntries(
    WORKSPACE_RELEASE_GATES.map(gate => {
      const declared = manifest.gates[gate];
      const evidencePasses = declared.evidence.every(evidenceId => {
        const evidence = manifest.evidence[evidenceId];
        return evidence?.status === 'pass'
          && !missingEvidence.has(evidenceId)
          && !invalidEvidence.has(evidenceId);
      });
      return [gate, declared.status === 'pass'
        && evidencePasses
        && !gatesMissingRequiredEvidence.has(gate)
        ? 'pass'
        : 'fail'];
    }),
  ) as Record<WorkspaceReleaseGate, WorkspaceReleaseStatus>;

  return {
    status: WORKSPACE_RELEASE_GATES.every(gate => gates[gate] === 'pass') ? 'pass' : 'blocked',
    gates,
    findings,
  };
}

export function verifyWorkspaceReleaseFile(
  manifestPath: string,
  repoRoot: string,
): { manifest: WorkspaceReleaseManifest; verdict: WorkspaceReleaseVerdict } {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspaceReleaseManifest;
  const verdict = evaluateWorkspaceRelease(
    manifest,
    path => existsSync(resolve(repoRoot, path)),
  );
  return { manifest, verdict };
}

function titleCase(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const repoRootFlag = args.indexOf('--repo-root');
  const repoRoot = repoRootFlag === -1 ? process.cwd() : resolve(args[repoRootFlag + 1] ?? '');
  if (repoRootFlag !== -1) args.splice(repoRootFlag, 2);
  const manifestPath = resolve(args[0] ?? 'docs/verification/2brain-release.json');

  try {
    const { manifest, verdict } = verifyWorkspaceReleaseFile(manifestPath, repoRoot);
    for (const gate of WORKSPACE_RELEASE_GATES) {
      process.stdout.write(`${titleCase(gate)}: ${verdict.gates[gate].toUpperCase()}\n`);
    }
    for (const finding of verdict.findings) {
      process.stdout.write(`- ${finding.code}: ${finding.evidence}\n`);
    }
    process.stdout.write(`${manifest.release} RELEASE ${verdict.status === 'pass' ? 'PASS' : 'BLOCKED'}\n`);
    process.exit(verdict.status === 'pass' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`Workspace release verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
