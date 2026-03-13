#!/usr/bin/env python3
"""Check status of specific items in a post-run state file."""

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: check-items-status.py <post-run-path> [sid1 sid2 ...]", file=sys.stderr)
        return 1

    post_run_path = Path(sys.argv[1])
    target_ids = sys.argv[2:] if len(sys.argv) > 2 else None

    with post_run_path.open(encoding="utf-8") as f:
        state = json.load(f)

    items = state.get("items", {})

    if target_ids:
        for sid in target_ids:
            item = items.get(sid, {})
            print(json.dumps({
                "statementLineId": sid[:16],
                "status": item.get("status", "MISSING"),
                "bankTransactionId": item.get("bankTransactionId"),
            }, indent=2))
    else:
        # Show summary of all statuses
        counts = {}
        for item in items.values():
            s = item.get("status", "unknown")
            counts[s] = counts.get(s, 0) + 1
        print(json.dumps({"total": len(items), "statusCounts": counts}, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
