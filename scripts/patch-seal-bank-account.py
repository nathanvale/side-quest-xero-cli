#!/usr/bin/env python3
"""Patch a quarter seal's bankAccountId field."""

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: patch-seal-bank-account.py <seal-path> <bank-account-id>", file=sys.stderr)
        return 1

    seal_path = Path(sys.argv[1])
    bank_account_id = sys.argv[2]

    with seal_path.open(encoding="utf-8") as f:
        seal = json.load(f)

    old_value = seal.get("bankAccountId")
    seal["bankAccountId"] = bank_account_id

    with seal_path.open("w", encoding="utf-8") as f:
        json.dump(seal, f, indent=2)

    print(json.dumps({
        "ok": True,
        "sealPath": str(seal_path),
        "oldBankAccountId": old_value,
        "newBankAccountId": bank_account_id,
    }, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
