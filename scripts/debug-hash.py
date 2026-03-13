#!/usr/bin/env python3
"""Debug hash mismatch between queue body and post-run requestHash."""

import json
import sys
from pathlib import Path
from reconcile_roundtrip import json_sha256


def main() -> int:
    queue_path = sys.argv[1]
    post_run_path = sys.argv[2]
    target_id = sys.argv[3] if len(sys.argv) > 3 else None

    with Path(queue_path).open(encoding="utf-8") as f:
        queue = json.load(f)

    with Path(post_run_path).open(encoding="utf-8") as f:
        post_run = json.load(f)

    for item in queue["items"]:
        sid = item["statementLineId"]
        if target_id and sid != target_id:
            continue
        body = item.get("body", {})
        computed_hash = json_sha256(body)
        state_item = post_run["items"].get(sid, {})
        stored_hash = state_item.get("requestHash", "MISSING")
        match = "OK" if computed_hash == stored_hash else "MISMATCH"
        print(json.dumps({
            "statementLineId": sid,
            "match": match,
            "computedHash": computed_hash[:16],
            "storedHash": stored_hash[:16],
        }, indent=2))
        if match == "MISMATCH":
            # Show the serialized body for debugging
            canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
            print(f"  canonical body (first 200 chars): {canonical[:200]}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
