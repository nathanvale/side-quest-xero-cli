#!/usr/bin/env python3
"""Look up a vendor in the Xero history cache."""
import json, sys

query = sys.argv[1].upper()

with open("data/.xero-history-cache.json") as f:
    raw = f.read()
if raw.startswith("$"):
    raw = raw[raw.index("\n") + 1:]
data = json.loads(raw)
if isinstance(data, dict) and "data" in data:
    data = data["data"]
records = data if isinstance(data, list) else data.get("transactions", [])

found = False
for r in records:
    c = (r.get("Contact") or r.get("ContactName") or "").upper()
    if query in c:
        found = True
        print(json.dumps(r, indent=2))

if not found:
    print(f"No history found for '{query}'")
