# CI pipeline

Measured 2026-10-12 from GitHub Actions timestamps. Wall-clock runs from workflow creation to the last completed CI job. Percentiles use the sorted index `floor((n - 1) * percentile)`.

## Before

The comparable cohort contains ten successful pull request runs with twelve server shards and mobile native static analysis. The cohort median is 2:25, p90 is 2:59, and median runner use is 26.97 minutes. A broader twenty-run pull request sample has a 2:17 median and 2:56 p90. The server shard that finishes last is on the critical path in fifteen of those twenty runs; native lint is last in four, and Build is last in one.

The representative baseline run [38318766538](https://github.com/supabitapp/supacode-next/actions/runs/38318766538) takes 2:33. Test Server 12 runs checkout, runtime setup, dependency installation, Chromium installation, and tests for 60 seconds. Chromium installation takes 6 seconds at the median and 31 seconds at p90 across 240 shard jobs. The mobile native job installs its Homebrew tools after runtime and workspace setup.

## Changes

- Server shards list their selected files with the configured weighted sequencer and install Chromium only when a `.browser.test.ts` file is selected.
- Mobile native tool installation starts after checkout and joins before lint, overlapping runtime and workspace setup.
- Server shards install the `supacode` and `@supacode/scripts` dependency closures, which selects 28 of 33 workspace projects.

Change detection, the required `Check` gate, transfer reports, concurrency, coverage, native change detection, and deployment safeguards remain unchanged.

## After

The first completed run on measured commit [`b1c3fbb`](https://github.com/supabitapp/supacode-next/actions/runs/38323596556) takes 2:25 and uses 28.28 runner minutes. Its critical path is Test Server 9, then `Check`; the server test jobs start near 23:43:15Z, the slowest server shard finishes at 23:45:01Z, and `Check` finishes at 23:45:37Z. The native tools finish in 16 seconds while workspace setup continues, and only Test Server 12 installs Chromium.

| Cohort                              | Samples | Median |           p90 | Median runner minutes |
| ----------------------------------- | ------: | -----: | ------------: | --------------------: |
| Comparable pull request runs before |      10 |   2:25 |          2:59 |                 26.97 |
| Pull request run after, `b1c3fbb`   |       1 |   2:25 | not available |                 28.28 |

The measured wall-clock change is 0 seconds, 0.0%, against the comparable median. Runner use is 1.31 minutes higher, or 4.9%, in this run. The predicted 2:04 chain was not confirmed because runner startup and test execution remained the dominant path. The setup levers fired and all required checks passed, but the sample does not establish a push-to-green improvement.

## Trend and next measurement

The server test inventory is 416 files at `b1c3fbb`, down from 459 at `862c911255869d854eb75708af0ab5159f2b61c3` when counted with `git ls-tree -r --name-only SHA apps/server` and the `.test.ts` or `.test.tsx` suffixes. Re-measure after ten comparable runs or when the server test inventory grows by 100 files. Keep the selective Chromium install and overlapping native setup until that cohort measurement distinguishes runner variance from a cost regression.

## Remaining levers

- A larger comparable cohort is required before crediting or reverting the setup changes.
- Vitest shared module state remains deferred because server files use integration state and the isolated suite needs leak-safe mocks.
- A lighter test environment remains deferred because the server suite exercises SQLite, Git, and orchestration runtimes together.
- Paid or larger runners remain deferred because this change does not require additional capacity or spending.

The Android preview upload is limited by the EAS free-plan local-build quota in [run 38322562804](https://github.com/supabitapp/supacode-next/actions/runs/38322562804), after the APK built and uploaded. It is outside this CI workflow and no quota or spending change was made.
