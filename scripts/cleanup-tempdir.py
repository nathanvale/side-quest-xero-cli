#!/usr/bin/env python3
"""Safely clean a temp directory created during xero-explorer runs."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path


def usage() -> int:
    print("Usage: python3 scripts/cleanup-tempdir.py <tmpdir>")
    return 1


def is_allowed_tempdir(path: Path) -> bool:
    if not path.is_absolute():
        return False
    name = path.name
    if not (name.startswith("tmp.") or name.startswith("tmp")):
        return False
    allowed_prefixes = (
        "/tmp/",
        "/private/tmp/",
        "/var/folders/",
        "/private/var/folders/",
    )
    as_posix = str(path)
    return any(as_posix.startswith(prefix) for prefix in allowed_prefixes)


def main() -> int:
    if len(sys.argv) != 2:
        return usage()

    target = Path(sys.argv[1]).resolve()
    if not target.exists():
        print(f"Temp cleanup: already removed ({target})")
        return 0
    if not target.is_dir():
        print(f"Temp cleanup skipped (not a directory): {target}")
        return 2
    if not is_allowed_tempdir(target):
        print(f"Temp cleanup blocked (unsafe target): {target}")
        return 3

    shutil.rmtree(target)
    print(f"Temp cleanup OK: {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
