#!/usr/bin/env python3
"""Trim a post-run state file to the first N items for testing."""

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 4:
        print("Usage: trim-post-run.py <input> <output> <count>", file=sys.stderr)
        return 1

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    count = int(sys.argv[3])

    with Path(input_path).open(encoding="utf-8") as f:
        state = json.load(f)

    keys = list(state["items"].keys())[:count]
    trimmed = {k: state["items"][k] for k in keys}
    state["items"] = trimmed

    with Path(output_path).open("w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

    print(json.dumps({"ok": True, "items": len(trimmed), "ids": keys}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
