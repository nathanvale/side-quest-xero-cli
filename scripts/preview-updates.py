#!/usr/bin/env python3
"""Preview all proposed CSV updates for reconciliation review.

Reads the current CSV + history cache, proposes account codes and statuses,
and outputs a grouped preview for human confirmation.

Usage:
    python3 scripts/preview-updates.py \
        --csv data/reconcile-review-fy25-q4.csv \
        --history data/.xero-history-cache.json \
        --accounts data/accounts.ndjson
"""

import argparse
import csv
import json
import re
import sys
from collections import defaultdict


# Coffee/cafe keywords -> 4781 Staff Amenities
COFFEE_KEYWORDS = [
    "coffee", "cafe", "espresso", "latte", "brew", "batch",
    "market lane", "industry beans", "industybeans", "industrybeans",
    "brunetti", "tip top cafe", "bliss", "millstone",
]

# Dining/restaurant/food keywords -> 911 Loan - Nathan
FOOD_KEYWORDS = [
    "restaurant", "tavern", "deli", "pizza", "pasta", "pho", "thai",
    "sushi", "burger", "grill", "charcoal", "bbq", "bratwurst",
    "fish", "meat", "butcher", "providore", "organics", "fruit",
    "woolworths", "coles", "iga", "kmart", "supermarket",
    "seafood", "bakery", "florina", "mcdonalds",
    "prepho", "tokyo deli", "amalfi", "kaede", "kosaten",
    "farmer's daughters", "corner larder", "sandbar", "eggporium",
    "ripe & cured", "happy cellars", "gewurzhaus", "chasos",
    "carter lovett", "that's amore", "fish monger", "george the fishmong",
    "chargrill charlie", "flinders lane", "rest house float",
]


def normalize(name):
    s = name.upper().strip()
    for prefix in ["SQ *", "SP *", "PP *", "CRD ", "GH *", "ZLR*", "SMP*", "LS "]:
        if s.startswith(prefix):
            s = s[len(prefix):]
    for suffix in [" PTY LTD", " PTY. LTD.", " P/L", " INC", " LLC", " CORP", " LIMITED", " LTD"]:
        if s.endswith(suffix):
            s = s[:-len(suffix)]
    s = re.sub(r'\s+Card\s+xx\d+.*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s+(AU|AUS|AUSTRALIA)\s*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def classify_food_item(payee):
    """Classify unmatched food/dining items. Returns (code, reason)."""
    lower = payee.lower()
    # Strip prefixes for matching
    clean = re.sub(r'^(sq \*|sp \*|zlr\*|smp\*|ls )', '', lower)

    for kw in COFFEE_KEYWORDS:
        if kw in clean:
            return "4781", f"Coffee/cafe match: '{kw}'"

    for kw in FOOD_KEYWORDS:
        if kw in clean:
            return "911", f"Food/dining match: '{kw}'"

    # Default for unmatched: 911 (personal)
    return "911", "Default: unmatched personal expense"


def load_history(path):
    with open(path) as f:
        raw = f.read()
    if raw.startswith("$"):
        raw = raw[raw.index("\n") + 1:]
    data = json.loads(raw)
    if isinstance(data, dict) and "data" in data:
        data = data["data"]

    records = data if isinstance(data, list) else data.get("transactions", [])
    lookup = {}
    for rec in records:
        contact = rec.get("Contact") or rec.get("ContactName") or ""
        if not contact:
            continue
        norm = normalize(contact)
        if norm not in lookup or (rec.get("Count", 0) or 0) > (lookup[norm].get("Count", 0) or 0):
            lookup[norm] = rec
    return lookup


def load_accounts(path):
    accounts = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            accounts[rec["Code"]] = rec["Name"]
    return accounts


def match_history(payee, history):
    norm = normalize(payee)
    hit = history.get(norm)
    if hit:
        return hit

    words = norm.split()
    for n_words in [2, 1]:
        if len(words) >= n_words:
            partial = " ".join(words[:n_words])
            for key in history:
                if key.startswith(partial):
                    return history[key]
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--history", required=True)
    parser.add_argument("--accounts", required=True)
    args = parser.parse_args()

    history = load_history(args.history)
    accounts = load_accounts(args.accounts)

    with open(args.csv) as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    # Build proposals for non-APPROVE rows
    proposals = []
    already_approved = 0

    for i, row in enumerate(rows):
        line = i + 2
        status = row.get("Status", "").strip()
        payee = row.get("Payee") or row.get("Contact") or ""
        amount = row.get("Amount", "")
        existing_code = row.get("AccountCode", "").strip()
        existing_name = row.get("AccountName", "").strip()

        if status == "APPROVE":
            already_approved += 1
            continue

        hit = match_history(payee, history)

        if hit:
            code = hit.get("AccountCode", "")
            reason = f"History: {hit.get('Contact', '')} ({hit.get('Count', 0)}x)"
            source = "history"
        elif existing_code:
            code = existing_code
            reason = f"Pre-filled code from CSV export"
            source = "prefilled"
        else:
            code, reason = classify_food_item(payee)
            source = "rule"

        name = accounts.get(code, "???")

        proposals.append({
            "line": line,
            "payee": payee,
            "amount": amount,
            "currentStatus": status or "blank",
            "proposedCode": code,
            "proposedName": name,
            "reason": reason,
            "source": source,
        })

    # Group by (source, code) for display
    groups = defaultdict(list)
    for p in proposals:
        groups[(p["source"], p["proposedCode"], p["proposedName"])].append(p)

    output = {
        "alreadyApproved": already_approved,
        "proposedChanges": len(proposals),
        "totalRows": len(rows),
        "groups": [],
    }

    for (source, code, name), items in sorted(groups.items(), key=lambda x: (-len(x[1]), x[0])):
        total = sum(float(i["amount"].replace(",", "").replace("$", "")) for i in items if i["amount"])
        group = {
            "source": source,
            "code": code,
            "name": name,
            "count": len(items),
            "total": round(total, 2),
            "items": [
                {
                    "line": i["line"],
                    "payee": i["payee"][:60],
                    "amount": i["amount"],
                    "reason": i["reason"],
                }
                for i in items
            ],
        }
        output["groups"].append(group)

    json.dump(output, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
