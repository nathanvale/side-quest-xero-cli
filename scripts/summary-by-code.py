#!/usr/bin/env python3
"""Summarize all approved items grouped by account code."""
import csv, json, sys
from collections import defaultdict

accounts = {}
with open("data/accounts.ndjson") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        accounts[rec["Code"]] = rec["Name"]

with open("data/reconcile-review-fy25-q4.csv") as f:
    reader = csv.DictReader(f)
    rows = list(reader)

groups = defaultdict(lambda: {"count": 0, "spend": 0.0, "receive": 0.0})

for row in rows:
    if row.get("Status", "").strip() != "APPROVE":
        continue
    code = row.get("AccountCode", "").strip()
    try:
        amount = float(row.get("Amount", "0").replace(",", "").replace("$", ""))
    except ValueError:
        amount = 0.0
    groups[code]["count"] += 1
    if amount < 0:
        groups[code]["spend"] += amount
    else:
        groups[code]["receive"] += amount

grand_spend = 0.0
grand_receive = 0.0
grand_count = 0

print(f"{'Code':<6} {'Account Name':<35} {'Items':>5} {'Spend':>12} {'Receive':>12} {'Net':>12}")
print("-" * 88)

for code in sorted(groups.keys(), key=lambda c: groups[c]["spend"]):
    g = groups[code]
    name = accounts.get(code, "???")
    net = g["spend"] + g["receive"]
    spend_str = f"${abs(g['spend']):,.2f}" if g["spend"] else ""
    recv_str = f"${g['receive']:,.2f}" if g["receive"] else ""
    net_str = f"${net:,.2f}" if net >= 0 else f"-${abs(net):,.2f}"
    print(f"{code:<6} {name:<35} {g['count']:>5} {spend_str:>12} {recv_str:>12} {net_str:>12}")
    grand_spend += g["spend"]
    grand_receive += g["receive"]
    grand_count += g["count"]

print("-" * 88)
grand_net = grand_spend + grand_receive
net_str = f"${grand_net:,.2f}" if grand_net >= 0 else f"-${abs(grand_net):,.2f}"
print(f"{'TOTAL':<6} {'':<35} {grand_count:>5} ${abs(grand_spend):>11,.2f} ${grand_receive:>11,.2f} {net_str:>12}")
