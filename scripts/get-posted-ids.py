#!/usr/bin/env python3
"""Extract bankTransactionIds from a post-run state file for items with 'posted' status."""

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: get-posted-ids.py <post-run-path> [--skip-sids sid1,sid2,...]", file=sys.stderr)
        return 1

    post_run_path = Path(sys.argv[1])
    skip_sids = set()
    for i, arg in enumerate(sys.argv):
        if arg == "--skip-sids" and i + 1 < len(sys.argv):
            skip_sids = set(sys.argv[i + 1].split(","))

    with post_run_path.open(encoding="utf-8") as f:
        state = json.load(f)

    posted = []
    for sid, item in state["items"].items():
        if item.get("status") == "posted" and sid not in skip_sids:
            bank_tx_id = item.get("bankTransactionId")
            if bank_tx_id:
                posted.append({"statementLineId": sid, "bankTransactionId": bank_tx_id})

    print(json.dumps({"count": len(posted), "first": posted[0] if posted else None}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
