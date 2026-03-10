#!/usr/bin/env python3
"""Shared helpers for quarter sealing and reconciliation CSV round-tripping."""

from __future__ import annotations

import csv
import hashlib
import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIDENCE_WEIGHTS_PATH = (
    REPO_ROOT / ".claude/skills/xero-explorer/references/confidence-weights.json"
)
REVIEW_FIELDNAMES = [
    "Status",
    "Date",
    "Payee",
    "Amount",
    "Type",
    "AccountCode",
    "AccountName",
    "Contact",
    "Confidence",
    "Evidence",
    "StatementLineID",
]
VALID_REVIEW_STATUSES = {"", "APPROVE", "EDIT", "SKIP", "REVIEW"}
GENERIC_PAYEES = {"TRANSFER", "PAYMENT", "DIRECT DEBIT", "DIRECT CREDIT", "DEBIT"}
FILE_STABILITY_DELAY_SECONDS = 0.2


def load_ndjson(path: str | Path) -> list[dict[str, Any]]:
    """Load an NDJSON file into a list of dictionaries."""
    rows: list[dict[str, Any]] = []
    with Path(path).open(encoding="utf-8") as handle:
        for line in handle:
            raw = line.strip()
            if not raw:
                continue
            item = json.loads(raw)
            if isinstance(item, dict):
                rows.append(item)
    return rows


def load_seal(path: str | Path) -> dict[str, Any]:
    """Load and minimally validate a quarter seal."""
    with Path(path).open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError("seal must contain a JSON object")
    if not isinstance(payload.get("statementLines"), list):
        raise ValueError("seal is missing statementLines")
    if not isinstance(payload.get("accounts"), list):
        raise ValueError("seal is missing accounts")
    return payload


def atomic_write_json(path: str | Path, payload: Any) -> None:
    """Write JSON atomically with private file permissions."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{target.name}.tmp-",
        dir=target.parent,
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, target)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def sha256_file(path: str | Path) -> str:
    """Return the SHA-256 hash for a file."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(64 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_sha256(payload: Any) -> str:
    """Return the SHA-256 hash for a JSON-serializable payload."""
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def ensure_stable_file(path: str | Path) -> None:
    """Reject files that change across two spaced hash/stat reads."""
    target = Path(path)
    before = target.stat()
    before_hash = sha256_file(target)
    time.sleep(FILE_STABILITY_DELAY_SECONDS)
    after = target.stat()
    after_hash = sha256_file(target)
    if (
        before.st_size != after.st_size
        or before.st_mtime_ns != after.st_mtime_ns
        or before_hash != after_hash
    ):
        raise ValueError(f"CSV appears to be changing during read-back: {target}")


def build_file_manifest(path: str | Path) -> dict[str, Any]:
    """Capture stable file metadata for seal invalidation checks."""
    target = Path(path)
    stat = target.stat()
    return {
        "path": str(target),
        "size": stat.st_size,
        "mtime": int(stat.st_mtime),
        "sha256": sha256_file(target),
    }


def statement_lines_semantic_fingerprint(
    statement_lines: list[dict[str, Any]],
) -> str:
    """Hash the downstream-relevant statement-line facts, independent of order."""
    lines = [
        "|".join(
            [
                str(item.get("statementLineId", "")).strip(),
                str(item.get("postedDate", "")).strip(),
                f"{float(item.get('amount', 0) or 0):.2f}",
                str(item.get("payee", "")).strip(),
                str(item.get("isReconciled", False)).lower(),
            ]
        )
        for item in statement_lines
    ]
    lines.sort()
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def normalize_payee(payee: str) -> str:
    """Normalize payee/contact text for deterministic matching."""
    value = payee.upper().strip()
    value = re.sub(r"\s+CARD XX\d+.*", "", value)
    value = re.sub(r"\s+VALUE DATE:.*", "", value)
    value = re.sub(r"\s+AU$", "", value)
    for prefix in ("SQ *", "ZLR*", "SMP*", "SP ", "LS ", "CRD ", "PP *", "MED*"):
        if value.startswith(prefix):
            value = value[len(prefix) :]
    value = re.sub(r"Card xx\d+", "", value, flags=re.IGNORECASE)
    value = re.sub(r"xx\d+", "", value)
    value = re.sub(r"NetBank", "", value, flags=re.IGNORECASE)
    for suffix in (
        " PTY LTD",
        " PTY LT",
        " INC.",
        " INC",
        " LLC",
        " CORP",
        " LIMITED",
        " P/L",
    ):
        value = value.replace(suffix, "")
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def fuzzy_match(normalized_payee: str, contact: str) -> tuple[bool, float]:
    """Return whether a contact matches the payee and how strongly."""
    normalized_contact = normalize_payee(contact)
    if not normalized_payee or not normalized_contact:
        return False, 0.0
    if normalized_payee == normalized_contact:
        return True, 1.0
    if normalized_payee in normalized_contact:
        return True, 0.8
    if normalized_contact in normalized_payee:
        return True, 0.9

    payee_words = [word for word in normalized_payee.split(" ") if len(word) > 2]
    contact_words = [word for word in normalized_contact.split(" ") if len(word) > 2]
    if not payee_words or not contact_words:
        return False, 0.0

    matches = [
        contact_word
        for contact_word in contact_words
        if any(
            payee_word in contact_word or contact_word in payee_word
            for payee_word in payee_words
        )
    ]
    overlap = len(matches) / len(contact_words)
    if overlap >= 0.5 and matches:
        return True, overlap * 0.7
    return False, 0.0


def normalize_status(value: str) -> str:
    """Normalize free-form status text to the review contract."""
    return value.strip().upper()


def clean_statement_line_id(value: str) -> str:
    """Strip Sheets apostrophes/whitespace and validate the UUID semantically."""
    cleaned = value.lstrip("'").strip()
    if not cleaned:
        raise ValueError("StatementLineID is blank")
    return str(uuid.UUID(cleaned))


def amount_to_csv(amount: float | int | str | None) -> str:
    """Format the amount field as a plain 2dp decimal."""
    return f"{float(amount or 0):.2f}"


def confidence_band(score: int) -> str:
    """Map a numeric proposal score to a stable confidence band."""
    return confidence_band_from_weights(score, load_confidence_weights())


def confidence_cell(score: int) -> str:
    """Render the CSV confidence cell with band and numeric score."""
    return f"{confidence_band(score)} ({score})"


def load_confidence_weights(
    path: str | Path = DEFAULT_CONFIDENCE_WEIGHTS_PATH,
) -> dict[str, Any]:
    """Load confidence weights from the shared xero-explorer reference file."""
    target = Path(path)
    with target.open(encoding="utf-8") as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"confidence weights must be a JSON object: {target}")
    return payload


def confidence_band_from_weights(score: int, weights: dict[str, Any]) -> str:
    """Map a numeric score to a band using the configured thresholds."""
    bands = weights.get("bands")
    if not isinstance(bands, dict):
        raise ValueError("confidence weights missing 'bands'")
    for band_name in ("high", "medium", "low"):
        band = bands.get(band_name)
        if not isinstance(band, dict):
            continue
        minimum = int(band.get("min", 0))
        maximum = int(band.get("max", 0))
        if minimum <= score <= maximum:
            return band_name
    raise ValueError(f"score {score} did not match any configured confidence band")


def load_accounts_map(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Index chart-of-accounts rows by account code."""
    accounts: dict[str, dict[str, Any]] = {}
    for record in records:
        code = str(record.get("Code", "")).strip()
        if not code:
            continue
        accounts[code] = {
            "name": str(record.get("Name", "")).strip(),
            "type": str(record.get("Type", "")).strip(),
            "tax": str(record.get("TaxType", "")).strip(),
            "status": str(record.get("Status", "")).strip(),
        }
    return accounts


def build_contact_lookup(
    bank_transactions: list[dict[str, Any]],
) -> tuple[dict[str, dict[str, Any]], dict[str, Any]]:
    """Build a normalized payee-to-contact lookup from reconciled bank transactions."""
    lookup: dict[str, dict[str, Any]] = {}
    stats = {
        "total": len(bank_transactions),
        "reconciled": 0,
        "lookupEntries": 0,
    }

    for transaction in bank_transactions:
        if not bool(transaction.get("IsReconciled")):
            continue
        stats["reconciled"] += 1
        contact = transaction.get("Contact") or {}
        if not isinstance(contact, dict):
            continue
        name = str(contact.get("Name", "")).strip()
        normalized = normalize_payee(name).lower()
        if not name or not normalized:
            continue
        entry = lookup.setdefault(
            normalized,
            {
                "NormalizedName": normalized,
                "ContactID": str(contact.get("ContactID", "")).strip(),
                "ContactName": name,
                "Count": 0,
            },
        )
        entry["Count"] += 1
        if not entry.get("ContactID"):
            entry["ContactID"] = str(contact.get("ContactID", "")).strip()

    stats["lookupEntries"] = len(lookup)
    return lookup, stats


RULES: list[tuple[list[str], str, str]] = [
    (["EXCO PARTNERS"], "200", "Sales Revenue"),
    (["TRANSFER TO XX9027", "NATHAN PAY"], "880", "Owner A Drawings"),
    (["ACCOUNT FEE"], "404", "Bank Fees"),
    (["HOME LOAN PYMT", "OFFICE RENT"], "469", "Rent"),
    (["INTERNATIONAL TRANSACTION FEE"], "434", "Int'l Transaction Fees"),
    (["GITHUB"], "495", "Software"),
    (["OPENAI", "CHATGPT"], "495", "Software"),
    (["FRONTENDMASTERS"], "465", "Professional Development"),
    (["NOTION LABS"], "495", "Software"),
    (["XERO AU"], "495", "Software"),
    (["AMAZON WEB SERVICES", "AWS"], "495", "Software"),
    (["GOOGLE*GSUITE", "GSUITE_NATHANVALE", "GSUITE NATHANVA"], "495", "Software"),
    (["ADOBE"], "495", "Software"),
    (["LEMSQZY", "LEMONSQUEEZY", "UICOLORS"], "495", "Software"),
    (["UI.DEV"], "465", "Professional Development"),
    (["PADDLE.NET", "MACPAW"], "495", "Software"),
    (["TELSTRA"], "489", "Telephone & Internet"),
    (["LIGHTNING BROADBAND"], "489", "Telephone & Internet"),
    (["ALDIMOBILE", "ALDI MOBILE"], "489", "Telephone & Internet"),
    (["CGU DIRECT"], "433", "Insurance"),
    (["ANGLE AUTO FINAN"], "449", "Motor Vehicle"),
    (["AMPOL", "BP LT RIV", "BP BAYSIDE", "7-ELEVEN"], "449", "Motor Vehicle"),
    (["ATO ATODD"], "505", "Income Tax Expense"),
    (["EZYPAY*BODY FIT"], "429", "General Expenses (Gym)"),
    (["LATITUDE GO", "BPAY 443887"], "880", "Owner A Drawings (BPAY)"),
    (["KATE BERRY"], "880", "Owner A Drawings"),
    (["CLINK DIR DEBIT"], "429", "General Expenses"),
    (["DISNEY PLUS"], "485", "Subscriptions"),
    (["NEW YORK TIMES"], "485", "Subscriptions"),
    (["AMZNPRIMEAU", "AMAZON PRIME"], "485", "Subscriptions"),
    (["APPLE.COM/BILL"], "485", "Subscriptions (Apple)"),
    (["APPLE APPLE.COM/BILL"], "485", "Subscriptions (Apple)"),
    (["MYKI"], "493", "Travel - National"),
    (
        ["PAYSTAY", "PRAHRAN SQUARE CAR PARK", "CAREPARK", "POINT PARKING", "EASYPARK"],
        "449",
        "Motor Vehicle (Parking)",
    ),
    (["AFTERPAY"], "880", "Owner A Drawings (Afterpay)"),
    (["ZIPMONEY", "ZIPMONEY*", "ZIP.CO"], "880", "Owner A Drawings (ZipMoney)"),
    (["SOUTH EAST WATER"], "445", "Light, Power, Heating"),
    (["ORIGIN ENERGY"], "445", "Light, Power, Heating"),
    (["SCRATCH DOG FOOD"], "429", "General Expenses"),
    (["SHOLEM ALEICHEM"], "429", "General Expenses (School)"),
    (["FOULKES MEDICAL", "DR F"], "429", "General Expenses (Medical)"),
    (["GLO HEALTH"], "429", "General Expenses (Health)"),
    (["GREENCROSS VETS"], "429", "General Expenses (Vet)"),
    (["CHEMIST WAREHOUSE"], "429", "General Expenses"),
    (["PARLOUR HAIRDRESSI"], "429", "General Expenses"),
    (["UBER *EATS", "MENULOG"], "420", "Entertainment (Food Delivery)"),
    (["UBER *TRIP"], "493", "Travel - National"),
    (["JETSTAR"], "493", "Travel - National"),
    (["BOOKING.COM", "HIPCAMP"], "493", "Travel - National"),
    (["BIRDS BASEMENT"], "420", "Entertainment"),
    (["CAULFIELD RSL"], "420", "Entertainment"),
    (["ARTHUR MURRAY"], "429", "General Expenses (Dance)"),
    (["BUNNINGS"], "473", "Repairs and Maintenance"),
    (["WONDROUS"], "429", "General Expenses"),
    (
        ["MELANIE JOY BENVENIST", "MELANIE", "CREDIT TO ACCOUNT"],
        "881",
        "Owner A Funds Introduced",
    ),
    (["RETURN SCRATCH DOG"], "429", "General Expenses (Refund)"),
]

PERSONAL_KEYWORDS = [
    "MYER",
    "JD SPORTS",
    "KATHMANDU",
    "KMART",
    "SHOES & SOX",
    "SIMONE PERELE",
    "CK UNDERWEAR",
    "GREENWOOD LEATHER",
    "DAISO",
    "KOKOBL",
    "APPLE R180",
]


def keyword_classify(payee: str, amount: float) -> tuple[str, str, int, list[str], str]:
    """Return keyword fallback proposal details."""
    upper = payee.upper()

    for keywords, code, category in RULES:
        if any(keyword in upper for keyword in keywords):
            return code, category, 62, [f"rule:{code}", f"category:{category}"], payee

    for keyword in PERSONAL_KEYWORDS:
        if keyword in upper:
            return (
                "880",
                "Owner A Drawings (Shopping)",
                55,
                ["rule:880", "category:shopping"],
                payee,
            )

    if amount > 0:
        return "", "RECEIVE - needs review", 20, ["rule:none", "direction:receive"], payee

    if "WDL ATM" in upper:
        return (
            "880",
            "Owner A Drawings (ATM)",
            55,
            ["rule:880", "category:atm"],
            payee,
        )

    return "", "Needs review", 15, ["rule:none"], payee


def classify_statement_line(
    statement_line: dict[str, Any],
    history_rows: list[dict[str, Any]],
    contact_lookup: dict[str, dict[str, Any]],
    accounts: dict[str, dict[str, Any]],
    confidence_weights: dict[str, Any],
) -> dict[str, str]:
    """Propose a CSV review row from one sealed statement line."""
    payee = str(statement_line.get("payee", "")).strip()
    normalized_payee = normalize_payee(payee)
    amount = float(statement_line.get("amount", 0) or 0)
    direction = "RECEIVE" if amount > 0 else "SPEND"
    abs_amount = abs(amount)
    lookup_entry = contact_lookup.get(normalized_payee.lower())
    scoring = confidence_weights.get("scoring")
    if not isinstance(scoring, dict):
        raise ValueError("confidence weights missing 'scoring'")

    best_history: dict[str, Any] | None = None
    best_score = int(scoring.get("base", 0))
    conflict = False
    candidate_codes: set[str] = set()

    for row in history_rows:
        if str(row.get("Type", "")).upper() != direction:
            continue
        contact_name = str(row.get("Contact", "")).strip()
        matches, score = fuzzy_match(normalized_payee, contact_name)
        if not matches:
            continue

        total_score = int(scoring.get("cliHistoryMatch", 80))
        amount_min = float(row.get("AmountMin", 0) or 0)
        amount_max = float(row.get("AmountMax", 0) or 0)
        if amount_min <= abs_amount <= amount_max:
            total_score += int(scoring.get("amountWithinHistoricalRangeOrTolerance", 15))
        else:
            total_score += int(scoring.get("amountAnomalyOutsideTolerance", -25))
        if int(row.get("Count", 0) or 0) >= 3:
            total_score += int(scoring.get("recurrenceCountGte3", 10))
        candidate_codes.add(str(row.get("AccountCode", "")).strip())
        if len(candidate_codes) == 1:
            total_score += int(scoring.get("stableHistoricalAccountCode", 10))
        if best_history is None or total_score > best_score:
            best_history = row
            best_score = total_score

    if len(candidate_codes) > 1:
        conflict = True
        best_score = max(
            best_score + int(scoring.get("ambiguousVendorWithoutHistory", -15)),
            0,
        )

    rule_code, rule_category, rule_score, rule_evidence, rule_contact = keyword_classify(
        payee, amount
    )
    contact_only_score = int(scoring.get("base", 0))
    if lookup_entry:
        contact_only_score += int(scoring.get("exactNormalizedPayeeMatch", 70))

    if normalized_payee in GENERIC_PAYEES:
        penalty = int(scoring.get("genericPayeeToken", -20))
        best_score += penalty
        contact_only_score += penalty

    if best_history and best_score >= rule_score:
        account_code = str(best_history.get("AccountCode", "")).strip()
        contact_name = (
            str(lookup_entry.get("ContactName", "")).strip()
            if lookup_entry
            else str(best_history.get("Contact", "")).strip()
        )
        evidence = [
            f"history:{contact_name}->{account_code}",
            f"count:{int(best_history.get('Count', 0) or 0)}",
        ]
        amount_min = float(best_history.get("AmountMin", 0) or 0)
        amount_max = float(best_history.get("AmountMax", 0) or 0)
        evidence.append(
            "amount:range" if amount_min <= abs_amount <= amount_max else "amount:outside-range"
        )
        if lookup_entry:
            evidence.append("contact:resolved")
        if conflict:
            evidence.append("history:conflict")
        score = max(min(best_score, 99), 0)
        band = confidence_band_from_weights(score, confidence_weights)
        evidence.append(f"band:{band}")
        account_name = accounts.get(account_code, {}).get("name", "")
        return {
            "Status": "",
            "Date": str(statement_line.get("postedDate", "")).strip()[:10],
            "Payee": payee,
            "Amount": amount_to_csv(amount),
            "Type": direction,
            "AccountCode": account_code,
            "AccountName": str(account_name),
            "Contact": contact_name,
            "Confidence": confidence_cell(score),
            "Evidence": "|".join(evidence),
            "StatementLineID": str(statement_line.get("statementLineId", "")).strip(),
        }

    if lookup_entry and contact_only_score >= rule_score:
        contact_name = str(lookup_entry.get("ContactName", "")).strip()
        score = max(min(contact_only_score, 99), 0)
        band = confidence_band_from_weights(score, confidence_weights)
        evidence = ["contact:exact-normalized-match", f"band:{band}"]
        return {
            "Status": "",
            "Date": str(statement_line.get("postedDate", "")).strip()[:10],
            "Payee": payee,
            "Amount": amount_to_csv(amount),
            "Type": direction,
            "AccountCode": "",
            "AccountName": "",
            "Contact": contact_name,
            "Confidence": confidence_cell(score),
            "Evidence": "|".join(evidence),
            "StatementLineID": str(statement_line.get("statementLineId", "")).strip(),
        }

    score = max(min(rule_score, 99), 0)
    band = confidence_band_from_weights(score, confidence_weights)
    account_name = accounts.get(rule_code, {}).get("name", "") if rule_code else ""
    evidence = [*rule_evidence, f"band:{band}"]
    return {
        "Status": "",
        "Date": str(statement_line.get("postedDate", "")).strip()[:10],
        "Payee": payee,
        "Amount": amount_to_csv(amount),
        "Type": direction,
        "AccountCode": rule_code,
        "AccountName": str(account_name),
        "Contact": str(lookup_entry.get("ContactName", rule_contact)).strip()
        if lookup_entry
        else rule_contact,
        "Confidence": confidence_cell(score),
        "Evidence": "|".join(evidence),
        "StatementLineID": str(statement_line.get("statementLineId", "")).strip(),
    }


def build_review_rows_from_seal(seal: dict[str, Any]) -> list[dict[str, str]]:
    """Generate review CSV rows from a quarter seal."""
    statement_lines = seal.get("statementLines") or []
    history_rows = seal.get("history", {}).get("rows") or []
    contact_lookup = seal.get("contactLookup", {}).get("lookup") or {}
    accounts = load_accounts_map(seal.get("accounts") or [])
    confidence_weights = load_confidence_weights()
    rows = [
        classify_statement_line(
            item,
            history_rows,
            contact_lookup,
            accounts,
            confidence_weights,
        )
        for item in statement_lines
        if not bool(item.get("isReconciled"))
    ]
    confidence_order = {"high": 0, "medium": 1, "low": 2}

    def sort_key(row: dict[str, str]) -> tuple[int, str, str]:
        band = row["Confidence"].split(" ", 1)[0]
        return (
            confidence_order.get(band, 3),
            row.get("AccountCode", ""),
            row.get("Date", ""),
        )

    rows.sort(key=sort_key)
    return rows


def write_review_csv(path: str | Path, rows: list[dict[str, str]]) -> None:
    """Write the review CSV using the strict project contract."""
    with Path(path).open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=REVIEW_FIELDNAMES,
            quoting=csv.QUOTE_ALL,
            lineterminator="\n",
            extrasaction="raise",
        )
        writer.writeheader()
        writer.writerows(rows)


def quarter_seal_filename(q: int, fy: int) -> str:
    """Return the quarter seal filename for a given FY/Q pair."""
    fy2 = fy % 100
    return f".quarter-cache-fy{fy2:02d}-q{q}.json"
