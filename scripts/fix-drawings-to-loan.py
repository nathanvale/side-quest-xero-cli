#!/usr/bin/env python3
"""Move all 880 (Owner A Drawings) items to 911 (Loan - Nathan) and upload to Google Sheets."""
import csv
import json
import sys
from pathlib import Path

CSV_PATH = "data/reconcile-review-fy25-q4.csv"
SHEET_ID = "1IxMMLs1Y2WMTgqXdHsJUlgpUhHEVHQsr0AT0aNf3R7w"
GID = "924466770"

# Load accounts for names
accounts = {}
with open("data/accounts.ndjson") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        accounts[rec["Code"]] = rec["Name"]

# Read CSV
with open(CSV_PATH) as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    rows = list(reader)

# Apply fixes
fixes = []
for i, row in enumerate(rows):
    line = i + 2
    if row.get("AccountCode", "").strip() == "880":
        payee = (row.get("Payee") or row.get("Contact") or "")[:65]
        amount = row.get("Amount", "0")
        row["AccountCode"] = "911"
        row["AccountName"] = accounts.get("911", "")
        fixes.append(f"L{line}: {payee} ({amount}) -> 911 Loan - Nathan")

# Write CSV
with open(CSV_PATH, "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)

# Upload to Google Sheets
import gspread
key_path = Path.home() / ".config" / "gspread" / "service_account.json"
gc = gspread.service_account(filename=str(key_path))
sh = gc.open_by_key(SHEET_ID)
worksheet = next((ws for ws in sh.worksheets() if str(ws.id) == GID), sh.sheet1)

with open(CSV_PATH) as f:
    upload_rows = list(csv.reader(f))

worksheet.clear()
worksheet.update(upload_rows, "A1")

print(json.dumps({"ok": True, "fixes": fixes, "count": len(fixes), "uploaded": True}, indent=2))
