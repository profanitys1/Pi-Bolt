#!/usr/bin/env python3
"""Run multi-step coding tasks through examples/worker/run.sh and record what the worker did with them.

`bench/worker.py` measures one prompt over several runs. This measures tasks that need tools: read a file, change it, run a
check, and carry the result into the next turn. Each task starts in a throwaway workspace with a fixture, and is scored by
running the check itself, not by trusting the model's answer.

  python3 bench/worker_soak.py --thinking low,off --out bench/results/<date>-worker-soak

Reproducing the recorded baseline:

  python3 bench/worker_soak.py --thinking low,off --out bench/results/2026-11-17-worker-soak

Per task it records: success, wall time, turns, tool calls and errors, stop reasons, input/output/reasoning/cache-read
tokens, cost, and whether the guard's loop breaker fired.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RUN_SH = REPO_ROOT / "examples" / "worker" / "run.sh"
MODEL = "opencode-go/deepseek-v4.1-flash"

# Each task: fixture files, the prompt, and how to score it. `verify` is the command whose stdout is compared with
# `expect_stdout`; tasks without one compare the reply text with `expect_text`.
TASKS: dict[str, dict] = {
    "fix-bug": {
        "files": {
            "calc.js": "function add(a, b) {\n\treturn a - b;\n}\n\nmodule.exports = { add };\n",
            "check.js": (
                "const { add } = require('./calc.js');\n"
                "if (add(2, 3) !== 5) {\n"
                "\tconsole.error(`FAIL: add(2, 3) = ${add(2, 3)}`);\n"
                "\tprocess.exit(1);\n"
                "}\n"
                "console.log('PASS');\n"
            ),
        },
        "prompt": (
            "Run `node check.js`. It fails. Fix the bug in calc.js, then run `node check.js` again and reply with its output."
        ),
        "verify": ["node", "check.js"],
        "expect_stdout": "PASS",
    },
    "add-feature": {
        "files": {
            "strings.js": "function upper(value) {\n\treturn value.toUpperCase();\n}\n\nmodule.exports = { upper };\n",
            "strings.test.js": (
                "const { upper, slugify } = require('./strings.js');\n"
                "const assert = require('node:assert');\n"
                "assert.strictEqual(upper('a'), 'A');\n"
                "assert.strictEqual(slugify('Hello World!'), 'hello-world');\n"
                "console.log('PASS');\n"
            ),
        },
        "prompt": (
            "`node strings.test.js` fails because `slugify` is missing: it must lowercase, replace runs of non-alphanumeric "
            "characters with a single dash and trim dashes. Implement `slugify` in strings.js, then run `node strings.test.js`."
        ),
        "verify": ["node", "strings.test.js"],
        "expect_stdout": "PASS",
    },
    "extract-helper": {
        "files": {
            "app.js": (
                "function label(name) {\n"
                "\treturn name.trim().toLowerCase().replace(/\\s+/g, '-');\n"
                "}\n\n"
                "function labelTwice(name) {\n"
                "\treturn name.trim().toLowerCase().replace(/\\s+/g, '-') + '/' + "
                "name.trim().toLowerCase().replace(/\\s+/g, '-');\n"
                "}\n\n"
                "console.log(label('A B'), labelTwice('C D'));\n"
            ),
        },
        "prompt": (
            "app.js repeats the slug expression three times. Move it into a single `slug` function in a new file util.js, "
            "require it from app.js, and run `node app.js`. The output must stay `a-b c-d/c-d`."
        ),
        "verify": ["node", "app.js"],
        "expect_stdout": "a-b c-d/c-d",
    },
    "read-only": {
        "files": {
            "a.js": (
                "function sortNames(items) {\n"
                "\treturn [...items].sort((x, y) => x.localeCompare(y));\n"
                "}\n"
                "module.exports = { sortNames };\n"
            ),
            "b.js": (
                "function orderNames(items) {\n"
                "\treturn [...items].sort((x, y) => x.localeCompare(y));\n"
                "}\n"
                "module.exports = { orderNames };\n"
            ),
        },
        "prompt": (
            "Which function body in a.js and b.js is identical? Reply with only the two function names, comma separated, "
            "lowercase, in the order a.js then b.js."
        ),
        "verify": None,
        "expect_text": "sortnames,ordernames",
    },
    "multi-file-shell": {
        "files": {},
        "prompt": (
            "Create two files: data/one.txt containing exactly `alpha` and data/two.txt containing exactly `beta` (each with a "
            "trailing newline, no other files). Then run `cat data/one.txt data/two.txt` and reply with its output."
        ),
        "verify": ["cat", "data/one.txt", "data/two.txt"],
        "expect_stdout": "alpha\nbeta\n",
    },
}


def make_workspace(task: dict) -> Path:
    root = Path(tempfile.mkdtemp(prefix="pi-soak-"))
    for name, body in task["files"].items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    return root


def fold_events(stdout: str) -> dict:
    """Sum the JSON event stream into turn, tool, usage and stop-reason counters."""
    folded = {
        "turns": 0,
        "tool_calls": 0,
        "tool_names": {},
        "tool_errors": 0,
        "stop_reasons": [],
        "input": 0,
        "output": 0,
        "reasoning": 0,
        "cache_read": 0,
        "cost_usd": 0.0,
        "text": "",
        "loop_breaker": "Loop breaker" in stdout,
        "unparsed_lines": 0,
    }
    for line in stdout.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            folded["unparsed_lines"] += 1
            continue
        if event.get("type") != "turn_end":
            continue

        folded["turns"] += 1
        message = event.get("message") or {}
        usage = message.get("usage") or {}
        for field, key in (("input", "input"), ("output", "output"), ("reasoning", "reasoning"), ("cacheRead", "cache_read")):
            value = usage.get(field)
            if isinstance(value, (int, float)):
                folded[key] += value
        cost = usage.get("cost") or {}
        if isinstance(cost.get("total"), (int, float)):
            folded["cost_usd"] += cost["total"]
        if message.get("stopReason"):
            folded["stop_reasons"].append(message["stopReason"])
        if message.get("role") == "assistant":
            for block in message.get("content") or []:
                if block.get("type") == "text":
                    folded["text"] += block.get("text", "")

        for result in event.get("toolResults") or []:
            folded["tool_calls"] += 1
            name = result.get("toolName") or result.get("name") or "?"
            folded["tool_names"][name] = folded["tool_names"].get(name, 0) + 1
            if result.get("isError"):
                folded["tool_errors"] += 1
    return folded


def score_task(task: dict, workspace: Path, text: str) -> tuple[bool, str]:
    if task["verify"]:
        check = subprocess.run(task["verify"], cwd=workspace, capture_output=True, text=True)
        produced = check.stdout
        return check.returncode == 0 and produced.strip() == task["expect_stdout"].strip(), produced[:200]
    answer = "".join(text.split()).lower()
    return answer == task["expect_text"].replace(" ", ""), text.strip()[:200]


def run_task(name: str, task: dict, thinking: str, timeout_s: int) -> dict:
    workspace = make_workspace(task)
    try:
        command = [
            str(RUN_SH),
            "--use-dist",
            "--mode",
            "json",
            "--model",
            MODEL,
            "--thinking",
            thinking,
            task["prompt"],
        ]
        started = time.perf_counter()
        try:
            proc = subprocess.run(
                command,
                cwd=workspace,
                capture_output=True,
                text=True,
                timeout=timeout_s,
                stdin=subprocess.DEVNULL,
            )
            stdout, exit_code, timed_out = proc.stdout, proc.returncode, False
        except subprocess.TimeoutExpired as expired:
            stdout = expired.stdout.decode() if isinstance(expired.stdout, bytes) else (expired.stdout or "")
            exit_code, timed_out = None, True
        wall_s = round(time.perf_counter() - started, 3)

        folded = fold_events(stdout)
        success, evidence = score_task(task, workspace, folded["text"])
        folded.pop("text")
        return {
            "task": name,
            "thinking": thinking,
            "success": success,
            "evidence": evidence,
            "wall_s": wall_s,
            "exit_code": exit_code,
            "timed_out": timed_out,
            **folded,
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--thinking", default="low", help="comma separated thinking levels (default: low)")
    parser.add_argument("--task", default=",".join(TASKS), help="comma separated task names (default: all)")
    parser.add_argument("--timeout", type=int, default=240, help="per-task timeout in seconds (default: 240)")
    parser.add_argument("--out", default=None, help="directory for <level>.json results")
    args = parser.parse_args()

    levels = [level for level in args.thinking.split(",") if level]
    names = [name for name in args.task.split(",") if name]
    unknown = [name for name in names if name not in TASKS]
    if unknown:
        raise SystemExit(f"unknown tasks: {', '.join(unknown)}")

    rows: list[dict] = []
    for thinking in levels:
        for name in names:
            row = run_task(name, TASKS[name], thinking, args.timeout)
            rows.append(row)
            print(
                f"{thinking:4} {name:16} success={row['success']!s:5} wall={row['wall_s']:6.1f}s "
                f"turns={row['turns']} tools={row['tool_calls']} errors={row['tool_errors']} "
                f"stop={row['stop_reasons']} out={row['output']} reasoning={row['reasoning']} "
                f"cache={row['cache_read']} loop_breaker={row['loop_breaker']}",
                flush=True,
            )

    for level in levels:
        level_rows = [row for row in rows if row["thinking"] == level]
        summary = {
            "model": MODEL,
            "thinking": level,
            "tasks": [row["task"] for row in level_rows],
            "passed": sum(1 for row in level_rows if row["success"]),
            "runs": level_rows,
        }
        if args.out:
            out_path = Path(args.out) / f"{level}.json"
            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_text(json.dumps(summary, indent=2) + "\n")
            print(f"wrote {out_path}")
        print(f"{level}: {summary['passed']}/{len(level_rows)} passed")


if __name__ == "__main__":
    main()
