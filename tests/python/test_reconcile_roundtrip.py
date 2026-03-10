from __future__ import annotations

import csv
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from reconcile_roundtrip import REVIEW_FIELDNAMES


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReconcileRoundTripTests(unittest.TestCase):
    def setUp(self) -> None:
        self.manage_quarters = load_module(
            "manage_quarters_test",
            SCRIPTS_DIR / "manage-quarters.py",
        )
        self.export_module = load_module(
            "export_reconcile_spreadsheet_test",
            SCRIPTS_DIR / "export-reconcile-spreadsheet.py",
        )
        self.read_module = load_module(
            "read_reconcile_csv_test",
            SCRIPTS_DIR / "read-reconcile-csv.py",
        )

    def write_ndjson(self, path: Path, rows: list[dict[str, Any]]) -> None:
        with path.open("w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row))
                handle.write("\n")

    def test_seal_quarter_builds_cache_and_skips_when_inputs_match(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data_dir = root / "data"
            data_dir.mkdir()

            self.manage_quarters.DATA_DIR = data_dir
            self.manage_quarters.QUARTERS_FILE = data_dir / "quarters.json"

            self.write_ndjson(
                data_dir / "statement-lines-fy25-q4.ndjson",
                [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "postedDate": "2025-04-01",
                        "payee": "Github Inc",
                        "amount": -49.99,
                        "isReconciled": False,
                        "bankAccountId": "bank-1",
                    },
                    {
                        "statementLineId": "22222222-2222-2222-2222-222222222222",
                        "postedDate": "2025-04-02",
                        "payee": "Officeworks",
                        "amount": -12.34,
                        "isReconciled": False,
                        "bankAccountId": "bank-1",
                    },
                ],
            )
            self.write_ndjson(
                data_dir / "accounts.ndjson",
                [
                    {"Code": "495", "Name": "Software", "Status": "ACTIVE"},
                    {"Code": "429", "Name": "General Expenses", "Status": "ACTIVE"},
                ],
            )
            self.write_ndjson(
                data_dir / "bank-transactions.ndjson",
                [
                    {
                        "IsReconciled": True,
                        "Contact": {
                            "Name": "Github Inc",
                            "ContactID": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                        },
                    }
                ],
            )

            history_calls: list[str] = []

            def fake_history(since: str):
                history_calls.append(since)
                return (
                    [
                        {
                            "Contact": "Github Inc",
                            "AccountCode": "495",
                            "Count": 6,
                            "AmountMin": 49.99,
                            "AmountMax": 49.99,
                            "Type": "SPEND",
                        }
                    ],
                    {
                        "status": "ok",
                        "generatedAt": "2026-03-10T10:00:00+11:00",
                        "since": since,
                    },
                )

            self.manage_quarters.gate_check = lambda q, fy: 0
            self.manage_quarters.count_qif_transactions = lambda path: 2
            self.manage_quarters.load_history_rows = fake_history

            first = self.manage_quarters.seal_quarter(4, 25)
            second = self.manage_quarters.seal_quarter(4, 25)

            self.assertEqual(first, 0)
            self.assertEqual(second, 0)
            self.assertEqual(history_calls, ["2024-01-01"])

            seal_path = data_dir / ".quarter-cache-fy25-q4.json"
            with seal_path.open(encoding="utf-8") as handle:
                seal = json.load(handle)

            self.assertEqual(seal["quarter"], "Q4 FY25")
            self.assertEqual(seal["sealStatus"], "ok")
            self.assertEqual(seal["statementLineCount"], 2)
            self.assertEqual(seal["bankAccountId"], "bank-1")
            self.assertEqual(len(seal["history"]["rows"]), 1)

    def test_export_from_seal_writes_new_review_contract(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seal_path = root / "seal.json"
            csv_path = root / "review.csv"
            seal = {
                "quarter": "Q4 FY25",
                "statementLines": [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "postedDate": "2025-04-01",
                        "payee": "Github Inc",
                        "amount": -49.99,
                        "isReconciled": False,
                    },
                    {
                        "statementLineId": "22222222-2222-2222-2222-222222222222",
                        "postedDate": "2025-04-03",
                        "payee": "Mystery Merchant",
                        "amount": -10.00,
                        "isReconciled": False,
                    },
                ],
                "accounts": [
                    {"Code": "495", "Name": "Software", "Status": "ACTIVE"},
                    {"Code": "429", "Name": "General Expenses", "Status": "ACTIVE"},
                ],
                "contactLookup": {
                    "lookup": {
                        "github inc": {
                            "ContactName": "Github Inc",
                            "ContactID": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                        }
                    }
                },
                "history": {
                    "rows": [
                        {
                            "Contact": "Github Inc",
                            "AccountCode": "495",
                            "Count": 6,
                            "AmountMin": 49.99,
                            "AmountMax": 49.99,
                            "Type": "SPEND",
                        }
                    ]
                },
            }
            seal_path.write_text(json.dumps(seal), encoding="utf-8")

            result = self.export_module.main(
                ["--seal", str(seal_path), "--output", str(csv_path)]
            )
            self.assertEqual(result, 0)

            with csv_path.open(encoding="utf-8", newline="") as handle:
                reader = csv.DictReader(handle)
                self.assertEqual(reader.fieldnames, REVIEW_FIELDNAMES)
                rows = list(reader)

            self.assertEqual(rows[0]["AccountCode"], "495")
            self.assertEqual(rows[0]["AccountName"], "Software")
            self.assertEqual(rows[0]["Contact"], "Github Inc")
            self.assertTrue(rows[0]["Confidence"].startswith("high"))
            self.assertEqual(rows[1]["Status"], "")

    def test_read_back_normalizes_status_and_reports_diffs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seal_path = root / "seal.json"
            csv_path = root / "review.csv"
            seal = {
                "quarter": "Q4 FY25",
                "statementLines": [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "postedDate": "2025-04-01",
                        "payee": "Github Inc",
                        "amount": -49.99,
                        "isReconciled": False,
                    },
                    {
                        "statementLineId": "22222222-2222-2222-2222-222222222222",
                        "postedDate": "2025-04-03",
                        "payee": "Mystery Merchant",
                        "amount": -10.00,
                        "isReconciled": False,
                    },
                ],
                "accounts": [
                    {"Code": "495", "Name": "Software", "Status": "ACTIVE"},
                    {"Code": "429", "Name": "General Expenses", "Status": "ACTIVE"},
                ],
                "contactLookup": {"lookup": {}},
                "history": {
                    "rows": [
                        {
                            "Contact": "Github Inc",
                            "AccountCode": "495",
                            "Count": 6,
                            "AmountMin": 49.99,
                            "AmountMax": 49.99,
                            "Type": "SPEND",
                        }
                    ]
                },
            }
            seal_path.write_text(json.dumps(seal), encoding="utf-8")
            csv_path.write_text(
                "\n".join(
                    [
                        '"Status","Date","Payee","Amount","Type","AccountCode","AccountName","Contact","Confidence","Evidence","StatementLineID"',
                        '" approve ","2025-04-01","Github Inc","-49.99","SPEND","495","Software","Github Inc","high (97)","history:Github Inc->495","\'11111111-1111-1111-1111-111111111111"',
                        '"EDIT","2025-04-03","Mystery Merchant","-10.00","SPEND","429","General Expenses","Mystery Merchant","low (15)","rule:none","22222222-2222-2222-2222-222222222222"',
                    ]
                ),
                encoding="utf-8",
            )

            buffer = io.StringIO()
            with redirect_stdout(buffer):
                result = self.read_module.cmd_read(str(csv_path), str(seal_path))
            payload = json.loads(buffer.getvalue())

            self.assertEqual(result, 0)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["summary"]["statusCounts"]["APPROVE"], 1)
            self.assertEqual(payload["summary"]["statusCounts"]["EDIT"], 1)
            self.assertEqual(payload["summary"]["diffCount"], 1)
            self.assertEqual(payload["rows"][0]["Status"], "APPROVE")

    def test_read_back_rejects_duplicate_statement_line_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seal_path = root / "seal.json"
            csv_path = root / "review.csv"
            seal = {
                "quarter": "Q4 FY25",
                "statementLines": [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "postedDate": "2025-04-01",
                        "payee": "Github Inc",
                        "amount": -49.99,
                        "isReconciled": False,
                    },
                    {
                        "statementLineId": "22222222-2222-2222-2222-222222222222",
                        "postedDate": "2025-04-03",
                        "payee": "Mystery Merchant",
                        "amount": -10.00,
                        "isReconciled": False,
                    },
                ],
                "accounts": [
                    {"Code": "495", "Name": "Software", "Status": "ACTIVE"},
                ],
                "contactLookup": {"lookup": {}},
                "history": {"rows": []},
            }
            seal_path.write_text(json.dumps(seal), encoding="utf-8")
            csv_path.write_text(
                "\n".join(
                    [
                        '"Status","Date","Payee","Amount","Type","AccountCode","AccountName","Contact","Confidence","Evidence","StatementLineID"',
                        '"","","Github Inc","-49.99","SPEND","495","Software","","low (15)","rule:none","11111111-1111-1111-1111-111111111111"',
                        '"","","Mystery Merchant","-10.00","SPEND","495","Software","","low (15)","rule:none","11111111-1111-1111-1111-111111111111"',
                    ]
                ),
                encoding="utf-8",
            )

            buffer = io.StringIO()
            with redirect_stdout(buffer):
                result = self.read_module.cmd_read(str(csv_path), str(seal_path))
            payload = json.loads(buffer.getvalue())

            self.assertEqual(result, 2)
            self.assertFalse(payload["ok"])
            self.assertTrue(
                any(error["code"] == "duplicate-id" for error in payload["errors"])
            )


if __name__ == "__main__":
    unittest.main()
