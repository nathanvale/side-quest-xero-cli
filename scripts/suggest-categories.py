#!/usr/bin/env python3
"""Cross-reference unreviewed CSV rows against Xero history cache.

Usage:
    python3 scripts/suggest-categories.py \
        --csv data/reconcile-review-fy25-q4.csv \
        --history data/.xero-history-cache.json \
        [--status REVIEW|blank|all]

Outputs a JSON summary of suggestions grouped by confidence.
"""

import argparse
import csv
import json
import re
import sys
from collections import defaultdict


def normalize(name):
    """Normalize payee name for fuzzy matching."""
    s = name.upper().strip()
    # Strip common prefixes
    for prefix in ["SQ *", "SP *", "PP *", "CRD ", "GH *"]:
        if s.startswith(prefix):
            s = s[len(prefix):]
    # Strip common suffixes
    for suffix in [" PTY LTD", " PTY. LTD.", " P/L", " INC", " LLC", " CORP", " LIMITED", " LTD"]:
        if s.endswith(suffix):
            s = s[:-len(suffix)]
    # Strip card info like "Card xx4459 Value Date"
    s = re.sub(r'\s+Card\s+xx\d+.*$', '', s, flags=re.IGNORECASE)
    # Strip location suffixes (AU, AUS, etc at end)
    s = re.sub(r'\s+(AU|AUS|AUSTRALIA)\s*$', '', s, flags=re.IGNORECASE)
    # Collapse whitespace
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def load_history(path):
    """Load history cache and build normalized lookup."""
    with open(path) as f:
        raw = f.read()
    # Skip CLI echo line if present (e.g. "$ bun ...")
    if raw.startswith("$"):
        raw = raw[raw.index("\n") + 1:]
    data = json.loads(raw)
    # Unwrap envelope if present
    if isinstance(data, dict) and "data" in data:
        data = data["data"]

    # History can be an array or object with a key
    records = data if isinstance(data, list) else data.get("transactions", data.get("history", data.get("contacts", [])))
    if isinstance(records, dict):
        # Maybe it's keyed by contact name
        flat = []
        for k, v in records.items():
            if isinstance(v, dict):
                v["_key"] = k
                flat.append(v)
            elif isinstance(v, list):
                for item in v:
                    if isinstance(item, dict):
                        item["_key"] = k
                        flat.append(item)
        records = flat

    lookup = {}
    for rec in records:
        contact = rec.get("Contact") or rec.get("ContactName") or rec.get("_key") or ""
        if not contact:
            continue
        norm = normalize(contact)
        if norm not in lookup or (rec.get("Count", 0) or 0) > (lookup[norm].get("Count", 0) or 0):
            lookup[norm] = rec

    return lookup


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--history", required=True)
    parser.add_argument("--status", default="all", help="Filter: REVIEW, blank, or all (default)")
    args = parser.parse_args()

    history = load_history(args.history)

    with open(args.csv) as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    # Filter rows
    target_rows = []
    for i, row in enumerate(rows):
        status = row.get("Status", "").strip()
        if args.status == "all" and status not in ("APPROVE",):
            target_rows.append((i + 2, row))  # +2 for 1-indexed + header
        elif args.status == "blank" and status == "":
            target_rows.append((i + 2, row))
        elif args.status.upper() == status:
            target_rows.append((i + 2, row))

    # Match against history
    matched = []
    unmatched = []
    for line_num, row in target_rows:
        payee = row.get("Payee") or row.get("Contact") or ""
        norm = normalize(payee)
        amount = row.get("Amount", "0")
        date = row.get("Date", "")
        status = row.get("Status", "").strip() or "blank"
        existing_code = row.get("AccountCode", "").strip()

        hit = history.get(norm)
        if not hit:
            # Try partial match (first two words)
            words = norm.split()
            for n_words in [2, 1]:
                if len(words) >= n_words:
                    partial = " ".join(words[:n_words])
                    for key in history:
                        if key.startswith(partial):
                            hit = history[key]
                            break
                if hit:
                    break

        entry = {
            "line": line_num,
            "payee": payee,
            "amount": amount,
            "date": date,
            "status": status,
            "existingCode": existing_code,
        }

        if hit:
            entry["suggestion"] = {
                "accountCode": hit.get("AccountCode", ""),
                "accountName": hit.get("AccountName", ""),
                "contact": hit.get("Contact") or hit.get("ContactName", ""),
                "count": hit.get("Count", 0),
                "amountRange": f"{hit.get('AmountMin', '?')} - {hit.get('AmountMax', '?')}",
            }
            matched.append(entry)
        else:
            unmatched.append(entry)

    # Group matched by suggested account code
    by_code = defaultdict(list)
    for m in matched:
        code = m["suggestion"]["accountCode"]
        by_code[code].append(m)

    output = {
        "totalUnreviewed": len(target_rows),
        "matchedFromHistory": len(matched),
        "unmatched": len(unmatched),
        "byAccountCode": {},
        "unmatchedItems": unmatched[:50],  # Cap output
    }

    for code in sorted(by_code.keys()):
        items = by_code[code]
        sample = items[0]["suggestion"]
        output["byAccountCode"][code] = {
            "accountName": sample.get("accountName", ""),
            "count": len(items),
            "totalAmount": sum(float(i["amount"].replace(",", "").replace("$", "")) for i in items if i["amount"]),
            "items": [{"line": i["line"], "payee": i["payee"], "amount": i["amount"]} for i in items],
        }

    json.dump(output, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
