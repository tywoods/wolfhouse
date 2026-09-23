"""Gina 4–7: offline presentation regressions at the real Luna tool boundary.

No guest sends, DB, Stripe or model calls. _post_bot is the only API fixture seam.
Quote amounts come from the unchanged JS calculator, not a replacement calculator.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(ROOT / "docker/hermes-staging"))
os.environ["LUNA_CLIENT_SLUG"] = "wolfhouse-somo"
import wolfhouse_staff_api as plugin


class GinaWordingTests(unittest.TestCase):
    def setUp(self):
        self.network = patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)

    def test_quote_preserves_complete_shares_and_aggregate_deposit(self):
        quote = json.loads(subprocess.check_output([
            "node", "-e", """
const {calculateWolfhouseQuote} = require('./scripts/lib/wolfhouse-quote-calculator');
console.log(JSON.stringify(calculateWolfhouseQuote({
  client_slug:'wolfhouse-somo', check_in:'2026-09-01', check_out:'2026-09-06',
  guest_count:3, package_code:'package_none', payment_choice:'deposit',
  add_ons:[{code:'hard_board_rental',days:5,quantity:3}]
})));
"""], cwd=ROOT, text=True))
        self.assertEqual(quote["total_cents"], 97500)
        response = {"success": True, "quote_status": "ready", "quote": quote,
                    "included_items": quote["line_items"]}
        with patch.object(plugin, "_post_bot", return_value=response):
            result = json.loads(plugin.quote_booking({
                "check_in": "2026-09-01", "check_out": "2026-09-06", "guest_count": 3,
            }))
        self.assertEqual(result.get("per_person"), quote["per_person"],
                         "Luna must see full subtotal, not only accommodation")
        self.assertEqual(result.get("per_guest_deposits"), quote["per_guest_deposits"])
        self.assertEqual(result["per_person"][0]["accommodation_cents"], 22500)
        self.assertEqual(result["per_person"][0]["subtotal_cents"], 32500)
        self.assertEqual(result["deposit_required_cents"], 30000)
        self.assertEqual(result["remaining_after_deposit_cents"], 67500)
        self.assertEqual(result["balance_due_cents"], 97500, "quote is not money received")
        self.assertIn("all quoted deposits", result["guest_safe_balance_label"])
        self.assertFalse(result["staff_review_needed"])

    def test_create_keeps_amount_beside_each_already_created_guest_link(self):
        guests = [{"booking_guest_id": f"g{n}", "guest_number": n, "guest_name": name}
                  for n, name in enumerate(["Gina", "Jamie", "Tina"], 1)]
        calls = []

        def api(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            if path == "/booking-create-from-plan":
                return {"success": True, "write_performed": True, "booking_code": "GINA-OFFLINE",
                        "uses_per_guest_model": True, "booking_guests": guests,
                        "payment_status": "unpaid"}
            for guest in guests:
                if path == f"/booking-guests/{guest['booking_guest_id']}/create-payment-link":
                    return {"success": True, **guest, "amount_due_cents": 32500, "currency": "EUR",
                            "payment_target": "full_share", "payment_status": "checkout_created",
                            "guest_payment_url": f"https://example.test/pay/GINA-OFFLINE/g{guest['guest_number']}"}
            raise AssertionError(f"unexpected API call {path}")

        with patch.object(plugin, "_post_bot", side_effect=api):
            result = json.loads(plugin.create_booking_from_plan({
                "check_in": "2026-09-01", "check_out": "2026-09-06", "guest_count": 3,
                "guests": [{"name": g["guest_name"]} for g in guests], "group_gender": "mixed",
                "package_code": "package_none", "payment_choice": "full", "confirm": True,
                "selected_bed_codes": ["M1", "M2", "M3"],
            }))
        self.assertEqual(len(calls), 4, "no extra round trips to repeat amounts or mint links")
        self.assertEqual(len(result["guest_payment_links"]), 3)
        for link in result["guest_payment_links"]:
            self.assertEqual(link.get("amount_due_cents"), 32500)
            self.assertEqual(link.get("currency"), "EUR")
            self.assertEqual(link.get("payment_target"), "full_share")
            self.assertEqual(link.get("payment_status"), "checkout_created")
        self.assertIs(result.get("no_payment_truth_recorded"), True)
        self.assertFalse(result["staff_review_needed"])
        self.assertEqual(result["next_action"], "send_per_guest_payment_links")

    def test_link_each_keeps_deposit_amount_separate_from_full_share(self):
        guests = [{"booking_guest_id": f"g{n}", "guest_number": n, "guest_name": name}
                  for n, name in enumerate(["Gina", "Jamie", "Tina"], 1)]
        calls = []

        def api(path, payload):
            calls.append((path, copy.deepcopy(payload)))
            if path == "/booking-create-from-plan":
                self.assertEqual(payload["payment_choice"], "deposit")
                return {"success": True, "write_performed": True, "booking_code": "GINA-OFFLINE",
                        "uses_per_guest_model": True, "booking_guests": guests,
                        "per_person": [{"guest_number": n, "subtotal_cents": 32500} for n in range(1, 4)]}
            self.assertEqual(payload["payment_target"], "deposit")
            return {"success": True, "amount_due_cents": 10000, "currency": "EUR",
                    "payment_target": "deposit", "payment_status": "checkout_created",
                    "guest_payment_url": "https://example.test/pay/" + path.split('/')[2]}

        with patch.object(plugin, "_post_bot", side_effect=api):
            result = json.loads(plugin.create_booking_from_plan({
                "guest_count": 3, "guests": [{"name": g["guest_name"]} for g in guests],
                "group_gender": "mixed", "selected_bed_codes": ["M1", "M2", "M3"],
                "check_in": "2026-09-01", "check_out": "2026-09-06",
                "payment_choice": "link each", "package_code": "package_none", "confirm": True,
            }))
        self.assertEqual(len(calls), 4)
        self.assertEqual(len(result["guest_payment_links"]), 3)
        for link, share in zip(result["guest_payment_links"], result["per_person"]):
            self.assertEqual(link.get("amount_due_cents"), 10000)
            self.assertEqual(link.get("payment_target"), "deposit")
            self.assertEqual(share["subtotal_cents"], 32500)
        self.assertFalse(result["staff_review_needed"])

    def test_create_keeps_single_link_amount_and_pending_state(self):
        responses = {
            "/booking-create-from-plan": {"success": True, "write_performed": True,
                "booking_code": "GINA-OFFLINE", "payment_id": "p1", "payment_status": "unpaid"},
            "/payments/p1/create-stripe-link": {"success": True, "amount_due_cents": 97500,
                "currency": "EUR", "checkout_url": "https://example.test/pay/GINA-OFFLINE",
                "payment_status": "checkout_created"},
        }
        with patch.object(plugin, "_post_bot", side_effect=lambda path, body: responses[path]):
            result = json.loads(plugin.create_booking_from_plan({
                "check_in": "2026-09-01", "check_out": "2026-09-06", "guest_count": 3,
                "guest_name": "Gina", "group_gender": "mixed", "package_code": "package_none",
                "payment_choice": "full", "confirm": True,
            }))
        self.assertEqual(result.get("amount_due_cents"), 97500)
        self.assertEqual(result.get("currency"), "EUR")
        self.assertIs(result.get("no_payment_truth_recorded"), True)
        self.assertEqual(result["next_action"], "send_secure_payment_link")
        self.assertFalse(result["staff_review_needed"])

    def test_status_keeps_real_api_booking_balance_not_just_latest_receipt(self):
        for paid, due in [(10000, 87500), (30000, 67500), (32500, 65000), (97500, 0)]:
            with self.subTest(paid=paid):
                row = {"payment_id": "tina-receipt", "booking_id": "bk-offline",
                       "booking_code": "GINA-OFFLINE", "payment_status": "paid",
                       "booking_payment_status": "paid" if due == 0 else "deposit_paid",
                       "amount_paid_cents": paid, "balance_due_cents": due}
                # Exercise the unchanged route's nested latest_payment contract.
                response = json.loads(subprocess.check_output([
                    "node", "-e", """
const {handleBotPaymentStatus} = require('./scripts/lib/staff-bot-v2-routes');
const row = JSON.parse(process.argv[1]);
handleBotPaymentStatus({}, {}, {}, 'bot', {
  DEFAULT_CLIENT:'wolfhouse-somo', readBody:async()=>JSON.stringify({booking_code:row.booking_code}),
  withPgClient:async fn=>fn({query:async()=>({rows:[row]})}),
  sendJSON:(_, code, body)=>{if(code!==200) throw Error('status'); console.log(JSON.stringify(body));}
}).catch(e=>{console.error(e);process.exit(1)});
""", json.dumps(row)], cwd=ROOT, text=True))
                with patch.object(plugin, "_post_bot", return_value=response):
                    result = json.loads(plugin.get_payment_status({"booking_code": "GINA-OFFLINE"}))
                self.assertEqual(result["amount_paid_cents"], paid)
                self.assertEqual(result["balance_due_cents"], due, "do not drop nested booking balance")
                self.assertEqual(result["booking_code"], "GINA-OFFLINE")
                self.assertIs(result.get("booking_fully_paid"), due == 0)
                self.assertEqual(result.get("payment_scope"), "booking")
                self.assertFalse(result["staff_review_needed"])

    def test_status_unknown_failed_and_zero_are_not_replaced_by_latest_receipt(self):
        cases = [
            ({"success": True, "amount_paid_cents": 0, "balance_due_cents": 97500,
              "latest_payment": {"status": "checkout_created", "amount_paid_cents": 32500}}, 0, False),
            ({"success": True, "payment_status": "paid"}, None, False),
            ({"success": False, "payment_status": "paid", "balance_due_cents": 0}, None, False),
        ]
        for data, paid, fully in cases:
            with self.subTest(data=data), patch.object(plugin, "_post_bot", return_value=data):
                result = json.loads(plugin.get_payment_status({"booking_code": "GINA-OFFLINE"}))
                self.assertEqual(result["amount_paid_cents"], paid)
                self.assertIs(result.get("booking_fully_paid"), fully)

    def test_pending_checkout_is_not_a_receipt_and_partial_booking_is_not_paid_in_full(self):
        for status, paid, balance, booking_status in [
            ("checkout_created", 0, 97500, "unpaid"),
            ("paid", 32500, 65000, "deposit_paid"),
            ("checkout_created", 32500, 65000, "deposit_paid"),
            ("fully_paid", 32500, 65000, "fully_paid"),
        ]:
            with self.subTest(status=status, paid=paid):
                data = {"success": True, "payment_truth_known": True,
                        "latest_payment": {"payment_status": status,
                            "booking_payment_status": booking_status,
                            "amount_paid_cents": paid, "balance_due_cents": balance}}
                with patch.object(plugin, "_post_bot", return_value=data):
                    result = json.loads(plugin.get_payment_status({"booking_code": "GINA-OFFLINE"}))
                self.assertFalse(result["booking_fully_paid"])
                self.assertEqual(result["amount_paid_cents"], paid)
                self.assertIs(result["payment_confirmed"], paid > 0)

    def test_balance_handoff_keeps_amount_and_does_not_escalate(self):
        data = {"success": True, "booking_code": "GINA-OFFLINE", "amount_due_cents": 65000,
                "balance_due_cents": 65000, "currency": "EUR",
                "checkout_url": "https://example.test/pay/GINA-OFFLINE"}
        with patch.object(plugin, "_post_bot", return_value=data) as api:
            result = json.loads(plugin.create_balance_payment_link({"booking_code": "GINA-OFFLINE"}))
        self.assertEqual(api.call_count, 1)
        self.assertEqual(result["amount_due_cents"], 65000)
        self.assertEqual(result["secure_payment_url"], data["checkout_url"])
        self.assertFalse(result["staff_review_needed"])
        self.assertEqual(result["next_action"], "send_secure_payment_link")
        self.assertNotIn("payment_confirmed", result)

    def test_payment_wording_rules_survive_conversationalist_injection(self):
        from wolfhouse.luna_personality import get_personality_pack, inject_personality_pack_once
        soul = (ROOT / "docker/hermes-staging/SOUL.md").read_text()
        combined = inject_personality_pack_once(soul, get_personality_pack("conversationalist"))
        self.assertTrue(combined["injected"])
        prompt = combined["system_prompt"]
        for rule in ("Minimum vs combined deposits", "Complete share", "Receipt vs booking",
                     "Link handoff", "No wording-only handoff", "payment is still pending",
                     "pago sigue pendiente", "per_person[].subtotal_cents", "booking_fully_paid",
                     "reuse the returned links", "Do not re-ask known details"):
            with self.subTest(rule=rule):
                self.assertTrue(rule in prompt, f"missing payment wording rule: {rule}")
        self.assertFalse("After each step, send ONE message and wait" in prompt,
                         "blanket per-step waiting creates unnecessary chat turns")
        self.assertIn("Never change facts, prices", prompt)
        self.assertIn("one €100 deposit locks the booking in", prompt)
        self.assertIn("one €200 deposit locks the booking in", prompt)


if __name__ == "__main__":
    unittest.main(verbosity=2)
