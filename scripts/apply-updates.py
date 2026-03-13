#!/usr/bin/env python3
"""Apply proposed reconciliation updates to the CSV and upload to Google Sheets.

Usage:
    python3 scripts/apply-updates.py \
        --csv data/reconcile-review-fy25-q4.csv \
        --history data/.xero-history-cache.json \
        --accounts data/accounts.ndjson \
        --output data/reconcile-review-fy25-q4.csv \
        [--sheet-id SPREADSHEET_ID --gid GID]
"""

import argparse
import csv
import json
import re
import sys
from pathlib import Path


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
    "birds basement", "mork chocolate", "tofulicious", "belles melbourne",
    "mcivers",
]

# Override rules for specific payees (confirmed 2026-03-13)
OVERRIDES = {
    "THE TRUSTEE FOR AGS": ("911", "Override: school uniforms (personal)"),
    "NATHAN PAY": ("804", "Override: salary transfer"),
    "TRANSFER TO XX9027": ("804", "Override: salary transfer"),
    "KATE BERRY": ("400", "Override: advertising agency"),
    "WONDROUS": ("400", "Override: advertising"),
    "SHOLEM ALEICHEM": ("911", "Override: school fees (personal)"),
    "FOULKES MEDICAL": ("911", "Override: medical (claimable, personal)"),
    "PV FOULKES": ("911", "Override: medical (claimable, personal)"),
}

# Skip rules - leave as REVIEW
SKIP_PAYEES = [
    "THE TRUSTEE FOR SAGUFT",
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
    lower = payee.lower()
    clean = re.sub(r'^(sq \*|sp \*|zlr\*|smp\*|ls )', '', lower)
    for kw in COFFEE_KEYWORDS:
        if kw in clean:
            return "4781", f"Coffee/cafe: '{kw}'"
    for kw in FOOD_KEYWORDS:
        if kw in clean:
            return "911", f"Food/dining: '{kw}'"
    return "911", "Default: personal expense"


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


def should_skip(payee):
    upper = payee.upper()
    for skip in SKIP_PAYEES:
        if skip in upper:
            return True
    return False


def get_override(payee):
    upper = payee.upper()
    for key, val in OVERRIDES.items():
        if key in upper:
            return val
    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--history", required=True)
    parser.add_argument("--accounts", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sheet-id", default=None)
    parser.add_argument("--gid", default=None)
    args = parser.parse_args()

    history = load_history(args.history)
    accounts = load_accounts(args.accounts)

    with open(args.csv) as f:
        reader = csv.DictReader(f)
        fieldnames = reader.fieldnames
        rows = list(reader)

    stats = {"already_approved": 0, "history": 0, "prefilled": 0, "rule": 0, "skipped": 0, "override": 0}

    for row in rows:
        status = row.get("Status", "").strip()
        payee = row.get("Payee") or row.get("Contact") or ""

        if status == "APPROVE":
            stats["already_approved"] += 1
            continue

        # Check skip list first
        if should_skip(payee):
            if not status:
                row["Status"] = "REVIEW"
            stats["skipped"] += 1
            continue

        # Check overrides
        override = get_override(payee)
        if override:
            code, reason = override
            row["AccountCode"] = code
            row["AccountName"] = accounts.get(code, "")
            row["Status"] = "APPROVE"
            stats["override"] += 1
            continue

        # Try history match
        hit = match_history(payee, history)
        if hit:
            code = hit.get("AccountCode", "")
            row["AccountCode"] = code
            row["AccountName"] = accounts.get(code, "")
            row["Status"] = "APPROVE"
            stats["history"] += 1
            continue

        # Pre-filled code
        existing_code = row.get("AccountCode", "").strip()
        if existing_code:
            row["AccountName"] = accounts.get(existing_code, row.get("AccountName", ""))
            row["Status"] = "APPROVE"
            stats["prefilled"] += 1
            continue

        # Rule-based classification
        code, reason = classify_food_item(payee)
        row["AccountCode"] = code
        row["AccountName"] = accounts.get(code, "")
        row["Status"] = "APPROVE"
        stats["rule"] += 1

    # Write output CSV
    output_path = Path(args.output)
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    # Count final statuses
    final_counts = {}
    for row in rows:
        s = row.get("Status", "").strip() or "blank"
        final_counts[s] = final_counts.get(s, 0) + 1

    result = {
        "ok": True,
        "output": str(output_path),
        "stats": stats,
        "finalStatusCounts": final_counts,
        "totalRows": len(rows),
    }

    # Upload to Google Sheets if requested
    if args.sheet_id:
        try:
            import gspread
            key_path = Path.home() / ".config" / "gspread" / "service_account.json"
            gc = gspread.service_account(filename=str(key_path))
            sh = gc.open_by_key(args.sheet_id)

            if args.gid:
                worksheet = next((ws for ws in sh.worksheets() if str(ws.id) == str(args.gid)), sh.sheet1)
            else:
                worksheet = sh.sheet1

            # Read CSV back as rows for upload
            with open(output_path) as f:
                reader = csv.reader(f)
                upload_rows = list(reader)

            worksheet.clear()
            worksheet.update(upload_rows, "A1")
            result["uploaded"] = True
            result["sheet"] = sh.title
        except Exception as e:
            result["uploaded"] = False
            result["uploadError"] = str(e)

    json.dump(result, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
