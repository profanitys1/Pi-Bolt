#!/usr/bin/env python3
"""Unit and integration tests for bench/worker.py."""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

BENCH_DIR = Path(__file__).resolve().parent
if str(BENCH_DIR) not in sys.path:
    sys.path.insert(0, str(BENCH_DIR))

import worker  # noqa: E402


def write_fake_worker(directory: Path, body: str) -> Path:
    script = directory / "fake_worker.py"
    script.write_text(body)
    return script


def wait_for_process_exit(pid: int, timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            return False
        time.sleep(0.02)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


class WorkerTests(unittest.TestCase):
    def test_parse_json_events_sums_multiple_agent_end_turns(self) -> None:
        lines = [
            json.dumps(
                {
                    "type": "agent_end",
                    "messages": [
                        {"role": "user", "content": [{"type": "text", "text": "go"}]},
                        {
                            "role": "assistant",
                            "stopReason": "toolUse",
                            "content": [{"type": "text", "text": "checking"}],
                            "usage": {
                                "input": 120,
                                "output": 15,
                                "reasoning": 5,
                                "cacheRead": 30,
                                "cost": {"total": 0.0012},
                            },
                        },
                    ],
                }
            ),
            json.dumps(
                {
                    "type": "agent_end",
                    "messages": [
                        {"role": "toolResult", "content": []},
                        {
                            "role": "assistant",
                            "stopReason": "stop",
                            "content": [{"type": "text", "text": "ready"}],
                            "usage": {
                                "input": 200,
                                "output": 25,
                                "reasoning": 0,
                                "cacheRead": 80,
                                "cost": {"total": 0.0023},
                            },
                        },
                    ],
                }
            ),
            json.dumps({"type": "agent_settled", "aborted": False}),
        ]

        parsed = worker.parse_json_events("\n".join(lines))

        self.assertTrue(parsed["settled"])
        self.assertEqual(parsed["stop_reason"], "stop")
        self.assertIsNone(parsed["error_message"])
        self.assertEqual(parsed["text"], "ready")
        self.assertEqual(
            parsed["usage"],
            {"input": 320, "output": 40, "reasoning": 5, "cacheRead": 110},
        )
        self.assertAlmostEqual(parsed["cost_usd"], 0.0035, places=10)

    def test_parse_json_events_prefers_message_end_without_double_counting(self) -> None:
        turn1 = {
            "role": "assistant",
            "stopReason": "toolUse",
            "content": [{"type": "text", "text": "step 1"}],
            "usage": {"input": 100, "output": 10, "cacheRead": 20, "cost": {"total": 0.001}},
        }
        turn2 = {
            "role": "assistant",
            "stopReason": "stop",
            "content": [{"type": "text", "text": "final"}],
            "usage": {"input": 150, "output": 20, "cacheRead": 50, "cost": {"total": 0.0025}},
        }
        lines = [
            json.dumps({"type": "message_end", "message": turn1}),
            json.dumps({"type": "agent_end", "messages": [turn1]}),
            json.dumps({"type": "message_end", "message": turn2}),
            json.dumps({"type": "agent_end", "messages": [turn2]}),
            json.dumps({"type": "agent_settled", "aborted": False}),
        ]

        parsed = worker.parse_json_events("\n".join(lines))

        self.assertEqual(
            parsed["usage"],
            {"input": 250, "output": 30, "reasoning": None, "cacheRead": 70},
        )
        self.assertAlmostEqual(parsed["cost_usd"], 0.0035, places=10)
        self.assertEqual(parsed["stop_reason"], "stop")
        self.assertEqual(parsed["text"], "final")

    def test_error_stop_reason_with_zero_exit_not_counted_ok_and_exits_nonzero(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pi-worker-test-") as tmp:
            tmp_dir = Path(tmp)
            out_path = tmp_dir / "report.json"
            script = write_fake_worker(
                tmp_dir,
                """import json, sys
if "--version" in sys.argv:
    print("fake-pi 1.0")
    sys.exit(0)
msg = {
    "role": "assistant",
    "stopReason": "error",
    "errorMessage": "401 Unauthorized",
    "content": [],
    "usage": {"input": 0, "output": 0, "cacheRead": 0, "cost": {"total": 0.0}},
}
print(json.dumps({"type": "message_end", "message": msg}))
print(json.dumps({"type": "agent_end", "messages": [msg]}))
print(json.dumps({"type": "agent_settled", "aborted": False}))
""",
            )

            argv = [
                "worker.py",
                "--runs",
                "1",
                "--binary",
                f"{sys.executable} {script}",
                "--out",
                str(out_path),
            ]
            with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as exit_ctx:
                    worker.main()

            self.assertNotEqual(exit_ctx.exception.code, 0)
            self.assertTrue(out_path.exists())
            report = json.loads(out_path.read_text())
            self.assertEqual(report["summary"]["runs"], 1)
            self.assertEqual(report["summary"]["settled_runs"], 1)
            self.assertEqual(report["summary"]["ok_runs"], 0)
            self.assertEqual(report["runs"][0]["exit_code"], 0)
            self.assertTrue(report["runs"][0]["settled"])
            self.assertEqual(report["runs"][0]["stop_reason"], "error")
            self.assertEqual(report["runs"][0]["error_message"], "401 Unauthorized")

    def test_timeout_kills_process_group_records_row_and_writes_out(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pi-worker-timeout-") as tmp:
            tmp_dir = Path(tmp)
            out_path = tmp_dir / "timeout-report.json"
            pids_path = tmp_dir / "pids.json"
            script = write_fake_worker(
                tmp_dir,
                f"""import json, os, subprocess, sys, time
if "--version" in sys.argv:
    print("fake-pi 1.0")
    sys.exit(0)
grandchild = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
with open({str(pids_path)!r}, "w") as fh:
    json.dump({{"child": os.getpid(), "grandchild": grandchild.pid}}, fh)
    fh.flush()
time.sleep(60)
""",
            )

            argv = [
                "worker.py",
                "--runs",
                "1",
                "--timeout",
                "1",
                "--binary",
                f"{sys.executable} {script}",
                "--out",
                str(out_path),
            ]
            with mock.patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaises(SystemExit) as exit_ctx:
                    worker.main()

            self.assertNotEqual(exit_ctx.exception.code, 0)
            self.assertTrue(out_path.exists(), "timeout must still write --out JSON")
            report = json.loads(out_path.read_text())
            self.assertEqual(report["summary"]["runs"], 1)
            self.assertEqual(report["summary"]["settled_runs"], 0)
            self.assertEqual(report["summary"]["ok_runs"], 0)

            row = report["runs"][0]
            self.assertIsNone(row["exit_code"])
            self.assertFalse(row["settled"])
            self.assertEqual(row["stop_reason"], "timeout")
            self.assertEqual(row["error_message"], "timeout after 1s")

            pids = json.loads(pids_path.read_text())
            self.assertTrue(wait_for_process_exit(pids["child"]), "timed-out child process still alive")
            self.assertTrue(wait_for_process_exit(pids["grandchild"]), "timed-out grandchild process leaked")

    def test_run_once_without_time_tool_sets_rss_bytes_to_none(self) -> None:
        with tempfile.TemporaryDirectory(prefix="pi-worker-rss-") as tmp:
            tmp_dir = Path(tmp)
            script = write_fake_worker(
                tmp_dir,
                """import json, sys
msg = {
    "role": "assistant",
    "stopReason": "stop",
    "content": [{"type": "text", "text": "ready"}],
    "usage": {"input": 10, "output": 1, "cacheRead": 0, "cost": {"total": 0.0001}},
}
print(json.dumps({"type": "message_end", "message": msg}))
print(json.dumps({"type": "agent_settled", "aborted": False}))
""",
            )
            row = worker.run_once(
                binary_argv=[sys.executable, str(script)],
                model="opencode-go/deepseek-v4.1-flash",
                thinking="low",
                prompt="ready",
                timeout_s=10,
                use_time_l=False,
                use_time_v=False,
            )

            self.assertIsNone(row["rss_bytes"])
            self.assertEqual(row["exit_code"], 0)
            self.assertTrue(row["settled"])
            self.assertEqual(row["stop_reason"], "stop")


if __name__ == "__main__":
    unittest.main()
