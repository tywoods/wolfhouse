"""Classic one-yes contract: real typed tools, offline Staff transport only.

Localized legacy copy is a scripted model fixture, not a production prose owner.
No successful booking receipt is fabricated: create is captured and refused.
"""
import json
import unittest
from copy import deepcopy
from unittest.mock import patch

from wolfhouse import accepted_quote as owner
from wolfhouse import booking_names, pending_question
from wolfhouse import test_first_yes_owner as fixtures
import wolfhouse_staff_api as plugin


class ClassicOneYesDepositTests(unittest.TestCase):
    def offer(self, *, guests=1, deposit=20000, total=60000, language="en"):
        names = [{"name": name} for name in ("Alex", "Sam", "Robin")[:guests]]
        plan = {
            "check_in": "2026-11-01", "check_out": "2026-11-08",
            "guest_count": guests, "room_type": "shared", "room_preference": "mixed",
            "package_code": "package_none", "guests": names, "language": language,
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
        """One displayed choice -> typed create; no second save question/turn."""
        case = fixtures.FirstYesOwnerTests()
        case.setUp()
        self.addCleanup(case.tearDown)
        plan, offer = self.offer(guests=guests, language=language, deposit=deposit, total=total)
        requests = []

        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **tool): self.tools[tool['name']] = tool
            def register_hook(self, *args, **kwargs): pass

        registry = Registry()
        plugin.register(registry)

        def staff(path, body):
            requests.append((path, deepcopy(body)))
            if path == '/availability-check':
                return case._exact_recheck(body, offer['room_arrangement'])
            if path == '/booking-preview':
                choice = body.get('payment_choice') or ('full' if deposit == total else 'deposit')
                response = case._checked_offer({**body, 'payment_choice': choice},
                    offer['room_arrangement'], quote_overrides={
                        'total_cents': total, 'deposit_required_cents': deposit,
                        'payment_link_amount_cents': deposit if choice == 'deposit' else total})
                response['payment_choice_needed'] = not body.get('payment_choice') and deposit < total
                response['full_payment_only'] = deposit == total
                return response
            self.assertEqual(path, '/booking-create-from-plan')
            return {'success': False, 'write_performed': False, 'error': 'offline_capture'}

        def call(name, args):
            token = booking_names._agent.set(case.agent)
            try:
                booking_names.begin_turn(session_id=case.agent.session_id,
                                         scope=plugin._booking_name_scope())
                return json.loads(registry.tools[name]['handler'](args))
            finally:
                booking_names.end_turn()
                booking_names._agent.reset(token)

        save = owner._style_copy(language)['save_group' if language == 'de' and guests > 1 else 'save']
        with patch.object(plugin, '_post_bot', side_effect=staff), \
                patch.object(owner, 'interpret_owner_turn', side_effect=AssertionError('No interpreter')) as diagnostic:
            if guests > 1:
                self.assertEqual(pending_question.rendered_options(plan, offer, language, False),
                                 ['together', 'separate'])
                plan['payment_link_distribution'] = distribution
            result = call('quote_booking', plan)
            self.assertTrue(result['success'], result)
            self.assertEqual(bool(result['payment_choice_needed']), deposit < total)
            self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in requests))
            shown = fixtures.offline_quote_result({'completed': True, 'final_response': 'scripted quote'})
            self.assertTrue(shown.get('completed'), shown)
            presentation = case.owner_state()['presentation']
            self.assertIsNotNone(presentation)
            self.assertEqual(presentation['payment_choices'],
                             (['deposit', 'per_guest', 'full'] if guests > 1 else ['deposit', 'full'])
                             if deposit < total else ['full'])
            text = shown['final_response']
            self.assertEqual(text.count(save), 0 if deposit < total else 1)
            case.turn('selected-payment', 'モデルが表示済みの選択肢を選択')
            start = len(requests)
            selected = payment if deposit < total else 'full'
            created = call('create_booking_from_plan', {'payment_choice': selected})
            self.assertFalse(created['success'], created)
            self.assertFalse(created['write_performed'], created)
            calls = requests[start:]
            writes = [body for path, body in calls if path == '/booking-create-from-plan']
            self.assertEqual(len(writes), 1, created)
            self.assertEqual(sum(path == '/booking-preview' for path, _ in calls), 1)
            self.assertLess([path for path, _ in calls].index('/booking-preview'),
                            [path for path, _ in calls].index('/booking-create-from-plan'))
            body = writes[0]
            self.assertTrue(body['require_offer_identity'])
            self.assertEqual(body['payment_choice'], selected)
            self.assertEqual(body['guests'], plan['guests'])
            self.assertEqual(body['accepted_offer']['total_cents'], total)
            self.assertEqual(body['accepted_offer']['deposit_required_cents'], deposit)
            self.assertEqual(body['accepted_offer']['payment_link_amount_cents'],
                             deposit if selected == 'deposit' else total)
            self.assertEqual(body['selected_bed_codes'], [row['bed_code'] for row in offer['room_arrangement']])
            if distribution:
                self.assertEqual(body['payment_link_distribution'], distribution)
                self.assertIs(body['per_guest_payment_links'], distribution == 'separate')
            self.assertFalse(case.owner_state().get('receipt'))
            diagnostic.assert_not_called()
        return body, text

    def test_solo_english_gets_deposit_full_then_one_create(self):
        body, text = self.complete_flow()
        self.assertEqual(body['payment_choice'], 'deposit')
        self.assertIn('€200 deposit', text)
        self.assertIn('full €600', text)
        self.assertNotIn('Shall I save this booking?', text)

    def test_group_separate_spanish_gets_deposit_full_then_one_create(self):
        body, text = self.complete_flow(guests=3, language='es', distribution='separate',
                                        payment='full', deposit=30000, total=36000)
        self.assertEqual(body['payment_choice'], 'full')
        self.assertNotIn('¿Guardo esta reserva?', text)

    def test_group_together_italian_gets_deposit_full_then_one_create(self):
        body, text = self.complete_flow(guests=2, language='it', distribution='together')
        self.assertEqual(body['payment_choice'], 'deposit')
        self.assertNotIn('Salvo questa prenotazione?', text)

    def test_german_group_uses_displayed_payment_choice_without_second_save(self):
        body, text = self.complete_flow(guests=2, language='de', distribution='together')
        self.assertEqual(body['payment_link_distribution'], 'together')
        self.assertNotIn('Soll ich eure Buchung speichern?', text)

    def test_short_stay_deposit_equals_total_has_one_save_and_no_amount_question(self):
        plan, offer = self.offer(deposit=60000, total=60000)
        self.assertFalse(pending_question.requires_payment_amount_choice(plan, offer))
        self.assertEqual(pending_question.quote_question_kind(plan, offer, 'en', False), 'go_ahead')
        body, text = self.complete_flow(deposit=60000, total=60000)
        self.assertEqual(body['payment_choice'], 'full')
        self.assertNotIn('Which would you like?', text)
        self.assertEqual(text.count('Shall I save this booking?'), 1)

    def test_distribution_alone_never_satisfies_amount_choice(self):
        plan, offer = self.offer(guests=3, language='es', deposit=30000, total=36000)
        # Legacy read compatibility remains distinct from the typed tool input.
        plan.update(payment_distribution='separate', per_guest_payment_links=True)
        self.assertTrue(pending_question.requires_payment_amount_choice(plan, offer))
        # Deposit vs full is after save, never a pre-save quote question.
        self.assertEqual(pending_question.quote_question_kind(plan, offer, 'es', False), 'go_ahead')
        self.assertIsNone(pending_question.rendered_options(plan, offer, 'es', False))


if __name__ == '__main__':
    unittest.main()
