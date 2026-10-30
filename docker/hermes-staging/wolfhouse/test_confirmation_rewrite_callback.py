"""Focused contract tests for the saved-booking confirmation rewrite boundary."""
import json
from copy import deepcopy
from types import SimpleNamespace
from threading import RLock
import unittest
from unittest.mock import Mock, patch

from wolfhouse import accepted_quote


FACTS = {
    'reference': 'WH-1644', 'guest_names': ['Anna Smith'],
    'check_in': '2026-11-01', 'check_out': '2026-11-05',
    'room': ['M1'], 'total_cents': 50000, 'deposit_cents': 10000,
    'payment_links': ['https://pay.invalid/WH-1644'],
    'rewrite_context': {'language': 'en'},
}
VALID = ('Gebucht WH-1644 für Anna Smith, 2026-11-01 bis 2026-11-05, '
         'Zimmer M1, Gesamt 500.00 EUR, Anzahlung 100.00 EUR. '
         'https://pay.invalid/WH-1644')


class RewriteTransportTests(unittest.TestCase):
    def _agent(self, mode, result=None, error=None):
        create = Mock(side_effect=error) if error else Mock(return_value=result)
        if mode == 'codex_responses':
            client = SimpleNamespace(responses=SimpleNamespace(create=create))
        else:
            client = SimpleNamespace(chat=SimpleNamespace(
                completions=SimpleNamespace(create=create)))
        agent = SimpleNamespace(
            api_mode=mode, model='offline-model',
            _create_request_openai_client=Mock(return_value=client),
            _close_request_openai_client=Mock(),
        )
        return agent, client, create

    def _assert_request(self, agent, client, create, mode):
        self.assertEqual(create.call_count, 1)
        request = create.call_args.kwargs
        self.assertEqual(request['tools'], [])
        self.assertEqual(request['tool_choice'], 'none')
        self.assertFalse(request['stream'])
        self.assertEqual(request['timeout'], 12)
        messages = request['input' if mode == 'codex_responses' else 'messages']
        body = json.loads(messages[1]['content'])
        self.assertEqual(body['canonical_saved_booking'], FACTS)
        self.assertEqual(body['invalid_draft'], 'bad draft')
        self.assertNotIn('conversation', request)
        agent._close_request_openai_client.assert_called_once_with(client)

    def test_chat_completions_is_one_tool_disabled_call_and_closes(self):
        response = SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=VALID))])
        agent, client, create = self._agent('chat_completions', response)
        self.assertEqual(accepted_quote._rewrite_saved_confirmation(
            agent, FACTS, 'bad draft'), VALID)
        self._assert_request(agent, client, create, 'chat_completions')

    def test_responses_is_one_tool_disabled_call_and_closes(self):
        agent, client, create = self._agent(
            'codex_responses', SimpleNamespace(output_text=VALID))
        self.assertEqual(accepted_quote._rewrite_saved_confirmation(
            agent, FACTS, 'bad draft'), VALID)
        self._assert_request(agent, client, create, 'codex_responses')

    def test_error_propagates_but_always_closes(self):
        agent, client, create = self._agent(
            'chat_completions', error=TimeoutError('bounded timeout'))
        with self.assertRaises(TimeoutError):
            accepted_quote._rewrite_saved_confirmation(agent, FACTS, 'bad draft')
        self.assertEqual(create.call_count, 1)
        agent._close_request_openai_client.assert_called_once_with(client)


class FinalizeRewriteTests(unittest.TestCase):
    def setUp(self):
        self.state = {
            'plan': {'check_in': FACTS['check_in'], 'check_out': FACTS['check_out'],
                     'guests': [{'name': 'Anna Smith'}]},
            'checked_offer': {'room_arrangement': [{'bed_code': 'M1'}],
                              'total_cents': 50000, 'deposit_required_cents': 10000},
            'completion': {'success': True, 'booking_code': 'WH-1644',
                           'secure_payment_url': FACTS['payment_links'][0]},
            'status': 'accepted',
        }
        self.messages = [
            {'role': 'user', 'content': 'Bitte buchen.'},
            {'role': 'tool', 'content': json.dumps({
                'tool': 'create_booking_from_plan', 'success': True,
                'booking_code': 'WH-1644'})},
            {'role': 'assistant', 'content': 'bad draft'},
        ]

    def finalize(self, draft, callback=None, projection=None, messages=None):
        result = {'completed': True, 'final_response': draft,
                  'messages': deepcopy(messages or self.messages)}
        result['messages'][-1]['content'] = draft
        with patch.object(accepted_quote, '_transaction',
                          side_effect=lambda fn: fn(deepcopy(self.state), {'MESSAGE_ID': 'm',
                                                                         'tenant': 'wolfhouse-somo'})):
            return accepted_quote.finalize_offer_response(result, callback, projection)

    def test_valid_german_draft_preserves_exact_wording_and_skips_callback(self):
        callback = Mock()
        output = self.finalize(VALID, callback)
        self.assertEqual(output['final_response'], VALID)
        callback.assert_not_called()

    def test_each_wrong_canonical_value_invokes_once_and_correct_rewrite_passes(self):
        mutations = {
            'reference': VALID.replace('WH-1644', 'WH-WRONG'),
            'name': VALID.replace('Anna Smith', 'Andere Person'),
            'date': VALID.replace('2026-11-05', '2026-11-06'),
            'room': VALID.replace('M1', 'X9'),
            'total': VALID.replace('500.00', '501.00'),
            'deposit': VALID.replace('100.00', '101.00'),
            'link': VALID.replace('https://pay.invalid/WH-1644', 'https://evil.invalid/pay'),
        }
        for label, invalid in mutations.items():
            with self.subTest(label=label):
                callback = Mock(return_value=VALID)
                output = self.finalize(invalid, callback)
                self.assertEqual(output['final_response'], VALID)
                callback.assert_called_once_with(FACTS, invalid)
                self.assertEqual(output['messages'][-1]['content'], VALID)

    def test_empty_error_second_invalid_and_invented_payment_fail_closed(self):
        cases = [
            ('empty', Mock(return_value='')),
            ('error', Mock(side_effect=RuntimeError('offline'))),
            ('invalid', Mock(return_value=VALID.replace('M1', 'X9'))),
            ('invented-payment', Mock(return_value=VALID + ' Zahlung bestätigt.')),
        ]
        for label, callback in cases:
            with self.subTest(label=label):
                output = self.finalize('bad draft', callback)
                callback.assert_called_once_with(FACTS, 'bad draft')
                self.assertIsNone(output['final_response'])
                self.assertTrue(output['confirmation_withheld'])
                self.assertIsNone(output['messages'][-1]['content'])

    def test_invalid_draft_claiming_payment_is_rewritten(self):
        callback = Mock(return_value=VALID)
        invalid = VALID + ' Payment confirmed.'
        output = self.finalize(invalid, callback)
        self.assertEqual(output['final_response'], VALID)
        callback.assert_called_once()

    def test_recovery_projection_reaches_the_same_finalizer_boundary(self):
        messages = [self.messages[0], {'role': 'assistant', 'content': 'bad draft'}]
        receipt = deepcopy(self.state['completion'])
        callback = Mock(return_value=VALID)
        output = self.finalize('bad draft', callback, projection=receipt, messages=messages)
        self.assertEqual(output['final_response'], VALID)
        callback.assert_called_once_with(FACTS, 'bad draft')

    def test_finalizer_callback_receives_language_style_and_date_context(self):
        self.state['plan'].update(language='de', personality_style='warm', date_style='DMY')
        expected = dict(FACTS, rewrite_context={
            'language': 'de', 'personality_style': 'warm', 'date_style': 'DMY'})
        callback = Mock(return_value=VALID)
        self.finalize('bad draft', callback)
        callback.assert_called_once_with(expected, 'bad draft')

    def test_current_payment_projection_replaces_stale_create_link(self):
        self.state['completion']['secure_payment_url'] = 'https://pay.invalid/old'
        payment = {'tool': 'create_payment_link', 'success': True,
                   'booking_code': 'WH-1644', 'secure_payment_url': FACTS['payment_links'][0]}
        messages = deepcopy(self.messages)
        messages.insert(-1, {'role': 'tool', 'content': json.dumps(payment)})
        callback = Mock(return_value=VALID)
        self.finalize('bad draft', callback, messages=messages)
        callback.assert_called_once_with(FACTS, 'bad draft')

    def test_bound_staff_style_language_and_register_reach_rewrite(self):
        self.state['plan'].update(language='de', guest_register='Sie')
        callback = Mock(return_value=VALID)
        with patch('wolfhouse.luna_personality.get_bound_personality',
                   return_value={'pack': {'id': 'extra'}}):
            self.finalize('bad draft', callback)
        facts = callback.call_args.args[0]
        self.assertEqual(facts['rewrite_context'], {
            'language': 'de', 'register': 'Sie', 'personality_style': 'extra'})

    def test_missing_room_projection_never_bypasses_validation(self):
        self.state['checked_offer'].pop('room_arrangement')
        callback = Mock(return_value=VALID)
        output = self.finalize(VALID, callback)
        self.assertIsNone(output['final_response'])
        self.assertTrue(output['confirmation_withheld'])
        callback.assert_called_once()

    def test_failed_rewrite_remains_owed_and_next_turn_recovers(self):
        state = deepcopy(self.state)
        ingress = {'MESSAGE_ID': 'm', 'tenant': 'wolfhouse-somo'}
        first = {'completed': True, 'final_response': 'bad draft',
                 'messages': deepcopy(self.messages)}
        first['messages'][-1]['content'] = 'bad draft'
        with patch.object(accepted_quote, '_transaction',
                          side_effect=lambda fn: fn(state, ingress)):
            withheld = accepted_quote.finalize_offer_response(first, Mock(return_value=None))
            self.assertTrue(withheld['confirmation_withheld'])
            self.assertIn('confirmation_owed', state)
            second = {'completed': True, 'final_response': 'another bad draft',
                      'messages': [{'role': 'assistant', 'content': 'another bad draft'}]}
            recovered = accepted_quote.finalize_offer_response(
                second, Mock(return_value=VALID))
        self.assertEqual(recovered['final_response'], VALID)
        self.assertNotIn('confirmation_owed', state)


class ExactSemanticBoundaryTests(unittest.TestCase):
    def test_incomplete_canonical_contract_is_never_sendable(self):
        required_mutations = {
            'reference': {'reference': None},
            'guest roster': {'guest_names': []},
            'stay dates': {'check_in': None},
            'total': {'total_cents': None},
            'deposit': {'deposit_cents': None},
            'payment link': {'payment_links': []},
        }
        for label, mutation in required_mutations.items():
            with self.subTest(label=label):
                facts = dict(FACTS, **mutation)
                self.assertFalse(accepted_quote._confirmation_has_all_facts(VALID, facts))

    def test_amounts_match_numeric_tokens_not_substrings(self):
        facts = dict(FACTS, total_cents=100, deposit_cents=200)
        draft = ('WH-1644 Anna Smith 2026-11-01 2026-11-05 M1 '
                 'total 10.00, deposit 20.00 https://pay.invalid/WH-1644')
        self.assertFalse(accepted_quote._confirmation_has_all_facts(draft, facts))

    def test_equal_settlement_fields_need_separate_renderings(self):
        facts = dict(FACTS, amount_due_now_cents=10000)
        self.assertFalse(accepted_quote._confirmation_has_all_facts(VALID, facts))
        self.assertTrue(accepted_quote._confirmation_has_all_facts(
            VALID.replace('Anzahlung 100.00 EUR.',
                          'Anzahlung 100.00 EUR, jetzt fällig 100.00 EUR.'), facts))

    def test_room_type_is_a_required_semantic_fact(self):
        facts = dict(FACTS, room_type='private')
        self.assertFalse(accepted_quote._confirmation_has_all_facts(VALID, facts))
        self.assertTrue(accepted_quote._confirmation_has_all_facts(
            VALID.replace('Zimmer M1', 'privates Zimmer M1'), facts))

    def test_rewrite_context_carries_explicit_date_style(self):
        facts = accepted_quote._saved_confirmation_facts(
            {'check_in': '2026-11-01', 'check_out': '2026-11-05', 'guests': [],
             'language': 'de', 'personality_style': 'warm', 'date_style': 'DMY'},
            {'room_arrangement': [], 'total_cents': 50000,
             'deposit_required_cents': 10000},
            {'booking_code': 'WH-1644'})
        self.assertEqual(facts['rewrite_context'], {
            'language': 'de', 'personality_style': 'warm', 'date_style': 'DMY'})


class OwedConfirmationRecoveryTests(unittest.TestCase):
    def test_owed_contract_recovers_without_ephemeral_receipt_or_checked_offer(self):
        state = {'plan': {'language': 'de'}, 'confirmation_owed': deepcopy(FACTS)}
        result = {'completed': True, 'final_response': 'ordinary model reply',
                  'messages': [{'role': 'assistant', 'content': 'ordinary model reply'}]}
        callback = Mock(return_value=VALID)
        with patch.object(accepted_quote, '_transaction',
                          side_effect=lambda fn: fn(state, {'MESSAGE_ID': 'next'})):
            output = accepted_quote.finalize_offer_response(result, callback)
        self.assertEqual(output['final_response'], VALID)
        self.assertNotIn('confirmation_owed', state)
        callback.assert_called_once()


class InstalledBoundaryTests(unittest.TestCase):
    def test_installed_send_boundary_wires_direct_rewrite_callback(self):
        from agent import conversation_loop
        from wolfhouse import original_inbound

        original = Mock(return_value={'completed': True, 'final_response': 'bad draft'})
        response = SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=VALID))])
        create = Mock(return_value=response)
        client = SimpleNamespace(chat=SimpleNamespace(
            completions=SimpleNamespace(create=create)))
        agent = SimpleNamespace(
            model='offline-model', api_mode='chat_completions',
            _create_request_openai_client=Mock(return_value=client),
            _close_request_openai_client=Mock(),
        )
        inbound = SimpleNamespace(lock=RLock(), text='Bitte buchen.')

        def bind_owner(bound_agent, _text):
            accepted_quote._current.set(accepted_quote.TurnCapability(
                bound_agent, None, None, None))

        def exercise_callback(result, callback):
            self.assertEqual(result['final_response'], 'bad draft')
            return {'completed': True,
                    'final_response': callback(FACTS, result['final_response'])}

        prior = conversation_loop.run_conversation
        try:
            conversation_loop.run_conversation = original
            with patch.object(original_inbound, 'consume', return_value=inbound), \
                    patch.object(accepted_quote, 'observe_owner_turn', side_effect=bind_owner), \
                    patch.object(accepted_quote, 'finalize_offer_response',
                                 side_effect=exercise_callback):
                accepted_quote.install_owner_hook()
                output = conversation_loop.run_conversation(agent, 'Bitte buchen.')
            self.assertEqual(output['final_response'], VALID)
            original.assert_called_once_with(agent, 'Bitte buchen.')
            self.assertEqual(create.call_count, 1)
            self.assertEqual(create.call_args.kwargs['tools'], [])
            self.assertEqual(create.call_args.kwargs['tool_choice'], 'none')
            payload = json.loads(create.call_args.kwargs['messages'][1]['content'])
            guide = payload['booking_confirmation_guide']
            self.assertIn('every guest name', guide)
            self.assertIn('selected Staff personality style', guide)
            self.assertIn('self-selected emoji', guide)
            agent._close_request_openai_client.assert_called_once_with(client)
        finally:
            conversation_loop.run_conversation = prior
            accepted_quote.close_turn()


if __name__ == '__main__':
    unittest.main()
