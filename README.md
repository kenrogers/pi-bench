# Pi-Bench

Pi-Bench is a local [Pi](https://github.com/badlogic/pi-mono) extension for
benchmarking real agentic coding setups against OpenRouter models.

It scores the combination people actually use:

```text
Pi setup + selected model + tools + prompts + permissions + generated coding task
```

That makes Pi-Bench a **rig benchmark**, not a pure model leaderboard. A score
answers: "How well did this model work inside my Pi setup on this coding task?"

## Status

Pi-Bench is early but usable. The first public release includes:

- local benchmark run generation
- fuzzy Pi/OpenRouter model resolution
- visible and hidden test scoring
- process scoring from Pi tool events
- provider/API interruption tracking
- local history and setup suggestions

Public score sharing is intentionally not included yet.

## Requirements

- Node.js 20+
- Pi 0.70+
- A configured model in Pi
- Optional but recommended: an OpenRouter key configured in Pi for live model lookup

## Install

Clone the repo, install dependencies, and run Pi with the extension:

```bash
git clone https://github.com/badlogic/pi-bench.git
cd pi-bench
npm install
pi -e ./src/extension.ts
```

You can also install it as a Pi package from a checkout:

```bash
pi install .
```

Then launch Pi normally from a project where you want to run the benchmark.

## OpenRouter Keys

Pi-Bench uses Pi's existing model registry. If Pi already has an OpenRouter key,
Pi-Bench can reuse it. The extension does not store OpenRouter credentials.

Run:

```text
/pibench doctor
```

to check whether Pi-Bench can see a Pi OpenRouter key.

## Commands

```text
/pibench run [suite] [model query]
/pibench doctor
/pibench history
/pibench suggest
/pibench status
/pibench score
```

Examples:

```text
/pibench run quick
/pibench run quick openrouter/qwen/qwen3-coder
/pibench run deepseek 4
/pibench run quick deepseek coder
/pibench doctor
/pibench history
/pibench suggest
```

Model selection is fuzzy. Pi-Bench checks Pi's available model registry first,
then searches OpenRouter's live `/api/v1/models` list for recent releases and
aliases. If OpenRouter finds a match that Pi's generated registry does not know
yet, Pi-Bench registers a temporary `openrouter-live` provider using your
existing Pi OpenRouter key.

## How It Works

`/pibench run` creates a fresh generated workspace under:

```text
~/.pi/agent/pi-bench/runs/<run-id>/workspace
```

Pi receives a benchmark prompt telling it to fix the generated repo. When the
agent believes it is done, it should call the `pibench_submit` tool. The tool
runs visible and hidden checks, computes a score, records historical data, and
shows a short report.

If a provider/API error interrupts the agent before submission, you can run:

```text
/pibench score
```

to score the current workspace. Interrupted runs receive correctness credit for
the patch but lose process points.

## Score Shape

Pi-Bench records:

- correctness from visible and hidden tests
- process quality from Pi events and tool calls
- churn from changed source lines
- provider/API interruptions during the active run
- model/setup metadata and local history
- suggestions for improving the Pi setup

Current weighting:

- 25 points: visible-test pass ratio
- 55 points: hidden-test pass ratio
- 15 points: observed process quality
- 5 points: small-task efficiency/churn

Repeated submissions for the same run update one history row and increment the
attempt count, so `/pibench history` shows the latest result for each run rather
than duplicate partial attempts.

See [docs/methodology.md](docs/methodology.md) for the scoring philosophy and
calibration scenarios.

## Development

```bash
npm install
npm run verify
pi -e ./src/extension.ts
```

`npm run verify` runs TypeScript checking and the calibration tests.

## Roadmap

- More task packs: frontend, migration, repo-injection, flaky-test, vague-report
- Richer time/cost reporting
- Visual dashboard inside Pi custom UI
- Historical score charts
- Optional headless runner using `@openrouter/agent`
- Optional private/public sharing later

## License

MIT
