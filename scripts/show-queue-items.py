#!/usr/bin/env python3
"""Show details of specific queue items by statementLineId."""

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: show-queue-items.py <queue-path> <sid1> [sid2 ...]", file=sys.stderr)
        return 1

    queue_path = Path(sys.argv[1])
    target_ids = set(sys.argv[2:])

    with queue_path.open(encoding="utf-8") as f:
        queue = json.load(f)

    for item in queue["items"]:
        sid = item["statementLineId"]
        if sid in target_ids:
            body = item.get("body", {})
            contact = body.get("Contact", {}).get("Name", "?")
            account = body.get("LineItems", [{}])[0].get("AccountCode", "?")
            line_desc = body.get("LineItems", [{}])[0].get("Description", "?")
            amount = body.get("LineItems", [{}])[0].get("LineAmount", "?")
            tx_type = body.get("Type", "?")
            date = body.get("Date", "?")
            print(json.dumps({
                "statementLineId": sid[:16],
                "contact": contact,
                "type": tx_type,
                "date": date,
                "amount": amount,
                "accountCode": account,
                "description": line_desc,
            }, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
