#!/usr/bin/env python3
"""Sync reconciliation CSVs between local files and Google Sheets.

Usage:
    # Read from Google Sheet to local CSV
    python3 scripts/gsheet-sync.py read SPREADSHEET_ID [--gid GID] --output path/to/file.csv

    # Write local CSV to Google Sheet
    python3 scripts/gsheet-sync.py write SPREADSHEET_ID [--gid GID] --input path/to/file.csv

    # Test connection to a Google Sheet
    python3 scripts/gsheet-sync.py test SPREADSHEET_ID

Environment:
    Service account key: ~/.config/gspread/service_account.json
    The target Google Sheet must be shared with the service account email as Editor.
"""

import argparse
import csv
import io
import json
import sys
from pathlib import Path

try:
    import gspread
except ImportError:
    print("ERROR: gspread not installed. Run: pip3 install gspread", file=sys.stderr)
    sys.exit(1)


def get_client():
    """Create authenticated gspread client."""
    key_path = Path.home() / ".config" / "gspread" / "service_account.json"
    if not key_path.exists():
        print(f"ERROR: Service account key not found at {key_path}", file=sys.stderr)
        sys.exit(1)
    return gspread.service_account(filename=str(key_path))


def cmd_test(args):
    """Test connection to a Google Sheet."""
    gc = get_client()
    sh = gc.open_by_key(args.spreadsheet_id)
    worksheets = sh.worksheets()
    print(json.dumps({
        "ok": True,
        "title": sh.title,
        "sheets": [{"title": ws.title, "gid": ws.id, "rows": ws.row_count, "cols": ws.col_count} for ws in worksheets],
    }, indent=2))


def cmd_read(args):
    """Read Google Sheet to local CSV file."""
    gc = get_client()
    sh = gc.open_by_key(args.spreadsheet_id)

    if args.gid:
        worksheet = next((ws for ws in sh.worksheets() if str(ws.id) == str(args.gid)), None)
        if not worksheet:
            print(f"ERROR: No worksheet with gid={args.gid}", file=sys.stderr)
            sys.exit(1)
    else:
        worksheet = sh.sheet1

    rows = worksheet.get_all_values()
    if not rows:
        print("WARNING: Sheet is empty", file=sys.stderr)
        sys.exit(0)

    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerows(rows)

    # Count statuses from header
    header = rows[0]
    status_idx = header.index("Status") if "Status" in header else None
    status_counts = {}
    if status_idx is not None:
        for row in rows[1:]:
            val = row[status_idx].strip() if status_idx < len(row) else ""
            key = val if val else "blank"
            status_counts[key] = status_counts.get(key, 0) + 1

    print(json.dumps({
        "ok": True,
        "rows": len(rows) - 1,
        "output": str(output_path),
        "statusCounts": status_counts,
    }, indent=2))


def cmd_write(args):
    """Write local CSV to Google Sheet."""
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"ERROR: File not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    with open(input_path, "r") as f:
        reader = csv.reader(f)
        rows = list(reader)

    if not rows:
        print("ERROR: CSV is empty", file=sys.stderr)
        sys.exit(1)

    gc = get_client()
    sh = gc.open_by_key(args.spreadsheet_id)

    if args.gid:
        worksheet = next((ws for ws in sh.worksheets() if str(ws.id) == str(args.gid)), None)
        if not worksheet:
            print(f"ERROR: No worksheet with gid={args.gid}", file=sys.stderr)
            sys.exit(1)
    else:
        worksheet = sh.sheet1

    worksheet.clear()
    worksheet.update(rows, "A1")

    print(json.dumps({
        "ok": True,
        "rows": len(rows) - 1,
        "sheet": worksheet.title,
        "spreadsheet": sh.title,
    }, indent=2))


def main():
    parser = argparse.ArgumentParser(description="Sync CSVs with Google Sheets")
    sub = parser.add_subparsers(dest="command", required=True)

    p_test = sub.add_parser("test", help="Test connection")
    p_test.add_argument("spreadsheet_id")

    p_read = sub.add_parser("read", help="Read sheet to CSV")
    p_read.add_argument("spreadsheet_id")
    p_read.add_argument("--gid", help="Worksheet GID (default: first sheet)")
    p_read.add_argument("--output", required=True, help="Output CSV path")

    p_write = sub.add_parser("write", help="Write CSV to sheet")
    p_write.add_argument("spreadsheet_id")
    p_write.add_argument("--gid", help="Worksheet GID (default: first sheet)")
    p_write.add_argument("--input", required=True, help="Input CSV path")

    args = parser.parse_args()
    {"test": cmd_test, "read": cmd_read, "write": cmd_write}[args.command](args)


if __name__ == "__main__":
    main()
