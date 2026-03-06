#!/usr/bin/env python3
"""Preview selected fields from NDJSON safely (no inline interpreter needed)."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def usage() -> int:
    print("Usage: python3 scripts/xero-ndjson-peek.py <file.ndjson> <limit> <field1> [field2 ...]")
    print("Example: python3 scripts/xero-ndjson-peek.py data/accounts.ndjson 5 Code Name Type AccountID")
    return 1


def main() -> int:
    if len(sys.argv) < 4:
        return usage()

    path = Path(sys.argv[1])
    if not path.is_file():
        print(f"ERROR: not a readable file: {path}")
        return 2

    try:
        limit = int(sys.argv[2])
    except ValueError:
        print(f"ERROR: limit must be integer, got: {sys.argv[2]!r}")
        return 3
    if limit <= 0:
        print("ERROR: limit must be > 0")
        return 4

    fields = sys.argv[3:]
    emitted = 0
    try:
        fh = path.open()
    except OSError as exc:
        print(f"ERROR: cannot open file: {exc}")
        return 5
    with fh as f:
        for line in f:
            raw = line.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue
            subset = {k: obj.get(k) for k in fields}
            print(json.dumps(subset, ensure_ascii=True))
            emitted += 1
            if emitted >= limit:
                break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
