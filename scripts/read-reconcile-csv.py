#!/usr/bin/env python3
"""Read and validate reconciliation review CSV files against a quarter seal."""

from __future__ import annotations

import argparse
import csv
import json
import hashlib
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from reconcile_roundtrip import (
    REVIEW_FIELDNAMES,
    VALID_REVIEW_STATUSES,
    atomic_write_json,
    build_review_rows_from_seal,
    clean_statement_line_id,
    json_sha256,
    load_accounts_map,
    normalize_status,
    normalize_payee,
    write_review_csv,
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

    merge_parser = subparsers.add_parser(
        "merge",
        help="Refresh REVIEW/blank rows from the latest sealed proposals",
    )
    merge_parser.add_argument("csv_path", help="Path to the review CSV")
    merge_parser.add_argument("--seal", required=True, help="Quarter seal JSON path")
    merge_parser.add_argument("--output", required=True, help="Path to write the merged CSV")

    export_parser = subparsers.add_parser(
        "export-post-bodies",
        help="Build POST queue payloads from APPROVE/EDIT rows",
    )
    export_parser.add_argument("csv_path", help="Path to the review CSV")
    export_parser.add_argument("--seal", required=True, help="Quarter seal JSON path")
    export_parser.add_argument("--output", required=True, help="Path to write the POST queue JSON")

    begin_parser = subparsers.add_parser(
        "begin-post-run",
        help="Write a confirmed post-run state after explicit interlock confirmation",
    )
    begin_parser.add_argument("queue_path", help="Path to the exported POST queue JSON")
    begin_parser.add_argument("--output", required=True, help="Path to write the post-run state JSON")
    begin_parser.add_argument(
        "--confirm",
        required=True,
        help='Exact confirmation phrase, for example "WRITE Q4 FY25"',
    )

    record_parser = subparsers.add_parser(
        "record-post-result",
        help="Apply one POST result to the post-run state and append the run log",
    )
    record_parser.add_argument("state_path", help="Path to the post-run state JSON")
    record_parser.add_argument("--statement-line-id", required=True, help="StatementLineID being recorded")
    record_parser.add_argument("--response-code", type=int, help="HTTP response code")
    record_parser.add_argument("--bank-transaction-id", help="Returned BankTransactionID on success")
    record_parser.add_argument("--error-reason", help="Validation or transport error details")
    record_parser.add_argument("--retry-after-seconds", type=int, help="Retry-After seconds for 429s")
    record_parser.add_argument(
        "--transport-error",
        choices=("timeout", "network"),
        help="Record an unknown transport outcome that should retry the same idempotency key",
    )
    return parser.parse_args(argv)


def now_iso() -> str:
    """Return an ISO8601 timestamp with local timezone offset."""
    return datetime.now().astimezone().isoformat(timespec="seconds")


def iso_plus_seconds(iso_value: str, seconds: int) -> str:
    """Return a timestamp offset by some seconds."""
    return (
        datetime.fromisoformat(iso_value) + timedelta(seconds=seconds)
    ).isoformat(timespec="seconds")


def load_post_queue(path: str | Path) -> dict[str, Any]:
    """Load the exported POST queue JSON."""
    with Path(path).open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("post queue must contain a JSON object")
    if not isinstance(payload.get("items"), list):
        raise ValueError("post queue is missing items")
    return payload


def load_post_run_state(path: str | Path) -> dict[str, Any]:
    """Load the post-run state JSON."""
    with Path(path).open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("post-run state must contain a JSON object")
    if not isinstance(payload.get("items"), dict):
        raise ValueError("post-run state is missing items")
    return payload


def append_jsonl(path: str | Path, payload: dict[str, Any]) -> None:
    """Append one JSON line to an audit log."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, sort_keys=True))
        handle.write("\n")


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


def load_ordered_rows(csv_path: Path) -> list[dict[str, Any]]:
    """Load CSV rows in order, preserving fully blank grouping rows."""
    ordered_rows: list[dict[str, Any]] = []
    with csv_path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, restkey="__extra__", restval="")
        validate_header(reader.fieldnames)
        for row in reader:
            candidate = {field: str(row.get(field, "")) for field in REVIEW_FIELDNAMES}
            if not any(value.strip() for value in candidate.values()):
                ordered_rows.append({"kind": "blank", "row": candidate, "line": reader.line_num})
                continue
            ordered_rows.append({"kind": "data", "row": candidate, "line": reader.line_num})
    return ordered_rows


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


def cmd_merge(csv_path: str, seal_path: str, output_path: str) -> int:
    """Merge refreshed proposals into REVIEW/blank rows while preserving row order."""
    try:
        seal = load_seal(seal_path)
        _, errors, _ = read_csv_rows(Path(csv_path), seal)
        if errors:
            payload = {
                "ok": False,
                "csvPath": csv_path,
                "sealPath": seal_path,
                "outputPath": output_path,
                "errors": errors,
            }
            print(json.dumps(payload, indent=2))
            return 2

        proposals = {
            row["StatementLineID"]: row for row in build_review_rows_from_seal(seal)
        }
        ordered_rows = load_ordered_rows(Path(csv_path))
        merged_rows: list[dict[str, str]] = []
        changes: list[dict[str, Any]] = []

        for entry in ordered_rows:
            row = dict(entry["row"])
            if entry["kind"] == "blank":
                merged_rows.append(row)
                continue

            statement_line_id = clean_statement_line_id(row["StatementLineID"])
            row["StatementLineID"] = statement_line_id
            row["Status"] = normalize_status(row["Status"])
            proposal = proposals.get(statement_line_id)
            if proposal is None:
                merged_rows.append(row)
                continue

            status = row["Status"]
            updated_row = dict(row)
            fields_to_update = ()
            if status == "REVIEW":
                fields_to_update = (
                    "AccountCode",
                    "AccountName",
                    "Contact",
                    "Confidence",
                    "Evidence",
                )
            elif status == "":
                fields_to_update = (
                    "Date",
                    "Payee",
                    "Amount",
                    "Type",
                    "AccountCode",
                    "AccountName",
                    "Contact",
                    "Confidence",
                    "Evidence",
                )

            for field in fields_to_update:
                new_value = proposal.get(field, "")
                if updated_row.get(field, "") != new_value:
                    changes.append(
                        {
                            "statementLineId": statement_line_id,
                            "line": entry["line"],
                            "field": field,
                            "from": updated_row.get(field, ""),
                            "to": new_value,
                            "status": status or "blank",
                        }
                    )
                    updated_row[field] = new_value

            merged_rows.append(updated_row)

        write_review_csv(output_path, merged_rows)
        payload = {
            "ok": True,
            "csvPath": csv_path,
            "sealPath": seal_path,
            "outputPath": output_path,
            "changedRows": len({change["statementLineId"] for change in changes}),
            "changeCount": len(changes),
            "changes": changes,
        }
        print(json.dumps(payload, indent=2))
        return 0
    except (OSError, ValueError, csv.Error, json.JSONDecodeError) as exc:
        payload = {
            "ok": False,
            "csvPath": csv_path,
            "sealPath": seal_path,
            "outputPath": output_path,
            "errors": [{"code": "merge-failed", "message": str(exc)}],
        }
        print(json.dumps(payload, indent=2))
        return 2


def resolve_contact_payload(
    contact_name: str,
    contact_lookup: dict[str, Any],
) -> dict[str, str]:
    """Resolve a contact name to ContactID when the seal can prove it."""
    normalized = normalize_payee(contact_name).lower()
    lookup_entry = contact_lookup.get(normalized)
    if isinstance(lookup_entry, dict):
        contact_id = str(lookup_entry.get("ContactID", "")).strip()
        resolved_name = str(lookup_entry.get("ContactName", contact_name)).strip() or contact_name
        if contact_id:
            return {"ContactID": contact_id, "Name": resolved_name}
        return {"Name": resolved_name}
    return {"Name": contact_name}


def cmd_export_post_bodies(csv_path: str, seal_path: str, output_path: str) -> int:
    """Export POST queue payloads for APPROVE/EDIT rows only."""
    try:
        seal = load_seal(seal_path)
        rows, errors, _ = read_csv_rows(Path(csv_path), seal)
        if errors:
            payload = {
                "ok": False,
                "csvPath": csv_path,
                "sealPath": seal_path,
                "outputPath": output_path,
                "errors": errors,
            }
            print(json.dumps(payload, indent=2))
            return 2

        bank_account_id = str(seal.get("bankAccountId", "")).strip()
        if not bank_account_id:
            raise ValueError("seal is missing bankAccountId")

        statement_lines = {
            str(item.get("statementLineId", "")).strip(): item
            for item in seal.get("statementLines") or []
        }
        contact_lookup = seal.get("contactLookup", {}).get("lookup") or {}
        queue_rows: list[dict[str, Any]] = []
        total_abs_amount = 0.0

        for row in rows:
            status = row["Status"]
            if status not in {"APPROVE", "EDIT"}:
                continue

            statement_line_id = row["StatementLineID"]
            statement_line = statement_lines.get(statement_line_id)
            if not isinstance(statement_line, dict):
                raise ValueError(f"seal is missing statement line {statement_line_id}")

            amount = float(statement_line.get("amount", 0) or 0)
            tx_type = "RECEIVE" if amount > 0 else "SPEND"
            tax_type = "OUTPUT" if tx_type == "RECEIVE" else "INPUT"
            payee = str(statement_line.get("payee", "")).strip()
            account_code = row["AccountCode"].strip()
            contact_name = row["Contact"].strip() or payee
            total_abs_amount += abs(amount)

            body = {
                "Type": tx_type,
                "Contact": resolve_contact_payload(contact_name, contact_lookup),
                "LineItems": [
                    {
                        "Description": payee,
                        "Quantity": 1,
                        "UnitAmount": round(abs(amount), 2),
                        "AccountCode": account_code,
                        "TaxType": tax_type,
                    }
                ],
                "BankAccount": {"AccountID": bank_account_id},
                "Date": str(statement_line.get("postedDate", "")).strip()[:10],
                "CurrencyCode": str(statement_line.get("currencyCode", "AUD")).strip() or "AUD",
                "IsReconciled": True,
            }
            queue_rows.append(
                {
                    "statementLineId": statement_line_id,
                    "status": status,
                    "accountCode": account_code,
                    "contact": body["Contact"],
                    "body": body,
                }
            )

        queue_hash = json_sha256(queue_rows)
        payload = {
            "schemaVersion": 1,
            "quarter": seal.get("quarter"),
            "queueHash": queue_hash,
            "rows": len(queue_rows),
            "approvedRows": sum(1 for row in queue_rows if row["status"] == "APPROVE"),
            "editedRows": sum(1 for row in queue_rows if row["status"] == "EDIT"),
            "totalAbsAmount": round(total_abs_amount, 2),
            "items": queue_rows,
        }
        atomic_write_json(output_path, payload)
        print(json.dumps({"ok": True, **payload, "outputPath": output_path}, indent=2))
        return 0
    except (OSError, ValueError, csv.Error, json.JSONDecodeError) as exc:
        payload = {
            "ok": False,
            "csvPath": csv_path,
            "sealPath": seal_path,
            "outputPath": output_path,
            "errors": [{"code": "export-post-bodies-failed", "message": str(exc)}],
        }
        print(json.dumps(payload, indent=2))
        return 2


def cmd_begin_post_run(queue_path: str, output_path: str, confirm: str) -> int:
    """Create the persisted post-run state after explicit write confirmation."""
    try:
        queue = load_post_queue(queue_path)
        quarter = str(queue.get("quarter", "")).strip()
        expected_confirm = f"WRITE {quarter}"
        if confirm != expected_confirm:
            payload = {
                "ok": False,
                "queuePath": queue_path,
                "outputPath": output_path,
                "errors": [
                    {
                        "code": "confirm-mismatch",
                        "message": f'confirmation phrase must be exactly "{expected_confirm}"',
                    }
                ],
            }
            print(json.dumps(payload, indent=2))
            return 2

        started_at = now_iso()
        state_path = Path(output_path)
        log_path = state_path.with_suffix(".log.ndjson")
        items: dict[str, Any] = {}
        for item in queue.get("items", []):
            if not isinstance(item, dict):
                continue
            statement_line_id = str(item.get("statementLineId", "")).strip()
            if not statement_line_id:
                continue
            body = item.get("body") or {}
            items[statement_line_id] = {
                "statementLineId": statement_line_id,
                "status": "confirmed",
                "confirmedAt": started_at,
                "idempotencyKey": hashlib.sha256(
                    f"{queue.get('queueHash', '')}:{statement_line_id}".encode("utf-8")
                ).hexdigest(),
                "requestHash": json_sha256(body),
                "responseCode": None,
                "bankTransactionId": None,
                "errorReason": None,
                "postedAt": None,
                "nextRetryAt": None,
                "tenantPauseUntil": None,
                "sameKeyRetryUntil": None,
            }

        state = {
            "schemaVersion": 1,
            "quarter": quarter,
            "queueHash": queue.get("queueHash"),
            "startedAt": started_at,
            "writeInterlock": confirm,
            "preview": {
                "rows": queue.get("rows", 0),
                "approvedRows": queue.get("approvedRows", 0),
                "editedRows": queue.get("editedRows", 0),
                "totalAbsAmount": queue.get("totalAbsAmount", 0),
            },
            "logFile": str(log_path),
            "items": items,
        }
        atomic_write_json(output_path, state)
        payload = {
            "ok": True,
            "queuePath": queue_path,
            "outputPath": output_path,
            "preview": state["preview"],
            "queueHash": state["queueHash"],
            "logFile": state["logFile"],
        }
        print(json.dumps(payload, indent=2))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        payload = {
            "ok": False,
            "queuePath": queue_path,
            "outputPath": output_path,
            "errors": [{"code": "begin-post-run-failed", "message": str(exc)}],
        }
        print(json.dumps(payload, indent=2))
        return 2


def cmd_record_post_result(
    state_path: str,
    statement_line_id: str,
    response_code: int | None,
    bank_transaction_id: str | None,
    error_reason: str | None,
    retry_after_seconds: int | None,
    transport_error: str | None,
) -> int:
    """Apply one POST result to the persisted post-run state and append the run log."""
    try:
        state = load_post_run_state(state_path)
        items = state["items"]
        item = items.get(statement_line_id)
        if not isinstance(item, dict):
            raise ValueError(f"post-run state does not contain {statement_line_id}")

        attempted_at = now_iso()
        log_entry: dict[str, Any] = {
            "statementLineId": statement_line_id,
            "idempotencyKey": item.get("idempotencyKey"),
            "attemptedAt": attempted_at,
            "responseCode": response_code,
            "bankTransactionId": bank_transaction_id,
            "errorReason": error_reason,
        }

        if transport_error:
            item["status"] = "confirmed"
            item["responseCode"] = None
            item["errorReason"] = error_reason or f"{transport_error} error during POST"
            item["sameKeyRetryUntil"] = iso_plus_seconds(attempted_at, 6 * 60)
            log_entry["result"] = "retryable"
            log_entry["sameKeyRetryUntil"] = item["sameKeyRetryUntil"]
            log_entry["errorReason"] = item["errorReason"]
        elif response_code == 200 and bank_transaction_id:
            item["status"] = "posted"
            item["responseCode"] = response_code
            item["bankTransactionId"] = bank_transaction_id
            item["errorReason"] = None
            item["postedAt"] = attempted_at
            item["nextRetryAt"] = None
            item["tenantPauseUntil"] = None
            item["sameKeyRetryUntil"] = None
            log_entry["result"] = "posted"
        elif response_code == 200:
            item["status"] = "errored"
            item["responseCode"] = response_code
            item["errorReason"] = error_reason or "missing BankTransactionID in successful response"
            log_entry["result"] = "errored"
            log_entry["errorReason"] = item["errorReason"]
        elif response_code == 429:
            if retry_after_seconds is None:
                raise ValueError("429 results require --retry-after-seconds")
            item["status"] = "confirmed"
            item["responseCode"] = response_code
            item["errorReason"] = error_reason or "rate limited"
            item["nextRetryAt"] = iso_plus_seconds(attempted_at, retry_after_seconds)
            log_entry["result"] = "retryable"
            log_entry["retryAfterSeconds"] = retry_after_seconds
            log_entry["nextRetryAt"] = item["nextRetryAt"]
            log_entry["errorReason"] = item["errorReason"]
        elif response_code == 503:
            item["status"] = "confirmed"
            item["responseCode"] = response_code
            item["errorReason"] = error_reason or "Organisation Offline"
            item["tenantPauseUntil"] = iso_plus_seconds(attempted_at, 5 * 60)
            log_entry["result"] = "retryable"
            log_entry["tenantPauseUntil"] = item["tenantPauseUntil"]
            log_entry["errorReason"] = item["errorReason"]
        elif response_code is not None and response_code >= 400:
            item["status"] = "errored"
            item["responseCode"] = response_code
            item["errorReason"] = error_reason or "POST failed"
            log_entry["result"] = "errored"
            log_entry["errorReason"] = item["errorReason"]
        else:
            raise ValueError("must provide either --transport-error or a supported --response-code")

        state["items"][statement_line_id] = item
        atomic_write_json(state_path, state)
        append_jsonl(state.get("logFile") or Path(state_path).with_suffix(".log.ndjson"), log_entry)
        payload = {
            "ok": True,
            "statePath": state_path,
            "statementLineId": statement_line_id,
            "status": item["status"],
            "postedAt": item.get("postedAt"),
            "nextRetryAt": item.get("nextRetryAt"),
            "tenantPauseUntil": item.get("tenantPauseUntil"),
            "sameKeyRetryUntil": item.get("sameKeyRetryUntil"),
            "errorReason": item.get("errorReason"),
            "bankTransactionId": item.get("bankTransactionId"),
        }
        print(json.dumps(payload, indent=2))
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        payload = {
            "ok": False,
            "statePath": state_path,
            "statementLineId": statement_line_id,
            "errors": [{"code": "record-post-result-failed", "message": str(exc)}],
        }
        print(json.dumps(payload, indent=2))
        return 2


def main(argv: list[str] | None = None) -> int:
    """CLI entry point for review CSV tooling."""
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if args.command == "read":
        return cmd_read(args.csv_path, args.seal)
    if args.command == "merge":
        return cmd_merge(args.csv_path, args.seal, args.output)
    if args.command == "export-post-bodies":
        return cmd_export_post_bodies(args.csv_path, args.seal, args.output)
    if args.command == "begin-post-run":
        return cmd_begin_post_run(args.queue_path, args.output, args.confirm)
    if args.command == "record-post-result":
        return cmd_record_post_result(
            args.state_path,
            args.statement_line_id,
            args.response_code,
            args.bank_transaction_id,
            args.error_reason,
            args.retry_after_seconds,
            args.transport_error,
        )
    raise ValueError(f"unsupported command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
