#!/usr/bin/env python3
"""Smoke tests for ADHD hook behavior."""

from __future__ import annotations

import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path


def assert_true(value: bool, msg: str) -> None:
    if not value:
        raise AssertionError(msg)


def assert_false(value: bool, msg: str) -> None:
    if value:
        raise AssertionError(msg)


def main() -> int:
    hook_path = Path.home() / ".claude" / "hooks" / "adhd" / "adhd-coach.py"
    spec = importlib.util.spec_from_file_location("adhd_hook", hook_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load hook module from {hook_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    # Dangerous command detection
    assert_true(module.command_is_dangerous("rm -rf /tmp/demo"), "rm -rf should be dangerous")
    assert_true(module.command_is_dangerous("rm -r -f /tmp/demo"), "rm -r -f should be dangerous")
    assert_true(module.command_is_dangerous('bash -lc "rm -rf /tmp/demo"'), "bash -lc wrapper should be dangerous")
    assert_false(module.command_is_dangerous('echo "rm -rf /tmp/demo"'), "echo quoted command should not be dangerous")

    # Control tokens
    assert_true(module.has_control_token("ADHD_OFF\nplease", "ADHD_OFF"), "line-start token should trigger")
    assert_false(module.has_control_token("Please mention ADHD_OFF in docs", "ADHD_OFF"), "inline token should not trigger")
    assert_false(module.has_control_token("```\nADHD_OFF\n```", "ADHD_OFF"), "token in fenced code should not trigger")

    # Auth bypass scope
    assert_true(module.is_xero_auth_recovery("xero login session expired"), "xero auth recovery should be detected")
    assert_false(module.is_xero_auth_recovery("need auth for stripe"), "non-xero auth should not trigger bypass")

    # Mission pruning
    state = {
        "active_mission": {
            "goal": "Old mission",
            "started_at": (datetime.now(timezone.utc) - timedelta(hours=30)).isoformat(),
            "cwd": "/tmp",
        },
        "edits_in_mission": 9,
    }
    pruned = module.prune_stale_mission(state)
    assert_true(pruned, "stale mission should be pruned")
    assert_true(state["active_mission"] is None, "pruned state should clear active mission")
    assert_true(state["edits_in_mission"] == 0, "pruned state should reset edit count")

    print("hook-smoke-ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
