# Pi-Bench Methodology

Pi-Bench scores the practical result of a real Pi run, not a pure model in
isolation. The score should answer:

> If I use this model with my current Pi setup, how likely is it to ship a good
> small coding change without me babysitting every step?

## Current Score Shape

The score is 100 points:

- 25 points from visible-test pass ratio
- 55 points from hidden-test pass ratio
- 15 points from observed agent process
- 5 points from efficiency, based on small-task churn

Correctness dominates because users ultimately care whether the code works.
Visible tests matter, but hidden tests carry more weight because they measure
whether the agent inferred the general behavior instead of fitting examples.

Process points are intentionally smaller. They reward behaviors people expect
from reliable coding agents:

- read before editing
- edit explicitly
- run tests
- submit after testing
- avoid failed or excessive tool calls
- avoid tool use after submitting
- avoid provider/API errors during the run

Efficiency is a small positive bonus rather than a large penalty. Real agents
often make several reasonable edits on the way to a good patch, so churn should
distinguish clean work from thrashing without drowning out correctness.

## What The Quick Suite Measures

The quick suite generates one tiny dependency-free Node package per run. The
current task catalog covers receipt math, inventory normalization, and settings
parsing. Together they test:

- finding a simple bug from visible failures
- generalizing visible examples into hidden edge cases
- preserving existing behavior while fixing parsing, formatting, and arithmetic
- using the local test loop
- stopping and submitting when done

It is intentionally dependency-free so it can run inside any Pi setup.

## Known Limits

- One small task catalog cannot represent agentic coding broadly. More suites need to cover
  multi-file reasoning, dependency use, vague bug reports, UI work, migrations,
  and failing-test diagnosis.
- Hidden tests are useful, but score calibration must stay visible enough that
  users trust the result.
- Token cost and wall-clock time are not yet first-class score inputs. They
  should become report fields before they become hard penalties.
- Pi-Bench now aborts the active agent turn after a successful submit tool
  result. It can penalize post-submit tool use, but it does not yet turn
  post-submit narration into a separate metric.
- Provider/API errors are treated as reliability failures in the process score.
  A manually scored interrupted run can still receive correctness credit for the
  files it changed, but it should not look like a clean completion.

## Calibration Scenarios

The test suite currently validates these bands:

- untouched scaffold: low score
- mostly-correct visible-pass solution with one hidden miss: high but not top
- complete fix with realistic process: near top
- complete fix with provider/API interruption: correctness credit with process
  penalty
- repeated scoring of the same run: one history row with incremented attempt

These are sanity checks, not a replacement for real model runs.
