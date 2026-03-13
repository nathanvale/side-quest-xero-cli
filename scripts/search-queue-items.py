#!/usr/bin/env python3
"""Search queue items by description or contact name (case-insensitive)."""

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: search-queue-items.py <queue-path> <search-term>", file=sys.stderr)
        return 1

    queue_path = Path(sys.argv[1])
    search = sys.argv[2].lower()

    with queue_path.open(encoding="utf-8") as f:
        queue = json.load(f)

    found = 0
    for item in queue["items"]:
        body = item.get("body", {})
        contact = body.get("Contact", {}).get("Name", "")
        desc = body.get("LineItems", [{}])[0].get("Description", "")
        line_amount = body.get("LineItems", [{}])[0].get("LineAmount", "?")
        date = body.get("Date", "?")

        if search in contact.lower() or search in desc.lower():
            found += 1
            print(json.dumps({
                "statementLineId": item["statementLineId"][:16],
                "contact": contact,
                "date": date,
                "amount": line_amount,
                "description": desc[:80],
            }, indent=2))

    if found == 0:
        print(f"No items matching '{search}' found in queue ({len(queue['items'])} items)", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
