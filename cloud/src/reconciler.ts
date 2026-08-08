/**
 * The guarded reconciler loop (#48).
 *
 * The interval guard used to live inline in index.ts and assumed every tick
 * settles. One adapter promise that never did left the guard held forever:
 * every later interval fire returned at the first line, provisioning froze for
 * the whole fleet, and the journal showed nothing at all. The watchdog here
 * makes that class of failure cost one tick: a tick that outlives its wall-clock
 * bound is abandoned — logged loudly, guard released — and the next interval
 * fire reconciles whatever else is claimable. The abandoned tick's workspace
 * stays leased until its lease lapses, so nothing else touches it meanwhile.
 */
import { runProvisioningTick, type ProvisioningDeps, type TickOutcome } from './provisioning.ts';

export interface ReconcilerOptions {
  /**
   * Wall-clock bound on a single tick. Generous next to the adapters' own
   * timeouts (workspace 10s, compute/dns 30s): tripping it means an adapter's
   * bound failed to hold, which is a bug report, not an operating mode.
   */
  watchdogMs?: number;
  /** One line per event, journal-bound. Injected so tests can record it. */
  log?: (line: string) => void;
}

export type RunOutcome = 'ran' | 'skipped' | 'stalled';

export interface Reconciler {
  /** One guarded drain: ticks until there is no uncontended progress left. */
  runOnce(): Promise<RunOutcome>;
  /** Production entry: runOnce on an interval, overlap refused by the guard. */
  start(intervalMs: number): ReturnType<typeof setInterval>;
}

export function createReconciler(deps: ProvisioningDeps, options: ReconcilerOptions = {}): Reconciler {
  const watchdogMs = options.watchdogMs ?? 90_000;
  const log = options.log ?? (line => console.error(line));
  let ticking = false;

  /**
   * Race the tick against the watchdog. An abandoned tick keeps running in the
   * background; its eventual settlement is logged (and its rejection swallowed —
   * an abandoned promise must never become an unhandled rejection).
   */
  function boundedTick(): Promise<TickOutcome | 'stalled'> {
    return new Promise((resolve, reject) => {
      let abandoned = false;
      const timer = setTimeout(() => {
        abandoned = true;
        resolve('stalled');
      }, watchdogMs);
      runProvisioningTick(deps).then(
        outcome => {
          clearTimeout(timer);
          if (abandoned) log(`[control-plane] an abandoned provisioning tick eventually settled: ${outcome}`);
          else resolve(outcome);
        },
        error => {
          clearTimeout(timer);
          if (abandoned) log(`[control-plane] an abandoned provisioning tick eventually failed: ${(error as Error).message}`);
          else reject(error);
        },
      );
    });
  }

  async function runOnce(): Promise<RunOutcome> {
    if (ticking) return 'skipped';
    ticking = true;
    try {
      for (;;) {
        const outcome = await boundedTick();
        if (outcome === 'stalled') {
          log(
            `[control-plane] provisioning tick stalled: still running after ${watchdogMs}ms; ` +
              'abandoning it so the reconciler keeps serving the rest of the fleet',
          );
          return 'stalled';
        }
        if (outcome !== 'advanced') return 'ran';
        // 'advanced': keep going while there is uncontended progress to make.
      }
    } catch (error) {
      // A tick must never take the process down: the row keeps the state, and
      // the next tick retries. Adapter errors are already free of credentials.
      log(`[control-plane] provisioning tick failed: ${(error as Error).message}`);
      return 'ran';
    } finally {
      ticking = false;
    }
  }

  return {
    runOnce,
    start(intervalMs: number) {
      return setInterval(() => {
        void runOnce();
      }, intervalMs);
    },
  };
}
