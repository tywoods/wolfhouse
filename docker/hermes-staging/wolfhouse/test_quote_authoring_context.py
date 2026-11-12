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

    def test_short_followup_does_not_have_to_repeat_quote_total(self):
        facts = self.facts(payment_choice='full', per_guest_payment_links=True)
        for text in (
            'Absolutely—you can each have a separate link for your full share! 🌊\n'
            'Would you like the Santander shuttle included with your package?',
            'Claro, un enlace por persona para pagar el total. ¿Necesitáis traslado?',
            'Would you like the shuttle?',
        ):
            with self.subTest(text=text):
                self.assertEqual(owner._quote_reject_reasons(text, facts), [])
        self.assertEqual(owner._quote_reject_reasons('Your share is €481.', facts),
                         ['unknown_amount:48100'])
        self.assertTrue(owner._quote_reject_reasons('', facts))

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
        confirmation_guide = Path(__file__).parents[1] / 'soul-guides' / '06-confirmation.md'
        self.assertIn(confirmation_guide.read_text().strip(), confirmation[0]['content'])
        self.assertNotIn(confirmation_guide.read_text().strip(), quote[0]['content'])
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

    def test_repair_can_continue_without_reopening_early_full_separate_choice(self):
        before = self.facts(payment_choice='full', per_guest_payment_links=True)
        self.assertEqual(before['next_decision']['subject'], 'shuttle')
        self.assertEqual(before['next_decision']['selected_payment_amount'], 'full')
        after = self.facts(payment_choice='full', per_guest_payment_links=True,
                           shuttle_choice='declined')
        self.assertNotIn(after['next_decision']['subject'],
                         ('shuttle', 'payment_amount', 'payment_distribution'))
        payload = json.loads(owner._quote_rewrite_messages(before, 'Wrong €999', [])[-1]['content'])
        instructions = payload['instructions']
        self.assertNotIn('Write the complete guest-facing quote card', instructions)
        for rule in ('short nudge', 'first or materially revised', 'already selected'):
            self.assertIn(rule, instructions)

    def test_prior_sent_map_is_optional_but_not_replaceable(self):
        facts = {'reference': 'WH-20270314-12345678', 'payment_links': ['https://pay.invalid/one'],
                 'total_cents': 49800, 'amount_due_now_cents': 49800,
                 'amount_due_cents': 49800, 'location_url': 'https://maps.invalid/house',
                 'location_already_sent': True}
        text = 'WH-20270314-12345678 Total €498, due €498. https://pay.invalid/one'
        self.assertEqual(owner._confirmation_reject_reasons(text, facts), [])
        self.assertEqual(owner._confirmation_reject_reasons(
            text + ' https://maps.invalid/house', facts), [])
        self.assertTrue(owner._confirmation_reject_reasons(
            text + ' https://maps.invalid/other', facts))
        for evidence in (False, None, 'true'):
            with self.subTest(evidence=evidence):
                self.assertIn('missing_location', owner._confirmation_reject_reasons(
                    text, {**facts, 'location_already_sent': evidence}))

    def test_staff_context_requires_bound_ingress_and_exact_response_scope(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        from wolfhouse.test_accepted_quote import OwnerHostileTests
        fixture = OwnerHostileTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        fixture.turn('wamid.context', 'Can we each pay in full?',
                     chat_id='34000000001', user_id='34000000001')
        calls = []
        def staff(path, body):
            calls.append((path, body))
            return {'success': True, 'client_slug': body['client_slug'],
                    'phone': body['phone'], 'inbound_message_id': body['inbound_message_id'],
                    'previous_sent_replies': ['Prior question'], 'location_already_sent': True,
                    'location_history_status': 'already_sent'}
        with patch.dict('sys.modules', {'wolfhouse_staff_api': SimpleNamespace(_post_bot=staff)}):
            got = owner._staff_sent_reply_context()
        self.assertEqual(got['previous_sent_replies'], ['Prior question'])
        self.assertIs(got['location_already_sent'], True)
        self.assertEqual(calls[0][0], '/staff/bot/bookings/confirmation-preview')
        self.assertIs(calls[0][1]['authoring_context_only'], True)
        self.assertEqual(calls[0][1]['inbound_message_id'], 'wamid.context')
        for bad in ({'success': False}, {'success': True, 'phone': 'other'},
                    {'success': True, 'client_slug': 'sunset'}):
            with patch.dict('sys.modules', {'wolfhouse_staff_api': SimpleNamespace(_post_bot=lambda *args: bad)}):
                self.assertIs(owner._staff_sent_reply_context()['location_already_sent'], False)
        owner.close_turn()
        with patch.dict('sys.modules', {'wolfhouse_staff_api': SimpleNamespace(_post_bot=staff)}):
            self.assertEqual(owner._staff_sent_reply_context()['previous_sent_replies'], [])
        self.assertEqual(len(calls), 1, 'unbound scope cannot perform a lookup')

    def test_normal_model_hook_carries_same_trusted_conversation_context(self):
        from unittest.mock import patch
        import wolfhouse_staff_api as plugin
        context = {'previous_sent_replies': ['Already offered shuttle'],
                   'location_already_sent': True, 'location_history_status': 'already_sent'}
        with patch.object(owner, '_staff_sent_reply_context', return_value=context), \
             patch.object(owner, '_transaction', return_value=None), \
             patch.object(owner, 'shuttle_offer_context', return_value=None):
            result = plugin._pending_question_model_context()
        self.assertEqual(result['sent_reply_context'], context)
        self.assertIn('Already offered shuttle', result['context'])
        self.assertIn('not booking, consent or price authority', result['context'])


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
    def test_location_history_controls_original_and_repaired_confirmation(self):
        from unittest.mock import patch
        from copy import deepcopy
        from wolfhouse.test_quote_polish import QuotePolishTests
        fixture = QuotePolishTests()
        fixture.setUp()
        link, location = 'https://pay.invalid/one', 'https://maps.example/canonical'
        prose = f'WH-LOCATION €300 €100 €200 {link}'
        receipt = {'success': True, 'tool': 'create_booking_from_plan',
                   'booking_code': 'WH-LOCATION', 'secure_payment_url': link,
                   'amount_due_cents': 10000}
        for sent, included, resend in ((True, False, False), (True, True, False),
                                      (True, True, True), (False, False, False), (False, True, False)):
            with self.subTest(sent=sent, included=included, resend=resend):
                state = {'status': 'completed', 'plan': deepcopy(fixture.plan),
                         'checked_offer': deepcopy(fixture.offer), 'completion': deepcopy(receipt)}
                draft = prose + (' ' + location if included else '')
                result = {'completed': True, 'final_response': draft, 'messages': [
                    {'role': 'user', 'content': 'Please resend the map' if resend else 'Save that'},
                    {'role': 'tool', 'content': json.dumps(receipt)},
                    {'role': 'assistant', 'content': draft}]}
                calls = []
                def rewrite(facts, _draft):
                    calls.append(facts)
                    return prose + (' ' + location if not sent or resend else '')
                context = {'previous_sent_replies': ['Prior reply'],
                           'location_already_sent': sent, 'location_history_status': 'test'}
                with patch.object(owner, '_transaction', side_effect=lambda fn: fn(state, {'MESSAGE_ID': 'test'})), \
                     patch.object(owner, '_saved_property_location_url', return_value=location), \
                     patch.object(owner, '_staff_sent_reply_context', return_value=context):
                    output = owner.finalize_offer_response(result, rewrite_callback=rewrite)
                expected = prose + (' ' + location if not sent or resend else '')
                self.assertEqual(output['final_response'], expected)
                self.assertEqual(len(calls), int(sent == included))
                if calls:
                    self.assertIs(calls[0]['location_already_sent'], sent)
                    self.assertEqual(calls[0]['rewrite_context']['previous_sent_replies'], ['Prior reply'])

    def test_short_full_separate_reply_survives_finalization_and_shuttle_decline(self):
        from wolfhouse.test_accepted_quote import OwnerHostileTests
        from unittest.mock import Mock
        fixture = OwnerHostileTests()
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        fixture.turn('full-separate', 'Can we each pay our full share?')
        plan = {**fixture.plan, 'package_code': 'package_surf_week',
                'payment_choice': 'full', 'per_guest_payment_links': True}
        response = fixture.checked(plan)
        owner.record_quote(plan, response)
        text = 'Absolutely, a link each for your full share! Would you like the shuttle?'
        rewrite = Mock(side_effect=AssertionError('brief truthful reply must not be rewritten'))
        result = owner.finalize_offer_response(
            {'completed': True, 'final_response': text, 'messages': [
                {'role': 'user', 'content': 'Can we each pay our full share?'},
                {'role': 'assistant', 'content': text}]}, quote_rewrite_callback=rewrite)
        self.assertEqual(result['final_response'], text)
        rewrite.assert_not_called()
        fixture.turn('no-shuttle', 'No shuttle')
        prepared = owner.prepare_quote({'shuttle_choice': 'declined'})
        self.assertEqual(prepared['payment_choice'], 'full')
        self.assertIs(prepared['per_guest_payment_links'], True)
        response = fixture.checked(prepared)
        owner.record_quote(prepared, response)
        state = owner._transaction(lambda state, ingress: deepcopy(state))
        facts = owner._quote_authoring_facts(owner._presentation_plan(state),
                                            response['offer_revision'])
        self.assertNotIn(facts['next_decision']['subject'],
                         ('shuttle', 'payment_amount', 'payment_distribution'))

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
        original = 'Untrusted amount €999999'
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
