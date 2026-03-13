#!/usr/bin/env python3
"""Summarize preview-updates output for human review."""
import json, sys

data = json.load(sys.stdin)

print(f"Already approved: {data['alreadyApproved']}")
print(f"Proposed changes: {data['proposedChanges']}")
print(f"Total rows: {data['totalRows']}")
print()

for g in data["groups"]:
    src_label = {"history": "HISTORY", "prefilled": "PRE-FILLED", "rule": "RULE"}[g["source"]]
    print(f"### [{src_label}] {g['code']} - {g['name']}  ({g['count']} items, ${abs(g['total']):,.2f})")
    for item in g["items"]:
        payee = item["payee"][:50]
        print(f"  L{item['line']:>3}  {item['amount']:>10}  {payee}")
    print()
