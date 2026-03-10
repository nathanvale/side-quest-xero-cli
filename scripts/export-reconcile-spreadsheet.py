#!/usr/bin/env python3
"""Export a sealed quarter to the reconciliation review CSV contract."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Any

from reconcile_roundtrip import (
    REVIEW_FIELDNAMES,
    build_review_rows_from_seal,
    load_accounts_map,
    load_ndjson,
    load_seal,
    write_review_csv,
)

DEFAULT_GOOGLE_DRIVE_INBOX = (
    Path.home()
    / "Library/CloudStorage/GoogleDrive-hi@nathanvale.com/My Drive/00 Inbox"
)


def load_contact_lookup(path: str | None) -> dict[str, Any]:
    """Load an existing contact lookup JSON file if present."""
    if not path:
        return {}
    lookup_path = Path(path)
    if not lookup_path.exists():
        return {}
    with lookup_path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        return {}
    lookup = payload.get("lookup", payload)
    return lookup if isinstance(lookup, dict) else {}
def build_legacy_seal(
    statement_lines_path: str,
    accounts_path: str,
    lookup_path: str | None,
) -> dict[str, Any]:
    """Support the old positional invocation by wrapping inputs in a seal-shaped object."""
    accounts = load_ndjson(accounts_path)
    return {
        "quarter": "legacy",
        "statementLines": load_ndjson(statement_lines_path),
        "accounts": accounts,
        "contactLookup": {"lookup": load_contact_lookup(lookup_path)},
        "history": {"rows": []},
        "sourceManifest": {
            "statementLines": {"path": statement_lines_path},
            "accounts": {"path": accounts_path},
        },
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse CLI arguments while keeping positional backward compatibility."""
    parser = argparse.ArgumentParser(
        description="Export a reconciliation review CSV from a quarter seal."
    )
    parser.add_argument(
        "legacy",
        nargs="*",
        help=(
            "Backward-compatible mode: <statement-lines.ndjson> <accounts.ndjson> "
            "<output.csv> [contact-lookup.json]"
        ),
    )
    parser.add_argument("--seal", help="Path to a quarter seal JSON file")
    parser.add_argument("--output", help="Path to the review CSV to write")
    parser.add_argument(
        "--copy-to-google-drive",
        action="store_true",
        help="Copy the generated CSV to the mounted Google Drive inbox path",
    )
    parser.add_argument(
        "--google-drive-inbox",
        default=str(DEFAULT_GOOGLE_DRIVE_INBOX),
        help="Mounted Google Drive inbox directory used with --copy-to-google-drive",
    )
    args = parser.parse_args(argv)

    if args.seal:
        if not args.output:
            parser.error("--output is required when using --seal")
        if args.legacy:
            parser.error("do not mix --seal with positional legacy arguments")
        return args

    if len(args.legacy) not in (3, 4):
        parser.error(
            "usage: export-reconcile-spreadsheet.py --seal <seal.json> --output <review.csv> "
            "or export-reconcile-spreadsheet.py <statement-lines.ndjson> <accounts.ndjson> <output.csv> "
            "[contact-lookup.json]"
        )
    args.output = args.legacy[2]
    return args


def main(argv: list[str] | None = None) -> int:
    """Build the review CSV from a seal or legacy positional inputs."""
    args = parse_args(argv if argv is not None else sys.argv[1:])

    if args.seal:
        seal = load_seal(args.seal)
    else:
        lookup_path = args.legacy[3] if len(args.legacy) == 4 else None
        seal = build_legacy_seal(args.legacy[0], args.legacy[1], lookup_path)

    rows = build_review_rows_from_seal(seal)
    write_review_csv(args.output, rows)
    drive_copy_path: Path | None = None
    if args.copy_to_google_drive:
        inbox = Path(args.google_drive_inbox)
        if not inbox.exists():
            raise ValueError(f"Google Drive inbox does not exist: {inbox}")
        drive_copy_path = inbox / Path(args.output).name
        shutil.copy2(args.output, drive_copy_path)

    accounts = load_accounts_map(seal.get("accounts") or [])
    high = sum(1 for row in rows if row["Confidence"].startswith("high"))
    medium = sum(1 for row in rows if row["Confidence"].startswith("medium"))
    low = sum(1 for row in rows if row["Confidence"].startswith("low"))

    print(f"Exported {len(rows)} review rows to {args.output}")
    print(f"  Quarter: {seal.get('quarter', 'legacy')}")
    print(f"  Columns: {', '.join(REVIEW_FIELDNAMES)}")
    print(f"  Accounts available: {len(accounts)}")
    print(f"  High confidence: {high}")
    print(f"  Medium confidence: {medium}")
    print(f"  Low confidence: {low}")
    if drive_copy_path is not None:
        print(f"  Google Drive copy: {drive_copy_path}")
        print("  Undo path: use Google Sheets version history for reviewed iterations.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
