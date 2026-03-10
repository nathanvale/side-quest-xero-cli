#!/usr/bin/env python3
"""Manage quarters.json - track bank exports, Xero imports, extractions, and reconciliation."""
import json
import os
import sys
import subprocess
import re
import shutil
from hashlib import sha256
from datetime import datetime, date, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from reconcile_roundtrip import (
    atomic_write_json,
    build_contact_lookup,
    build_file_manifest,
    json_sha256,
    load_ndjson,
    quarter_seal_filename,
    statement_lines_semantic_fingerprint,
)

DATA_DIR = Path("data")
QUARTERS_FILE = DATA_DIR / "quarters.json"

# Quarter definitions: Q{N} -> (month_start, month_end, month_suffix)
QUARTER_DEFS = {
    1: (7, 9, "jul-sep"),
    2: (10, 12, "oct-dec"),
    3: (1, 3, "jan-mar"),
    4: (4, 6, "apr-jun"),
}
MELBOURNE_TZ = ZoneInfo("Australia/Melbourne")
VALID_STATUSES = {"classified", "confirmed", "posted", "skipped", "errored"}
SEAL_SCHEMA_VERSION = 1


def quarter_dates(q: int, fy: int) -> tuple[str, str]:
    """Return (fromDate, toDate) for Q{q} FY{fy}. FY can be 2-digit (25) or 4-digit (2025)."""
    if q not in QUARTER_DEFS:
        raise ValueError(f"invalid quarter {q}; use 1, 2, 3, or 4")
    m_start, m_end, _ = QUARTER_DEFS[q]
    # Normalize 2-digit FY to 4-digit year
    fy_full = fy + 2000 if fy < 100 else fy
    if q <= 2:
        year = fy_full - 1
    else:
        year = fy_full
    from_date = f"{year}-{m_start:02d}-01"
    # Last day of the end month
    import calendar
    last_day = calendar.monthrange(year, m_end)[1]
    to_date = f"{year}-{m_end:02d}-{last_day:02d}"
    return from_date, to_date


def quarter_key(q: int, fy: int) -> str:
    fy2 = fy % 100
    return f"Q{q} FY{fy2:02d}"


def qif_filename(q: int, fy: int) -> str:
    if q not in QUARTER_DEFS:
        raise ValueError(f"invalid quarter {q}; use 1, 2, 3, or 4")
    fy2 = fy % 100
    _, _, suffix = QUARTER_DEFS[q]
    return f"bank-export-fy{fy2:02d}-q{q}-{suffix}.qif"


def statement_lines_filename(q: int, fy: int) -> str:
    fy2 = fy % 100
    return f"statement-lines-fy{fy2:02d}-q{q}.ndjson"


def state_filename(q: int, fy: int) -> str:
    fy2 = fy % 100
    return f".xero-explorer-state-fy{fy2:02d}-q{q}.json"


def seal_path(q: int, fy: int) -> Path:
    """Return the quarter seal path."""
    return DATA_DIR / quarter_seal_filename(q, fy)


def resolve_statefile_path(q: int, fy: int) -> str:
    return str(DATA_DIR / state_filename(q, fy))


def quarter_end_date(q: int, fy: int) -> date:
    _, to_date = quarter_dates(q, fy)
    return date.fromisoformat(to_date)


def melbourne_today() -> date:
    """Return today's date in Australia/Melbourne."""
    return datetime.now(MELBOURNE_TZ).date()


def melbourne_now_iso() -> str:
    """Return an ISO8601 timestamp in Australia/Melbourne with offset."""
    return datetime.now(MELBOURNE_TZ).isoformat(timespec="seconds")


def latest_completed_quarter(today: date | None = None) -> tuple[int, int]:
    now = today or melbourne_today()
    # Quarter mapping for AU FY (year ends in June)
    if now.month >= 7:
        fy = now.year + 1
    else:
        fy = now.year

    # Current financial quarter by month
    if now.month in (7, 8, 9):
        current_q = 1
    elif now.month in (10, 11, 12):
        current_q = 2
    elif now.month in (1, 2, 3):
        current_q = 3
    else:
        current_q = 4

    if current_q == 1:
        return 4, (fy - 1)
    return current_q - 1, fy


def load_quarters() -> dict:
    if QUARTERS_FILE.exists():
        try:
            return json.loads(QUARTERS_FILE.read_text())
        except json.JSONDecodeError as exc:
            backup = QUARTERS_FILE.with_suffix(f".json.corrupt-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
            try:
                shutil.copy2(QUARTERS_FILE, backup)
            except OSError:
                backup = None
            print(f"ERROR: {QUARTERS_FILE} is invalid JSON: {exc}")
            if backup:
                print(f"Backed up corrupt file to: {backup}")
            print("Starting with an empty quarter registry. Run init after fixing source files.")
            return {"quarters": {}}
    return {"quarters": {}}


def quarter_sort_key(key: str) -> tuple[int, int]:
    """Sort quarter keys chronologically by FY then quarter number."""
    match = re.match(r"Q([1-4]) FY(\d{2,4})$", key)
    if not match:
        return (9999, 9)
    q = int(match.group(1))
    fy_raw = int(match.group(2))
    fy = fy_raw + 2000 if fy_raw < 100 else fy_raw
    return (fy, q)


def save_quarters(data: dict):
    QUARTERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(QUARTERS_FILE) + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.rename(tmp, str(QUARTERS_FILE))


def read_json_file(path: Path) -> dict:
    """Read a JSON file and return an object payload."""
    with path.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def year_history_since(q: int, fy: int) -> str:
    """Use a stable history window that covers the previous year plus the quarter."""
    from_date, _ = quarter_dates(q, fy)
    start_year = date.fromisoformat(from_date).year
    return f"{start_year - 1}-01-01"


def resolve_bank_account_id(statement_lines: list[dict]) -> str | None:
    """Extract a bank account identifier from statement lines if present."""
    values: set[str] = set()
    for line in statement_lines:
        candidates = [
            line.get("bankAccountId"),
            line.get("bank_account_id"),
        ]
        bank_account = line.get("bankAccount")
        if isinstance(bank_account, dict):
            candidates.extend(
                [
                    bank_account.get("accountId"),
                    bank_account.get("AccountID"),
                    bank_account.get("bankAccountId"),
                ]
            )
        for candidate in candidates:
            value = str(candidate or "").strip()
            if value:
                values.add(value)
    if not values:
        return None
    if len(values) > 1:
        raise ValueError(
            f"statement lines contain multiple bankAccountId values: {', '.join(sorted(values))}"
        )
    return next(iter(values))


def load_history_rows(since: str) -> tuple[list[dict], dict]:
    """Fetch grouped history rows from the CLI and capture degraded-mode metadata."""
    command = ["bun", "run", "xero-cli", "history", "--since", since, "--json"]
    started_at = melbourne_now_iso()
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            check=True,
        )
        payload = json.loads(result.stdout)
        data = payload.get("data") if isinstance(payload, dict) else None
        rows = data.get("transactions") if isinstance(data, dict) else None
        if not isinstance(rows, list):
            raise ValueError("history command returned no transactions array")
        return rows, {
            "status": "ok",
            "generatedAt": started_at,
            "since": since,
            "command": command,
            "stdoutSha256": sha256(result.stdout.encode("utf-8")).hexdigest(),
            "stderr": result.stderr.strip(),
        }
    except (subprocess.CalledProcessError, json.JSONDecodeError, ValueError) as exc:
        detail = ""
        if isinstance(exc, subprocess.CalledProcessError):
            detail = exc.stderr.strip() or exc.stdout.strip()
        else:
            detail = str(exc)
        return [], {
            "status": "degraded",
            "generatedAt": started_at,
            "since": since,
            "command": command,
            "error": detail or "history refresh failed",
        }


def seal_is_current(
    existing_seal: dict,
    statement_lines_manifest: dict,
    accounts_manifest: dict,
    bank_transactions_manifest: dict | None,
) -> bool:
    """Check whether an existing seal still matches its inputs."""
    source_manifest = existing_seal.get("sourceManifest")
    if not isinstance(source_manifest, dict):
        return False
    existing_statement_lines = source_manifest.get("statementLines")
    existing_accounts = source_manifest.get("accounts")
    if existing_statement_lines != statement_lines_manifest:
        return False
    if existing_accounts != accounts_manifest:
        return False
    existing_bank_transactions = source_manifest.get("bankTransactions")
    return existing_bank_transactions == bank_transactions_manifest


def describe_seal_invalidation(
    existing_seal: dict,
    statement_lines_manifest: dict,
    accounts_manifest: dict,
    bank_transactions_manifest: dict | None,
) -> str:
    """Explain why an existing seal must be rebuilt."""
    source_manifest = existing_seal.get("sourceManifest")
    if not isinstance(source_manifest, dict):
        return "missing source manifest"
    if source_manifest.get("statementLines") != statement_lines_manifest:
        return "statement-lines changed"
    if source_manifest.get("accounts") != accounts_manifest:
        return "accounts changed"
    if source_manifest.get("bankTransactions") != bank_transactions_manifest:
        return "bank-transactions changed"
    return "history refresh required"


def count_qif_transactions(qif_path: str) -> int:
    """Count transactions in a QIF file."""
    result = subprocess.run(
        ["python3", "scripts/parse-qif.py", qif_path],
        capture_output=True, text=True
    )
    # First line of parse-qif.py output contains the count
    for line in result.stdout.splitlines():
        if "transaction" in line.lower():
            # Extract number from line like "287 transactions..."
            parts = line.split()
            for p in parts:
                if p.isdigit():
                    return int(p)
    # Fallback: count ^ separators
    count = 0
    with open(qif_path) as f:
        for line in f:
            if line.strip() == "^":
                count += 1
    return count


def count_ndjson_lines(path: str) -> int:
    if not os.path.exists(path):
        return 0
    with open(path) as f:
        return sum(1 for line in f if line.strip())


def parse_qif_date(raw: str) -> date | None:
    """Parse common QIF date formats into a date."""
    value = raw.strip().replace("'", "/")
    # CommBank exports use day-first date formats. Avoid month-first parsing
    # to keep date interpretation deterministic.
    formats = ("%d/%m/%Y", "%d/%m/%y", "%Y-%m-%d")
    for fmt in formats:
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None


def qif_date_bounds(path: str) -> tuple[date | None, date | None]:
    """Return min/max transaction dates found in a QIF file."""
    dates: list[date] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line.startswith("D"):
                parsed = parse_qif_date(line[1:])
                if parsed is not None:
                    dates.append(parsed)
    if not dates:
        return None, None
    return min(dates), max(dates)


def init_from_existing():
    """Scan data/ for existing QIF and NDJSON files and build quarters.json."""
    data = load_quarters()
    import glob
    import re

    # Find all QIF files
    for qif_path in sorted(glob.glob(str(DATA_DIR / "bank-export-fy*-q*-*.qif"))):
        basename = os.path.basename(qif_path)
        match = re.match(r"bank-export-fy(\d+)-q(\d+)-(.+)\.qif", basename)
        if not match:
            continue

        fy = int(match.group(1))
        q = int(match.group(2))
        if q not in QUARTER_DEFS:
            # Ignore unexpected quarter filenames rather than crashing init.
            continue
        key = quarter_key(q, fy)
        from_date, to_date = quarter_dates(q, fy)
        _, _, suffix = QUARTER_DEFS[q]

        txn_count = count_qif_transactions(qif_path)

        # Check for quarter-scoped statement lines
        sl_file = str(DATA_DIR / statement_lines_filename(q, fy))
        sl_count = count_ndjson_lines(sl_file)

        # Check for legacy single statement-lines.ndjson (only if no quarter-scoped file)
        legacy_sl = str(DATA_DIR / "statement-lines.ndjson")
        legacy_count = count_ndjson_lines(legacy_sl) if sl_count == 0 else 0

        quarter_entry = data["quarters"].get(key, {})
        quarter_entry.update({
            "quarter": key,
            "period": f"{suffix.replace('-', ' - ').title()}",
            "fromDate": from_date,
            "toDate": to_date,
            "bankExport": {
                "file": qif_path,
                "txnCount": txn_count,
                "validated": txn_count > 0,
            },
            "xeroImport": quarter_entry.get("xeroImport", {
                "imported": False,
                "importedAt": None,
            }),
            "extraction": quarter_entry.get("extraction", {
                "file": sl_file if sl_count > 0 else None,
                "lineCount": sl_count,
                "extractedAt": None,
                "countsMatch": sl_count == txn_count if sl_count > 0 else None,
            }),
            "reconciliation": quarter_entry.get("reconciliation", {
                "status": "not_started",
                "posted": 0,
                "skipped": 0,
                "remaining": 0,
            }),
        })

        data["quarters"][key] = quarter_entry

    save_quarters(data)
    return data


def show_status():
    """Display quarter status table."""
    data = load_quarters()
    if not data["quarters"]:
        print("No quarters tracked. Run: python3 scripts/manage-quarters.py init")
        return

    print(f"{'Quarter':<10} {'Period':<16} {'Bank QIF':<10} {'Imported':<10} {'Extracted':<12} {'Match':<7} {'Reconciled':<12}")
    print("-" * 87)

    for key in sorted(data["quarters"].keys(), key=quarter_sort_key):
        q = data["quarters"][key]
        bank = q.get("bankExport", {})
        imp = q.get("xeroImport", {})
        ext = q.get("extraction", {})
        rec = q.get("reconciliation", {})

        bank_str = f"{bank.get('txnCount', '?')} txns" if bank.get("validated") else "MISSING"
        imp_str = "Yes" if imp.get("imported") else "No"
        ext_count = ext.get("lineCount", 0)
        ext_str = f"{ext_count} lines" if ext_count > 0 else "No"
        match_str = "OK" if ext.get("countsMatch") else ("MISMATCH" if ext.get("countsMatch") is False else "-")
        rec_status = rec.get("status", "not_started")
        posted = rec.get("posted", 0)
        total = ext_count or bank.get("txnCount", 0)
        rec_str = f"{posted}/{total}" if rec_status != "not_started" else rec_status

        print(f"{key:<10} {q.get('period', '?'):<16} {bank_str:<10} {imp_str:<10} {ext_str:<12} {match_str:<7} {rec_str:<12}")


def mark_imported(q: int, fy: int) -> bool:
    """Mark a quarter as imported into Xero."""
    data = load_quarters()
    key = quarter_key(q, fy)
    if key not in data["quarters"]:
        print(f"Quarter {key} not tracked. Run init first.")
        return False
    data["quarters"][key]["xeroImport"] = {
            "imported": True,
            "importedAt": melbourne_now_iso(),
        }
    save_quarters(data)
    print(f"Marked {key} as imported into Xero.")
    return True


def update_extraction(q: int, fy: int, line_count: int) -> bool:
    """Update extraction info after pulling statement lines."""
    data = load_quarters()
    key = quarter_key(q, fy)
    if key not in data["quarters"]:
        print(f"Quarter {key} not tracked. Run init first.")
        return False

    sl_file = str(DATA_DIR / statement_lines_filename(q, fy))
    bank_count = data["quarters"][key].get("bankExport", {}).get("txnCount", 0)

    data["quarters"][key]["extraction"] = {
        "file": sl_file,
        "lineCount": line_count,
        "extractedAt": melbourne_now_iso(),
        "countsMatch": line_count == bank_count,
    }
    save_quarters(data)

    if line_count == bank_count:
        print(f"Extraction recorded for {key}: {line_count} lines (matches bank export)")
    else:
        print(f"WARNING: Extraction for {key}: {line_count} lines but bank export has {bank_count} txns - MISMATCH")
    return True


def validate_state(q: int, fy: int) -> int:
    """Validate quarter-scoped state file shape and core consistency."""
    state_path = resolve_statefile_path(q, fy % 100)
    if not os.path.exists(state_path):
        print(f"ERROR: state file not found: {state_path}")
        return 2

    try:
        with open(state_path) as f:
            state = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"ERROR: invalid state file: {exc}")
        return 3

    required = ("quarter", "statementLinesFile", "transactions")
    missing = [k for k in required if k not in state]
    if missing:
        print(f"ERROR: state missing required field(s): {', '.join(missing)}")
        return 4

    expected_quarter = quarter_key(q, fy)
    if state.get("quarter") != expected_quarter:
        print(f"ERROR: state quarter mismatch: found {state.get('quarter')}, expected {expected_quarter}")
        return 5

    sl_file = state.get("statementLinesFile")
    if not isinstance(sl_file, str) or not os.path.exists(sl_file):
        print(f"ERROR: statementLinesFile missing or not found: {sl_file}")
        return 6

    transactions = state.get("transactions", {})
    if not isinstance(transactions, dict):
        print("ERROR: transactions must be an object/map")
        return 7

    bad_status = []
    lifecycle_errors = []
    for sid, meta in transactions.items():
        status = meta.get("status") if isinstance(meta, dict) else None
        if status not in VALID_STATUSES:
            bad_status.append((sid, status))
            if len(bad_status) >= 5:
                break
        if not isinstance(meta, dict):
            lifecycle_errors.append((sid, "metadata must be an object"))
            continue
        confirmed_at = meta.get("confirmedAt")
        posted_at = meta.get("postedAt")
        if status == "classified" and confirmed_at:
            lifecycle_errors.append((sid, "classified cannot have confirmedAt"))
        if status == "posted" and not posted_at:
            lifecycle_errors.append((sid, "posted requires postedAt"))
        if status in {"confirmed", "posted"} and not confirmed_at:
            lifecycle_errors.append((sid, f"{status} requires confirmedAt"))
        if len(lifecycle_errors) >= 5:
            break
    if bad_status:
        preview = ", ".join(f"{sid}:{status}" for sid, status in bad_status)
        print(f"ERROR: invalid transaction status values: {preview}")
        return 8
    if lifecycle_errors:
        preview = ", ".join(f"{sid}:{reason}" for sid, reason in lifecycle_errors)
        print(f"ERROR: invalid transaction lifecycle fields: {preview}")
        return 11

    line_ids = set()
    try:
        with open(sl_file) as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    obj = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                sid = obj.get("statementLineId")
                if sid:
                    line_ids.add(sid)
    except OSError as exc:
        print(f"ERROR: unable to read statement lines file: {exc}")
        return 9

    unknown_ids = [sid for sid in transactions.keys() if sid not in line_ids][:5]
    if unknown_ids:
        print(f"ERROR: state has transaction IDs missing from statement lines: {', '.join(unknown_ids)}")
        return 10

    print(f"State validation OK: {state_path}")
    return 0


def gate_check(q: int, fy: int) -> int:
    """Quarter gate check for completed quarter + QIF presence + date validity."""
    if q not in QUARTER_DEFS:
        print(f"BLOCKED: invalid quarter {q}. Use 1, 2, 3, or 4.")
        return 1

    fy2 = fy % 100
    key = quarter_key(q, fy2)
    from_date, to_date = quarter_dates(q, fy2)
    expected_from = date.fromisoformat(from_date)
    expected_to = date.fromisoformat(to_date)
    today = melbourne_today()
    end = date.fromisoformat(to_date)
    qif_path = str(DATA_DIR / qif_filename(q, fy2))

    if today <= end:
        latest_q, latest_fy = latest_completed_quarter(today)
        comeback_date = (end + timedelta(days=1)).isoformat()
        print(f"BLOCKED: {key} ends on {to_date}, today is {today.isoformat()}.")
        print("Time machine check: this quarter is not finished yet in Melbourne time.")
        print(f"Come back on or after {comeback_date}.")
        print(f"Try latest completed quarter: Q{latest_q} FY{latest_fy % 100:02d}")
        return 2

    if not os.path.exists(qif_path):
        print(f"BLOCKED: Bank export not found: {qif_path}")
        print("Quarter is complete. Download QIF from CommBank and save to data/.")
        print(f"Required filename: {qif_filename(q, fy2)}")
        return 3

    result = subprocess.run(
        ["python3", "scripts/parse-qif.py", qif_path],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"BLOCKED: parse-qif failed for {qif_path}")
        details = result.stderr.strip() or result.stdout.strip() or "Unknown parse error"
        print(details)
        return 4

    qif_min, qif_max = qif_date_bounds(qif_path)
    if qif_min is None or qif_max is None:
        print(f"BLOCKED: Could not parse transaction dates from {qif_path}")
        print("Check QIF date format and re-export from CommBank if needed.")
        return 5

    if qif_min < expected_from or qif_max > expected_to:
        print(f"BLOCKED: QIF date range mismatch for {key}")
        print(f"  Expected quarter range: {from_date} to {to_date}")
        print(f"  Found transaction range: {qif_min.isoformat()} to {qif_max.isoformat()}")
        print("Fix filename/export so quarter and file contents match, then retry.")
        return 6

    lines = result.stdout.splitlines()
    print(f"Gate OK: {key}")
    print(f"  QIF: {qif_path}")
    print(f"  Quarter range: {from_date} to {to_date}")
    print(f"  Transaction range: {qif_min.isoformat()} to {qif_max.isoformat()}")
    if lines:
        for line in lines[:4]:
            print(f"  {line}")
    return 0


def seal_quarter(q: int, fy: int) -> int:
    """Build a sealed quarter cache for offline classification and CSV review."""
    gate_result = gate_check(q, fy)
    if gate_result != 0:
        return gate_result

    fy2 = fy % 100
    key = quarter_key(q, fy2)
    from_date, to_date = quarter_dates(q, fy2)
    statement_lines_path = DATA_DIR / statement_lines_filename(q, fy2)
    accounts_path = DATA_DIR / "accounts.ndjson"
    bank_transactions_path = DATA_DIR / "bank-transactions.ndjson"
    target_path = seal_path(q, fy2)

    if not statement_lines_path.exists():
        print(f"ERROR: statement lines not found: {statement_lines_path}")
        return 7
    if not accounts_path.exists():
        print(f"ERROR: accounts file not found: {accounts_path}")
        return 8

    statement_lines = load_ndjson(statement_lines_path)
    if not statement_lines:
        print(f"ERROR: statement lines file is empty: {statement_lines_path}")
        return 9
    accounts = load_ndjson(accounts_path)
    if not accounts:
        print(f"ERROR: accounts file is empty: {accounts_path}")
        return 10

    bank_transactions = (
        load_ndjson(bank_transactions_path) if bank_transactions_path.exists() else []
    )
    contact_lookup, lookup_stats = build_contact_lookup(bank_transactions)
    statement_lines_manifest = {
        **build_file_manifest(statement_lines_path),
        "semanticFingerprint": statement_lines_semantic_fingerprint(statement_lines),
    }
    accounts_manifest = build_file_manifest(accounts_path)
    bank_transactions_manifest = (
        build_file_manifest(bank_transactions_path)
        if bank_transactions_path.exists()
        else None
    )

    if target_path.exists():
        try:
            existing_seal = read_json_file(target_path)
        except (OSError, json.JSONDecodeError, ValueError):
            existing_seal = {}
        if seal_is_current(
            existing_seal,
            statement_lines_manifest,
            accounts_manifest,
            bank_transactions_manifest,
        ):
            print(
                f"Seal intact. Last sealed: {existing_seal.get('sealedAt', 'unknown')} ({target_path})"
            )
            return 0
        invalidation_reason = describe_seal_invalidation(
            existing_seal,
            statement_lines_manifest,
            accounts_manifest,
            bank_transactions_manifest,
        )
        print(f"Seal invalidated: {invalidation_reason}. Rebuilding {target_path}.")
    else:
        invalidation_reason = None

    bank_count = count_qif_transactions(str(DATA_DIR / qif_filename(q, fy2)))
    statement_line_count = len(statement_lines)
    counts_match = statement_line_count == bank_count
    if not counts_match:
        print(
            f"ERROR: statement line count mismatch for {key}: {statement_line_count} lines vs {bank_count} bank transactions"
        )
        return 11

    history_rows, history_meta = load_history_rows(year_history_since(q, fy2))
    source_manifest = {
        "statementLines": statement_lines_manifest,
        "accounts": accounts_manifest,
        "history": {
            "status": history_meta.get("status"),
            "generatedAt": history_meta.get("generatedAt"),
            "since": history_meta.get("since"),
            "rowCount": len(history_rows),
            "sha256": json_sha256(history_rows),
        },
    }
    if bank_transactions_manifest is not None:
        source_manifest["bankTransactions"] = bank_transactions_manifest

    try:
        bank_account_id = resolve_bank_account_id(statement_lines)
    except ValueError as exc:
        print(f"ERROR: {exc}")
        return 12

    seal_status = "ok" if history_meta.get("status") == "ok" else "degraded"
    seal = {
        "schemaVersion": SEAL_SCHEMA_VERSION,
        "createdBy": "scripts/manage-quarters.py seal",
        "sealStatus": seal_status,
        "sealInvalidationReason": invalidation_reason,
        "sealedAt": melbourne_now_iso(),
        "quarter": key,
        "fromDate": from_date,
        "toDate": to_date,
        "bankAccountId": bank_account_id,
        "statementLineCount": statement_line_count,
        "bankExportCount": bank_count,
        "countsMatch": counts_match,
        "summaryOnly": True,
        "statementLinesFile": str(statement_lines_path),
        "sourceManifest": source_manifest,
        "statementLines": statement_lines,
        "accounts": accounts,
        "contactLookup": {
            "lookup": contact_lookup,
            "stats": lookup_stats,
        },
        "history": {
            **history_meta,
            "rows": history_rows,
        },
    }

    atomic_write_json(target_path, seal)
    os.chmod(target_path, 0o600)

    print(f"Seal written: {target_path}")
    print(f"  Quarter: {key}")
    print(f"  Statement lines: {statement_line_count}")
    print(f"  Accounts: {len(accounts)}")
    print(f"  Contact lookup entries: {lookup_stats.get('lookupEntries', 0)}")
    print(f"  History rows: {len(history_rows)} ({seal_status})")
    if seal_status == "degraded":
        print(f"  History warning: {history_meta.get('error', 'history refresh failed')}")
    return 0


def next_action(q: int | None = None, fy: int | None = None):
    data = load_quarters()
    if not data["quarters"]:
        print("next action: run `python3 scripts/manage-quarters.py init`")
        return

    if q is not None and fy is not None:
        key = quarter_key(q, fy)
        quarter = data["quarters"].get(key)
        if not quarter:
            print(f"next action: quarter {key} not found, run init")
            return
        _print_quarter_next_action(key, quarter)
        return

    # Global next action: first incomplete by chronological key order
    for key in sorted(data["quarters"].keys(), key=quarter_sort_key):
        quarter = data["quarters"][key]
        rec = quarter.get("reconciliation", {})
        ext = quarter.get("extraction", {})
        imp = quarter.get("xeroImport", {})
        if not imp.get("imported"):
            _print_quarter_next_action(key, quarter)
            return
        if ext.get("lineCount", 0) <= 0:
            _print_quarter_next_action(key, quarter)
            return
        if rec.get("status", "not_started") != "completed":
            _print_quarter_next_action(key, quarter)
            return
    print("next action: all tracked quarters appear complete")


def _print_quarter_next_action(key: str, quarter: dict):
    imp = quarter.get("xeroImport", {})
    ext = quarter.get("extraction", {})
    rec = quarter.get("reconciliation", {})
    if not imp.get("imported"):
        print(f"{key}: next action -> import QIF into Xero UI, then run mark-imported")
        return
    if ext.get("lineCount", 0) <= 0:
        print(f"{key}: next action -> run /xero-explorer extract {key}")
        return
    if rec.get("status", "not_started") in ("not_started", "in_progress"):
        print(f"{key}: next action -> run /xero-explorer reconcile {key}")
        return
    print(f"{key}: next action -> review and close quarter")


def main():
    def parse_int_arg(idx: int, name: str) -> int:
        try:
            return int(sys.argv[idx])
        except IndexError:
            raise ValueError(f"missing argument: {name}")
        except ValueError:
            raise ValueError(f"invalid {name}: {sys.argv[idx]!r} (must be integer)")

    if len(sys.argv) < 2:
        print("Usage: python3 scripts/manage-quarters.py <command> [args]")
        print()
        print("Commands:")
        print("  init                    Scan data/ and build quarters.json from existing files")
        print("  status                  Show quarter status table")
        print("  mark-imported Q FY      Mark quarter as imported into Xero (e.g., 1 26)")
        print("  update-extraction Q FY COUNT  Record extraction result")
        print("  seal Q FY               Build/update the quarter seal cache")
        print("  dates Q FY              Show FromDate/ToDate for a quarter")
        print("  filename Q FY           Show expected statement-lines filename")
        print("  qif-file Q FY           Show expected bank export QIF filename")
        print("  statefile Q FY          Show expected quarter-scoped reconcile state file")
        print("  validate-state Q FY     Validate state file shape and core consistency")
        print("  is-complete Q FY        Exit 0 if quarter is complete, else exit 1")
        print("  gate Q FY               Run quarter gate check (complete + QIF + parse)")
        print("  next-action [Q FY]      Show next best action globally or for one quarter")
        sys.exit(1)

    cmd = sys.argv[1]

    try:
        if cmd == "init":
            data = init_from_existing()
            print(f"Initialized quarters.json with {len(data['quarters'])} quarters.")
            show_status()
        elif cmd == "status":
            show_status()
        elif cmd == "mark-imported":
            q, fy = parse_int_arg(2, "Q"), parse_int_arg(3, "FY")
            if not mark_imported(q, fy):
                sys.exit(1)
        elif cmd == "update-extraction":
            q = parse_int_arg(2, "Q")
            fy = parse_int_arg(3, "FY")
            count = parse_int_arg(4, "COUNT")
            if not update_extraction(q, fy, count):
                sys.exit(1)
        elif cmd == "seal":
            q, fy = parse_int_arg(2, "Q"), parse_int_arg(3, "FY")
            sys.exit(seal_quarter(q, fy))
        elif cmd == "dates":
            q, fy = parse_int_arg(2, "Q"), parse_int_arg(3, "FY")
            from_date, to_date = quarter_dates(q, fy)
            print(f"{quarter_key(q, fy)}: FromDate={from_date} ToDate={to_date}")
        elif cmd == "filename":
            q, fy = parse_int_arg(2, "Q"), parse_int_arg(3, "FY")
            print(statement_lines_filename(q, fy))
        elif cmd == "qif-file":
            q, fy = parse_int_arg(2, "Q"), parse_int_arg(3, "FY")
            print(qif_filename(q, fy))
        elif cmd == "statefile":
            q, fy = parse_int_arg(2, "Q"), parse_int_arg(3, "FY")
            print(resolve_statefile_path(q, fy % 100))
        elif cmd == "validate-state":
            q, fy = parse_int_arg(2, "Q"), parse_int_arg(3, "FY")
            sys.exit(validate_state(q, fy))
        elif cmd == "is-complete":
            q, fy = parse_int_arg(2, "Q"), parse_int_arg(3, "FY")
            fy2 = fy % 100
            complete = melbourne_today() > quarter_end_date(q, fy2)
            print("yes" if complete else "no")
            sys.exit(0 if complete else 1)
        elif cmd == "gate":
            q, fy = parse_int_arg(2, "Q"), parse_int_arg(3, "FY")
            sys.exit(gate_check(q, fy))
        elif cmd == "next-action":
            if len(sys.argv) == 4:
                q, fy = parse_int_arg(2, "Q"), parse_int_arg(3, "FY")
                next_action(q, fy)
            elif len(sys.argv) == 2:
                next_action()
            else:
                raise ValueError("next-action expects either no quarter args or both Q and FY")
        else:
            print(f"Unknown command: {cmd}")
            sys.exit(1)
    except ValueError as exc:
        print(f"ERROR: {exc}")
        sys.exit(1)


if __name__ == "__main__":
    main()
