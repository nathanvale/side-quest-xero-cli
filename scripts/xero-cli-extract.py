#!/usr/bin/env python3
"""Extract Accounting API datasets via xero-cli and write NDJSON files."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


DATASET_CONFIG = {
    "accounts": {
        "command": ["accounts"],
        "data_key": "accounts",
        "out": Path("data/accounts.ndjson"),
    },
    "bank-transactions": {
        "command": ["transactions"],
        "data_key": "transactions",
        "out": Path("data/bank-transactions.ndjson"),
    },
    "invoices": {
        "command": ["invoices"],
        "data_key": "invoices",
        "out": Path("data/invoices.ndjson"),
    },
    "contacts": {
        "command": ["contacts"],
        "data_key": "contacts",
        "out": Path("data/contacts.ndjson"),
    },
    "payments": {
        "command": ["payments"],
        "data_key": "payments",
        "out": Path("data/payments.ndjson"),
    },
}


def atomic_write_ndjson(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(str(path) + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        for row in rows:
            f.write(json.dumps(row))
            f.write("\n")
    os.replace(tmp, path)


def parse_json_line(stdout: str) -> dict[str, Any]:
    for line in reversed(stdout.splitlines()):
        candidate = line.strip()
        if not candidate:
            continue
        if not candidate.startswith("{"):
            continue
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            return payload
    raise RuntimeError("xero-cli did not emit JSON output")


def run_xero_cli(command: list[str]) -> dict[str, Any]:
    proc = subprocess.run(
        ["bun", "src/cli/command.ts", *command, "--json"],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        details = proc.stderr.strip() or proc.stdout.strip() or "unknown error"
        raise RuntimeError(f"xero-cli {' '.join(command)} failed: {details}")
    payload = parse_json_line(proc.stdout)
    status = payload.get("status")
    if status != "data":
        raise RuntimeError(f"xero-cli returned non-data status: {status!r}")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("xero-cli JSON payload missing data object")
    return data


def extract_dataset(name: str) -> int:
    cfg = DATASET_CONFIG[name]
    data = run_xero_cli(cfg["command"])
    key = cfg["data_key"]
    rows = data.get(key, [])
    if not isinstance(rows, list):
        raise RuntimeError(f"xero-cli data.{key} is not a list")
    dict_rows = [row for row in rows if isinstance(row, dict)]
    atomic_write_ndjson(cfg["out"], dict_rows)
    print(f"{name}: wrote {len(dict_rows)} rows to {cfg['out']}")
    return len(dict_rows)


def usage() -> int:
    print("Usage: python3 scripts/xero-cli-extract.py <dataset|all>")
    print("Datasets: accounts, bank-transactions, invoices, contacts, payments, all")
    return 1


def main() -> int:
    if len(sys.argv) != 2:
        return usage()
    target = sys.argv[1].strip().lower()
    if target == "all":
        total = 0
        for name in ("accounts", "bank-transactions", "invoices", "contacts", "payments"):
            total += extract_dataset(name)
        print(f"all datasets complete ({total} rows total)")
        return 0
    if target not in DATASET_CONFIG:
        return usage()
    extract_dataset(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
