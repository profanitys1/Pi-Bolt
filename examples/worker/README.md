# Worker kit

Headless, isolated runner kit for Pi-Bolt subagent or batch worker tasks.

## Files

- `agent/models.json` caps `maxTokens` at `8192` for `opencode-go/deepseek-v4.1-flash` and `deepseek/deepseek-flash`, and maps `thinking: "off"` for `opencode-go/deepseek-v4.1-flash` to `thinking: { "type": "disabled" }` and `reasoning_effort: "none"`.
- `agent/settings.json` sets worker defaults (`deepseek/deepseek-flash`, `thinking: "low"`), disables skills (`"skills": ["!**"]`), disables compaction (`"compaction": { "enabled": false }`), sets `defaultProjectTrust` to `"never"`, disables telemetry and analytics, and keeps up to `3` retries.
- `extensions/worker-guard.ts` registers three guards:
  - Clamps `max_tokens`, `max_completion_tokens`, and `max_output_tokens` to `8192` in `before_provider_request`, defaulting Responses (`input`) payloads to `max_output_tokens` and Chat (`messages`) payloads to `max_tokens`.
  - Normalizes `bash` exit code `1` to `isError: false` in `tool_result` for standalone `rg`, `grep`, `egrep`, `fgrep`, or `diff` commands without shell chaining or syntax or permission errors.
  - Breaks identical failing tool loops on the third attempt (`block: true`, `terminate: true`) using canonical key-sorted input keys tracked per key, resetting on `agent_start` or when that exact key succeeds.
- `prompt.md` appends concise worker rules via `--append-system-prompt`.
- `run.sh` copies the kit into a temporary `PI_CODING_AGENT_DIR` (deleted on exit) so runs never mutate `~/.pi/agent` or the repository.

## Usage

Inspect the command without running it:

```bash
examples/worker/run.sh --print-command
```

Run a one-shot task with an API key in the environment:

```bash
DEEPSEEK_API_KEY=... examples/worker/run.sh "Summarize packages/ai/package.json"
```

Override model, thinking level, or output mode:

```bash
OPENCODE_API_KEY=... examples/worker/run.sh \
	--mode json \
	--model opencode-go/deepseek-v4.1-flash \
	--thinking off \
	"Reply with the single word: ready"
```

Override the binary path with `PI_BOLT_BIN`, or run the local workspace build directly via `--use-dist`:

```bash
PI_BOLT_BIN=/path/to/pi-bolt examples/worker/run.sh "Reply with the single word: ready"
examples/worker/run.sh --use-dist "Reply with the single word: ready"
```
