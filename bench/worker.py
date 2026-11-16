#!/usr/bin/env python3
"""Benchmark Pi-Bolt in isolated headless worker mode across live runs."""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import platform
import re
import shlex
import shutil
import signal
import statistics
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
KIT_DIR = REPO_ROOT / "examples" / "worker"
RUN_SH = KIT_DIR / "run.sh"

MACOS_RSS_RE = re.compile(r"^\s*(\d+)\s+maximum resident set size\b", re.MULTILINE)
LINUX_RSS_RE = re.compile(r"^\s*Maximum resident set size \(kbytes\):\s*(\d+)\s*$", re.MULTILINE)


@contextlib.contextmanager
def temporary_agent_dir():
    with tempfile.TemporaryDirectory(prefix="pi-worker-bench-") as tmp:
        agent_dir = Path(tmp)
        ext_dir = agent_dir / "extensions"
        ext_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(KIT_DIR / "agent" / "models.json", agent_dir / "models.json")
        shutil.copy2(KIT_DIR / "agent" / "settings.json", agent_dir / "settings.json")
        shutil.copy2(KIT_DIR / "extensions" / "worker-guard.ts", ext_dir / "worker-guard.ts")
        yield agent_dir


def resolve_binary_argv(spec: str) -> list[str]:
    argv = [os.path.expanduser(token) for token in shlex.split(spec)]
    if not argv:
        raise SystemExit("--binary must not be empty")
    return argv


def probe_binary_version(binary_argv: list[str]) -> str | None:
    try:
        proc = subprocess.run(
            [*binary_argv, "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    output = proc.stdout.strip()
    return output or None


def parse_rss_bytes(stderr_text: str, use_time_l: bool, use_time_v: bool) -> int | None:
    if use_time_l:
        rss_match = MACOS_RSS_RE.search(stderr_text)
        return int(rss_match.group(1)) if rss_match else None
    if use_time_v:
        rss_match = LINUX_RSS_RE.search(stderr_text)
        return int(rss_match.group(1)) * 1024 if rss_match else None
    return None


def parse_json_events(stdout_text: str) -> dict[str, Any]:
    events: list[dict[str, Any]] = []
    for raw_line in stdout_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            events.append(obj)

    settled = any(ev.get("type") == "agent_settled" and not ev.get("aborted", False) for ev in events)

    assistant_messages: list[dict[str, Any]] = []
    for ev in events:
        if ev.get("type") == "message_end":
            msg = ev.get("message")
            if isinstance(msg, dict) and msg.get("role") == "assistant":
                assistant_messages.append(msg)

    if not assistant_messages:
        for ev in events:
            if ev.get("type") == "agent_end" and isinstance(ev.get("messages"), list):
                for msg in ev["messages"]:
                    if isinstance(msg, dict) and msg.get("role") == "assistant":
                        assistant_messages.append(msg)

    total_input = 0
    total_output = 0
    total_cache_read = 0
    total_cost = 0.0
    reasoning_values: list[int] = []

    for msg in assistant_messages:
        usage = msg.get("usage")
        if not isinstance(usage, dict):
            continue
        total_input += int(usage.get("input") or 0)
        total_output += int(usage.get("output") or 0)
        total_cache_read += int(usage.get("cacheRead") or 0)
        if "reasoning" in usage and usage["reasoning"] is not None:
            reasoning_values.append(int(usage["reasoning"]))
        cost = usage.get("cost")
        if isinstance(cost, dict) and cost.get("total") is not None:
            total_cost += float(cost["total"])

    final_text = ""
    stop_reason = None
    error_message = None
    if assistant_messages:
        last_msg = assistant_messages[-1]
        stop_reason = last_msg.get("stopReason")
        error_message = last_msg.get("errorMessage")
        parts: list[str] = []
        for block in last_msg.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
        final_text = "".join(parts).strip()

    return {
        "settled": settled,
        "stop_reason": stop_reason,
        "error_message": error_message,
        "text": final_text,
        "usage": {
            "input": total_input,
            "output": total_output,
            "reasoning": sum(reasoning_values) if reasoning_values else None,
            "cacheRead": total_cache_read,
        },
        "cost_usd": round(total_cost, 10),
    }


def can_run_gnu_time_v() -> bool:
    if sys.platform == "darwin" or not Path("/usr/bin/time").exists():
        return False
    probe = subprocess.run(
        ["/usr/bin/time", "-v", "/bin/true"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        check=False,
    )
    return probe.returncode == 0 and bool(LINUX_RSS_RE.search(probe.stderr))


def run_once(
    binary_argv: list[str],
    model: str,
    thinking: str,
    prompt: str,
    timeout_s: int,
    use_time_l: bool,
    use_time_v: bool,
) -> dict[str, Any]:
    with contextlib.ExitStack() as stack:
        env = dict(os.environ)
        worker_args = [
            "--mode",
            "json",
            "--model",
            model,
            "--thinking",
            thinking,
            prompt,
        ]
        if len(binary_argv) == 1:
            env["PI_BOLT_BIN"] = binary_argv[0]
            cmd = [str(RUN_SH), *worker_args]
        else:
            agent_dir = stack.enter_context(temporary_agent_dir())
            env["PI_CODING_AGENT_DIR"] = str(agent_dir)
            cmd = [
                *binary_argv,
                "-p",
                "--no-session",
                "--no-context-files",
                "--no-skills",
                "--no-prompt-templates",
                "--no-extensions",
                "-e",
                str(agent_dir / "extensions" / "worker-guard.ts"),
                "--append-system-prompt",
                str(KIT_DIR / "prompt.md"),
                *worker_args,
            ]

        if use_time_l:
            exec_cmd = ["/usr/bin/time", "-l", *cmd]
        elif use_time_v:
            exec_cmd = ["/usr/bin/time", "-v", *cmd]
        else:
            exec_cmd = cmd

        t0 = time.perf_counter()
        proc = subprocess.Popen(
            exec_cmd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            start_new_session=True,
        )
        timed_out = False
        try:
            stdout_text, stderr_text = proc.communicate(timeout=timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            stdout_text, stderr_text = proc.communicate()
        wall_s = round(time.perf_counter() - t0, 4)

    rss_bytes = parse_rss_bytes(stderr_text, use_time_l, use_time_v)
    parsed = parse_json_events(stdout_text)
    if timed_out:
        return {
            "exit_code": None,
            "wall_s": wall_s,
            "rss_bytes": rss_bytes,
            "usage": parsed["usage"],
            "cost_usd": parsed["cost_usd"],
            "settled": False,
            "stop_reason": "timeout",
            "text": parsed["text"],
            "error_message": f"timeout after {timeout_s}s",
        }

    record: dict[str, Any] = {
        "exit_code": proc.returncode,
        "wall_s": wall_s,
        "rss_bytes": rss_bytes,
        "usage": parsed["usage"],
        "cost_usd": parsed["cost_usd"],
        "settled": parsed["settled"],
        "stop_reason": parsed["stop_reason"],
        "text": parsed["text"],
    }
    if parsed["error_message"]:
        record["error_message"] = parsed["error_message"]
    return record


def median_or_none(values: list[float | int | None]) -> float | int | None:
    present = [v for v in values if v is not None]
    if not present:
        return None
    med = statistics.median(present)
    if all(isinstance(v, int) for v in present) and isinstance(med, float) and med.is_integer():
        return int(med)
    return med


def build_summary(runs: list[dict[str, Any]]) -> dict[str, Any]:
    ok_runs = [
        r
        for r in runs
        if r["exit_code"] == 0
        and r["settled"]
        and r["stop_reason"] not in ("error", "aborted", "timeout", None)
    ]
    target = ok_runs if ok_runs else runs

    wall_values = [r["wall_s"] for r in target]
    rss_values = [r["rss_bytes"] for r in target if r["rss_bytes"] is not None]

    med_wall = median_or_none(wall_values)
    med_rss = median_or_none(rss_values)
    med_in = median_or_none([r["usage"]["input"] for r in target])
    med_out = median_or_none([r["usage"]["output"] for r in target])
    med_reason = median_or_none([r["usage"]["reasoning"] for r in target])
    med_cache = median_or_none([r["usage"]["cacheRead"] for r in target])
    med_cost = median_or_none([r["cost_usd"] for r in target])

    return {
        "runs": len(runs),
        "settled_runs": sum(1 for r in runs if r["settled"]),
        "ok_runs": len(ok_runs),
        "median_wall_s": round(float(med_wall), 4) if med_wall is not None else None,
        "min_wall_s": min(wall_values) if wall_values else None,
        "max_wall_s": max(wall_values) if wall_values else None,
        "median_rss_bytes": int(round(float(med_rss))) if med_rss is not None else None,
        "min_rss_bytes": min(rss_values) if rss_values else None,
        "max_rss_bytes": max(rss_values) if rss_values else None,
        "median_input_tokens": med_in,
        "median_output_tokens": med_out,
        "median_reasoning_tokens": med_reason,
        "median_cache_read_tokens": med_cache,
        "median_cost_usd": round(float(med_cost), 10) if med_cost is not None else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runs", type=int, default=5, help="number of runs (default: 5)")
    parser.add_argument("--model", default="opencode-go/deepseek-v4.1-flash", help="provider/model id")
    parser.add_argument("--thinking", default="low", help="thinking level (default: low)")
    parser.add_argument(
        "--binary",
        default="/Users/filip/.local/bin/pi-bolt",
        help="pi-bolt binary path or command prefix",
    )
    parser.add_argument("--prompt", default="Reply with the single word: ready", help="prompt text")
    parser.add_argument("--timeout", type=int, default=120, help="per-run timeout in seconds")
    parser.add_argument("--out", default="bench/results/worker-flash.json", help="output JSON path")
    args = parser.parse_args()

    if args.runs < 1:
        raise SystemExit("--runs must be >= 1")

    binary_argv = resolve_binary_argv(args.binary)
    binary_version = probe_binary_version(binary_argv)
    use_time_l = sys.platform == "darwin" and Path("/usr/bin/time").exists()
    use_time_v = False if use_time_l else can_run_gnu_time_v()

    runs: list[dict[str, Any]] = []
    for idx in range(1, args.runs + 1):
        row = run_once(
            binary_argv=binary_argv,
            model=args.model,
            thinking=args.thinking,
            prompt=args.prompt,
            timeout_s=args.timeout,
            use_time_l=use_time_l,
            use_time_v=use_time_v,
        )
        row["run"] = idx
        runs.append(row)
        rss_mb = f"{row['rss_bytes'] / (1 << 20):.1f} MB" if row["rss_bytes"] is not None else "n/a"
        print(
            f"[{idx}/{args.runs}] wall={row['wall_s']:.3f}s rss={rss_mb} "
            f"settled={row['settled']} in={row['usage']['input']} out={row['usage']['output']} "
            f"reasoning={row['usage']['reasoning']} cost=${row['cost_usd']:.6f} text={row['text']!r}",
            flush=True,
        )

    now = datetime.now(timezone.utc)
    report = {
        "date": now.strftime("%Y-%m-%d"),
        "timestamp": now.isoformat(),
        "platform": f"{sys.platform}-{platform.machine()}",
        "binary": args.binary,
        "binary_version": binary_version,
        "model": args.model,
        "thinking": args.thinking,
        "prompt": args.prompt,
        "runs": runs,
        "summary": build_summary(runs),
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2) + "\n")
    print(f"Wrote {out_path}", flush=True)

    if report["summary"]["ok_runs"] != args.runs:
        sys.exit(1)


if __name__ == "__main__":
    main()
