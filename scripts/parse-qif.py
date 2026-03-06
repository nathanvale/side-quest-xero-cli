#!/usr/bin/env python3
"""Parse a QIF file and summarize transactions."""
import os
import sys
from datetime import datetime
from collections import defaultdict

def parse_date(raw):
    value = raw.strip().replace("'", "/")
    formats = ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d")
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None

def parse_qif(path):
    records = []
    current = {}
    invalid_amount_count = 0
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line == '^':
                if current:
                    records.append(current)
                current = {}
            elif line.startswith('D'):
                current['date'] = line[1:]
            elif line.startswith('T'):
                try:
                    current['amount'] = float(line[1:])
                except ValueError:
                    # Keep parsing other records; malformed amount will be ignored in summaries.
                    current['amount'] = None
                    invalid_amount_count += 1
            elif line.startswith('P'):
                current['payee'] = line[1:]
            elif line.startswith('L'):
                current['label'] = line[1:]
    # Flush trailing record when file omits final '^'
    if current:
        records.append(current)
    return records, invalid_amount_count

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/parse-qif.py <path-to-qif>")
        return 1
    if len(sys.argv) > 2:
        print("ERROR: parse-qif accepts exactly one file path.")
        print("Tip: loop files with: for f in data/bank-export-*.qif; do python3 scripts/parse-qif.py \"$f\"; done")
        return 1

    path = sys.argv[1]
    if not os.path.exists(path):
        print(f"ERROR: QIF file not found: {path}")
        return 2

    try:
        records, invalid_amount_count = parse_qif(path)
    except OSError as exc:
        print(f"ERROR: Failed to read QIF file: {exc}")
        return 3

    debits = [r for r in records if isinstance(r.get('amount'), (int, float)) and r['amount'] < 0]
    credits = [r for r in records if isinstance(r.get('amount'), (int, float)) and r['amount'] > 0]

    print(f"Total transactions: {len(records)}")
    print(f"  Debits (SPEND):  {len(debits)} (${sum(abs(r['amount']) for r in debits):,.2f})")
    print(f"  Credits (RECEIVE): {len(credits)} (${sum(r['amount'] for r in credits):,.2f})")
    if records:
        parsed_dates = [parse_date(r.get('date', '')) for r in records]
        parsed_dates = [d for d in parsed_dates if d is not None]
        if parsed_dates:
            print(f"  Date range: {min(parsed_dates).isoformat()} to {max(parsed_dates).isoformat()}")
        else:
            print("  Date range: unknown (unparseable date format)")
    else:
        print("  Date range: n/a (no records)")
    if invalid_amount_count:
        print(f"  WARNING: {invalid_amount_count} malformed amount field(s) ignored")
    print()

    payee_totals = defaultdict(lambda: {'count': 0, 'total': 0.0})
    for r in debits:
        p = r.get('payee', 'Unknown')
        payee_totals[p]['count'] += 1
        payee_totals[p]['total'] += abs(r['amount'])

    print("Top 20 payees by total spend:")
    for p, d in sorted(payee_totals.items(), key=lambda x: -x[1]['total'])[:20]:
        print(f"  {d['count']:>3}x  ${d['total']:>10,.2f}  {p[:60]}")
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
