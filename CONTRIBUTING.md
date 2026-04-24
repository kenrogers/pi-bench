# Contributing

Thanks for helping make Pi-Bench more useful.

## Development

```bash
npm install
npm run verify
pi -e ./src/extension.ts
```

## Benchmark Tasks

Good tasks should be small, deterministic, and easy to inspect. They should
reward generalization beyond visible tests without hiding ambiguous product
requirements.

When adding or changing scoring behavior, add a calibration test in
`tests/scoring.test.ts` that describes the score band you expect.

## Pull Requests

- Keep benchmark fixtures dependency-light.
- Do not commit generated run data from `~/.pi/agent/pi-bench`.
- Document scoring changes in `docs/methodology.md`.
- Run `npm run verify` before opening a PR.
