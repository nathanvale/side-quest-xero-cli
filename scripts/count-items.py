#!/usr/bin/env python3
"""Count items in queue and post-run JSON files."""

import json
import sys
from pathlib import Path


def main() -> int:
    for path in sys.argv[1:]:
        with Path(path).open(encoding="utf-8") as f:
            data = json.load(f)
        items = data.get("items", {})
        count = len(items) if isinstance(items, dict) else len(items)
        print(f"{path}: {count} items")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
