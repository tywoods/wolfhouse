import json
import re
import unittest
from pathlib import Path


FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "fixtures/luna-acceptance/sim15-season-oneq-rendered-replies.json"
)


class Sim15SeasonOneQuestionExpectedTextTests(unittest.TestCase):
    """Validate editorial examples only; these tests do not generate model replies."""

    @classmethod
    def setUpClass(cls):
        cls.cases = {row["case"]: row for row in json.loads(FIXTURE.read_text())}

    def expected_text(self, case):
        row = self.cases[case]
        self.assertEqual(row["label"], "expected_text_example_not_model_output")
        return row["expected_text"]

    def assert_at_most_one_question(self, text):
        self.assertLessEqual(text.count("?"), 1, text)

    def assert_no_stale_season_caveat(self, text):
        self.assertIsNone(
            re.search(r"easter|halloween|not confirm|can't confirm|cannot confirm", text, re.I),
            text,
        )

    def test_g3_expected_text_keeps_supported_sister_policy_but_defers_her_night(self):
        text = self.expected_text("g3_open")
        self.assert_no_stale_season_caveat(text)
        self.assertIn("Those dates work", text)
        self.assertRegex(text, r"women-only dorm.*mixed dorm")
        self.assertIn("sister", text.lower())
        self.assertNotRegex(text.lower(), r"which night|what night|when.*sister")
        self.assert_at_most_one_question(text)

    def test_november_couple_expected_text_preserves_private_room_preference(self):
        row = self.cases["couple_open"]
        text = self.expected_text("couple_open")
        self.assertEqual(row["known_preference"], "private room")
        self.assert_no_stale_season_caveat(text)
        self.assertRegex(text.lower(), r"private room is available")
        self.assertNotRegex(text.lower(), r"private.*or.*shared|shared.*or.*private")
        self.assertRegex(text.lower(), r"softboards.*hardboards")
        self.assert_at_most_one_question(text)

    def test_closed_season_expected_text_remains_binding(self):
        text = self.expected_text("closed")
        self.assertRegex(text.lower(), r"closed for those dates")
        self.assertRegex(text.lower(), r"different dates")
        self.assert_at_most_one_question(text)

    def test_missing_date_authority_expected_text_does_not_invent_opening(self):
        text = self.expected_text("missing")
        self.assertRegex(text.lower(), r"can.t confirm")
        self.assertNotRegex(text.lower(), r"dates work|^we.re open|^we are open")
        self.assert_at_most_one_question(text)


if __name__ == "__main__":
    unittest.main()
