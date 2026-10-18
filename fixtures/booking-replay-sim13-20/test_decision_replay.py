"""JW1628 decision-only replay over captured Sim13--21 accepted quotes."""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
CORPUS = Path(os.environ.get("SIM13_20_REPLAY_CORPUS", "/opt/data/workspace/replay-corpus-sim13-20-20261018T1530"))
sys.path.insert(0, str(HERE))

class DecisionReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sim21 = {row['id']: row for row in
                     json.loads((HERE / 'sim21_cases.json').read_text())['cases']}

    def test_sim21_g3_explicit_beds_ignore_derived_group_tag(self):
        case = self.sim21['sim21-g3-becker-explicit-beds']
        script = r"""
const c=JSON.parse(process.argv[1]);
const {computeWolfhouseOfferFingerprint}=require('./scripts/lib/luna-front-desk-accommodation-availability-service');
const base={v:1,client_slug:'wolfhouse-somo',check_in:c.check_in,check_out:c.check_out,
 guest_count:c.guest_count,room_type:'shared',room_preference:'male_only',package_code:'package_none',
 payment_choice:'deposit',currency:'EUR',total_cents:c.total_cents,
 deposit_required_cents:c.deposit_required_cents,payment_link_amount_cents:c.deposit_required_cents,
 guest_bed_assignments:c.guests.map((g,i)=>({guest_index:i,guest_name:g.name.toLowerCase(),bed_code:c.selected_bed_codes[i]})),
 room_arrangement:c.selected_bed_codes.map(code=>({bed_code:code,room_code:'R4',gender_strategy:'male preferred'})),
 selected_bed_codes:c.selected_bed_codes,guest_packages:[],add_ons:[],payment_distribution:[],
 per_guest_payment_links:false,availability_checked:true};
const quote={...base,resolved_room_claim:c.quoted_resolved_room_claim};
const create={...base,resolved_room_claim:c.create_resolved_room_claim};
if(computeWolfhouseOfferFingerprint(quote)!==computeWolfhouseOfferFingerprint(create)) process.exit(9);
"""
        subprocess.run(['node', '-e', script, json.dumps(case)], cwd=HERE.parents[1],
                       check=True, capture_output=True, text=True)

    def test_sim21_g4_preserves_women_stock_and_corrected_dates(self):
        import wolfhouse_staff_api as plugin
        case = self.sim21['sim21-g4-emma-women-room']
        result = {'girls_room_available': case['girls_room_available'],
                  'room_options': {'girls_room_available': case['girls_room_available']},
                  'check_in': case['check_in'], 'check_out': case['check_out']}
        decision = {'clarification_needed': True, 'conflict': False,
                    'excluded_room_preferences': ['female_only'],
                    'clarification_prompt': 'Are you eligible for the women-only dorm?'}
        adapted = plugin._suppress_gender_handoff(result, decision)
        self.assertTrue(adapted['girls_room_available'])
        self.assertEqual((adapted['check_in'], adapted['check_out']),
                         (case['check_in'], case['check_out']))
        self.assertEqual(adapted['next_action'], case['expected_next_action'])
        self.assertNotIn('mixed', adapted['reply_draft'].casefold())

    def test_sim21_g5_checks_room_correctness_and_discloses_change(self):
        from wolfhouse import accepted_quote as owner
        case = self.sim21['sim21-g5-raj-room-preference']
        offer = {'room_arrangement': [
            {'bed_code': bed, 'room_code': room, 'gender_strategy': 'flexible'}
            for bed, room in zip(case['allocated_bed_codes'], case['allocated_room_codes'])]}
        notice = owner._requested_room_change_line(
            {'room_preference': case['room_preference']}, offer, 'en')
        self.assertIn('Room 1 is not available', notice)
        self.assertIn('Room 9', notice)

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
