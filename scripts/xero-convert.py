#!/usr/bin/env python3
"""Convert raw Xero API JSON responses to NDJSON files."""

import json
import os
import sys
from typing import Any


def atomic_write_ndjson(path: str, records: list[dict[str, Any]]) -> None:
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        for record in records:
            f.write(json.dumps(record) + "\n")
    os.rename(tmp, path)


def convert_by_key(raw_path: str, output_path: str, key: str) -> int:
    with open(raw_path) as f:
        data = json.load(f)
    status = data.get("Status", "unknown")
    records = data.get(key, [])
    print(f"Status: {status}, {key}: {len(records)} records")
    if not records:
        print(f"WARNING: No records found for key '{key}'")
        return 2
    atomic_write_ndjson(output_path, records)
    print(f"Written: {output_path} ({len(records)} records)")
    return 0


def verify_by_key(raw_path: str, key: str) -> int:
    with open(raw_path) as f:
        data = json.load(f)
    status = str(data.get("Status", "unknown"))
    records = data.get(key, [])
    count = len(records) if isinstance(records, list) else 0
    print(f"Status: {status}")
    print(f"{key}: {count} records")
    if status.upper() != "OK" or count == 0:
        print("WARNING: response may be incomplete or empty")
        return 2
    return 0


def extract_statement_lines(data: dict[str, Any], envelope_path: str | None = None) -> tuple[list[dict[str, Any]], str]:
    if envelope_path == "statements[].statementLines[]":
        stmts = data.get("statements", [])
        if isinstance(stmts, list):
            return [line for s in stmts if isinstance(s, dict) for line in s.get("statementLines", [])], envelope_path
    elif envelope_path == "statements[].lines[]":
        stmts = data.get("statements", [])
        if isinstance(stmts, list):
            return [line for s in stmts if isinstance(s, dict) for line in s.get("lines", [])], envelope_path
    elif envelope_path == "statementLines":
        lines = data.get("statementLines", [])
        if isinstance(lines, list):
            return lines, envelope_path
    elif envelope_path:
        candidate = data.get(envelope_path)
        if isinstance(candidate, list):
            return candidate, envelope_path

    if "statements" in data and isinstance(data["statements"], list):
        stmts = data["statements"]
        if stmts and isinstance(stmts[0], dict) and "statementLines" in stmts[0]:
            return [l for s in stmts if isinstance(s, dict) for l in s.get("statementLines", [])], "statements[].statementLines[]"
        if stmts and isinstance(stmts[0], dict) and "lines" in stmts[0]:
            return [l for s in stmts if isinstance(s, dict) for l in s.get("lines", [])], "statements[].lines[]"
    if "statementLines" in data and isinstance(data["statementLines"], list):
        return data["statementLines"], "statementLines"
    for key, value in data.items():
        if isinstance(value, list) and value and isinstance(value[0], dict) and "statementLineId" in value[0]:
            return value, key
    return [], envelope_path or "unknown"


def convert_statement_lines(raw_path: str, output_path: str, envelope_path: str | None = None) -> int:
    with open(raw_path) as f:
        data = json.load(f)
    lines, detected_path = extract_statement_lines(data, envelope_path)
    if not lines:
        print("WARNING: Could not find statement lines in raw response.")
        return 2
    print(f"Found {len(lines)} statement lines via: {detected_path}")
    atomic_write_ndjson(output_path, lines)
    print(f"Written: {output_path} ({len(lines)} records)")
    return 0


def inspect_envelope(raw_path: str) -> int:
    with open(raw_path) as f:
        data = json.load(f)
    lines, envelope_path = extract_statement_lines(data)
    print(f"Top-level keys: {list(data.keys())}")
    print(f"Envelope path: {envelope_path}")
    print(f"Statement lines found: {len(lines)}")
    if lines:
        print(f"Sample keys: {list(lines[0].keys())}")
        sample = lines[0]
        print(
            "Sample values: "
            f"payee={sample.get('payee', 'N/A')} "
            f"amount={sample.get('amount', 'N/A')} "
            f"isReconciled={sample.get('isReconciled', 'N/A')}"
        )
    return 0 if lines else 2


def write_envelope_profile(raw_path: str, profile_path: str) -> int:
    with open(raw_path) as f:
        data = json.load(f)
    lines, envelope_path = extract_statement_lines(data)
    if not lines:
        print("ERROR: unable to detect statement line envelope")
        return 2
    profile = {
        "detectedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "envelopePath": envelope_path,
        "topLevelKeys": list(data.keys()),
        "sampleKeys": list(lines[0].keys()),
    }
    tmp = profile_path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(profile, f, indent=2)
        f.write("\n")
    os.rename(tmp, profile_path)
    print(f"Saved envelope profile: {profile_path}")
    return 0


def get_envelope_path(profile_path: str) -> int:
    try:
        with open(profile_path) as f:
            profile = json.load(f)
        path = str(profile.get("envelopePath", "")).strip()
        if not path:
            raise ValueError("missing envelopePath")
        print(path)
        return 0
    except Exception:
        print("statements[].statementLines[]")
        return 0


def legacy_mode(cmd: str) -> int:
    with open("/tmp/xero-extract-tmpdir.txt") as f:
        tmpdir = f.read().strip()
    if cmd == "accounts":
        return convert_by_key(f"{tmpdir}/xero-accounts-raw.json", "data/accounts.ndjson", "Accounts")
    if cmd == "bank-transactions":
        return convert_by_key(f"{tmpdir}/xero-banktransactions-raw.json", "data/bank-transactions.ndjson", "BankTransactions")
    if cmd == "invoices":
        return convert_by_key(f"{tmpdir}/xero-invoices-raw.json", "data/invoices.ndjson", "Invoices")
    if cmd == "contacts":
        return convert_by_key(f"{tmpdir}/xero-contacts-raw.json", "data/contacts.ndjson", "Contacts")
    if cmd == "statement-lines":
        return convert_statement_lines(f"{tmpdir}/xero-bankstatementsplus-raw.json", "data/statement-lines.ndjson")
    print(f"Unknown command: {cmd}")
    return 1


def main() -> int:
    if len(sys.argv) >= 4 and sys.argv[1] == "verify-key":
        return verify_by_key(sys.argv[2], sys.argv[3])
    if len(sys.argv) >= 3 and sys.argv[1] == "inspect-envelope":
        return inspect_envelope(sys.argv[2])
    if len(sys.argv) >= 4 and sys.argv[1] == "write-envelope-profile":
        return write_envelope_profile(sys.argv[2], sys.argv[3])
    if len(sys.argv) >= 3 and sys.argv[1] == "get-envelope-path":
        return get_envelope_path(sys.argv[2])

    if len(sys.argv) >= 4:
        raw_path = sys.argv[1]
        output_path = sys.argv[2]
        key_or_envelope = sys.argv[3]
        if key_or_envelope in ("Accounts", "BankTransactions", "Invoices", "Contacts"):
            return convert_by_key(raw_path, output_path, key_or_envelope)
        return convert_statement_lines(raw_path, output_path, key_or_envelope)
    if len(sys.argv) == 2:
        return legacy_mode(sys.argv[1])
    print("Usage: python3 scripts/xero-convert.py <raw.json> <out.ndjson> <key|envelopePath>")
    print("       python3 scripts/xero-convert.py verify-key <raw.json> <key>")
    print("       python3 scripts/xero-convert.py inspect-envelope <raw.json>")
    print("       python3 scripts/xero-convert.py write-envelope-profile <raw.json> <profile.json>")
    print("       python3 scripts/xero-convert.py get-envelope-path <profile.json>")
    print("Legacy: python3 scripts/xero-convert.py <accounts|bank-transactions|invoices|contacts|statement-lines>")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
