# Worker soak: 5 multi-step coding tasks, thinking low vs off

    python3 bench/worker_soak.py --thinking low,off --out bench/results/2026-11-17-worker-soak

- Build: `packages/coding-agent/dist/cli.js` rebuilt from `d085724a3`, run through `examples/worker/run.sh --use-dist` with
  `examples/worker/agent/models.json`, `agent/settings.json` and the `worker-guard` extension. No `models.json` is written by
  the benchmark; the kit's own file is used.
- Model: `opencode-go/deepseek-v4.1-flash`.
- Tasks: fix a bug until `node check.js` prints `PASS`; implement a missing function until its test passes; extract a repeated
  expression into a new module and keep `node app.js` output byte-identical; answer a read-only question about two files;
  create two files and `cat` them. Every score comes from running the check, never from the reply text.
- Five tasks, one run each, per level: 10 live runs, $0.0025 + $0.0023 in total.

| | low | off |
| --- | --- | --- |
| passed | 5/5 | 5/5 |
| turns (sum) | 18 | 17 |
| tool calls (sum) | 18 | 14 |
| output tokens (sum) | 1431 | 1257 |
| output tokens (mean/task) | 286.2 | 251.4 |
| reasoning tokens (sum) | 25 | 0 |
| cache read tokens (sum) | 24576 | 21888 |
| wall seconds (mean/task) | 11.66 | 7.37 |
| tool errors | 0 | 0 |
| loop-breaker trips | 0 | 0 |
| timeouts | 0 | 0 |
| cost (USD) | 0.00250 | 0.00232 |

## What this says

- **No schema-argument failures and no loops.** All 10 runs ended on `stop` after a normal `toolUse` chain. Nothing was
  malformed, retried in a different form, or blocked by the guard's loop breaker. The P5 gate (TypeBox argument repair or a
  `maxTurns` cap only if schema failures exceed 2% or alternating non-identical loops appear) is not met, so both are
  skipped rather than built speculatively.
- **`low` costs about 24% more output tokens and 58% more wall time here, for the same 5/5.** Turns and tool calls are within
  one of each other. The gap is provider latency spread (per-task wall ranges 2.7 s to 13.2 s), not a difference in how the
  worker works.
- **The guard's token cap held.** `maxTokens: 8192` from the kit plus the extension's per-request clamp produced no truncated
  file writes: every task that had to write a file body completed its check on the first try.
- **Cache read is real but small.** 3.5k-6.3k tokens per task at `low`, 1.7k-5.4k at `off`, on a ~1.6k-token system prompt;
  the rest of each request is new.

## Limits

Five tasks, one run each. This shows the kit completes realistic multi-step tool work on the rebuilt bundle, and that the
counted failure modes are absent at this size. It does not rank models or reasoning levels: a 24% token difference on five
samples is one task's variance away from noise. Re-run with more tasks before treating the level comparison as a result.
