#!/usr/bin/env python3
"""Format audit-approvals.py output for human review."""
import json, sys

data = json.load(sys.stdin)

conflicts = [i for i in data['issues'] if i['type'] == 'CODE_CONFLICT']
type_mismatches = [i for i in data['issues'] if i['type'] == 'TYPE_MISMATCH']
amount_anomalies = [i for i in data['issues'] if i['type'] == 'AMOUNT_ANOMALY']

print(f'=== AUDIT SUMMARY ===')
print(f'Total approved: {data["totalApproved"]}')
print(f'Code conflicts: {len(conflicts)}')
print(f'Type mismatches: {len(type_mismatches)}')
print(f'Amount anomalies: {len(amount_anomalies)} (info only)')
print(f'No history (new vendors): {data["noHistoryCount"]}')
print()

if conflicts:
    print('=== CODE CONFLICTS (approved code != history) ===')
    for c in conflicts:
        print(f'  L{c["line"]:>3}  {c["amount"]:>10}  {c["payee"]}')
        print(f'       Approved: {c["approved"]}  |  History: {c["history"]} ({c["histCount"]}x, match: {c["matchType"]})')
        print()

if type_mismatches:
    print('=== TYPE MISMATCHES ===')
    for t in type_mismatches:
        print(f'  L{t["line"]:>3}  {t["amount"]:>10}  {t["payee"]}')
        print(f'       {t["detail"]}')
        print()

print('=== CODE CONCENTRATION ===')
for c in data['codeConcentration']:
    bar = '#' * int(c['pct'] / 2)
    print(f'  {c["code"]:>5} {c["name"]:<30} {c["count"]:>3} items  ${abs(c["total"]):>10,.2f}  {c["pct"]:>5.1f}%  {bar}')
