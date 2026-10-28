import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "docker/hermes-staging"), str(ROOT / "docker/hermes-staging/plugins")]

from wolfhouse import accepted_quote, output_guard, pending_question
import wolfhouse_staff_api as plugin


class ShuttleAndPaymentWordingTests(unittest.TestCase):
    def test_short_acknowledgement_keeps_established_spanish(self):
        history = [
            {"role": "user", "content": "Hola, quiero reservar para dos personas."},
            {"role": "assistant", "content": "¿Necesitáis el traslado desde el aeropuerto?"},
            {"role": "user", "content": "no thx"},
        ]
        self.assertEqual(output_guard._guest_lang_from_history(history), "es")

    def test_language_mismatch_remains_advisory_and_preserves_answer(self):
        original = "No problem—no airport transfer. Would you like just the room?"
        text, findings = output_guard.guard_reply(original, guest_lang="es")
        self.assertEqual(text, original)
        self.assertTrue(any(row["kind"] == "language_mismatch" and row["severity"] == "warn"
                            for row in findings))

    def test_package_requires_proactive_shuttle_offer(self):
        with patch.object(accepted_quote, "_transaction", return_value={
            "plan": {"package_code": "malibu"}, "language": "es",
        }):
            context = accepted_quote.shuttle_offer_context()
        self.assertTrue(context["shuttle_offer_required"])
        self.assertEqual(context["guest_language"], "es")

    def test_flight_details_do_not_count_as_shuttle_decision(self):
        with patch.object(accepted_quote, "_transaction", return_value={
            "plan": {
                "package_code": "malibu",
                "pending_transfers": [{"direction": "arrival", "time": "14:00"}],
            },
            "language": "en",
        }):
            self.assertIsNotNone(accepted_quote.shuttle_offer_context())

    def test_explicit_shuttle_decision_suppresses_repeat_offer(self):
        for decision in ("accepted", "declined"):
            with self.subTest(decision=decision), patch.object(
                accepted_quote, "_transaction", return_value={
                    "plan": {"package_code": "malibu", "shuttle_choice": decision},
                    "language": "en",
                },
            ):
                self.assertIsNone(accepted_quote.shuttle_offer_context())

    def test_accommodation_only_does_not_offer_shuttle(self):
        with patch.object(accepted_quote, "_transaction", return_value={
            "plan": {"package_code": "package_none"}, "language": "en",
        }):
            self.assertIsNone(accepted_quote.shuttle_offer_context())

    def test_guest_payment_status_returns_person_scoped_copy(self):
        with patch.object(plugin, "_post_bot", return_value={
            "success": True,
            "payment_status": "paid",
            "booking_code": "WH-GROUP",
            "booking_guest_id": "guest-1",
            "guest_name": "Mike",
            "deposit_amount_cents": 10000,
            "amount_paid_cents": 10000,
            "balance_due_cents": 2000,
        }):
            result = json.loads(plugin.get_guest_payment_status({"booking_guest_id": "guest-1"}))
        self.assertEqual(result["payment_scope"], "guest")
        self.assertEqual(
            result["guest_safe_payment_summaries"]["en"],
            "€100 received from Mike. €20 remains on Mike's share.",
        )
        self.assertNotIn("group", result["guest_safe_payment_summaries"]["en"].lower())

    def test_guest_payment_status_has_paid_and_owed_amounts_in_every_supported_language(self):
        with patch.object(plugin, "_post_bot", return_value={
            "success": True,
            "payment_status": "paid",
            "booking_code": "WH-GROUP",
            "booking_guest_id": "guest-1",
            "guest_name": "Mike",
            "deposit_amount_cents": 10000,
            "amount_paid_cents": 10000,
            "balance_due_cents": 2000,
        }):
            result = json.loads(plugin.get_guest_payment_status({"booking_guest_id": "guest-1"}))
        self.assertEqual(set(result["guest_safe_payment_summaries"]), {"en", "es", "it", "de", "fr"})
        for language, summary in result["guest_safe_payment_summaries"].items():
            with self.subTest(language=language):
                self.assertIn("€100", summary)
                self.assertIn("€20", summary)

    def test_output_guard_renders_authoritative_guest_payment_amounts_in_german(self):
        calls = [{"name": "get_guest_payment_status", "result": {
            "success": True,
            "payment_confirmed": True,
            "payment_scope": "guest",
            "guest_name": "Mike",
            "amount_paid_cents": 10000,
            "balance_due_cents": 2000,
            "guest_safe_payment_summaries": {
                "de": "Für Mike sind €100 eingegangen. Auf Mikes Anteil sind noch €20 offen."
            },
        }}]
        text, findings = output_guard.guard_reply(
            "Die Zahlung dieses Gastes ist für den eigenen Anteil bestätigt.",
            guest_lang="de", tool_calls=calls,
        )
        self.assertEqual(text, calls[0]["result"]["guest_safe_payment_summaries"]["de"])
        self.assertTrue(any(row["kind"] == "confirmed_guest_payment_receipt" for row in findings))

    def test_partial_guest_payment_does_not_claim_deposit_paid(self):
        with patch.object(plugin, "_post_bot", return_value={
            "success": True,
            "payment_status": "partial",
            "guest_name": "Mike",
            "deposit_amount_cents": 10000,
            "amount_paid_cents": 5000,
            "balance_due_cents": 7000,
        }):
            result = json.loads(plugin.get_guest_payment_status({"booking_guest_id": "guest-1"}))
        self.assertTrue(result["payment_confirmed"])
        self.assertEqual(
            result["guest_safe_payment_summaries"]["en"],
            "€50 received from Mike. €70 remains on Mike's share.",
        )
        self.assertNotIn("deposit is paid", result["guest_safe_payment_summaries"]["en"])

    def test_pending_question_ignores_transfer_details_and_honours_yes_or_no_choice(self):
        offer = {"package_code": "package_malibu"}
        self.assertEqual(
            pending_question.quote_question_kind({"pending_transfers": []}, offer, "en", False),
            "add_on",
        )
        for choice in ("yes", "accepted", "no", "declined"):
            with self.subTest(choice=choice):
                self.assertEqual(
                    pending_question.quote_question_kind({"shuttle_choice": choice}, offer, "en", False),
                    "payment_choice",
                )

    def test_booking_payment_status_has_italian_staff_backed_summary(self):
        with patch.object(plugin, "_post_bot", return_value={
            "success": True,
            "payment_status": "deposit_paid",
            "booking_status": "deposit_paid",
            "amount_paid_cents": 10000,
            "amount_paid_known": True,
            "balance_due_cents": 26000,
            "booking_code": "WH-GROUP",
        }):
            result = json.loads(plugin.get_payment_status({"booking_code": "WH-GROUP"}))
        self.assertEqual(
            result["guest_safe_payment_summaries"]["it"],
            "Pagamento ricevuto: €100. Saldo restante della prenotazione: €260.",
        )
        self.assertFalse(result["staff_review_needed"])

    def test_phantom_italian_handoff_is_blocked_without_receipt(self):
        text, findings = output_guard.guard_reply(
            "Anche la richiesta in sospeso è stata passata al team.",
            guest_lang="it",
            tool_calls=[],
        )
        self.assertNotIn("team", text.casefold())
        self.assertTrue(any(row["kind"] == "unsupported_handoff_claim"
                            and row["severity"] == "block" for row in findings))

    def test_separate_guest_receipt_blocks_group_overclaim_paraphrases(self):
        calls = [{"name": "get_guest_payment_status", "result": {
            "success": True, "payment_confirmed": True, "payment_scope": "guest",
            "guest_name": "Mike", "amount_paid_cents": 10000,
            "balance_due_cents": 2000,
        }}]
        personal_link_calls = (
            [{"name": "create_guest_payment_link", "result": {
                "success": True, "booking_guest_id": "g1",
                "secure_payment_url": "https://example.test/pay/WH/g1",
            }}],
            [{"name": "create_booking_from_plan", "result": {
                "success": True, "guest_payment_links": [{
                    "booking_guest_id": "g1",
                    "guest_payment_url": "https://example.test/pay/WH/g1",
                }],
            }}],
        )
        claims = (
            "Your payment confirms the group booking.",
            "This secures the booking.",
            "Everyone's place is locked in.",
            "The booking is complete.",
            "Your payment covers the entire booking.",
            "Your payment pays for everyone.",
            "Tu pago confirma la reserva del grupo.",
            "Il tuo pagamento conferma la prenotazione del gruppo.",
            "Il tuo pagamento blocca la prenotazione del gruppo.",
            "Deine Zahlung bestätigt die Buchung für die ganze Gruppe.",
        )
        for tool_context in (calls, *personal_link_calls):
            for claim in claims:
                with self.subTest(tool_context=tool_context[0]["name"], claim=claim):
                    text, findings = output_guard.guard_reply(
                        claim, guest_lang="en", tool_calls=tool_context,
                    )
                    self.assertEqual(text, output_guard.GUEST_PAYMENT_FALLBACK["en"])
                    self.assertTrue(any(row["kind"] == "guest_payment_group_overclaim"
                                        for row in findings))

    def test_common_italian_phantom_handoffs_are_blocked(self):
        for claim in (
            "Ho avvisato il team.",
            "Il team ti contatterà.",
            "Ho inoltrato la richiesta al team.",
            "Ho passato la richiesta alla squadra.",
        ):
            with self.subTest(claim=claim):
                text, findings = output_guard.guard_reply(
                    claim, guest_lang="it", tool_calls=[],
                )
                self.assertNotIn("team", text.casefold())
                self.assertTrue(any(row["kind"] == "unsupported_handoff_claim"
                                    for row in findings))


if __name__ == "__main__":
    unittest.main()
