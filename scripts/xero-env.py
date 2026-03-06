#!/usr/bin/env python3
"""Persist and retrieve Xero explorer environment values."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

DATA_DIR = Path("data")
ENV_FILE = DATA_DIR / ".xero-explorer-env.json"


def _read_env() -> dict:
    if not ENV_FILE.exists():
        return {}
    try:
        with ENV_FILE.open() as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_env(data: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = ENV_FILE.with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, ENV_FILE)


def cmd_get_bank_account_id() -> int:
    data = _read_env()
    value = str(data.get("BANK_ACCOUNT_ID", "")).strip()
    if value:
        print(value)
        return 0
    return 1


def cmd_set_bank_account_id(value: str) -> int:
    value = value.strip()
    if not value:
        print("ERROR: BANK_ACCOUNT_ID cannot be empty")
        return 1
    data = _read_env()
    data["BANK_ACCOUNT_ID"] = value
    _write_env(data)
    print(f"Saved BANK_ACCOUNT_ID to {ENV_FILE}")
    return 0


def _bank_accounts_from_ndjson(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open() as f:
        for line in f:
            raw = line.strip()
            if not raw:
                continue
            try:
                item = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(item, dict):
                continue
            if str(item.get("Type", "")).upper() != "BANK":
                continue
            account_id = str(item.get("AccountID", "")).strip()
            if not account_id:
                continue
            rows.append(
                {
                    "AccountID": account_id,
                    "Code": str(item.get("Code", "")).strip(),
                    "Name": str(item.get("Name", "")).strip(),
                    "BankAccountNumber": str(item.get("BankAccountNumber", "")).strip(),
                }
            )
    return rows


def cmd_detect_bank_account_id(accounts_path: str) -> int:
    path = Path(accounts_path)
    if not path.exists():
        print(f"ERROR: accounts file not found: {path}")
        return 2
    rows = _bank_accounts_from_ndjson(path)
    if not rows:
        print("ERROR: no BANK accounts found in accounts.ndjson")
        return 3
    if len(rows) == 1:
        return cmd_set_bank_account_id(rows[0]["AccountID"])
    print("Multiple BANK accounts found. Pick one and set explicitly:")
    for idx, row in enumerate(rows, start=1):
        print(f"  {idx}. {row['AccountID']}  code={row['Code']}  name={row['Name']}  bank={row['BankAccountNumber']}")
    return 4


def cmd_export_snippet() -> int:
    data = _read_env()
    value = str(data.get("BANK_ACCOUNT_ID", "")).strip()
    if not value:
        return 1
    print(f'export BANK_ACCOUNT_ID="{value}"')
    return 0


def usage() -> int:
    print("Usage: python3 scripts/xero-env.py <command> [args]")
    print()
    print("Commands:")
    print("  get-bank-account-id")
    print("  set-bank-account-id <uuid>")
    print("  detect-bank-account-id [accounts_ndjson_path]")
    print("  export-snippet")
    return 1


def main() -> int:
    if len(sys.argv) < 2:
        return usage()

    cmd = sys.argv[1]
    if cmd == "get-bank-account-id":
        return cmd_get_bank_account_id()
    if cmd == "set-bank-account-id":
        if len(sys.argv) != 3:
            return usage()
        return cmd_set_bank_account_id(sys.argv[2])
    if cmd == "detect-bank-account-id":
        path = sys.argv[2] if len(sys.argv) >= 3 else "data/accounts.ndjson"
        return cmd_detect_bank_account_id(path)
    if cmd == "export-snippet":
        return cmd_export_snippet()
    return usage()


if __name__ == "__main__":
    raise SystemExit(main())
