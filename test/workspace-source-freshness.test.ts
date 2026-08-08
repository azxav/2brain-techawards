import { describe, expect, test } from 'bun:test';
import { evaluateSourceFreshness } from '../src/workspace/source-freshness.ts';

describe('Source Freshness policy', () => {
  test('becomes Due soon at exactly the final 20 percent of a timed cadence', () => {
    expect(evaluateSourceFreshness({
      expectedCadence: 'daily',
      lastVerifiedAt: '2026-07-12T00:00:00.000Z',
      knownUnsynchronizedRevision: null,
      latestVerificationOutcome: 'succeeded',
      now: '2026-07-12T19:12:00.000Z',
    })).toMatchObject({ state: 'due_soon', reason: 'verification_due_soon' });
  });

  test('remains Current immediately before the final 20 percent', () => {
    expect(evaluateSourceFreshness({
      expectedCadence: 'daily',
      lastVerifiedAt: '2026-07-12T00:00:00.000Z',
      knownUnsynchronizedRevision: null,
      latestVerificationOutcome: 'succeeded',
      now: '2026-07-12T19:11:59.999Z',
    })).toMatchObject({ state: 'current', reason: 'verified_within_cadence' });
  });

  test('becomes Stale exactly when a timed cadence elapses', () => {
    expect(evaluateSourceFreshness({
      expectedCadence: 'daily',
      lastVerifiedAt: '2026-07-12T00:00:00.000Z',
      knownUnsynchronizedRevision: null,
      latestVerificationOutcome: 'succeeded',
      now: '2026-07-13T00:00:00.000Z',
    })).toMatchObject({ state: 'stale', reason: 'verification_overdue', potentiallyOutdated: true });
  });

  test('known unsynchronized changes make any cadence Stale', () => {
    expect(evaluateSourceFreshness({
      expectedCadence: 'manual',
      lastVerifiedAt: '2026-07-12T00:00:00.000Z',
      knownUnsynchronizedRevision: 'revision-2',
      latestVerificationOutcome: 'succeeded',
      now: '2026-07-13T00:00:00.000Z',
    })).toMatchObject({ state: 'stale', reason: 'known_unsynchronized_changes', potentiallyOutdated: true });
  });

  test('a failed requested verification makes any cadence Stale', () => {
    expect(evaluateSourceFreshness({
      expectedCadence: 'hourly',
      lastVerifiedAt: '2026-07-12T23:55:00.000Z',
      knownUnsynchronizedRevision: null,
      latestVerificationOutcome: 'failed',
      now: '2026-07-13T00:00:00.000Z',
    })).toMatchObject({ state: 'stale', reason: 'requested_verification_failed', potentiallyOutdated: true });
  });

  test('Manual stays Current after its latest requested verification succeeds', () => {
    expect(evaluateSourceFreshness({
      expectedCadence: 'manual',
      lastVerifiedAt: '2020-01-01T00:00:00.000Z',
      knownUnsynchronizedRevision: null,
      latestVerificationOutcome: 'succeeded',
      now: '2026-07-13T00:00:00.000Z',
    })).toMatchObject({ state: 'current', reason: 'manual_verification_succeeded' });
  });

  test('Manual is Unknown without requested verification evidence', () => {
    expect(evaluateSourceFreshness({
      expectedCadence: 'manual',
      lastVerifiedAt: null,
      knownUnsynchronizedRevision: null,
      latestVerificationOutcome: null,
      now: '2026-07-13T00:00:00.000Z',
    })).toMatchObject({ state: 'unknown', reason: 'insufficient_verification_evidence' });
  });

  test('uses the same 80-to-100-percent window for Hourly, Daily, and Weekly', () => {
    const cases = [
      ['hourly', '2026-07-12T00:48:00.000Z', 'due_soon'],
      ['hourly', '2026-07-12T00:59:59.999Z', 'due_soon'],
      ['daily', '2026-07-12T23:59:59.999Z', 'due_soon'],
      ['weekly', '2026-07-17T14:24:00.000Z', 'due_soon'],
      ['weekly', '2026-07-18T23:59:59.999Z', 'due_soon'],
    ] as const;
    expect(cases.map(([expectedCadence, now]) => evaluateSourceFreshness({
      expectedCadence,
      lastVerifiedAt: '2026-07-12T00:00:00.000Z',
      knownUnsynchronizedRevision: null,
      latestVerificationOutcome: 'succeeded',
      now,
    }).state)).toEqual(cases.map(([, , expected]) => expected));
  });
});
