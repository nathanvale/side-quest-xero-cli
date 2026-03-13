#!/usr/bin/env python3
"""Trim a post queue to match a trimmed post-run state file."""

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 4:
        print("Usage: trim-post-queue.py <queue-input> <post-run-input> <queue-output>", file=sys.stderr)
        return 1

    queue_path = sys.argv[1]
    post_run_path = sys.argv[2]
    output_path = sys.argv[3]

    with Path(queue_path).open(encoding="utf-8") as f:
        queue = json.load(f)

    with Path(post_run_path).open(encoding="utf-8") as f:
        post_run = json.load(f)

    keep_ids = set(post_run["items"].keys())
    queue["items"] = [item for item in queue["items"] if item["statementLineId"] in keep_ids]

    with Path(output_path).open("w", encoding="utf-8") as f:
        json.dump(queue, f, indent=2)

    print(json.dumps({"ok": True, "items": len(queue["items"])}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
