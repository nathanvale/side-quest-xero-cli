#!/usr/bin/env python3
"""Patch specific items in a post-run state file to 'posted' status.

Usage:
  patch-post-run-items.py <post-run-path> <sid1>=<bankTxId1> [<sid2>=<bankTxId2> ...]
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: patch-post-run-items.py <post-run-path> <sid>=<bankTxId> ...",
            file=sys.stderr,
        )
        return 1

    post_run_path = Path(sys.argv[1])
    patches = {}
    for arg in sys.argv[2:]:
        if "=" not in arg:
            print(f"Invalid argument (expected sid=bankTxId): {arg}", file=sys.stderr)
            return 1
        sid, bank_tx_id = arg.split("=", 1)
        patches[sid] = bank_tx_id

    with post_run_path.open(encoding="utf-8") as f:
        state = json.load(f)

    now = datetime.now(timezone.utc).isoformat()
    patched = []

    for sid, bank_tx_id in patches.items():
        item = state["items"].get(sid)
        if not item:
            print(f"WARNING: {sid} not found in post-run", file=sys.stderr)
            continue
        old_status = item.get("status")
        item["status"] = "posted"
        item["bankTransactionId"] = bank_tx_id
        item["postedAt"] = now
        item["responseCode"] = 200
        patched.append(sid)

    with post_run_path.open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

    print(json.dumps({
        "ok": True,
        "postRunPath": str(post_run_path),
        "patched": len(patched),
        "total": len(state["items"]),
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
