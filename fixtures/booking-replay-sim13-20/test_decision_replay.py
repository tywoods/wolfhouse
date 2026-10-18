"""JW1628 decision-only replay over captured Sim13--20 accepted quotes."""
import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORPUS = Path(os.environ.get("SIM13_20_REPLAY_CORPUS", "/opt/data/workspace/replay-corpus-sim13-20-20261018T1530"))
sys.path.insert(0, str(HERE))

class DecisionReplayTests(unittest.TestCase):
    def test_all_recorded_decisions(self):
        from accepted_quote_replay import replay_table
        table = json.loads((HERE / "expected_cases.json").read_text())
        results = replay_table(table, CORPUS)
        failures = [row for row in results if row["actual"] != row["expected"]]
        self.assertFalse(failures, json.dumps(failures, ensure_ascii=False, indent=2))
        replayed = [row for row in results if row["expected"] != "not_replayable"]
        skipped = [row for row in results if row["expected"] == "not_replayable"]
        self.assertGreater(len(replayed), 0)
        self.assertTrue(all(row.get("reason") for row in skipped))
        print(json.dumps({"cases": len(results), "replayed": len(replayed),
                          "not_replayable": len(skipped), "failures": len(failures)}, sort_keys=True))

    def test_explicitly_synthetic_refusals_and_controls(self):
        from accepted_quote_replay import replay_synthetic_case
        fixture = json.loads((HERE / "synthetic_refusal_cases.json").read_text())
        self.assertEqual(fixture["provenance"],
                         "synthetic Staff variations; not historical outcomes")
        expected_ids = {
            "synthetic-refusal-changed-dates", "synthetic-refusal-changed-count",
            "synthetic-refusal-changed-bed", "synthetic-refusal-changed-price",
            "synthetic-refusal-changed-package", "synthetic-refusal-unavailable-bed",
            "synthetic-refusal-conflicting-bed", "synthetic-control-unchanged",
            "synthetic-control-name-completion", "synthetic-control-payment-completion",
        }
        self.assertEqual({case["id"] for case in fixture["cases"]}, expected_ids)
        results = [replay_synthetic_case({**fixture["base"], **case})
                   for case in fixture["cases"]]
        failures = [row for row in results if row["actual"] != row["expected"]]
        self.assertFalse(failures, json.dumps(failures, indent=2, sort_keys=True))

if __name__ == "__main__": unittest.main(verbosity=2)
