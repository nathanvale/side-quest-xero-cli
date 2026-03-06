#!/usr/bin/env python3
"""Reconciliation reporting and export utilities for xero-explorer."""

from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any


def _atomic_write_json(path: str, payload: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(target) + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(payload, f, indent=2)
        f.write("\n")
    os.replace(tmp, str(target))


def _load_state(path: str) -> dict[str, Any]:
    with open(path) as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("state must be a JSON object")
    return data


def _resolve_state_file(q: int, fy: int) -> str:
    out = subprocess.check_output(
        ["python3", "scripts/manage-quarters.py", "statefile", str(q), str(fy)],
        text=True,
    ).strip()
    if not out:
        raise RuntimeError("manage-quarters returned empty state path")
    return out


def cmd_state_status(q: int, fy: int) -> int:
    q_label = f"Q{q}"
    fy_label = f"FY{fy % 100:02d}"
    state_file = _resolve_state_file(q, fy)

    if not os.path.exists(state_file):
        print(f"No reconciliation state for {q_label} {fy_label}.")
        print(f"Next action: run /xero-explorer reconcile {q_label} {fy_label}")
        return 0

    state = _load_state(state_file)
    txns = state.get("transactions", {})
    if not isinstance(txns, dict):
        txns = {}

    statuses = Counter(
        str(item.get("status", "unknown"))
        for item in txns.values()
        if isinstance(item, dict)
    )
    total = len(txns)
    posted = statuses.get("posted", 0)
    skipped = statuses.get("skipped", 0)
    errored = statuses.get("errored", 0)
    done = posted + skipped
    remaining = max(total - done - errored, 0)

    print(f"{q_label} {fy_label}")
    print("  imported: see quarter status")
    print("  extracted: see quarter status")
    print(f"  mode: {state.get('mode', 'unknown')}")
    print(f"  active round: {state.get('activeRound', '?')}")
    print(f"  total: {total} | done: {done} | remaining: {remaining}")
    print(f"  posted: {posted}")
    print(f"  confirmed: {statuses.get('confirmed', 0)}")
    print(f"  classified: {statuses.get('classified', 0)}")
    print(f"  skipped: {skipped}")
    print(f"  errored: {errored}")
    next_action = "resume reconcile" if remaining > 0 else "review export/close quarter"
    print(f"  next action: {next_action}")
    print(f"  last saved: {state.get('savedAt', 'unknown')}")
    return 0


def cmd_classify_overview(sl_file: str) -> int:
    if not os.path.exists(sl_file):
        print(f"ERROR: statement lines file not found: {sl_file}")
        return 2

    rows: list[dict[str, Any]] = []
    with open(sl_file) as f:
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
            is_reconciled = bool(item.get("isReconciled"))
            has_match = bool(item.get("bankTransactions"))
            if is_reconciled or has_match:
                continue
            rows.append(item)

    total = len(rows)
    total_abs = round(sum(abs(float(r.get("amount", 0) or 0)) for r in rows), 2)
    print(f"Unreconciled: {total} statement lines (${total_abs:,.2f})")

    spend_rows = [r for r in rows if float(r.get("amount", 0) or 0) < 0]
    receive_rows = [r for r in rows if float(r.get("amount", 0) or 0) >= 0]
    spend_total = round(sum(abs(float(r.get("amount", 0) or 0)) for r in spend_rows), 2)
    receive_total = round(sum(abs(float(r.get("amount", 0) or 0)) for r in receive_rows), 2)
    print(f"  SPEND: {len(spend_rows)} items (${spend_total:,.2f})")
    print(f"  RECEIVE: {len(receive_rows)} items (${receive_total:,.2f})")

    payee_count: Counter[str] = Counter()
    payee_value: Counter[str] = Counter()
    for row in rows:
        payee = str(row.get("payee", "")).strip() or "(blank)"
        payee_count[payee] += 1
        payee_value[payee] += abs(float(row.get("amount", 0) or 0))

    print("\nTop unreconciled payees:")
    for payee, count in payee_count.most_common(10):
        total_value = round(payee_value[payee], 2)
        print(f"  {payee}: {count} items (${total_value:,.2f})")
    return 0


def cmd_export_confirmed(state_file: str, output_path: str = "data/pending-reconciliation.json") -> int:
    state = _load_state(state_file)
    transactions = state.get("transactions", {})
    if not isinstance(transactions, dict):
        transactions = {}

    confirmed = [
        {"statementLineId": sid, **details}
        for sid, details in transactions.items()
        if isinstance(details, dict) and details.get("status") == "confirmed"
    ]
    _atomic_write_json(output_path, confirmed)
    print(f"Exported {len(confirmed)} items to {output_path}")
    return 0


def cmd_session_summary(state_file: str) -> int:
    state = _load_state(state_file)
    txns = state.get("transactions", {})
    if not isinstance(txns, dict):
        txns = {}

    posted = {k: v for k, v in txns.items() if isinstance(v, dict) and v.get("status") == "posted"}
    skipped = {k: v for k, v in txns.items() if isinstance(v, dict) and v.get("status") == "skipped"}
    errored = {k: v for k, v in txns.items() if isinstance(v, dict) and v.get("status") == "errored"}

    rounds = Counter(int(v.get("round", 0)) for v in posted.values() if str(v.get("round", "")).isdigit())

    print("SESSION COMPLETE")
    print()
    print(f"  Reconciled:  {len(posted)} statement lines")
    print(f"  Skipped:     {len(skipped)} (exported to data/needs-review.csv)")
    print(f"  Errors:      {len(errored)} (exported to data/needs-review.csv)")
    print()
    print("  By round:")
    print(f"    Auto-matched (R1):   {rounds.get(1, 0)} posted")
    print(f"    AI-researched (R2):  {rounds.get(2, 0)} posted")
    print(f"    Unknown (R3):        {rounds.get(3, 0)} posted")
    print()
    done_like = len(posted) + len(skipped) + len(errored)
    total = len(txns) or 1
    readiness = round((done_like / total) * 100)
    print("  Win recap:")
    print(f"    Tax readiness now: {readiness}%")
    print("    Next mission suggestion: 25 items or 15 minutes")
    return 0


def cmd_export_needs_review(state_file: str, output_path: str = "data/needs-review.csv") -> int:
    state = _load_state(state_file)
    transactions = state.get("transactions", {})
    if not isinstance(transactions, dict):
        transactions = {}

    rows = [
        (sid, details)
        for sid, details in transactions.items()
        if isinstance(details, dict) and details.get("status") in {"skipped", "errored"}
    ]

    if not rows:
        print("No items to export -- all reconciled!")
        return 0

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(out) + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["StatementLineId", "Status", "ContactName", "AccountCode", "Round", "ErrorReason"])
        for sid, item in rows:
            writer.writerow([
                sid,
                item.get("status", ""),
                item.get("contactName", ""),
                item.get("accountCode", ""),
                item.get("round", ""),
                item.get("errorReason", ""),
            ])
    os.replace(tmp, str(out))
    print(f"Exported {len(rows)} items to {output_path}")
    return 0


def usage() -> int:
    print("Usage: python3 scripts/xero-reconcile-report.py <command> [args]")
    print()
    print("Commands:")
    print("  state-status <Q> <FY>")
    print("  classify-overview <statement-lines.ndjson>")
    print("  export-confirmed <state-file> [output.json]")
    print("  session-summary <state-file>")
    print("  export-needs-review <state-file> [output.csv]")
    return 1


def main() -> int:
    if len(sys.argv) < 2:
        return usage()

    cmd = sys.argv[1]
    if cmd == "state-status" and len(sys.argv) == 4:
        return cmd_state_status(int(sys.argv[2]), int(sys.argv[3]))
    if cmd == "classify-overview" and len(sys.argv) == 3:
        return cmd_classify_overview(sys.argv[2])
    if cmd == "export-confirmed" and len(sys.argv) in (3, 4):
        out = sys.argv[3] if len(sys.argv) == 4 else "data/pending-reconciliation.json"
        return cmd_export_confirmed(sys.argv[2], out)
    if cmd == "session-summary" and len(sys.argv) == 3:
        return cmd_session_summary(sys.argv[2])
    if cmd == "export-needs-review" and len(sys.argv) in (3, 4):
        out = sys.argv[3] if len(sys.argv) == 4 else "data/needs-review.csv"
        return cmd_export_needs_review(sys.argv[2], out)
    return usage()


if __name__ == "__main__":
    raise SystemExit(main())
