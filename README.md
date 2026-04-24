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
- fuzzy OpenRouter model resolution
- visible and hidden test scoring
- process scoring from Pi tool events
- provider/API interruption tracking
- local history and setup suggestions

Public score sharing is intentionally not included yet.

## Requirements

- Node.js 20+
- Pi 0.70+
- An OpenRouter API key

## Install

Install Pi-Bench as a Pi package from GitHub:

```bash
pi install git:github.com/kenrogers/pi-bench
```

Then launch Pi normally from any project where you want to run the benchmark:

```bash
pi
```

For a pinned install, use a tag or commit:

```bash
pi install git:github.com/kenrogers/pi-bench@v0.1.0
```

For local development, clone the repo and run the extension directly:

```bash
git clone https://github.com/kenrogers/pi-bench.git
cd pi-bench
npm install
pi -e ./src/extension.ts
```

## OpenRouter Keys

Pi-Bench is OpenRouter-first. If Pi already has an OpenRouter key, Pi-Bench
reuses it. If not, `/pibench run` prompts for one and saves it through Pi's
normal auth storage at `~/.pi/agent/auth.json`.

You can also set `OPENROUTER_API_KEY` before launching Pi.

Run:

```text
/pibench doctor
```

to check whether Pi-Bench can see a Pi OpenRouter key.

## Commands

```text
/pibench run [suite] [model query]
/pibench compare [suite] model one vs model two [vs model three]
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
/pibench run qwen/qwen3-coder
/pibench run deepseek 4
/pibench run quick deepseek coder
/pibench compare quick deepseek 4 flash vs qwen/qwen3-coder vs kimi k2
/pibench doctor
/pibench history
/pibench suggest
```

Model selection is OpenRouter-only and fuzzy. If the current Pi model is already
an OpenRouter model, `/pibench run quick` uses it. Otherwise Pi-Bench asks which
OpenRouter model to run. Queries like `deepseek 4` are matched against
OpenRouter's live `/api/v1/models` list so recent releases can be used before
Pi's generated model registry knows about them. If OpenRouter finds a match that
Pi does not know yet, Pi-Bench registers a temporary `openrouter-live` provider.

`/pibench compare` runs multiple models sequentially. Separate model queries
with `vs`, `|`, or commas. Each model gets its own fresh workspace and history
entry, but all runs in the comparison share the same generated task seed so the
scores are easier to compare.

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

## Troubleshooting

### DeepSeek reasoning_content errors

Some DeepSeek models on OpenRouter require reasoning content to be replayed
during thinking-mode tool calls. Pi-Bench patches active benchmark requests so
OpenRouter's `reasoning` field is also sent as DeepSeek's expected
`reasoning_content` field. If you still see a `reasoning_content` provider
error, update Pi-Bench and restart Pi.

## Development

```bash
npm install
npm run verify
pi -e ./src/extension.ts
```

To test package installation from a checkout, run `pi install .`.

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
