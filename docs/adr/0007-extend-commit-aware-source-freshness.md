# Extend the existing commit-aware Source freshness model

2Brain will reuse the project's existing commit- and content-aware Source health calculation, then add Source-specific Expected Cadence and a Due soon state for the Workspace. Hourly, Daily, and Weekly Sources use the final 20% of their interval for Due soon and become Stale when the interval elapses; Manual Sources never become Due soon or Stale from time alone, but known unsynchronized changes or a failed requested verification can make them Stale. A separate dashboard formula was rejected because doctor, CLI, advisor, and UI surfaces must share one truth, and quiet Sources with unchanged content must not become stale merely because their last synchronization is old.

ADR-0049 clarifies that this calculation applies to Managed Git Sources. Built-in and unmanaged core Sources have no Git verification contract and report Source Freshness as **Not applicable**, never fabricated Current, Unknown, or Stale evidence.
