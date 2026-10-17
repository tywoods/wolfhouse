import json
import re
import unittest
from pathlib import Path


FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "fixtures/luna-acceptance/sim15-season-oneq-rendered-replies.json"
)


class Sim15SeasonOneQuestionRenderedReplyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = {row["case"]: row for row in json.loads(FIXTURE.read_text())}

    def reply(self, case):
        return self.cases[case]["reply"]

    def assert_one_question(self, reply):
        self.assertEqual(reply.count("?"), 1, reply)

    def assert_no_stale_season_caveat(self, reply):
        self.assertIsNone(re.search(r"easter|halloween|not confirm|can't confirm|cannot confirm", reply, re.I), reply)

    def test_g3_open_uses_current_date_authority_and_defers_sisters_night(self):
        reply = self.reply("g3_open")
        self.assert_no_stale_season_caveat(reply)
        self.assertIn("Those dates work", reply)
        self.assertRegex(reply, r"women-only dorm.*mixed dorm")
        self.assertNotRegex(reply.lower(), r"sister|her night|which night")
        self.assert_one_question(reply)

    def test_november_couple_open_asks_only_room_choice(self):
        reply = self.reply("couple_open")
        self.assert_no_stale_season_caveat(reply)
        self.assertIn("November dates work", reply)
        self.assertRegex(reply, r"private double.*shared dorm")
        self.assert_one_question(reply)

    def test_closed_season_remains_binding(self):
        reply = self.reply("closed")
        self.assertRegex(reply.lower(), r"closed for those dates")
        self.assertRegex(reply.lower(), r"different dates")
        self.assert_one_question(reply)

    def test_missing_date_authority_does_not_invent_opening_confirmation(self):
        reply = self.reply("missing")
        self.assertRegex(reply.lower(), r"can.t confirm")
        self.assertNotRegex(reply.lower(), r"dates work|^we.re open|^we are open")
        self.assert_one_question(reply)


if __name__ == "__main__":
    unittest.main()
