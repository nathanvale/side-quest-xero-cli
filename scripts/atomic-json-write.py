#!/usr/bin/env python3
"""Write a JSON file atomically from a source file path."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


def _load_json(path: str) -> Any:
    with open(path) as f:
        return json.load(f)


def _atomic_write(path: str, payload: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(target) + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    os.replace(tmp, str(target))


def usage() -> int:
    print("Usage: python3 scripts/atomic-json-write.py <output.json> <input.json>")
    return 1


def main() -> int:
    if len(sys.argv) != 3:
        return usage()
    out_path, input_path = sys.argv[1], sys.argv[2]
    payload = _load_json(input_path)
    _atomic_write(out_path, payload)
    print(f"Wrote JSON atomically: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
