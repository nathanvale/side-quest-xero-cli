#!/usr/bin/env python3
"""Print the canonical JSON body for a specific queue item."""

import json
import sys
from pathlib import Path


def main() -> int:
    queue_path = sys.argv[1]
    target_id = sys.argv[2]

    with Path(queue_path).open(encoding="utf-8") as f:
        queue = json.load(f)

    for item in queue["items"]:
        if item["statementLineId"] == target_id:
            body = item.get("body", {})
            canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
            print(canonical)
            return 0

    print(f"Item {target_id} not found", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
