#!/usr/bin/env bun

// Offline ship gate for customer Agent Workspace provisioning (issue #68).
// It reads a committed manifest plus the fixed header of each evidence report
// and answers one question: may this exact source commit be offered to
// customers? It never calls GitHub or a cloud provider — the operator records
// authoritative issue state immediately before release. Everything unknown
// blocks: a missing file, an unreadable header and an unparsable state all land
// as findings rather than as silence.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const AGENT_PILOT_RELEASE_NAME = '2Brain Agent customer pilot';
export const AGENT_PILOT_OPENCLAW_VERSION = '2026.7.1-2';
export const AGENT_PILOT_SHIP_GATE_ISSUES = [61, 68] as const;

export const AGENT_PILOT_EVIDENCE_KEYS = [
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
] as const;

export type AgentPilotEvidenceKey = typeof AGENT_PILOT_EVIDENCE_KEYS[number];
export type AgentPilotShipGateIssue = typeof AGENT_PILOT_SHIP_GATE_ISSUES[number];
export type AgentPilotStatus = 'pass' | 'fail';

export interface AgentPilotReleaseManifest {
  release: '2Brain Agent customer pilot';
  generated_at: string;
  vm_started_at: string;
  subject_commit_sha: string;
  openclaw_version: '2026.7.1-2';
  issues: Record<AgentPilotShipGateIssue, {
    state: 'open' | 'closed';
    checked_at: string;
  }>;
  evidence: {
    subject_commit_sha: string;
    artifacts: Record<AgentPilotEvidenceKey, {
      path: string;
      status: AgentPilotStatus;
    }>;
  };
}

export interface AgentPilotReleaseFinding {
  code: string;
  issue?: AgentPilotShipGateIssue;
  evidence?: AgentPilotEvidenceKey;
}

export interface AgentPilotReleaseVerdict {
  status: 'pass' | 'blocked';
  findings: AgentPilotReleaseFinding[];
}

export interface AgentPilotArtifactInspection {
  exists: boolean;
  status: AgentPilotStatus | null;
  subjectCommitSha: string | null;
}

// The evidence-report header is exactly this, at the top of the file, and
// nothing else is read from the report:
//
// ```yaml
// status: pass
// subject_commit_sha: <40 lowercase hex>
// verified_at: <UTC timestamp>
// ```
const EVIDENCE_HEADER_FIELDS = ['status', 'subject_commit_sha', 'verified_at'] as const;

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && UTC_TIMESTAMP.test(value)
    && !Number.isNaN(Date.parse(value));
}

function isSubjectCommitSha(value: unknown): value is string {
  return typeof value === 'string'
    && COMMIT_SHA.test(value)
    && !/^0+$/.test(value);
}

function isRepositoryRelativePath(path: unknown): path is string {
  if (typeof path !== 'string') return false;
  const normalized = path.replaceAll('\\', '/');
  return normalized.length > 0
    && !normalized.startsWith('/')
    && !/^[a-zA-Z]:\//.test(normalized)
    && !normalized.split('/').includes('..');
}

/**
 * Reads the three fixed header fields from an evidence report. A header that is
 * not the first thing in the file, is missing a field, carries an extra field
 * or holds an unparsable value is reported as unreadable — report prose is
 * never treated as configuration.
 */
export function readAgentPilotEvidenceHeader(
  contents: string,
): { status: AgentPilotStatus | null; subjectCommitSha: string | null } {
  const unreadable = { status: null, subjectCommitSha: null };
  const lines = contents.split(/\r?\n/);
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === '') index += 1;
  if (lines[index]?.trim() !== '```yaml') return unreadable;
  index += 1;

  const fields = new Map<string, string>();
  while (index < lines.length && lines[index]!.trim() !== '```') {
    const line = lines[index]!;
    const separator = line.indexOf(':');
    if (separator === -1) return unreadable;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!EVIDENCE_HEADER_FIELDS.includes(key as typeof EVIDENCE_HEADER_FIELDS[number])) return unreadable;
    if (fields.has(key)) return unreadable;
    fields.set(key, value);
    index += 1;
  }
  if (lines[index]?.trim() !== '```') return unreadable;
  if (fields.size !== EVIDENCE_HEADER_FIELDS.length) return unreadable;

  const status = fields.get('status');
  const subjectCommitSha = fields.get('subject_commit_sha');
  if (status !== 'pass' && status !== 'fail') return unreadable;
  if (!isSubjectCommitSha(subjectCommitSha)) return unreadable;
  if (!isUtcTimestamp(fields.get('verified_at'))) return unreadable;

  return { status, subjectCommitSha };
}

export function evaluateAgentPilotRelease(
  manifest: AgentPilotReleaseManifest,
  inspectArtifact: (path: string) => AgentPilotArtifactInspection,
): AgentPilotReleaseVerdict {
  const findings: AgentPilotReleaseFinding[] = [];

  if (manifest?.release !== AGENT_PILOT_RELEASE_NAME) {
    findings.push({ code: 'release_mismatch' });
  }

  const issues = (manifest?.issues ?? {}) as Partial<Record<string, { state?: string; checked_at?: string }>>;
  for (const issue of AGENT_PILOT_SHIP_GATE_ISSUES) {
    const recorded = issues[String(issue)];
    if (!recorded) {
      findings.push({ code: 'ship_gate_issue_missing', issue });
      continue;
    }
    if (recorded.state !== 'open' && recorded.state !== 'closed') {
      findings.push({ code: 'ship_gate_issue_state_invalid', issue });
    } else if (recorded.state === 'open') {
      findings.push({ code: 'ship_gate_issue_open', issue });
    }
    if (!isUtcTimestamp(recorded.checked_at)) {
      findings.push({ code: 'ship_gate_issue_check_invalid', issue });
    }
  }

  if (manifest?.openclaw_version !== AGENT_PILOT_OPENCLAW_VERSION) {
    findings.push({ code: 'openclaw_version_mismatch' });
  }

  const subjectSha = manifest?.subject_commit_sha;
  const evidenceSha = manifest?.evidence?.subject_commit_sha;
  if (!isSubjectCommitSha(subjectSha) || !isSubjectCommitSha(evidenceSha)) {
    findings.push({ code: 'subject_commit_sha_invalid' });
  } else if (subjectSha !== evidenceSha) {
    findings.push({ code: 'subject_commit_sha_mismatch' });
  }

  const generatedAt = manifest?.generated_at;
  const vmStartedAt = manifest?.vm_started_at;
  if (!isUtcTimestamp(generatedAt)) findings.push({ code: 'generated_at_invalid' });
  if (!isUtcTimestamp(vmStartedAt)) findings.push({ code: 'vm_started_at_invalid' });
  if (isUtcTimestamp(generatedAt)
    && isUtcTimestamp(vmStartedAt)
    && Date.parse(generatedAt) < Date.parse(vmStartedAt)) {
    findings.push({ code: 'generated_at_before_vm_start' });
  }

  const artifacts = (manifest?.evidence?.artifacts ?? {}) as Partial<
    Record<AgentPilotEvidenceKey, { path?: string; status?: string }>
  >;
  for (const evidence of AGENT_PILOT_EVIDENCE_KEYS) {
    const artifact = artifacts[evidence];
    if (!artifact) {
      findings.push({ code: 'evidence_missing', evidence });
      continue;
    }
    if (artifact.status !== 'pass') {
      findings.push({ code: 'evidence_failed', evidence });
    }
    if (!isRepositoryRelativePath(artifact.path)) {
      findings.push({ code: 'evidence_path_invalid', evidence });
      continue;
    }
    const inspection = inspectArtifact(artifact.path);
    if (!inspection.exists) {
      findings.push({ code: 'evidence_file_missing', evidence });
      continue;
    }
    if (inspection.status === null || inspection.subjectCommitSha === null) {
      findings.push({ code: 'evidence_report_header_unreadable', evidence });
      continue;
    }
    if (inspection.status !== 'pass') {
      findings.push({ code: 'evidence_report_failed', evidence });
    }
    if (inspection.subjectCommitSha !== evidenceSha) {
      findings.push({ code: 'evidence_report_sha_mismatch', evidence });
    }
  }

  return { status: findings.length === 0 ? 'pass' : 'blocked', findings };
}

export function verifyAgentPilotReleaseFile(
  manifestPath: string,
  repoRoot: string,
): { manifest: AgentPilotReleaseManifest; verdict: AgentPilotReleaseVerdict } {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AgentPilotReleaseManifest;
  const inspected = new Map<string, AgentPilotArtifactInspection>();
  const verdict = evaluateAgentPilotRelease(manifest, path => {
    const cached = inspected.get(path);
    if (cached) return cached;
    // Guarded again here, not only in the evaluator: this is the step that
    // touches the filesystem, and it must never resolve a path that escaped
    // the repository.
    const inspection: AgentPilotArtifactInspection = !isRepositoryRelativePath(path)
      || !existsSync(resolve(repoRoot, path))
      ? { exists: false, status: null, subjectCommitSha: null }
      : { exists: true, ...readAgentPilotEvidenceHeader(readFileSync(resolve(repoRoot, path), 'utf8')) };
    inspected.set(path, inspection);
    return inspection;
  });
  return { manifest, verdict };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const repoRootFlag = args.indexOf('--repo-root');
  const repoRoot = repoRootFlag === -1 ? process.cwd() : resolve(args[repoRootFlag + 1] ?? '');
  if (repoRootFlag !== -1) args.splice(repoRootFlag, 2);
  const manifestPath = resolve(args[0] ?? 'docs/verification/agent-pilot-release.json');

  try {
    const { verdict } = verifyAgentPilotReleaseFile(manifestPath, repoRoot);
    for (const finding of verdict.findings) {
      const subject = finding.evidence ?? (finding.issue === undefined ? '' : `#${finding.issue}`);
      process.stdout.write(`- ${finding.code}${subject ? `: ${subject}` : ''}\n`);
    }
    // The constant, never the manifest's own release string: a manifest cannot
    // rename the verdict it failed.
    process.stdout.write(`${AGENT_PILOT_RELEASE_NAME} RELEASE ${verdict.status === 'pass' ? 'PASS' : 'BLOCKED'}\n`);
    process.exit(verdict.status === 'pass' ? 0 : 1);
  } catch (error) {
    process.stderr.write(`Agent pilot release verification failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}
