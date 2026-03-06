#!/usr/bin/env python3
"""Build and inspect contact lookup data from bank-transactions NDJSON."""

from __future__ import annotations

import json
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


def normalize_name(value: str) -> str:
    text = value.upper().strip()
    text = re.sub(r"^(SQ \*|CRD |PP \*|SP )", "", text)
    text = re.sub(r"\b(PTY LTD|INC|LLC|CORP|LIMITED|P/L)\b", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text.lower()


def read_ndjson(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with path.open() as f:
        for line in f:
            raw = line.strip()
            if not raw:
                continue
            try:
                item = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if isinstance(item, dict):
                rows.append(item)
    return rows


def build_lookup(rows: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], dict[str, int]]:
    lookup: dict[str, dict[str, Any]] = {}
    stats = {
        "total": len(rows),
        "reconciled": 0,
        "with_contact_name": 0,
        "with_lineitems": 0,
        "with_account_code": 0,
        "lookup_entries": 0,
    }
    account_code_hist: Counter[str] = Counter()

    for txn in rows:
        if not bool(txn.get("IsReconciled")):
            continue
        stats["reconciled"] += 1
        contact = txn.get("Contact") or {}
        if not isinstance(contact, dict):
            continue
        name = str(contact.get("Name", "")).strip()
        if not name:
            continue
        stats["with_contact_name"] += 1
        normalized = normalize_name(name)
        if not normalized:
            continue

        line_items = txn.get("LineItems") or []
        if isinstance(line_items, list) and line_items:
            stats["with_lineitems"] += 1
        account_code = ""
        if isinstance(line_items, list) and line_items and isinstance(line_items[0], dict):
            account_code = str(line_items[0].get("AccountCode", "")).strip()
        if account_code:
            stats["with_account_code"] += 1
            account_code_hist[account_code] += 1

        amount = abs(float(txn.get("Total", 0) or 0))
        if normalized not in lookup:
            lookup[normalized] = {
                "NormalizedName": normalized,
                "ContactID": str(contact.get("ContactID", "")).strip(),
                "ContactName": name,
                "AccountCode": account_code,
                "Count": 0,
                "AmountMin": amount,
                "AmountMax": amount,
                "AccountCodeCounts": {},
            }
        entry = lookup[normalized]
        entry["Count"] += 1
        entry["AmountMin"] = min(float(entry["AmountMin"]), amount)
        entry["AmountMax"] = max(float(entry["AmountMax"]), amount)
        if account_code:
            code_counts = entry.get("AccountCodeCounts", {})
            if not isinstance(code_counts, dict):
                code_counts = {}
            code_counts[account_code] = int(code_counts.get(account_code, 0)) + 1
            entry["AccountCodeCounts"] = code_counts
            # Keep most common account code as default.
            if not entry.get("AccountCode") or code_counts[account_code] > code_counts.get(str(entry.get("AccountCode", "")), 0):
                entry["AccountCode"] = account_code

    stats["lookup_entries"] = len(lookup)
    stats["top_account_codes"] = dict(account_code_hist.most_common(10))
    return lookup, stats


def atomic_write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(path) + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def cmd_summary(input_path: Path) -> int:
    rows = read_ndjson(input_path)
    _, stats = build_lookup(rows)
    print(f"bank-transactions rows: {stats['total']}")
    print(f"reconciled rows: {stats['reconciled']}")
    print(f"reconciled with contact name: {stats['with_contact_name']}")
    print(f"reconciled with line items: {stats['with_lineitems']}")
    print(f"reconciled with account code: {stats['with_account_code']}")
    print(f"lookup entries: {stats['lookup_entries']}")
    print("top account codes:")
    for code, count in stats["top_account_codes"].items():
        print(f"  {code}: {count}")
    return 0


def cmd_build(input_path: Path, output_path: Path) -> int:
    rows = read_ndjson(input_path)
    lookup, stats = build_lookup(rows)
    atomic_write_json(output_path, {"lookup": lookup, "stats": stats})
    print(f"Wrote lookup: {output_path}")
    print(f"Lookup entries: {stats['lookup_entries']}")
    return 0


def usage() -> int:
    print("Usage:")
    print("  python3 scripts/xero-contact-lookup.py summary [bank_transactions_ndjson]")
    print("  python3 scripts/xero-contact-lookup.py build [bank_transactions_ndjson] [output_json]")
    return 1


def main() -> int:
    if len(sys.argv) < 2:
        return usage()
    cmd = sys.argv[1]
    input_path = Path(sys.argv[2]) if len(sys.argv) >= 3 else Path("data/bank-transactions.ndjson")
    if cmd == "summary":
        return cmd_summary(input_path)
    if cmd == "build":
        output_path = Path(sys.argv[3]) if len(sys.argv) >= 4 else Path("data/.xero-contact-lookup.json")
        return cmd_build(input_path, output_path)
    return usage()


if __name__ == "__main__":
    raise SystemExit(main())
