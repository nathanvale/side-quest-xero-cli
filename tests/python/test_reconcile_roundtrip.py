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

    def test_seal_quarter_reports_named_invalidation_reason(self) -> None:
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
                    }
                ],
            )
            self.write_ndjson(
                data_dir / "accounts.ndjson",
                [{"Code": "495", "Name": "Software", "Status": "ACTIVE"}],
            )

            self.manage_quarters.gate_check = lambda q, fy: 0
            self.manage_quarters.count_qif_transactions = lambda path: 1
            self.manage_quarters.load_history_rows = lambda since: ([], {
                "status": "degraded",
                "generatedAt": "2026-03-10T10:00:00+11:00",
                "since": since,
                "error": "history offline",
            })

            self.assertEqual(self.manage_quarters.seal_quarter(4, 25), 0)
            self.write_ndjson(
                data_dir / "accounts.ndjson",
                [{"Code": "495", "Name": "Software and SaaS", "Status": "ACTIVE"}],
            )

            buffer = io.StringIO()
            with redirect_stdout(buffer):
                result = self.manage_quarters.seal_quarter(4, 25)
            self.assertEqual(result, 0)
            self.assertIn("Seal invalidated: accounts changed", buffer.getvalue())

            seal_path = data_dir / ".quarter-cache-fy25-q4.json"
            with seal_path.open(encoding="utf-8") as handle:
                seal = json.load(handle)
            self.assertEqual(seal["sealInvalidationReason"], "accounts changed")

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
                        "github": {
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

    def test_export_can_copy_csv_to_google_drive_inbox(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seal_path = root / "seal.json"
            csv_path = root / "review.csv"
            drive_inbox = root / "drive"
            drive_inbox.mkdir()
            seal = {
                "quarter": "Q4 FY25",
                "statementLines": [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "postedDate": "2025-04-01",
                        "payee": "Github Inc",
                        "amount": -49.99,
                        "isReconciled": False,
                    }
                ],
                "accounts": [{"Code": "495", "Name": "Software", "Status": "ACTIVE"}],
                "contactLookup": {"lookup": {}},
                "history": {"rows": []},
            }
            seal_path.write_text(json.dumps(seal), encoding="utf-8")

            result = self.export_module.main(
                [
                    "--seal",
                    str(seal_path),
                    "--output",
                    str(csv_path),
                    "--copy-to-google-drive",
                    "--google-drive-inbox",
                    str(drive_inbox),
                ]
            )
            self.assertEqual(result, 0)
            self.assertTrue((drive_inbox / "review.csv").exists())

    def test_export_uses_contact_lookup_score_without_history_weight_stacking(self) -> None:
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
                    }
                ],
                "accounts": [
                    {"Code": "495", "Name": "Software", "Status": "ACTIVE"},
                ],
                "contactLookup": {
                    "lookup": {
                        "github": {
                            "ContactName": "Github Inc",
                            "ContactID": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                        }
                    }
                },
                "history": {"rows": []},
            }
            seal_path.write_text(json.dumps(seal), encoding="utf-8")

            self.assertEqual(
                self.export_module.main(["--seal", str(seal_path), "--output", str(csv_path)]),
                0,
            )

            with csv_path.open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))

            self.assertEqual(rows[0]["AccountCode"], "")
            self.assertEqual(rows[0]["Contact"], "Github Inc")
            self.assertEqual(rows[0]["Confidence"], "medium (70)")
            self.assertIn("contact:exact-normalized-match", rows[0]["Evidence"])

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

    def test_merge_preserves_order_and_only_updates_review_and_blank_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seal_path = root / "seal.json"
            csv_path = root / "review.csv"
            merged_path = root / "review-merged.csv"
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
                    {
                        "statementLineId": "33333333-3333-3333-3333-333333333333",
                        "postedDate": "2025-04-04",
                        "payee": "OpenAI",
                        "amount": -30.00,
                        "isReconciled": False,
                    },
                ],
                "accounts": [
                    {"Code": "495", "Name": "Software", "Status": "ACTIVE"},
                    {"Code": "429", "Name": "General Expenses", "Status": "ACTIVE"},
                ],
                "contactLookup": {"lookup": {"github": {"ContactName": "Github Inc"}}},
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
                        '"REVIEW","2025-04-01","Github Inc","-49.99","SPEND","","","","low (10)","stale","11111111-1111-1111-1111-111111111111"',
                        '"","","","","","","","","","",""',
                        '"APPROVE","2025-04-03","Mystery Merchant","-10.00","SPEND","429","General Expenses","Mystery Merchant","low (15)","manual","22222222-2222-2222-2222-222222222222"',
                        '"","2024-01-01","Wrong Payee","-1.00","SPEND","","","","low (1)","old","33333333-3333-3333-3333-333333333333"',
                    ]
                ),
                encoding="utf-8",
            )

            buffer = io.StringIO()
            with redirect_stdout(buffer):
                result = self.read_module.cmd_merge(
                    str(csv_path), str(seal_path), str(merged_path)
                )
            payload = json.loads(buffer.getvalue())

            self.assertEqual(result, 0)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["changedRows"], 2)

            with merged_path.open(encoding="utf-8", newline="") as handle:
                rows = list(csv.DictReader(handle))

            self.assertEqual(rows[0]["Status"], "REVIEW")
            self.assertEqual(rows[0]["AccountCode"], "495")
            self.assertEqual(rows[0]["AccountName"], "Software")
            self.assertEqual(rows[0]["Contact"], "Github Inc")
            self.assertEqual(rows[1]["StatementLineID"], "")
            self.assertEqual(rows[2]["Status"], "APPROVE")
            self.assertEqual(rows[2]["Evidence"], "manual")
            self.assertEqual(rows[3]["Payee"], "OpenAI")
            self.assertEqual(rows[3]["Date"], "2025-04-04")
            self.assertEqual(rows[3]["Evidence"], "rule:495|category:Software|band:medium")

    def test_export_post_bodies_uses_only_approved_and_edited_rows(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            seal_path = root / "seal.json"
            csv_path = root / "review.csv"
            queue_path = root / "post-queue.json"
            seal = {
                "quarter": "Q4 FY25",
                "bankAccountId": "bank-1",
                "statementLines": [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "postedDate": "2025-04-01",
                        "payee": "Github Inc",
                        "amount": -49.99,
                        "currencyCode": "AUD",
                        "isReconciled": False,
                    },
                    {
                        "statementLineId": "22222222-2222-2222-2222-222222222222",
                        "postedDate": "2025-04-02",
                        "payee": "Mystery Merchant",
                        "amount": 150.00,
                        "currencyCode": "AUD",
                        "isReconciled": False,
                    },
                    {
                        "statementLineId": "33333333-3333-3333-3333-333333333333",
                        "postedDate": "2025-04-03",
                        "payee": "Ignored Merchant",
                        "amount": -10.00,
                        "currencyCode": "AUD",
                        "isReconciled": False,
                    },
                ],
                "accounts": [
                    {"Code": "495", "Name": "Software", "Status": "ACTIVE"},
                    {"Code": "200", "Name": "Sales Revenue", "Status": "ACTIVE"},
                ],
                "contactLookup": {
                    "lookup": {
                        "github": {
                            "ContactID": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                            "ContactName": "Github Inc",
                        }
                    }
                },
                "history": {"rows": []},
            }
            seal_path.write_text(json.dumps(seal), encoding="utf-8")
            csv_path.write_text(
                "\n".join(
                    [
                        '"Status","Date","Payee","Amount","Type","AccountCode","AccountName","Contact","Confidence","Evidence","StatementLineID"',
                        '"APPROVE","2025-04-01","Github Inc","-49.99","SPEND","495","Software","Github Inc","high (80)","history","11111111-1111-1111-1111-111111111111"',
                        '"EDIT","2025-04-02","Mystery Merchant","150.00","RECEIVE","200","Sales Revenue","Custom Contact","medium (70)","manual","22222222-2222-2222-2222-222222222222"',
                        '"SKIP","2025-04-03","Ignored Merchant","-10.00","SPEND","495","Software","","low (10)","skip","33333333-3333-3333-3333-333333333333"',
                    ]
                ),
                encoding="utf-8",
            )

            buffer = io.StringIO()
            with redirect_stdout(buffer):
                result = self.read_module.cmd_export_post_bodies(
                    str(csv_path), str(seal_path), str(queue_path)
                )
            payload = json.loads(buffer.getvalue())

            self.assertEqual(result, 0)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["rows"], 2)
            self.assertEqual(payload["approvedRows"], 1)
            self.assertEqual(payload["editedRows"], 1)
            self.assertEqual(payload["totalAbsAmount"], 199.99)

            with queue_path.open(encoding="utf-8") as handle:
                queue = json.load(handle)

            self.assertEqual(len(queue["items"]), 2)
            first = queue["items"][0]
            second = queue["items"][1]
            self.assertEqual(first["body"]["BankAccount"]["AccountID"], "bank-1")
            self.assertEqual(first["body"]["Contact"]["ContactID"], "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
            self.assertEqual(first["body"]["LineItems"][0]["TaxType"], "INPUT")
            self.assertEqual(second["body"]["Type"], "RECEIVE")
            self.assertEqual(second["body"]["Contact"], {"Name": "Custom Contact"})
            self.assertEqual(second["body"]["LineItems"][0]["TaxType"], "OUTPUT")

    def test_begin_post_run_requires_exact_interlock_and_writes_preview_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            queue_path = root / "queue.json"
            state_path = root / "post-run.json"
            queue = {
                "quarter": "Q4 FY25",
                "queueHash": "queue-hash",
                "rows": 2,
                "approvedRows": 1,
                "editedRows": 1,
                "totalAbsAmount": 199.99,
                "items": [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "body": {"Type": "SPEND"},
                    },
                    {
                        "statementLineId": "22222222-2222-2222-2222-222222222222",
                        "body": {"Type": "RECEIVE"},
                    },
                ],
            }
            queue_path.write_text(json.dumps(queue), encoding="utf-8")

            bad_buffer = io.StringIO()
            with redirect_stdout(bad_buffer):
                bad_result = self.read_module.cmd_begin_post_run(
                    str(queue_path), str(state_path), "WRITE FY25"
                )
            bad_payload = json.loads(bad_buffer.getvalue())
            self.assertEqual(bad_result, 2)
            self.assertFalse(bad_payload["ok"])

            good_buffer = io.StringIO()
            with redirect_stdout(good_buffer):
                good_result = self.read_module.cmd_begin_post_run(
                    str(queue_path), str(state_path), "WRITE Q4 FY25"
                )
            good_payload = json.loads(good_buffer.getvalue())
            self.assertEqual(good_result, 0)
            self.assertTrue(good_payload["ok"])
            self.assertEqual(good_payload["preview"]["rows"], 2)

            with state_path.open(encoding="utf-8") as handle:
                state = json.load(handle)
            self.assertEqual(state["quarter"], "Q4 FY25")
            self.assertEqual(len(state["items"]), 2)
            self.assertEqual(
                state["items"]["11111111-1111-1111-1111-111111111111"]["status"],
                "confirmed",
            )

    def test_verify_post_sync_blocks_drifted_current_seal(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            queue_path = root / "queue.json"
            current_seal_path = root / "current-seal.json"
            queue = {
                "quarter": "Q4 FY25",
                "bankAccountId": "bank-1",
                "queueHash": "queue-hash",
                "originalSeal": {
                    "sourceManifest": {
                        "statementLines": {
                            "path": "data/statement-lines-fy25-q4.ndjson",
                            "size": 100,
                            "mtime": 1,
                            "sha256": "abc",
                            "semanticFingerprint": "fingerprint-original",
                        }
                    }
                },
                "items": [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "status": "APPROVE",
                        "body": {"Type": "SPEND"},
                    }
                ],
            }
            current_seal = {
                "quarter": "Q4 FY25",
                "bankAccountId": "bank-1",
                "sourceManifest": {
                    "statementLines": {
                        "path": "data/statement-lines-fy25-q4.ndjson",
                        "size": 100,
                        "mtime": 2,
                        "sha256": "def",
                        "semanticFingerprint": "fingerprint-drifted",
                    }
                },
                "statementLines": [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "postedDate": "2025-04-01",
                        "payee": "Github Inc",
                        "amount": -49.99,
                        "isReconciled": True,
                    }
                ],
                "accounts": [{"Code": "495", "Name": "Software", "Status": "ACTIVE"}],
            }
            queue_path.write_text(json.dumps(queue), encoding="utf-8")
            current_seal_path.write_text(json.dumps(current_seal), encoding="utf-8")

            buffer = io.StringIO()
            with redirect_stdout(buffer):
                result = self.read_module.cmd_verify_post_sync(
                    str(queue_path), str(current_seal_path)
                )
            payload = json.loads(buffer.getvalue())

            self.assertEqual(result, 2)
            self.assertFalse(payload["ok"])
            self.assertTrue(
                any(error["code"] == "statement-lines-drift" for error in payload["errors"])
            )
            self.assertTrue(
                any(error["code"] == "already-reconciled" for error in payload["errors"])
            )

    def test_verify_post_sync_passes_when_current_seal_matches_queue_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            queue_path = root / "queue.json"
            current_seal_path = root / "current-seal.json"
            manifest = {
                "statementLines": {
                    "path": "data/statement-lines-fy25-q4.ndjson",
                    "size": 100,
                    "mtime": 1,
                    "sha256": "abc",
                    "semanticFingerprint": "fingerprint-original",
                }
            }
            queue = {
                "quarter": "Q4 FY25",
                "bankAccountId": "bank-1",
                "queueHash": "queue-hash",
                "originalSeal": {"sourceManifest": manifest},
                "items": [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "status": "APPROVE",
                        "body": {"Type": "SPEND"},
                    }
                ],
            }
            current_seal = {
                "quarter": "Q4 FY25",
                "bankAccountId": "bank-1",
                "sourceManifest": manifest,
                "statementLines": [
                    {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "postedDate": "2025-04-01",
                        "payee": "Github Inc",
                        "amount": -49.99,
                        "isReconciled": False,
                    }
                ],
                "accounts": [{"Code": "495", "Name": "Software", "Status": "ACTIVE"}],
            }
            queue_path.write_text(json.dumps(queue), encoding="utf-8")
            current_seal_path.write_text(json.dumps(current_seal), encoding="utf-8")

            buffer = io.StringIO()
            with redirect_stdout(buffer):
                result = self.read_module.cmd_verify_post_sync(
                    str(queue_path), str(current_seal_path)
                )
            payload = json.loads(buffer.getvalue())

            self.assertEqual(result, 0)
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["errors"], [])

    def test_record_post_result_handles_success_and_retries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            state_path = root / "post-run.json"
            log_path = root / "post-run.log.ndjson"
            state = {
                "schemaVersion": 1,
                "quarter": "Q4 FY25",
                "queueHash": "queue-hash",
                "startedAt": "2026-03-10T10:00:00+11:00",
                "writeInterlock": "WRITE Q4 FY25",
                "preview": {"rows": 2, "approvedRows": 1, "editedRows": 1, "totalAbsAmount": 199.99},
                "logFile": str(log_path),
                "items": {
                    "11111111-1111-1111-1111-111111111111": {
                        "statementLineId": "11111111-1111-1111-1111-111111111111",
                        "status": "confirmed",
                        "confirmedAt": "2026-03-10T10:00:00+11:00",
                        "idempotencyKey": "idem-1",
                        "requestHash": "hash-1",
                        "responseCode": None,
                        "bankTransactionId": None,
                        "errorReason": None,
                        "postedAt": None,
                        "nextRetryAt": None,
                        "tenantPauseUntil": None,
                        "sameKeyRetryUntil": None,
                    },
                    "22222222-2222-2222-2222-222222222222": {
                        "statementLineId": "22222222-2222-2222-2222-222222222222",
                        "status": "confirmed",
                        "confirmedAt": "2026-03-10T10:00:00+11:00",
                        "idempotencyKey": "idem-2",
                        "requestHash": "hash-2",
                        "responseCode": None,
                        "bankTransactionId": None,
                        "errorReason": None,
                        "postedAt": None,
                        "nextRetryAt": None,
                        "tenantPauseUntil": None,
                        "sameKeyRetryUntil": None,
                    },
                },
            }
            state_path.write_text(json.dumps(state), encoding="utf-8")

            success_buffer = io.StringIO()
            with redirect_stdout(success_buffer):
                success_result = self.read_module.cmd_record_post_result(
                    str(state_path),
                    "11111111-1111-1111-1111-111111111111",
                    200,
                    "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    None,
                    None,
                    None,
                )
            success_payload = json.loads(success_buffer.getvalue())
            self.assertEqual(success_result, 0)
            self.assertEqual(success_payload["status"], "posted")

            retry_buffer = io.StringIO()
            with redirect_stdout(retry_buffer):
                retry_result = self.read_module.cmd_record_post_result(
                    str(state_path),
                    "22222222-2222-2222-2222-222222222222",
                    429,
                    None,
                    "rate limited",
                    15,
                    None,
                )
            retry_payload = json.loads(retry_buffer.getvalue())
            self.assertEqual(retry_result, 0)
            self.assertEqual(retry_payload["status"], "confirmed")
            self.assertIsNotNone(retry_payload["nextRetryAt"])

            offline_buffer = io.StringIO()
            with redirect_stdout(offline_buffer):
                offline_result = self.read_module.cmd_record_post_result(
                    str(state_path),
                    "22222222-2222-2222-2222-222222222222",
                    503,
                    None,
                    "Organisation Offline",
                    None,
                    None,
                )
            offline_payload = json.loads(offline_buffer.getvalue())
            self.assertEqual(offline_result, 0)
            self.assertEqual(offline_payload["status"], "confirmed")
            self.assertIsNotNone(offline_payload["tenantPauseUntil"])

            unknown_buffer = io.StringIO()
            with redirect_stdout(unknown_buffer):
                unknown_result = self.read_module.cmd_record_post_result(
                    str(state_path),
                    "22222222-2222-2222-2222-222222222222",
                    None,
                    None,
                    "socket timeout",
                    None,
                    "timeout",
                )
            unknown_payload = json.loads(unknown_buffer.getvalue())
            self.assertEqual(unknown_result, 0)
            self.assertEqual(unknown_payload["status"], "confirmed")
            self.assertIsNotNone(unknown_payload["sameKeyRetryUntil"])

            log_lines = log_path.read_text(encoding="utf-8").strip().splitlines()
            self.assertEqual(len(log_lines), 4)


if __name__ == "__main__":
    unittest.main()
