#!/usr/bin/env python3
"""Audit approved CSV rows against Xero history for drift and anomalies.

Checks:
1. Account code conflicts (approved code != history code)
2. Amount anomalies (outside historical range with 20% tolerance)
3. New vendors (no history at all)
4. Code concentration (unusual % in one account)
5. RECEIVE transactions with SPEND codes or vice versa

Usage:
    python3 scripts/audit-approvals.py \
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


def match_history(payee, history):
    norm = normalize(payee)
    hit = history.get(norm)
    if hit:
        return hit, "exact"
    words = norm.split()
    for n_words in [2, 1]:
        if len(words) >= n_words:
            partial = " ".join(words[:n_words])
            for key in history:
                if key.startswith(partial):
                    return history[key], "partial"
    return None, None


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

    issues = []
    code_totals = defaultdict(lambda: {"count": 0, "total": 0.0, "items": []})
    no_history = []

    for i, row in enumerate(rows):
        line = i + 2
        status = row.get("Status", "").strip()
        if status != "APPROVE":
            continue

        payee = row.get("Payee") or row.get("Contact") or ""
        code = row.get("AccountCode", "").strip()
        amount_str = row.get("Amount", "0").replace(",", "").replace("$", "")
        try:
            amount = float(amount_str)
        except ValueError:
            amount = 0.0
        tx_type = row.get("Type", "").strip()

        code_name = accounts.get(code, "???")
        code_totals[code]["count"] += 1
        code_totals[code]["total"] += amount
        code_totals[code]["name"] = code_name

        hit, match_type = match_history(payee, history)

        if hit:
            hist_code = hit.get("AccountCode", "")
            hist_type = hit.get("Type", "")
            hist_min = hit.get("AmountMin", 0) or 0
            hist_max = hit.get("AmountMax", 0) or 0
            hist_contact = hit.get("Contact", "")

            # Check 1: Code conflict
            if hist_code and code != hist_code:
                hist_name = accounts.get(hist_code, "???")
                issues.append({
                    "type": "CODE_CONFLICT",
                    "severity": "warning",
                    "line": line,
                    "payee": payee[:60],
                    "amount": amount,
                    "approved": f"{code} ({code_name})",
                    "history": f"{hist_code} ({hist_name})",
                    "histContact": hist_contact,
                    "histCount": hit.get("Count", 0),
                    "matchType": match_type,
                })

            # Check 2: Amount anomaly (only for exact matches)
            if match_type == "exact" and hist_max > 0:
                tolerance = 0.20
                low = hist_min * (1 - tolerance) if hist_min > 0 else hist_min
                high = hist_max * (1 + tolerance)
                abs_amount = abs(amount)
                if abs_amount < low or abs_amount > high:
                    issues.append({
                        "type": "AMOUNT_ANOMALY",
                        "severity": "info",
                        "line": line,
                        "payee": payee[:60],
                        "amount": amount,
                        "histRange": f"${hist_min:.2f} - ${hist_max:.2f}",
                        "histContact": hist_contact,
                    })

            # Check 3: Type mismatch (SPEND assigned to income code or vice versa)
            if amount < 0 and hist_type == "RECEIVE":
                issues.append({
                    "type": "TYPE_MISMATCH",
                    "severity": "warning",
                    "line": line,
                    "payee": payee[:60],
                    "amount": amount,
                    "detail": f"Negative amount but history says RECEIVE for {hist_contact}",
                })
            elif amount > 0 and hist_type == "SPEND":
                issues.append({
                    "type": "TYPE_MISMATCH",
                    "severity": "info",
                    "line": line,
                    "payee": payee[:60],
                    "amount": amount,
                    "detail": f"Positive amount but history says SPEND for {hist_contact} (refund?)",
                })
        else:
            no_history.append({
                "line": line,
                "payee": payee[:60],
                "amount": amount,
                "code": f"{code} ({code_name})",
            })

    # Check 4: Code concentration
    total_approved = sum(c["count"] for c in code_totals.values())
    concentration = []
    for code, data in sorted(code_totals.items(), key=lambda x: x[1]["count"], reverse=True):
        pct = (data["count"] / total_approved * 100) if total_approved > 0 else 0
        concentration.append({
            "code": code,
            "name": data["name"],
            "count": data["count"],
            "total": round(data["total"], 2),
            "pct": round(pct, 1),
        })

    output = {
        "totalApproved": total_approved,
        "issueCount": len(issues),
        "noHistoryCount": len(no_history),
        "issues": issues,
        "noHistory": no_history[:30],
        "codeConcentration": concentration,
    }

    json.dump(output, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
