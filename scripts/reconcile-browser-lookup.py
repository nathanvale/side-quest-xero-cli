#!/usr/bin/env python3
"""Look up a queue item by amount + date + optional description fragment.

Used by the agent during browser reconciliation to find the right
queue data for each visible statement line on the Xero Reconcile page.

Usage:
    reconcile-browser-lookup.py <queue-path> --amount 18.30 --date 2025-04-01 [--desc "TRIALTO"]

Output:
    JSON with contact, accountCode, description for the matched item(s).
    Exit 0 if exactly one match, exit 2 if multiple matches, exit 1 if none.
"""

import argparse
import json
import sys
from decimal import Decimal
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Look up queue item by amount + date"
    )
    parser.add_argument("queue_path", type=Path, help="Path to post queue JSON")
    parser.add_argument("--amount", required=True, help="Transaction amount (exact)")
    parser.add_argument("--date", required=True, help="Transaction date (YYYY-MM-DD)")
    parser.add_argument("--desc", default="", help="Description fragment for disambiguation")
    parser.add_argument("--exclude-ids", default="", help="Comma-separated statementLineIds to skip (already reconciled)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.queue_path.exists():
        print(json.dumps({"error": f"Queue file not found: {args.queue_path}"}))
        return 1

    with args.queue_path.open(encoding="utf-8") as f:
        queue = json.load(f)

    target_amount = Decimal(args.amount)
    target_date = args.date
    desc_fragment = args.desc.lower()
    exclude_ids = set(args.exclude_ids.split(",")) if args.exclude_ids else set()

    matches = []

    for item in queue["items"]:
        if item["statementLineId"] in exclude_ids:
            continue

        body = item.get("body", {})
        line_items = body.get("LineItems", [{}])
        # Queue uses UnitAmount (Qty=1), fallback to LineAmount for compatibility
        li = line_items[0] if line_items else {}
        line_amount = li.get("UnitAmount", li.get("LineAmount", 0))
        item_date = body.get("Date", "")
        contact_name = body.get("Contact", {}).get("Name", "")
        account_code = line_items[0].get("AccountCode", "") if line_items else ""
        description = line_items[0].get("Description", "") if line_items else ""

        # Amount match: compare as Decimal for precision
        try:
            if Decimal(str(line_amount)) != target_amount:
                continue
        except Exception:
            continue

        # Date match: exact YYYY-MM-DD
        if not item_date.startswith(target_date):
            continue

        matches.append({
            "statementLineId": item["statementLineId"],
            "contact": contact_name,
            "accountCode": account_code,
            "description": description,
            "amount": float(line_amount),
            "date": item_date[:10],
        })

    # If multiple matches and desc fragment provided, filter by description
    if len(matches) > 1 and desc_fragment:
        filtered = [
            m for m in matches
            if desc_fragment in m["description"].lower()
            or desc_fragment in m["contact"].lower()
        ]
        if filtered:
            matches = filtered

    if len(matches) == 0:
        print(json.dumps({"error": "No matching queue item found", "amount": str(target_amount), "date": target_date}))
        return 1
    elif len(matches) == 1:
        print(json.dumps(matches[0], indent=2))
        return 0
    else:
        print(json.dumps({"warning": "Multiple matches", "count": len(matches), "matches": matches}, indent=2))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
