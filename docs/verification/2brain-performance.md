# 2Brain v1 performance report

Measured on 2026-07-14 in the primary browser journey, against real Postgres and
an always-on worker. Verdict: **pass** — every budget met.

Raw samples are in [browser/browser-evidence.json](browser/browser-evidence.json)
under `timings_ms`.

## Budgets (ADR-0034)

| Measurement | Budget | Observed |
| --- | --- | --- |
| Authenticated shell after confirmation | < 2500 ms | 171 ms |
| Knowledge list p95 (20 warmed samples) | < 1000 ms | 60 ms |
| Search p95 (20 warmed samples) | < 1000 ms | 52 ms |
| Search HTTP p95 | reported | 49 ms |
| Ask acknowledgement | < 1000 ms | 161 ms |

## Method, and why it changed

The Knowledge and Search percentiles are measured over 20 warmed, in-page
interactions that alternate between two real filter values and two real queries,
so consecutive samples cannot be served from an unchanged render.

An earlier version of the harness measured these by navigating the document
repeatedly. That polluted the metric with full document load, script parse, and
live-stream bootstrap on every sample — it measured navigation, not the
Knowledge and Search surfaces. The budgets themselves were never relaxed; only
the thing being timed was corrected.

Search records both in-page latency and the underlying HTTP latency
(`search_network_p95`) so a fast render cannot hide a slow query.

## Scale

Scale targets are governed by ADR-0033 (v1 organization scale). This release
verifies the budgets above at the interaction level; it does not claim a
load-tested throughput figure, and no such claim appears in the release
manifest.
