#!/usr/bin/env python3
"""Read and validate reconciliation review CSV files against a quarter seal."""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from pathlib import Path
from typing import Any

from reconcile_roundtrip import (
    REVIEW_FIELDNAMES,
    VALID_REVIEW_STATUSES,
    build_review_rows_from_seal,
    clean_statement_line_id,
    load_accounts_map,
    normalize_status,
)


def load_seal(path: str) -> dict[str, Any]:
    """Load and minimally validate a quarter seal."""
    with Path(path).open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("seal must contain a JSON object")
    if not isinstance(payload.get("statementLines"), list):
        raise ValueError("seal is missing statementLines")
    if not isinstance(payload.get("accounts"), list):
        raise ValueError("seal is missing accounts")
    return payload


def ensure_stable_file(path: Path) -> None:
    """Reject files that are actively changing during read-back."""
    before = path.stat()
    after = path.stat()
    if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns:
        raise ValueError(f"CSV appears to be changing during read-back: {path}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse subcommands for the review CSV helper."""
    parser = argparse.ArgumentParser(description="Read reconciliation review CSV files.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    read_parser = subparsers.add_parser("read", help="Validate and summarize a review CSV")
    read_parser.add_argument("csv_path", help="Path to the review CSV")
    read_parser.add_argument("--seal", required=True, help="Quarter seal JSON path")
    return parser.parse_args(argv)


def validate_header(fieldnames: list[str] | None) -> list[str]:
    """Validate the CSV header against the fixed review contract."""
    if fieldnames is None:
        raise ValueError("CSV is empty")
    if fieldnames != REVIEW_FIELDNAMES:
        raise ValueError(
            "CSV header mismatch: expected "
            + ", ".join(REVIEW_FIELDNAMES)
            + " but found "
            + ", ".join(fieldnames)
        )
    return fieldnames


def read_csv_rows(
    csv_path: Path,
    seal: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Validate rows and return normalized data plus any validation errors."""
    ensure_stable_file(csv_path)
    accounts = load_accounts_map(seal.get("accounts") or [])
    expected_ids = {
        str(item.get("statementLineId", "")).strip()
        for item in seal.get("statementLines") or []
        if not bool(item.get("isReconciled"))
    }
    proposals = {
        row["StatementLineID"]: row
        for row in build_review_rows_from_seal(seal)
    }

    rows: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    diffs: list[dict[str, Any]] = []
    seen_ids: dict[str, int] = {}
    blank_rows_ignored = 0

    csv.field_size_limit(max(csv.field_size_limit(), 1024 * 1024))
    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, restkey="__extra__", restval="")
        validate_header(reader.fieldnames)

        for row in reader:
            line_number = reader.line_num
            extra_values = row.get("__extra__")
            if extra_values:
                errors.append(
                    {
                        "line": line_number,
                        "code": "extra-columns",
                        "message": f"row has unexpected extra cells: {extra_values}",
                    }
                )
                continue

            candidate = {field: str(row.get(field, "")) for field in REVIEW_FIELDNAMES}
            if not any(value.strip() for value in candidate.values()):
                blank_rows_ignored += 1
                continue

            raw_id = candidate["StatementLineID"]
            if not raw_id.strip():
                errors.append(
                    {
                        "line": line_number,
                        "code": "missing-id",
                        "message": "row has data but no StatementLineID",
                    }
                )
                continue

            try:
                statement_line_id = clean_statement_line_id(raw_id)
            except ValueError as exc:
                errors.append(
                    {
                        "line": line_number,
                        "code": "invalid-id",
                        "message": str(exc),
                    }
                )
                continue

            status = normalize_status(candidate["Status"])
            if status not in VALID_REVIEW_STATUSES:
                errors.append(
                    {
                        "line": line_number,
                        "code": "invalid-status",
                        "message": f"unknown Status '{candidate['Status']}'",
                    }
                )
                continue

            account_code = candidate["AccountCode"].strip()
            if account_code and account_code not in accounts:
                errors.append(
                    {
                        "line": line_number,
                        "code": "invalid-account-code",
                        "message": f"AccountCode '{account_code}' is not in the sealed chart of accounts",
                    }
                )
                continue
            if status in {"APPROVE", "EDIT"} and not account_code:
                errors.append(
                    {
                        "line": line_number,
                        "code": "missing-account-code",
                        "message": f"{status} rows must include an AccountCode",
                    }
                )
                continue

            if statement_line_id in seen_ids:
                errors.append(
                    {
                        "line": line_number,
                        "code": "duplicate-id",
                        "message": f"duplicate StatementLineID also seen on line {seen_ids[statement_line_id]}",
                    }
                )
                continue
            seen_ids[statement_line_id] = line_number

            normalized_row = {
                **candidate,
                "Status": status,
                "StatementLineID": statement_line_id,
                "line": line_number,
            }
            rows.append(normalized_row)

            proposal = proposals.get(statement_line_id)
            if proposal is None:
                continue
            for field in ("AccountCode", "Contact"):
                from_value = proposal.get(field, "")
                to_value = normalized_row.get(field, "")
                if from_value != to_value:
                    diffs.append(
                        {
                            "statementLineId": statement_line_id,
                            "line": line_number,
                            "field": field,
                            "from": from_value,
                            "to": to_value,
                            "status": status,
                        }
                    )

    row_ids = {row["StatementLineID"] for row in rows}
    missing_ids = sorted(expected_ids - row_ids)
    unexpected_ids = sorted(row_ids - expected_ids)
    if len(rows) != len(expected_ids):
        errors.append(
            {
                "code": "row-count-mismatch",
                "message": f"expected {len(expected_ids)} non-empty data rows, found {len(rows)}",
            }
        )
    if missing_ids:
        errors.append(
            {
                "code": "missing-ids",
                "message": f"CSV is missing {len(missing_ids)} statement lines",
                "statementLineIds": missing_ids[:10],
            }
        )
    if unexpected_ids:
        errors.append(
            {
                "code": "unexpected-ids",
                "message": f"CSV contains {len(unexpected_ids)} unknown statement lines",
                "statementLineIds": unexpected_ids[:10],
            }
        )

    status_counts = {"APPROVE": 0, "EDIT": 0, "SKIP": 0, "REVIEW": 0, "blank": 0}
    for row in rows:
        status = row["Status"]
        if status:
            status_counts[status] += 1
        else:
            status_counts["blank"] += 1

    summary = {
        "expectedRows": len(expected_ids),
        "dataRows": len(rows),
        "blankRowsIgnored": blank_rows_ignored,
        "diffCount": len(diffs),
        "statusCounts": status_counts,
    }
    return rows, errors, {"summary": summary, "diffs": diffs}


def cmd_read(csv_path: str, seal_path: str) -> int:
    """Validate a review CSV and print a structured summary."""
    payload: dict[str, Any]
    try:
        seal = load_seal(seal_path)
        rows, errors, extra = read_csv_rows(Path(csv_path), seal)
        payload = {
            "ok": len(errors) == 0,
            "csvPath": csv_path,
            "sealPath": seal_path,
            "quarter": seal.get("quarter"),
            "summary": extra["summary"],
            "diffs": extra["diffs"],
            "errors": errors,
            "rows": [
                {
                    "Status": row["Status"],
                    "AccountCode": row["AccountCode"],
                    "Contact": row["Contact"],
                    "StatementLineID": row["StatementLineID"],
                    "line": row["line"],
                }
                for row in rows
            ],
        }
    except (OSError, ValueError, csv.Error, json.JSONDecodeError) as exc:
        payload = {
            "ok": False,
            "csvPath": csv_path,
            "sealPath": seal_path,
            "errors": [{"code": "read-failed", "message": str(exc)}],
        }
        print(json.dumps(payload, indent=2))
        return 2

    print(json.dumps(payload, indent=2))
    return 0 if payload["ok"] else 2


def main(argv: list[str] | None = None) -> int:
    """CLI entry point for review CSV tooling."""
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.command == "read":
        return cmd_read(args.csv_path, args.seal)
    raise ValueError(f"unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
