"""End-to-end regression contract for Classic Luna's one-yes deposit flow."""
import unittest

from wolfhouse import accepted_quote as owner
from wolfhouse import pending_question


class ClassicOneYesDepositTests(unittest.TestCase):
    def offer(self, *, guests=1, deposit=20000, total=60000, language="en"):
        names = [{"name": f"Guest {i + 1}"} for i in range(guests)]
        plan = {
            "check_in": "2026-11-01", "check_out": "2026-11-08",
            "guest_count": guests, "room_type": "shared", "package_code": "package_none",
            "guests": names, "language": language,
        }
        offer = {
            **plan, "currency": "EUR", "total_cents": total,
            "deposit_required_cents": deposit,
            "room_arrangement": [{"bed_code": f"M{i+1}", "room_code": "M", "gender_strategy": "mixed"}
                                 for i in range(guests)],
            "guest_bed_assignments": [{"guest_index": i, "guest_name": row["name"], "bed_code": f"M{i+1}"}
                                      for i, row in enumerate(names)],
        }
        return plan, offer

    def complete_flow(self, *, guests=1, language="en", distribution=None,
                      payment="deposit", deposit=20000, total=60000):
        """Drive all choices, assert exactly one localized save/summary lifecycle."""
        plan, offer = self.offer(guests=guests, language=language,
                                 deposit=deposit, total=total)
        save = pending_question.go_ahead_question(language)
        if language == "de" and guests >= 2:
            save = "Soll ich eure Buchung speichern?"
        kind = pending_question.quote_question_kind(plan, offer, language, False)
        options = pending_question.rendered_options(plan, offer, language, False, kind)
        state = {"plan": dict(plan), "pending_question": {"kind": kind}}
        if options:
            state["pending_question"]["options"] = options
        prior = []
        if options == ["together", "separate"]:
            prior.append(owner._styled_quote_copy(state["plan"], offer, language, create_ready=False))
            pending_question.bind_answer(state, "accept" if distribution == "together" else "reject", distribution)
            self.assertEqual(state["pending_question"]["options"], ["deposit", "full"])
            prior.append(owner._styled_quote_copy(state["plan"], offer, language, create_ready=False))
            pending_question.bind_answer(state, "accept" if payment == "deposit" else "reject", payment)
        elif options == ["deposit", "full"]:
            prior.append(owner._styled_quote_copy(state["plan"], offer, language, create_ready=False))
            pending_question.bind_answer(state, "accept" if payment == "deposit" else "reject", payment)
        self.assertEqual(state["pending_question"], {"kind": "go_ahead"})
        self.assertTrue(all(save not in text for text in prior))

        selected = state["plan"].get("payment_choice", "full")
        final_offer = {**offer, "payment_choice": selected,
                       "payment_link_amount_cents": deposit if selected == "deposit" else total}
        final = owner._styled_quote_copy(state["plan"], final_offer, language, create_ready=True)
        self.assertEqual(final.count(save), 1)

        state.pop("pending_question")
        return state, final

    def test_solo_english_gets_deposit_full_then_one_save(self):
        plan, offer = self.offer(deposit=20000, total=60000)
        choice = owner._styled_quote_copy(plan, offer, "en", create_ready=False)
        self.assertIn("€200 deposit", choice)
        self.assertIn("full €600", choice)

        state, final = self.complete_flow()
        self.assertEqual(state["plan"]["payment_choice"], "deposit")
        self.assertEqual(final.count("Shall I save this booking?"), 1)

    def test_group_separate_spanish_gets_deposit_full_then_one_save(self):
        state, final = self.complete_flow(guests=3, language="es", distribution="separate",
                                          payment="full", deposit=30000, total=36000)
        self.assertEqual(state["plan"]["payment_distribution"], "separate")
        self.assertEqual(state["plan"]["payment_choice"], "full")
        self.assertTrue(state["plan"]["per_guest_payment_links"])
        self.assertEqual(final.count("¿Guardo esta reserva?"), 1)

    def test_group_together_italian_gets_deposit_full_then_one_save(self):
        state, final = self.complete_flow(guests=2, language="it", distribution="together")
        self.assertEqual(state["plan"]["payment_distribution"], "together")
        self.assertEqual(state["plan"]["payment_choice"], "deposit")
        self.assertEqual(final.count("Salvo questa prenotazione?"), 1)

    def test_german_group_gets_one_localized_save(self):
        state, final = self.complete_flow(guests=2, language="de", distribution="together")
        self.assertEqual(final.count("Soll ich eure Buchung speichern?"), 1)
        self.assertEqual(state["plan"]["payment_distribution"], "together")

    def test_short_stay_deposit_equals_total_has_no_amount_question(self):
        plan, offer = self.offer(deposit=60000, total=60000)
        self.assertFalse(pending_question.requires_payment_amount_choice(plan, offer))
        self.assertEqual(pending_question.quote_question_kind(plan, offer, "en", False), "go_ahead")
        text = owner._styled_quote_copy(plan, offer, "en", create_ready=False)
        self.assertNotIn("Which would you like?", text)
        self.assertEqual(text.count("Shall I save this booking?"), 1)

    def test_distribution_alone_never_satisfies_amount_choice(self):
        plan, offer = self.offer(guests=3, language="es", deposit=30000, total=36000)
        plan.update(payment_distribution="separate", per_guest_payment_links=True)
        self.assertTrue(pending_question.requires_payment_amount_choice(plan, offer))
        self.assertEqual(pending_question.quote_question_kind(plan, offer, "es", False),
                         "payment_choice")
        self.assertEqual(pending_question.rendered_options(plan, offer, "es", False),
                         ["deposit", "full"])


if __name__ == "__main__":
    unittest.main()
