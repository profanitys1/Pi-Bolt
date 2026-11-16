# Worker mode

Isolated, single-shot configuration and runtime guard for Pi-Bolt worker invocations.

## Worker kit layout

The example kit lives in [examples/worker/](../examples/worker):

- [examples/worker/agent/models.json](../examples/worker/agent/models.json) caps `maxTokens` at `8192` for `opencode-go/deepseek-v4.1-flash` and `deepseek/deepseek-flash`, and maps `thinking: "off"` on `opencode-go/deepseek-v4.1-flash` to `thinkingLevelMap.off: "none"` and `samplingParamsByThinkingLevel.off` (`thinking: { "type": "disabled" }`, `reasoning_effort: "none"`).
- [examples/worker/agent/settings.json](../examples/worker/agent/settings.json) sets defaults (`deepseek/deepseek-flash`, `defaultThinkingLevel: "low"`), disables skills (`"skills": ["!**"]`), disables compaction (`"compaction": { "enabled": false }`), sets `defaultProjectTrust` to `"never"`, turns off install telemetry and analytics, and keeps `retry` at `maxRetries: 3`.
- [examples/worker/extensions/worker-guard.ts](../examples/worker/extensions/worker-guard.ts) enforces request caps, exit-code normalization, and loop termination without runtime package imports.
- [examples/worker/prompt.md](../examples/worker/prompt.md) holds the short instruction block appended with `--append-system-prompt`.
- [examples/worker/run.sh](../examples/worker/run.sh) stages the kit into a temporary `PI_CODING_AGENT_DIR` that is removed on exit, leaving `~/.pi/agent` and the workspace untouched.
- [bench/worker.py](../bench/worker.py) runs headless `--mode json` trials, aggregates usage and cost across all assistant turns, verifies `agent_settled` and non-error `stopReason`, reads RSS from `/usr/bin/time -l` on macOS or `/usr/bin/time -v` on Linux (`null` when neither is available), and writes JSON summaries.

## Guard behavior

`worker-guard.ts` uses `import type` from `@earendil-works/pi-coding-agent` so `jiti` evaluates no runtime imports from the host package. It registers four handlers:

- `agent_start` resets the consecutive failure counter at the start of each run.
- `before_provider_request` clamps `payload.max_tokens` to `8192` whenever the field is missing, non-finite, or above `8192`.
- `tool_result` rewrites `isError` to `false` when `bash` returns `exit_code === 1` for a standalone `rg`, `grep`, `egrep`, `fgrep`, or `diff` command without unquoted shell chaining (`;`, `&`, `|`, `>`, `<`, newlines, backticks, or `$(`) and without `"No such file"`, `"Permission denied"`, `"unrecognized option"`, or `"regex parse error"` in the output text.
- `tool_call` tracks consecutive errors keyed by `${toolName}:${JSON.stringify(input ?? {})}` and blocks the third identical failing call with `{ block: true, terminate: true }`. Any different key or non-error result resets the streak.

## Usage

Print the staged command without running Pi-Bolt:

```bash
examples/worker/run.sh --print-command
```

Run a task using `opencode-go/deepseek-v4.1-flash`:

```bash
OPENCODE_API_KEY=... examples/worker/run.sh \
	--model opencode-go/deepseek-v4.1-flash \
	--thinking off \
	"Reply with the single word: ready"
```

Benchmark five live runs and save the JSON report:

```bash
OPENCODE_API_KEY=... python3 bench/worker.py \
	--runs 5 \
	--model opencode-go/deepseek-v4.1-flash \
	--thinking off \
	--out bench/results/2026-11-16-worker-flash/off.json
```

`bench/worker.py` counts a run in `summary.ok_runs` only when `exit_code == 0`, `settled` is `true` (`agent_settled` with `aborted: false`), and `stop_reason` is not `"error"`, `"aborted"`, `"timeout"`, or `null`. Runs exceeding `--timeout` have their process group killed with `SIGKILL` and are recorded with `exit_code: null`, `settled: false`, `stop_reason: "timeout"`, and `error_message: "timeout after <N>s"`. The `--out` JSON file is always written; `bench/worker.py` exits `0` only when `ok_runs == runs`, and exits `1` otherwise.

## Measured results

Measured on `2026-11-16` on `darwin-arm64` using the installed AOT binary `/Users/filip/.local/bin/pi-bolt` (`1.5.2 (Pi-Bolt 1.2.1, darwin-arm64, JIT off)`) with prompt `"Reply with the single word: ready"`.

Commands executed:

```bash
python3 /Users/filip/Pi-Bolt/bench/worker.py --runs 5 --model opencode-go/deepseek-v4.1-flash --thinking low --out /Users/filip/Pi-Bolt/bench/results/2026-11-16-worker-flash/low.json
python3 /Users/filip/Pi-Bolt/bench/worker.py --runs 5 --model opencode-go/deepseek-v4.1-flash --thinking off --out /Users/filip/Pi-Bolt/bench/results/2026-11-16-worker-flash/off.json
```

| Metric | `thinking: low` (`n=5`) | `thinking: off` (`n=5`) | Source file |
|---|---|---|---|
| Settled runs | `5 / 5` (`"ready"`) | `5 / 5` (`"ready"`) | [low.json](../bench/results/2026-11-16-worker-flash/low.json), [off.json](../bench/results/2026-11-16-worker-flash/off.json) |
| Median wall time | `2.7037 s` (`2.321` to `3.68 s`) | `3.0025 s` (`2.0567` to `3.5904 s`) | `summary.median_wall_s` |
| Median max RSS | `75,726,848 B` (`72.2 MiB`, `72.1` to `72.4 MiB`) | `75,907,072 B` (`72.4 MiB`, `72.2` to `72.5 MiB`) | `summary.median_rss_bytes` |
| Median input tokens | `2195` (`19` + `2176` `cacheRead` on run 5) | `2170` | `summary.median_input_tokens` |
| Median output tokens | `3` | `2` | `summary.median_output_tokens` |
| Median reasoning tokens | `0` | `0` | `summary.median_reasoning_tokens` |
| Median cost (USD) | `$0.00033105` (`$0.000011178` on run 5) | `$0.0003267` | `summary.median_cost_usd` |

Run-to-run wall latency spreads (`2.321` to `3.68 s` for `low`, `2.0567` to `3.5904 s` for `off`) exceed the `0.2988 s` difference between the two medians because remote HTTPS round-trip and provider inference dominate local startup time. Run 5 of `low` hit the provider prompt cache (`2176` `cacheRead` tokens, `19` uncached input tokens), reducing that single call's catalog cost estimate from `$0.00033105` to `$0.000011178`. Maximum resident set size (`72.1` to `72.5 MiB`, `75,628,544` to `75,988,992 B`) comes from `/usr/bin/time -l` `maximum resident set size`, which includes clean file-backed pages of the mapped AOT binary alongside runtime allocations.

## Scope and limits

What was measured:

- Five live runs each at `thinking: low` and `thinking: off` through `examples/worker/run.sh` with the installed `1.5.2 (Pi-Bolt 1.2.1, darwin-arm64, JIT off)` binary and `opencode-go/deepseek-v4.1-flash`.
- End-to-end verification of `models.json` `off` overrides, `before_provider_request` `max_tokens` clamping to `8192`, `bash` exit-code `1` normalization, and third-failure loop termination using the same installed `1.2.1` binary against a local mock OpenAI HTTP server.

What was not measured:

- An AOT binary rebuilt from the current source tree in this repository.
- Live runs against `deepseek/deepseek-flash`.
- Multi-step tool-calling tasks where `thinking: low` generates non-zero reasoning tokens.
