export type ExpectedSourceCadence = 'hourly' | 'daily' | 'weekly' | 'manual';
export type SourceFreshnessState = 'current' | 'due_soon' | 'stale' | 'unknown';
export type SourceFreshnessReason =
  | 'known_unsynchronized_changes'
  | 'requested_verification_failed'
  | 'manual_verification_succeeded'
  | 'verification_overdue'
  | 'verification_due_soon'
  | 'verified_within_cadence'
  | 'insufficient_verification_evidence';

export interface SourceFreshnessInput {
  expectedCadence: ExpectedSourceCadence;
  lastVerifiedAt: string | null;
  knownUnsynchronizedRevision: string | null;
  latestVerificationOutcome: 'succeeded' | 'failed' | null;
  now: string;
}

export interface SourceFreshnessAssessment {
  state: SourceFreshnessState;
  reason: SourceFreshnessReason;
  potentiallyOutdated: boolean;
}

const CADENCE_MS: Record<Exclude<ExpectedSourceCadence, 'manual'>, number> = {
  hourly: 60 * 60_000,
  daily: 24 * 60 * 60_000,
  weekly: 7 * 24 * 60 * 60_000,
};

export function evaluateSourceFreshness(input: SourceFreshnessInput): SourceFreshnessAssessment {
  if (input.knownUnsynchronizedRevision) {
    return { state: 'stale', reason: 'known_unsynchronized_changes', potentiallyOutdated: true };
  }
  if (input.latestVerificationOutcome === 'failed') {
    return { state: 'stale', reason: 'requested_verification_failed', potentiallyOutdated: true };
  }
  if (input.expectedCadence === 'manual' && input.latestVerificationOutcome === 'succeeded') {
    return { state: 'current', reason: 'manual_verification_succeeded', potentiallyOutdated: false };
  }
  if (input.expectedCadence !== 'manual' && input.lastVerifiedAt) {
    const elapsed = Date.parse(input.now) - Date.parse(input.lastVerifiedAt);
    if (elapsed >= CADENCE_MS[input.expectedCadence]) {
      return { state: 'stale', reason: 'verification_overdue', potentiallyOutdated: true };
    }
    if (elapsed >= CADENCE_MS[input.expectedCadence] * 0.8) {
      return { state: 'due_soon', reason: 'verification_due_soon', potentiallyOutdated: false };
    }
    return { state: 'current', reason: 'verified_within_cadence', potentiallyOutdated: false };
  }
  return { state: 'unknown', reason: 'insufficient_verification_evidence', potentiallyOutdated: false };
}
