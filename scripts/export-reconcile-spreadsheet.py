#!/usr/bin/env python3
"""Export statement lines to CSV for reconciliation review.

Reads statement lines NDJSON + accounts NDJSON + contact lookup,
pre-fills suggested account codes where confident, and outputs
a CSV for the user to review/fill in.
"""

from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path


def load_ndjson(path: str) -> list[dict]:
    """Load NDJSON file into list of dicts."""
    records = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))
    return records


def load_accounts(path: str) -> dict[str, dict]:
    """Load accounts keyed by Code."""
    accounts = {}
    for rec in load_ndjson(path):
        code = rec.get("Code", "")
        accounts[code] = {
            "name": rec.get("Name", ""),
            "type": rec.get("Type", ""),
            "tax": rec.get("TaxType", ""),
        }
    return accounts


def load_contact_lookup(path: str) -> dict[str, dict]:
    """Load contact lookup JSON if it exists."""
    p = Path(path)
    if not p.exists():
        return {}
    with open(p) as f:
        data = json.load(f)
    return data.get("lookup", data) if isinstance(data, dict) else {}


def normalize_payee(payee: str) -> str:
    """Normalize payee for matching."""
    s = payee.upper()
    # Strip card/date suffixes
    s = re.sub(r"\s+CARD XX\d+.*", "", s)
    s = re.sub(r"\s+VALUE DATE:.*", "", s)
    s = re.sub(r"\s+AU$", "", s)
    # Strip common prefixes
    for prefix in ["SQ *", "ZLR*", "SMP*", "SP ", "LS ", "CRD ", "PP *", "MED*"]:
        if s.startswith(prefix):
            s = s[len(prefix):]
    # Strip suffixes
    for suffix in [" PTY LTD", " PTY LT", " INC.", " INC", " LLC", " CORP", " LIMITED", " P/L"]:
        s = s.replace(suffix, "")
    return s.strip()


# Keyword-based classification rules
RULES: list[tuple[list[str], str, str]] = [
    # (keywords_any, account_code, category_label)
    (["EXCO PARTNERS"], "200", "Sales Revenue"),
    (["TRANSFER TO XX9027", "NATHAN PAY"], "880", "Owner A Drawings"),
    (["ACCOUNT FEE"], "404", "Bank Fees"),
    (["HOME LOAN PYMT", "OFFICE RENT"], "469", "Rent"),
    (["INTERNATIONAL TRANSACTION FEE"], "434", "Int'l Transaction Fees"),
    (["GITHUB"], "495", "Software"),
    (["OPENAI", "CHATGPT"], "495", "Software"),
    (["FRONTENDMASTERS"], "465", "Professional Development"),
    (["NOTION LABS"], "495", "Software"),
    (["XERO AU"], "495", "Software"),
    (["AMAZON WEB SERVICES", "AWS"], "495", "Software"),
    (["GOOGLE*GSUITE", "GSUITE_NATHANVALE", "GSUITE NATHANVA"], "495", "Software"),
    (["ADOBE"], "495", "Software"),
    (["LEMSQZY", "LEMONSQUEEZY", "UICOLORS"], "495", "Software"),
    (["UI.DEV"], "465", "Professional Development"),
    (["PADDLE.NET", "MACPAW"], "495", "Software"),
    (["TELSTRA"], "489", "Telephone & Internet"),
    (["LIGHTNING BROADBAND"], "489", "Telephone & Internet"),
    (["ALDIMOBILE", "ALDI MOBILE"], "489", "Telephone & Internet"),
    (["CGU DIRECT"], "433", "Insurance"),
    (["ANGLE AUTO FINAN"], "449", "Motor Vehicle"),
    (["AMPOL", "BP LT RIV", "BP BAYSIDE", "7-ELEVEN"], "449", "Motor Vehicle"),
    (["ATO ATODD"], "505", "Income Tax Expense"),
    (["EZYPAY*BODY FIT"], "429", "General Expenses (Gym)"),
    (["LATITUDE GO", "BPAY 443887"], "880", "Owner A Drawings (BPAY)"),
    (["KATE BERRY"], "880", "Owner A Drawings"),
    (["CLINK DIR DEBIT"], "429", "General Expenses"),
    (["DISNEY PLUS"], "485", "Subscriptions"),
    (["NEW YORK TIMES"], "485", "Subscriptions"),
    (["AMZNPRIMEAU", "AMAZON PRIME"], "485", "Subscriptions"),
    (["APPLE.COM/BILL"], "485", "Subscriptions (Apple)"),
    (["APPLE APPLE.COM/BILL"], "485", "Subscriptions (Apple)"),
    (["MYKI"], "493", "Travel - National"),
    (["PAYSTAY", "PRAHRAN SQUARE CAR PARK", "CAREPARK", "POINT PARKING", "EASYPARK"], "449", "Motor Vehicle (Parking)"),
    (["AFTERPAY"], "880", "Owner A Drawings (Afterpay)"),
    (["ZIPMONEY", "ZIPMONEY*", "ZIP.CO"], "880", "Owner A Drawings (ZipMoney)"),
    (["SOUTH EAST WATER"], "445", "Light, Power, Heating"),
    (["ORIGIN ENERGY"], "445", "Light, Power, Heating"),
    (["SCRATCH DOG FOOD"], "429", "General Expenses"),
    (["SHOLEM ALEICHEM"], "429", "General Expenses (School)"),
    (["FOULKES MEDICAL", "DR F"], "429", "General Expenses (Medical)"),
    (["GLO HEALTH"], "429", "General Expenses (Health)"),
    (["GREENCROSS VETS"], "429", "General Expenses (Vet)"),
    (["CHEMIST WAREHOUSE"], "429", "General Expenses"),
    (["PARLOUR HAIRDRESSI"], "429", "General Expenses"),
    (["UBER *EATS", "MENULOG"], "420", "Entertainment (Food Delivery)"),
    (["UBER *TRIP"], "493", "Travel - National"),
    (["JETSTAR"], "493", "Travel - National"),
    (["BOOKING.COM", "HIPCAMP"], "493", "Travel - National"),
    (["BIRDS BASEMENT"], "420", "Entertainment"),
    (["CAULFIELD RSL"], "420", "Entertainment"),
    (["ARTHUR MURRAY"], "429", "General Expenses (Dance)"),
    (["BUNNINGS"], "473", "Repairs and Maintenance"),
    (["WONDROUS"], "429", "General Expenses"),
    (["MELANIE JOY BENVENIST", "MELANIE", "CREDIT TO ACCOUNT"], "881", "Owner A Funds Introduced"),
    (["RETURN SCRATCH DOG"], "429", "General Expenses (Refund)"),
]

# Personal shopping - default to Owner A Drawings
PERSONAL_KEYWORDS = [
    "MYER", "JD SPORTS", "KATHMANDU", "KMART", "SHOES & SOX",
    "SIMONE PERELE", "CK UNDERWEAR", "GREENWOOD LEATHER",
    "DAISO", "KOKOBL", "APPLE R180",
]


def classify(payee: str, amount: float) -> tuple[str, str, str]:
    """Return (suggested_code, category, confidence)."""
    upper = payee.upper()
    norm = normalize_payee(payee)

    # Check rules
    for keywords, code, category in RULES:
        if any(kw in upper for kw in keywords):
            return code, category, "high"

    # Personal shopping
    for kw in PERSONAL_KEYWORDS:
        if kw in upper:
            return "880", "Owner A Drawings (Shopping)", "medium"

    # RECEIVE transactions without a rule match
    if amount > 0:
        return "", "RECEIVE - needs review", "low"

    # Groceries / food / cafes / restaurants pattern
    food_keywords = [
        "COLES", "WOOLWORTHS", "IGA", "WW METRO",
        "COFFEE", "CAFE", "DELI", "PASTA", "MEAT",
        "PHO", "THAI", "TOKYO", "SUSHI", "BRATWURST",
        "FLORINAS", "CHARGRILL", "MCDONALDS",
        "PROVIDORE", "MARKET", "FISH", "SEAFOO",
        "SOURCE BULK", "DIRITO", "TRIALTO",
        "KAEDE", "KOSATEN", "INDUSTRYBEANS",
        "BRUNETTI", "MORK", "MOKOSZ", "BELLES",
        "BROTHER BREW", "TIP TOP", "CARTER LOVETT",
        "SANDBAR", "PADDLEWHEEL", "REST HOUSE",
        "CORNER LARDER", "EGGPORIUM", "TOFULICIOUS",
        "AMALFI", "CHASOS", "HAPPY CELLARS",
        "FARMER", "RUSTICA", "MILLSTONE",
        "MOC ROLL", "ELSTER MELBOURNE",
        "THAT'S AMORE", "WOODFROG", "GOTRAYS",
    ]
    for kw in food_keywords:
        if kw in upper:
            return "880", "Owner A Drawings (Food/Groceries)", "medium"

    # ATM
    if "WDL ATM" in upper:
        return "880", "Owner A Drawings (ATM)", "medium"

    # Catch-all
    return "", "Needs review", "low"


def main():
    if len(sys.argv) < 4:
        print("Usage: export-reconcile-spreadsheet.py <statement-lines.ndjson> <accounts.ndjson> <output.csv>")
        print("Optional: <contact-lookup.json>")
        sys.exit(1)

    sl_file = sys.argv[1]
    accounts_file = sys.argv[2]
    output_file = sys.argv[3]
    lookup_file = sys.argv[4] if len(sys.argv) > 4 else None

    lines = load_ndjson(sl_file)
    accounts = load_accounts(accounts_file)
    lookup = load_contact_lookup(lookup_file) if lookup_file else {}

    # Build account code reference
    account_ref = {code: f"{code} - {info['name']}" for code, info in sorted(accounts.items())}

    rows = []
    for sl in lines:
        payee = sl.get("payee", "")
        amount = sl.get("amount", 0)
        posted = sl.get("postedDate", "")
        sl_id = sl.get("statementLineId", "")
        is_reconciled = sl.get("isReconciled", False)

        if is_reconciled:
            continue

        tx_type = "RECEIVE" if amount > 0 else "SPEND"
        suggested_code, category, confidence = classify(payee, amount)

        # Look up account name
        acct_name = ""
        if suggested_code and suggested_code in accounts:
            acct_name = accounts[suggested_code]["name"]

        rows.append({
            "statementLineId": sl_id,
            "postedDate": posted,
            "payee": payee,
            "amount": amount,
            "absAmount": abs(amount),
            "type": tx_type,
            "suggestedCode": suggested_code,
            "suggestedAccountName": acct_name,
            "category": category,
            "confidence": confidence,
            "yourCode": "",  # User fills this in
            "notes": "",     # User fills this in
        })

    # Sort by confidence (high first), then by category, then by payee
    confidence_order = {"high": 0, "medium": 1, "low": 2}
    rows.sort(key=lambda r: (confidence_order.get(r["confidence"], 3), r["category"], r["payee"]))

    # Write CSV
    fieldnames = [
        "statementLineId", "postedDate", "payee", "amount", "absAmount",
        "type", "suggestedCode", "suggestedAccountName", "category",
        "confidence", "yourCode", "notes",
    ]

    with open(output_file, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    # Summary
    high = sum(1 for r in rows if r["confidence"] == "high")
    medium = sum(1 for r in rows if r["confidence"] == "medium")
    low = sum(1 for r in rows if r["confidence"] == "low")
    print(f"Exported {len(rows)} unreconciled lines to {output_file}")
    print(f"  High confidence (pre-filled): {high}")
    print(f"  Medium confidence (pre-filled, review): {medium}")
    print(f"  Low confidence (needs your input): {low}")
    print()
    print("Instructions:")
    print("  1. Open in Google Sheets or Excel")
    print("  2. Review 'suggestedCode' column - these are my suggestions")
    print("  3. Fill in 'yourCode' column where you disagree or where it's blank")
    print("  4. If yourCode is empty, I'll use suggestedCode")
    print("  5. Add notes in 'notes' column for anything I should know")
    print()
    print("Account code reference:")
    for code, label in sorted(account_ref.items()):
        info = accounts[code]
        if info["type"] in ("EXPENSE", "REVENUE", "DIRECTCOSTS", "EQUITY", "CURRLIAB"):
            print(f"  {label} ({info['type']})")


if __name__ == "__main__":
    main()
