#!/usr/bin/env python3
"""List all approved items for a given account code."""
import csv, sys

code = sys.argv[1]
with open("data/reconcile-review-fy25-q4.csv") as f:
    reader = csv.DictReader(f)
    rows = list(reader)

total = 0.0
count = 0
for i, row in enumerate(rows):
    if row.get("Status", "").strip() != "APPROVE":
        continue
    if row.get("AccountCode", "").strip() != code:
        continue
    line = i + 2
    payee = (row.get("Payee") or row.get("Contact") or "")[:65]
    amount = row.get("Amount", "0")
    date = row.get("Date", "")
    try:
        total += float(amount.replace(",", "").replace("$", ""))
    except ValueError:
        pass
    count += 1
    print(f"  L{line:>3}  {date}  {amount:>10}  {payee}")

print()
print(f"  Total: {count} items, ${abs(total):,.2f}")
