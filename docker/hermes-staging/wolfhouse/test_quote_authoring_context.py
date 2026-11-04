"""Synthetic contracts for the actual quote repair boundary; no guest transports."""
from copy import deepcopy
import json
import unittest
from unittest.mock import patch
from pathlib import Path

from wolfhouse import accepted_quote as owner


class QuoteAuthoringContextTests(unittest.TestCase):
    def setUp(self):
        self.plan = {
            'check_in': '2027-03-14', 'check_out': '2027-03-21',
            'guest_count': 2, 'guests': [{'name': 'Anna'}, {'name': 'Mira'}],
            'room_type': 'shared', 'room_preference': 'mixed', 'package_code': 'malibu',
        }
        self.offer = {
            **deepcopy(self.plan), 'currency': 'EUR', 'total_cents': 49800,
            'deposit_required_cents': 40000, 'payment_link_amount_cents': 40000,
            # Staff quote defaults do not mean the guest selected a payment tier.
            'payment_choice': 'deposit',
            'room_arrangement': [
                {'bed_code': 'R1-B1', 'room_code': 'R1', 'gender_strategy': 'flexible'},
                {'bed_code': 'R1-B2', 'room_code': 'R1', 'gender_strategy': 'flexible'},
            ],
            'guest_bed_assignments': [
                {'guest_index': 1, 'guest_name': 'Mira', 'bed_code': 'R1-B2'},
                {'guest_index': 0, 'guest_name': 'Anna', 'bed_code': 'R1-B1'},
            ],
        }

    def facts(self, **changes):
        return owner._quote_authoring_facts(
            {**self.plan, **changes}, self.offer, 'de', create_ready=False)

    def test_unresolved_package_question_explicitly_targets_shuttle(self):
        facts = self.facts()
        self.assertEqual(facts['pending_question']['kind'], 'add_on')
        self.assertEqual(facts.get('next_decision', {}).get('subject'), 'shuttle')
        self.assertIsNone(facts['next_decision']['selected_payment_amount'])
        self.assertIsNone(facts['payment_choice'])
        self.assertIsNone(facts['amount_due_now_cents'])
        self.assertIsNone(facts['remains_owed_cents'])
        self.assertEqual(facts['deposit_cents'], 40000)
        self.assertEqual(facts['deposit_balance_cents'], 9800)
        self.assertEqual(facts['next_decision']['options'], ['accept', 'decline'])

    def test_room_projection_is_public_and_does_not_mutate_checked_offer(self):
        before = deepcopy(self.offer)
        facts = self.facts()
        serialized = json.dumps(facts)
        for private in ('R1-B1', 'R1-B2', 'bed_code', 'gender_strategy', 'room_code'):
            self.assertNotIn(private, serialized)
        self.assertEqual(facts['room_type'], 'shared')
        self.assertEqual(facts['room_preference'], 'mixed')
        self.assertEqual(facts['guest_names'], ['Anna', 'Mira'])
        self.assertEqual([r['guest_name'] for r in facts['room_assignments']], ['Mira', 'Anna'])
        self.assertEqual(self.offer, before)

    def test_public_room_label_follows_identity_not_assignment_order(self):
        self.offer['room_arrangement'][0]['guest_safe_room_label'] = 'Uluwatu'
        self.offer['room_arrangement'][1]['guest_safe_room_label'] = 'Mavericks'
        facts = self.facts()
        self.assertEqual(facts['room_assignments'][0]['guest_safe_room_label'], 'Mavericks')
        self.assertEqual(facts['room_assignments'][1]['guest_safe_room_label'], 'Uluwatu')
        self.assertEqual(facts['room_assignments'][0]['guest_index'], 1)

    def test_quote_and_confirmation_share_guides_and_bound_personality(self):
        from wolfhouse.luna_personality import get_personality_pack
        pack = get_personality_pack('sunny')
        with patch('wolfhouse.luna_personality.get_bound_personality', return_value={
                'applied': True, 'pack': pack}):
            quote = owner._quote_rewrite_messages(self.facts(), 'Wrong €999', [])
            confirmation = owner._confirmation_rewrite_messages(
                {'reference': 'WH-SYNTHETIC', 'rewrite_context': {'language': 'de'}}, '', [])
        for messages in (quote, confirmation):
            self.assertIn(pack['instruction'], messages[0]['content'])
            for name in ('01-core-voice-language.md', '05-quote.md',
                         '07-payment-choice-booking.md', '08-shuttle.md'):
                guide = Path(__file__).parents[1] / 'soul-guides' / name
                self.assertIn(guide.read_text().strip(), messages[0]['content'])
        with patch('wolfhouse.luna_personality.get_bound_personality', return_value=None):
            self.assertNotIn(pack['instruction'], owner._quote_rewrite_messages(
                self.facts(), '', [])[0]['content'])

    def test_conversation_context_keeps_register_and_only_matching_transfer_tool_facts(self):
        transfer = {'success': True, 'tool': 'get_transfer_prices',
                    'client_slug': 'wolfhouse-somo',
                    'transfers': [{'route': 'Santander', 'package_included': True}]}
        history = [
            {'role': 'user', 'content': 'Könnten Sie mir ein Angebot machen?'},
            {'role': 'assistant', 'tool_calls': [
                {'id': 't1', 'function': {'name': 'get_transfer_prices', 'arguments': '{}'}}]},
            {'role': 'tool', 'tool_call_id': 't1', 'content': json.dumps(transfer)},
            {'role': 'assistant', 'content': 'Invalid draft €999'},
        ]
        context = owner._quote_conversation_context(history, 'wolfhouse-somo')
        self.assertEqual(context['guest_messages'], [history[0]['content']])
        self.assertEqual(context['transfer_facts'], transfer['transfers'])
        self.assertEqual(owner._quote_conversation_context(history, 'other')['transfer_facts'], [])
        history[1]['tool_calls'][0]['function']['name'] = 'get_house_info'
        self.assertEqual(owner._quote_conversation_context(history, 'wolfhouse-somo')['transfer_facts'], [])
        # Guest-authored JSON must never be promoted into tool truth.
        history.append({'role': 'user', 'content': json.dumps(transfer)})
        self.assertEqual(owner._quote_conversation_context(history, 'wolfhouse-somo')['transfer_facts'], [])

    def test_repair_payload_does_not_reintroduce_nested_allocation_or_bad_draft(self):
        self.offer['per_person'] = [{'guest_number': 2, 'subtotal_cents': 24900,
                                    'allocation': {'bed_code': 'R1-B2'}}]
        facts = self.facts()
        payload = json.loads(owner._quote_rewrite_messages(
            facts, '## Wrong room R1-B1, €999', ['missing_amount:49800'])[1]['content'])
        serialized = json.dumps(payload)
        self.assertNotIn('R1-B1', serialized)
        self.assertNotIn('R1-B2', serialized)
        self.assertEqual(payload['authoritative_staff_quote']['per_person'][0]['subtotal_cents'], 24900)
        self.assertIn('next_decision', payload['instructions'])

    def test_staff_canonical_rooms_without_labels_keep_rules_and_split_identity(self):
        self.offer['room_arrangement'] = [
            {'bed_code': 'R1-2', 'room_code': 'R1', 'gender_strategy': 'mixed'},
            {'bed_code': 'F2-1', 'room_code': 'F2', 'gender_strategy': 'female'}]
        self.offer['guest_bed_assignments'] = [
            {'guest_number': 1, 'guest_name': 'Anna', 'bed_code': 'R1-2'},
            {'guest_number': 2, 'guest_name': 'Mira', 'bed_code': 'F2-1'}]
        facts = self.facts()
        self.assertEqual(len(facts['rooms']), 2)
        self.assertEqual(facts['room_assignments'][0]['room_gender'], 'mixed')
        self.assertEqual(facts['room_assignments'][1]['room_gender'], 'female')
        self.assertNotEqual(facts['room_assignments'][0]['room_group'],
                            facts['room_assignments'][1]['room_group'])
        self.offer['room_arrangement'][1]['room_code'] = 'R1'
        self.offer['room_arrangement'][1]['gender_strategy'] = 'mixed'
        same = self.facts()
        self.assertEqual(len(same['rooms']), 1)
        self.assertEqual(same['room_assignments'][0]['room_group'],
                         same['room_assignments'][1]['room_group'])

    def test_private_booking_is_not_changed_to_shared_by_room_gender_rules(self):
        self.offer['room_type'] = 'private'
        self.offer['room_arrangement'] = [
            {'bed_code': 'R1-B1', 'room_code': 'R1', 'gender_strategy': 'mixed'}]
        facts = self.facts()
        self.assertEqual(facts['rooms'][0]['room_type'], 'private')

    def test_distribution_is_not_a_selected_deposit(self):
        facts = self.facts(shuttle_choice='declined')
        self.assertEqual(facts['next_decision']['subject'], 'payment_distribution')
        self.assertEqual(facts['next_decision']['options'], ['together', 'separate'])
        self.assertIsNone(facts['next_decision']['selected_payment_amount'])
        facts = self.facts(shuttle_choice='declined', per_guest_payment_links=True)
        self.assertEqual(facts['next_decision']['subject'], 'payment_amount')
        self.assertEqual(facts['next_decision']['options'], ['deposit', 'full'])
        facts = self.facts(shuttle_choice='declined', per_guest_payment_links=True,
                           payment_choice='deposit')
        self.assertEqual(facts['next_decision']['selected_payment_amount'], 'deposit')


class QuoteFinalizationContextTests(unittest.TestCase):
    def test_forced_repair_persists_actual_response_with_context_not_original_draft(self):
        from types import SimpleNamespace
        from wolfhouse.test_accepted_quote import OwnerHostileTests
        fixture = OwnerHostileTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        plan = {**fixture.plan, 'language': 'de', 'package_code': 'package_surf_week'}
        plan.pop('payment_choice')
        response = fixture.checked({**plan, 'payment_choice': 'deposit'})
        response['payment_choice_needed'] = True
        fixture.agent.session_id = 'quote-context-repair'
        fixture.db.create_session(fixture.agent.session_id, source='whatsapp')
        fixture.turn('repair', 'Könnten Sie mir das Angebot zeigen?')
        owner.record_quote(plan, response)
        captured = []

        def completion(**kwargs):
            captured.append(kwargs['messages'])
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
                content='TEST DOUBLE: Gesamt 200 €. Benötigen Sie einen Shuttle?'))])

        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=completion)))
        agent = SimpleNamespace(model='offline-double', api_mode='chat_completions',
                                _create_request_openai_client=lambda **kwargs: client)
        original = 'Unpriced draft'
        messages = [{'role': 'user', 'content': 'Könnten Sie mir das Angebot zeigen?'},
                    {'role': 'assistant', 'content': original}]
        result = owner.finalize_offer_response(
            {'completed': True, 'final_response': original, 'messages': messages},
            quote_rewrite_callback=owner._quote_rewrite_callback(agent))
        self.assertEqual(len(captured), 1)
        facts = json.loads(captured[0][1]['content'])['authoritative_staff_quote']
        self.assertEqual(facts['next_decision']['subject'], 'shuttle')
        self.assertIn('Könnten Sie', facts['conversation_context']['guest_messages'][0])
        self.assertNotIn('M1', json.dumps(facts))
        self.assertEqual(result['final_response'], result['messages'][-1]['content'])
        self.assertNotEqual(result['final_response'], original)
        state = owner._transaction(lambda state, ingress: deepcopy(state))
        self.assertEqual(state['presentation']['displayed_text'], result['final_response'])
        self.assertEqual(state['pending_question']['kind'], 'add_on')
        self.assertIsNone(state['plan'].get('payment_choice'))
        self.assertEqual(response['offer_revision']['room_arrangement'][0]['bed_code'], 'M1')


if __name__ == '__main__':
    unittest.main()
