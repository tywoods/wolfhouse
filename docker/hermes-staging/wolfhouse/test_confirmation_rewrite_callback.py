"""Focused contract tests for the saved-booking confirmation rewrite boundary."""
import json
import logging
from copy import deepcopy
from pathlib import Path
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
VALID = ('Booked {ref} for {guest_names}, {check_in} to {check_out}, '
         'room {room}, total {total}, deposit {deposit}.\n{payment_link}')


def sent(facts=None, draft=None):
    """Guest text after code fills the slot draft from saved booking facts."""
    return accepted_quote._fill_confirmation_slots(draft or VALID, facts or FACTS)


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
        self.assertNotIn('tools', request)
        self.assertNotIn('tool_choice', request)
        if mode == 'codex_responses':
            self.assertFalse(request['store'])
        else:
            self.assertNotIn('store', request)
        self.assertEqual(request['stream'], mode == 'codex_responses')
        self.assertEqual(request['timeout'], 12)
        messages = request['input' if mode == 'codex_responses' else 'messages']
        body = json.loads(messages[1]['content'])
        self.assertEqual(body['canonical_saved_booking'], FACTS)
        self.assertEqual(body['invalid_draft'], 'bad draft')
        self.assertNotIn('conversation', request)
        agent._close_request_openai_client.assert_called_once_with(client)

    def test_rewrite_prompt_logs_reject_reason_and_guest_language(self):
        facts = dict(FACTS, rewrite_context={'language': 'de'})
        draft = (
            'Hallo Anna Smith, Buchung WH-1644 ist gespeichert. '
            'Sun 1 Nov to Thu 5 Nov, Zimmer M1, total €500.00, Anzahlung €100.00.\n'
            'https://pay.invalid/WH-1644\n'
            'Here is our Location: https://maps.app.goo.gl/oPRckhqozVBvXxL16'
        )
        response = SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=VALID))])
        agent, client, create = self._agent('chat_completions', response)
        accepted_quote._rewrite_saved_confirmation(agent, facts, draft)
        messages = create.call_args_list[0].kwargs['messages']
        body = json.loads(messages[1]['content'])
        reasons = ' '.join(body.get('reject_reasons') or [])
        self.assertIn('english_location', reasons)
        self.assertEqual(body.get('guest_language'), 'de')
        guide = body.get('booking_confirmation_guide') or ''
        self.assertIn('guest', guide.lower())
        self.assertIn('language', guide.lower())

    def test_rejected_confirmation_is_emitted_at_gateway_visible_warning_level(self):
        facts = dict(FACTS, rewrite_context={'language': 'de'})
        response = SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=VALID))])
        agent, _client, _create = self._agent('chat_completions', response)
        logger = logging.getLogger('wolfhouse.accepted_quote')
        logger.setLevel(logging.WARNING)
        with self.assertLogs('wolfhouse.accepted_quote', level='WARNING') as captured:
            accepted_quote._rewrite_saved_confirmation(agent, facts, 'bad draft')
        self.assertTrue(any('saved-booking-confirmation-rejected' in line
                            for line in captured.output))

    def test_responses_stream_collects_output_text_deltas(self):
        class Stream:
            def __init__(self):
                self.closed = False
            def __iter__(self):
                return iter([
                    SimpleNamespace(type='response.output_text.delta', delta=VALID[:20]),
                    SimpleNamespace(type='response.output_text.delta', delta=VALID[20:]),
                ])
            def close(self):
                self.closed = True
        stream = Stream()
        agent, _client, create = self._agent('codex_responses', stream)
        self.assertEqual(accepted_quote._rewrite_saved_confirmation(agent, FACTS, 'bad draft'), VALID)
        self.assertTrue(stream.closed)
        self.assertTrue(create.call_args.kwargs['stream'])

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

    def test_primary_transport_error_closes_then_uses_grok(self):
        agent, client, create = self._agent(
            'chat_completions', error=TimeoutError('bounded timeout'))
        grok = Mock(return_value=VALID)
        with patch.object(accepted_quote, '_rewrite_saved_confirmation_with_grok', grok):
            self.assertEqual(accepted_quote._rewrite_saved_confirmation(
                agent, FACTS, 'bad draft'), VALID)
        self.assertEqual(create.call_count, 2)
        agent._close_request_openai_client.assert_called_once_with(client)
        grok.assert_called_once()

    def test_empty_german_rewrite_retries_model_in_german(self):
        facts = dict(FACTS, rewrite_context={'language': 'de'})
        german = ('Buchung {ref} für {guest_names}, {check_in} bis {check_out}, '
                  'Zimmer {room}, Gesamtpreis {total}, Anzahlung {deposit}.\n{payment_link}')
        responses = [
            SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=''))]),
            SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=german))]),
        ]
        agent, _client, create = self._agent('chat_completions')
        create.side_effect = responses
        self.assertEqual(accepted_quote._rewrite_saved_confirmation(
            agent, facts, 'bad draft'), german)
        self.assertEqual(create.call_count, 2)
        retry_body = json.loads(create.call_args.kwargs['messages'][1]['content'])
        self.assertEqual(retry_body['guest_language'], 'de')
        self.assertTrue(retry_body['language_retry'])

    def test_english_german_rewrite_retries_model_and_never_returns_english(self):
        facts = dict(FACTS, rewrite_context={'language': 'de'})
        german = ('Buchung {ref} für {guest_names}, {check_in} bis {check_out}, '
                  'Zimmer {room}, Gesamtpreis {total}, Anzahlung {deposit}.\n{payment_link}')
        responses = [
            SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=VALID))]),
            SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=german))]),
        ]
        agent, _client, create = self._agent('chat_completions')
        create.side_effect = responses
        self.assertEqual(accepted_quote._rewrite_saved_confirmation(
            agent, facts, VALID), german)
        self.assertEqual(create.call_count, 2)

    def test_invalid_rewrite_retries_with_checker_reasons_then_uses_grok(self):
        facts = dict(FACTS, rewrite_context={'language': 'de'})
        incomplete = 'Buchung {ref} für {guest_names}.'
        invalid_retry = 'Buchung {ref} für {guest_names}, Zimmer {room}.'
        german = ('Buchung {ref} für {guest_names}, {check_in} bis {check_out}, '
                  'Zimmer {room}, Gesamtpreis {total}, Anzahlung {deposit}.\n{payment_link}')
        agent, _client, create = self._agent('chat_completions')
        create.side_effect = [
            SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=incomplete))]),
            SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=invalid_retry))]),
        ]
        grok = Mock(return_value=german)
        with patch.object(accepted_quote, '_rewrite_saved_confirmation_with_grok', grok):
            self.assertEqual(accepted_quote._rewrite_saved_confirmation(
                agent, facts, 'bad draft'), german)
        self.assertEqual(create.call_count, 2)
        retry_body = json.loads(create.call_args.kwargs['messages'][1]['content'])
        self.assertIn('missing_payment_link', retry_body['reject_reasons'])
        self.assertIn('check_in_date_not_mentioned', retry_body['reject_reasons'])
        grok.assert_called_once_with(facts, invalid_retry, retry_body['reject_reasons'], 12)

    def test_checker_accepts_complete_german_slot_confirmation(self):
        facts = dict(FACTS, rewrite_context={'language': 'de'})
        german = ('Buchung {ref} für {guest_names}, {check_in} bis {check_out}, '
                  'Zimmer {room}, Gesamtpreis {total}, Anzahlung {deposit}.\n{payment_link}')
        self.assertEqual(accepted_quote._confirmation_reject_reasons(german, facts), [])


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

    def test_valid_slot_draft_fills_saved_facts_and_skips_callback(self):
        callback = Mock()
        output = self.finalize(VALID, callback)
        filled = sent()
        self.assertEqual(output['final_response'], filled)
        self.assertEqual(output['messages'][-1]['content'], filled)
        self.assertNotIn('{ref}', filled)
        self.assertIn('WH-1644', filled)
        self.assertIn('Anna Smith', filled)
        self.assertIn('€500.00', filled)
        self.assertIn('€100.00', filled)
        self.assertIn(FACTS['payment_links'][0], filled)
        callback.assert_not_called()

    def _native_staff_plugin(self):
        from hermes_cli.plugins import PluginManager, PluginManifest
        plugin_dir = Path(__file__).resolve().parents[1] / 'plugins' / 'wolfhouse_staff_api'
        manager = PluginManager()
        return manager._load_directory_module(PluginManifest(
            name='wolfhouse_staff_api', key='wolfhouse_staff_api',
            source='project', path=str(plugin_dir)))

    def test_native_hermes_plugin_loader_supplies_staff_property_map(self):
        plugin = self._native_staff_plugin()
        current = 'https://maps.example.invalid/current'
        with patch.object(plugin, '_post_bot', return_value={
                'success': True, 'location_url': current}) as staff_read:
            facts = accepted_quote._saved_confirmation_facts(
                self.state['plan'], self.state['checked_offer'], self.state['completion'])
        self.assertEqual(plugin.__name__, 'hermes_plugins.wolfhouse_staff_api')
        self.assertEqual(facts['location_url'], current)
        staff_read.assert_called_once_with('/house-info', {})

    def test_saved_booking_uses_current_staff_map_not_old_receipt_map(self):
        receipt = dict(self.state['completion'],
                       guest_location_line='https://maps.example.invalid/old',
                       location_url='https://maps.example.invalid/also-old')
        plugin = self._native_staff_plugin()
        current = 'https://maps.example.invalid/current'
        with patch.object(plugin, '_post_bot', return_value={
                'success': True, 'location_url': current}):
            facts = accepted_quote._saved_confirmation_facts(
                self.state['plan'], self.state['checked_offer'], receipt)
        self.assertEqual(facts['location_url'], current)
        self.assertNotEqual(facts['location_url'], receipt['location_url'])
        self.assertNotIn('guest_location_line', facts)

    def test_german_empty_rewrite_withholds_instead_of_english_fallback(self):
        self.state['plan']['language'] = 'de'
        output = self.finalize(VALID, Mock(return_value=''))
        self.assertIsNone(output['final_response'])
        self.assertTrue(output['confirmation_withheld'])
        self.assertNotIn('Booked ', str(output.get('final_response') or ''))

    def test_all_llm_confirmation_attempts_mark_staff_needs_human_once(self):
        self.state['plan']['language'] = 'de'
        handoff = Mock(return_value={'success': True, 'needs_human': True})
        with patch.object(accepted_quote, '_mark_confirmation_needs_human', handoff):
            output = self.finalize(VALID, Mock(return_value=''))
        self.assertIsNone(output['final_response'])
        self.assertTrue(output['confirmation_withheld'])
        handoff.assert_called_once()

    def test_saved_booking_bypasses_empty_post_tool_loop_and_returns_direct_german_confirmation(self):
        """A successful save owns the turn even when a later read exhausts the model loop."""
        self.state['plan']['language'] = 'de'
        self.state['plan']['guests'] = [
            {'name': 'Anna'}, {'name': 'Lisa'}, {'name': 'Max'},
        ]
        self.state['checked_offer'].update({
            'room_arrangement': [
                {'bed_code': 'R2-B1'}, {'bed_code': 'R5-B1'}, {'bed_code': 'R5-B2'},
            ],
            'package_label': 'Malibu',
            'total_cents': 74700,
            'deposit_required_cents': 60000,
        })
        self.state['completion'] = {
            'success': True,
            'booking_code': 'WH-20261101-10062867',
            'guest_payment_links': [
                {'guest_name': 'Anna', 'amount_due_cents': 20000,
                 'secure_payment_url': 'https://pay.invalid/anna'},
                {'guest_name': 'Lisa', 'amount_due_cents': 20000,
                 'secure_payment_url': 'https://pay.invalid/lisa'},
                {'guest_name': 'Max', 'amount_due_cents': 20000,
                 'secure_payment_url': 'https://pay.invalid/max'},
            ],
        }
        direct = (
            'Eure Buchung {ref} für {guest_names} von {check_in} bis {check_out} ist gespeichert. '
            'Zimmer {room}, Paket {package}, Gesamtpreis {total}, Anzahlung {deposit}; '
            '{balance} bleibt bis zum Check-out offen.\n{payment_link}\nStandort: {location}'
        )
        exhausted = {
            'completed': False,
            'partial': True,
            'error': 'Processing completed but no response was generated.',
            'final_response': None,
            'messages': [
                {'role': 'user', 'content': 'Ja, bitte buchen.'},
                {'role': 'tool', 'content': json.dumps({
                    'tool': 'create_booking_from_plan', 'success': True,
                    'booking_code': 'WH-20261101-10062867'})},
                {'role': 'tool', 'content': json.dumps({
                    'tool': 'get_house_info', 'success': True})},
            ],
        }
        rewrite = Mock(return_value=direct)
        plugin = self._native_staff_plugin()
        with patch.object(plugin, '_post_bot', return_value={
                'success': True, 'location_url': MAPS_URL}), patch.object(
                accepted_quote, '_transaction',
                side_effect=lambda fn: fn(self.state, {
                    'MESSAGE_ID': 'post-save-empty', 'tenant': 'wolfhouse-somo'})):
            output = accepted_quote.finalize_offer_response(exhausted, rewrite)

        rewrite.assert_called_once()
        self.assertTrue(output['completed'])
        self.assertFalse(output.get('partial', False))
        self.assertNotIn('error', output)
        self.assertFalse(output.get('confirmation_withheld', False))
        for expected in (
                'WH-20261101-10062867', 'Anna', 'Lisa', 'Max',
                '01.11.2026', '05.11.2026', 'R2-B1', 'R5-B1', 'R5-B2',
                'Malibu', '747,00 €', '600,00 €',
                'https://pay.invalid/anna', 'https://pay.invalid/lisa',
                'https://pay.invalid/max', MAPS_URL):
            self.assertIn(expected, output['final_response'])

    def test_each_wrong_canonical_value_invokes_once_and_correct_rewrite_passes(self):
        mutations = {
            'reference': VALID + ' WH-9999',
            'name': VALID.replace('{guest_names}', 'Andere Person'),
            'date': VALID.replace('{check_out}', '2026-11-06'),
            'room': VALID + ' room 99',
            'total': VALID + ' 501.00 EUR',
            'deposit': VALID + ' 101,00 €',
            'link': VALID.replace('{payment_link}', 'https://evil.invalid/pay'),
        }
        for label, invalid in mutations.items():
            with self.subTest(label=label):
                callback = Mock(return_value=VALID)
                output = self.finalize(invalid, callback)
                self.assertEqual(output['final_response'], sent())
                callback.assert_called_once_with(FACTS, invalid)
                self.assertEqual(output['messages'][-1]['content'], sent())

    def test_4044_empty_rewrite_keeps_fact_matching_original(self):
        original = sent()
        self.assertNotIn('{ref}', original)
        callback = Mock(return_value='')
        output = self.finalize(original, callback)
        self.assertEqual(output['final_response'], original)
        self.assertNotEqual(output['final_response'], '')
        self.assertFalse(output.get('confirmation_withheld'))
        self.assertEqual(output['messages'][-1]['content'], original)
        self.assertIn('WH-1644', output['final_response'])
        self.assertIn('Anna Smith', output['final_response'])
        self.assertIn('M1', output['final_response'])
        self.assertIn('€500.00', output['final_response'])
        self.assertIn('€100.00', output['final_response'])

    def test_failed_rewrite_keeps_fact_matching_original(self):
        original = sent()
        output = self.finalize(original, Mock(side_effect=RuntimeError('offline')))
        self.assertEqual(output['final_response'], original)
        self.assertFalse(output.get('confirmation_withheld'))

    def test_invalid_rewrite_keeps_fact_matching_original(self):
        original = sent()
        output = self.finalize(original, Mock(return_value=VALID.replace('{room}', 'X9')))
        self.assertEqual(output['final_response'], original)
        self.assertNotIn('X9', output['final_response'])

    def test_fact_matching_original_does_not_need_rewrite(self):
        original = sent()
        callback = Mock(return_value=VALID)
        output = self.finalize(original, callback)
        self.assertEqual(output['final_response'], original)
        callback.assert_not_called()

    def test_ordinary_german_wording_is_kept_when_rewrite_empty(self):
        self.state['plan'].update(check_in='2026-11-02', check_out='2026-11-05', language='de')
        self.state['checked_offer']['total_cents'] = 49900
        self.state['completion']['amount_due_cents'] = 10000
        original = (
            'Hallo Anna Smith, Buchung WH-1644 ist gespeichert. '
            '2. November bis 5. November, Zimmer M1, total 499€, Anzahlung 100€, '
            'Restbetrag 399€, zahlbar beim Check-out.\n'
            'https://pay.invalid/WH-1644'
        )
        output = self.finalize(original, Mock(return_value=''))
        self.assertEqual(output['final_response'], original)
        self.assertIsNotNone(output['final_response'])
        self.assertFalse(output.get('confirmation_withheld'))

    def test_german_draft_fails_once_then_rewrite_in_german_is_kept(self):
        self.state['plan'].update(check_in='2026-11-02', check_out='2026-11-05', language='de')
        self.state['checked_offer']['total_cents'] = 49900
        self.state['completion']['amount_due_cents'] = 10000
        rejected = (
            'Hallo Anna Smith, Buchung WH-1644 ist gespeichert. '
            '2. November bis 5. November, Zimmer M1, total 499€, Anzahlung 100€.\n'
            'https://pay.invalid/WH-1644\n'
            'Here is our Location: https://maps.app.goo.gl/oPRckhqozVBvXxL16'
        )
        rewritten = (
            'Hallo Anna Smith, Buchung WH-1644 ist gespeichert. '
            '2. November bis 5. November, Zimmer M1, total 499€, Anzahlung 100€, '
            'Restbetrag 399€, zahlbar beim Check-out.\n'
            'https://pay.invalid/WH-1644'
        )
        callback = Mock(return_value=rewritten)
        output = self.finalize(rejected, callback)
        callback.assert_called_once()
        self.assertEqual(output['final_response'], rewritten)
        self.assertNotIn('Booked WH-1644', output['final_response'])
        self.assertNotIn('Here is our Location', output['final_response'])
        self.assertIn('Buchung WH-1644', output['final_response'])
        self.assertIn('Anzahlung 100€', output['final_response'])

    def test_german_slots_with_english_location_line_keep_german_wording(self):
        self.state['plan'].update(language='de')
        draft = (
            'Gebucht {ref} für {guest_names}, {check_in} bis {check_out}, '
            'Zimmer {room}, total {total}, Anzahlung {deposit}.\n{payment_link}\n'
            'Here is our Location: https://maps.app.goo.gl/oPRckhqozVBvXxL16'
        )
        callback = Mock(return_value='')
        output = self.finalize(draft, callback)
        callback.assert_not_called()
        self.assertIn('Gebucht WH-1644', output['final_response'])
        self.assertNotIn('Booked WH-1644', output['final_response'])
        self.assertNotIn('Here is our Location', output['final_response'])
        self.assertIn('Anzahlung', output['final_response'])

    def test_payment_plugin_location_survives_completion_and_german_confirmation(self):
        """Plugin facts must survive both durable retention and turn projection."""
        state = deepcopy(self.state)
        state['plan'].update(language='de')
        state['receipt'] = dict(state['completion'], booking_id='booking-1644',
                                payment_id='payment-1644')
        state['completion'] = deepcopy(state['receipt'])
        plugin_output = {
            'tool': 'create_payment_link', 'success': True,
            'booking_id': 'booking-1644', 'booking_code': 'WH-1644',
            'payment_id': 'payment-1644', 'amount_due_cents': 10000,
            'secure_payment_url': FACTS['payment_links'][0],
            'location_url': 'https://maps.app.goo.gl/oPRckhqozVBvXxL16',
        }
        with patch.object(accepted_quote, '_transaction',
                          side_effect=lambda fn: fn(state, {'MESSAGE_ID': 'm',
                                                            'tenant': 'wolfhouse-somo'})):
            accepted_quote.record_payment_completion(plugin_output)
            self.assertEqual(state['completion']['location_url'],
                             plugin_output['location_url'])
            draft = (
                'Gebucht WH-1644 für Anna Smith, 01.11.2026 bis 05.11.2026, '
                'Zimmer M1, gesamt 500,00 €, Anzahlung 100,00 €, '
                'Restbetrag 400,00 €, zahlbar beim Check-out.\n'
                'https://pay.invalid/WH-1644\n'
                'Standort: https://maps.app.goo.gl/oPRckhqozVBvXxL16'
            )
            messages = [
                {'role': 'user', 'content': 'Bitte buchen.'},
                {'role': 'tool', 'content': json.dumps({
                    'tool': 'create_booking_from_plan', 'success': True,
                    'booking_id': 'booking-1644', 'booking_code': 'WH-1644'})},
                {'role': 'tool', 'content': json.dumps(plugin_output)},
                {'role': 'assistant', 'content': draft},
            ]
            output = accepted_quote.finalize_offer_response({
                'completed': True, 'final_response': draft, 'messages': messages})
        text = output['final_response']
        for expected in ('WH-1644', 'Anna Smith', '01.11.2026', '05.11.2026',
                         'M1', '500,00 €', '100,00 €', FACTS['payment_links'][0],
                         plugin_output['location_url']):
            self.assertIn(expected, text)
        self.assertIn('Gebucht', text)
        self.assertNotIn('Booked', text)

    def test_guest_payment_plugin_location_survives_completion_and_german_confirmation(self):
        """Per-guest plugin facts survive retention and same-turn projection."""
        state = deepcopy(self.state)
        state['plan'].update(language='de')
        state['receipt'] = dict(
            state['completion'], booking_id='booking-1644',
            booking_guests=[{
                'booking_guest_id': 'guest-anna', 'guest_name': 'Anna Smith',
            }],
        )
        state['completion'] = deepcopy(state['receipt'])
        plugin_output = {
            'tool': 'create_guest_payment_link', 'success': True,
            'booking_id': 'booking-1644', 'booking_code': 'WH-1644',
            'booking_guest_id': 'guest-anna', 'guest_name': 'Anna Smith',
            'amount_due_cents': 10000, 'currency': 'EUR',
            'secure_payment_url': FACTS['payment_links'][0],
            'location_url': 'https://maps.app.goo.gl/oPRckhqozVBvXxL16',
        }
        with patch.object(accepted_quote, '_transaction',
                          side_effect=lambda fn: fn(state, {'MESSAGE_ID': 'm',
                                                            'tenant': 'wolfhouse-somo'})):
            accepted_quote.record_payment_completion(plugin_output)
            retained = state['completion']['guest_payment_links'][0]
            self.assertEqual(retained['location_url'], plugin_output['location_url'])
            draft = (
                'Gebucht WH-1644 für Anna Smith, 01.11.2026 bis 05.11.2026, '
                'Zimmer M1, gesamt 500,00 €, Anzahlung 100,00 €, '
                'Restbetrag 400,00 €, zahlbar beim Check-out.\n'
                'https://pay.invalid/WH-1644\n'
                'Standort: https://maps.app.goo.gl/oPRckhqozVBvXxL16'
            )
            messages = [
                {'role': 'user', 'content': 'Bitte buchen.'},
                {'role': 'tool', 'content': json.dumps({
                    'tool': 'create_booking_from_plan', 'success': True,
                    'booking_id': 'booking-1644', 'booking_code': 'WH-1644'})},
                {'role': 'tool', 'content': json.dumps(plugin_output)},
                {'role': 'assistant', 'content': draft},
            ]
            output = accepted_quote.finalize_offer_response({
                'completed': True, 'final_response': draft, 'messages': messages})
        text = output['final_response']
        for expected in ('WH-1644', 'Anna Smith', '01.11.2026', '05.11.2026',
                         'M1', '500,00 €', '100,00 €', FACTS['payment_links'][0],
                         plugin_output['location_url']):
            self.assertIn(expected, text)
        self.assertIn('Gebucht', text)
        self.assertNotIn('Booked', text)

    def test_receipt_only_german_group_confirmation_reads_saved_property_map(self):
        """Cap gap: no payment tool in this turn still yields localized map confirmation."""
        plugin = self._native_staff_plugin()

        state = deepcopy(self.state)
        state['plan'] = {
            'check_in': '2026-11-01', 'check_out': '2026-11-08', 'language': 'de',
            'guests': [
                {'name': 'Anna Weber'}, {'name': 'Lisa Weber'}, {'name': 'Max Weber'},
            ],
        }
        state['checked_offer'] = {
            'room_arrangement': [
                {'bed_code': 'R2-B1'}, {'bed_code': 'R5-B1'}, {'bed_code': 'R5-B2'},
            ],
            'package_label': 'Malibu',
            'total_cents': 74700,
            'deposit_required_cents': 60000,
        }
        state['completion'] = {
            'success': True,
            'booking_id': 'booking-cap-map',
            'booking_code': 'WH-20261101-04706321',
            'booking_guests': [
                {'booking_guest_id': 'guest-1', 'guest_name': 'Anna Weber'},
                {'booking_guest_id': 'guest-2', 'guest_name': 'Lisa Weber'},
                {'booking_guest_id': 'guest-3', 'guest_name': 'Max Weber'},
            ],
            'guest_payment_links': [
                {'booking_guest_id': 'guest-1', 'guest_name': 'Anna Weber',
                 'amount_due_cents': 20000, 'secure_payment_url': 'https://pay.invalid/anna'},
                {'booking_guest_id': 'guest-2', 'guest_name': 'Lisa Weber',
                 'amount_due_cents': 20000, 'secure_payment_url': 'https://pay.invalid/lisa'},
                {'booking_guest_id': 'guest-3', 'guest_name': 'Max Weber',
                 'amount_due_cents': 20000, 'secure_payment_url': 'https://pay.invalid/max'},
            ],
        }
        german = (
            'Eure Buchung WH-20261101-04706321 für Anna Weber, Lisa Weber und Max Weber '
            'vom 01.11.2026 bis 08.11.2026 ist gespeichert. Zimmer R2-B1, R5-B1 und R5-B2, '
            'Paket Malibu, Gesamtpreis 747,00 €, Anzahlung 600,00 €, '
            'Restbetrag 147,00 €, zahlbar beim Check-out.\n'
            'Anna Weber: https://pay.invalid/anna\n'
            'Lisa Weber: https://pay.invalid/lisa\n'
            'Max Weber: https://pay.invalid/max\n'
            f'Standort: {MAPS_URL}'
        )
        messages = [
            {'role': 'user', 'content': 'Ja, bitte buchen.'},
            {'role': 'tool', 'content': json.dumps({
                'tool': 'create_booking_from_plan', 'success': True,
                'booking_id': 'booking-cap-map',
                'booking_code': 'WH-20261101-04706321',
            })},
            {'role': 'assistant', 'content': 'Buchung gespeichert.'},
        ]
        result = {'completed': True, 'final_response': 'Buchung gespeichert.',
                  'messages': messages}
        callback = Mock(return_value=german)
        with patch.object(plugin, '_post_bot', return_value={
                'success': True, 'location_url': MAPS_URL,
             }) as staff_read, patch.object(
                 accepted_quote, '_transaction',
                 side_effect=lambda fn: fn(state, {
                     'MESSAGE_ID': 'receipt-only', 'tenant': 'wolfhouse-somo'})):
            output = accepted_quote.finalize_offer_response(result, callback)

        self.assertEqual(output['final_response'], german)
        callback.assert_called_once()
        staff_read.assert_called_once_with('/house-info', {})
        facts = callback.call_args.args[0]
        missing_location = german.rsplit('\n', 1)[0]
        wrong_location = german.replace(MAPS_URL, 'https://maps.app.goo.gl/wrong-property')
        self.assertIn('missing_location',
                      accepted_quote._confirmation_reject_reasons(missing_location, facts))
        self.assertFalse(accepted_quote._confirmation_has_all_facts(wrong_location, facts))
        slot_draft = (
            'Eure Buchung {ref} für {guest_names} vom {check_in} bis {check_out} ist gespeichert. '
            'Zimmer {room}, Paket {package}, Gesamtpreis {total}, Anzahlung {deposit}, '
            'Restbetrag {balance}, zahlbar beim Check-out.\n{payment_link}\nStandort: {location}'
        )
        self.assertIsNotNone(accepted_quote._fill_confirmation_slots(slot_draft, facts))
        self.assertIsNone(accepted_quote._fill_confirmation_slots(
            slot_draft.replace('\nStandort: {location}', ''), facts))
        self.assertNotIn('Booked ', output['final_response'])
        for expected in (
                'WH-20261101-04706321', 'Anna Weber', 'Lisa Weber', 'Max Weber',
                '01.11.2026', '08.11.2026', 'R2-B1', 'R5-B1', 'R5-B2',
                '747,00 €', '600,00 €', MAPS_URL):
            self.assertIn(expected, output['final_response'])

    def test_filled_map_url_suffix_mutation_is_rejected(self):
        facts = dict(FACTS, location_url=MAPS_URL)
        draft = VALID + '\nStandort: {location}'
        filled = accepted_quote._fill_confirmation_slots(draft, facts)
        self.assertIsNotNone(filled)
        self.assertFalse(accepted_quote._confirmation_has_all_facts(
            filled.replace(MAPS_URL, MAPS_URL + '-wrong-property'), facts))

    def test_slot_map_url_suffix_mutation_is_rejected_after_expansion(self):
        facts = dict(FACTS, location_url=MAPS_URL)
        draft = VALID + '\nStandort: {location}-wrong-property'
        self.assertIsNone(accepted_quote._fill_confirmation_slots(draft, facts))

    def test_exact_map_url_with_surrounding_punctuation_is_accepted(self):
        facts = dict(FACTS, location_url=MAPS_URL)
        draft = VALID + '\nStandort: ({location}),'
        filled = accepted_quote._fill_confirmation_slots(draft, facts)
        self.assertIsNotNone(filled)
        self.assertTrue(accepted_quote._confirmation_has_all_facts(filled, facts))

    def test_map_url_suffix_mutation_keeps_confirmation_debt(self):
        facts = dict(FACTS, location_url=MAPS_URL)
        invalid = accepted_quote._fill_confirmation_slots(
            VALID + '\nStandort: {location}', facts).replace(
                MAPS_URL, MAPS_URL + '-wrong-property')
        state = {
            'plan': {'language': 'en'},
            'confirmation_owed': deepcopy(facts),
            'confirmation_owed_status': {'status': 'owed'},
            'status': 'accepted',
        }
        result = {'completed': True, 'final_response': invalid,
                  'messages': [{'role': 'assistant', 'content': invalid}]}
        callback = Mock(return_value=invalid)
        with patch.object(accepted_quote, '_transaction',
                          side_effect=lambda fn: fn(state, {
                              'MESSAGE_ID': 'map-suffix', 'tenant': 'wolfhouse-somo'})):
            output = accepted_quote.finalize_offer_response(result, callback)
        self.assertIsNone(output['final_response'])
        self.assertTrue(output['confirmation_withheld'])
        self.assertEqual(state['confirmation_owed'], facts)
        self.assertIn('confirmation_owed_status', state)
        self.assertGreaterEqual(callback.call_count, 1)

    def test_german_wrong_amount_fails_then_rewrite_in_german_is_kept(self):
        self.state['plan'].update(check_in='2026-11-02', check_out='2026-11-05', language='de')
        self.state['checked_offer']['total_cents'] = 49900
        self.state['completion']['amount_due_cents'] = 10000
        rejected = (
            'Hallo Anna Smith, Buchung WH-1644 ist gespeichert. '
            '2. November bis 5. November, Zimmer M1, total 1€, Anzahlung 100€.\n'
            'https://pay.invalid/WH-1644'
        )
        rewritten = (
            'Hallo Anna Smith, Buchung WH-1644 ist gespeichert. '
            '2. November bis 5. November, Zimmer M1, total 499€, Anzahlung 100€, '
            'Restbetrag 399€, zahlbar beim Check-out.\n'
            'https://pay.invalid/WH-1644'
        )
        callback = Mock(return_value=rewritten)
        output = self.finalize(rejected, callback)
        callback.assert_called_once()
        self.assertEqual(output['final_response'], rewritten)
        self.assertNotIn('Booked WH-1644', output['final_response'])
        self.assertIn('total 499€', output['final_response'])

    def test_wrong_amount_rewrite_still_fails_withholds_for_german(self):
        self.state['plan'].update(language='de')
        rejected = (
            'Hallo Anna Smith, Buchung WH-1644 ist gespeichert. '
            '1. November bis 5. November, Zimmer M1, total 1€, Anzahlung 100€.\n'
            'https://pay.invalid/WH-1644'
        )
        still_wrong = rejected.replace('total 1€', 'total 2€')
        output = self.finalize(rejected, Mock(return_value=still_wrong))
        self.assertIsNone(output['final_response'])
        self.assertTrue(output['confirmation_withheld'])

    def test_rewrite_fail_sends_code_filled_slot_confirmation(self):
        output = self.finalize('bad draft', Mock(return_value=''))
        self.assertEqual(output['final_response'], sent())
        self.assertIsNotNone(output['final_response'])
        self.assertFalse(output.get('confirmation_withheld'))

    def test_retry_reused_booking_sends_slot_confirmation(self):
        messages = [
            {'role': 'user', 'content': 'nochmal'},
            {'role': 'tool', 'content': json.dumps({
                'tool': 'create_booking_from_plan', 'success': True,
                'booking_code': 'WH-1644', 'idempotent': True,
                'write_performed': False, 'created': False})},
            {'role': 'assistant', 'content': ''},
        ]
        output = self.finalize('', Mock(return_value=''), messages=messages)
        self.assertEqual(output['final_response'], sent())
        self.assertIsNotNone(output['final_response'])

    def test_swapped_total_and_deposit_is_rejected(self):
        swapped = (
            'Booked WH-1644 for Anna Smith, Sun 1 Nov to Thu 5 Nov, room M1, '
            'total €100.00, deposit €500.00.\nhttps://pay.invalid/WH-1644'
        )
        self.assertFalse(accepted_quote._confirmation_has_all_facts(swapped, FACTS))
        output = self.finalize(swapped, Mock(return_value=''))
        self.assertNotEqual(output['final_response'], swapped)
        self.assertNotIn('total €100.00', str(output.get('final_response') or ''))

    def test_owed_normal_reply_goes_through_untouched(self):
        state = deepcopy(self.state)
        state['confirmation_owed'] = deepcopy(FACTS)
        thanks = 'Danke, super!'
        result = {'completed': True, 'final_response': thanks,
                  'messages': [{'role': 'assistant', 'content': thanks}]}
        with patch.object(accepted_quote, '_transaction',
                          side_effect=lambda fn: fn(state, {
                              'MESSAGE_ID': 'next', 'tenant': 'wolfhouse-somo'})):
            output = accepted_quote.finalize_offer_response(
                result, Mock(side_effect=AssertionError('rewrite must not run')))
        self.assertEqual(output['final_response'], thanks)
        self.assertIsNotNone(output['final_response'])
        self.assertIn('confirmation_owed', state)

    def test_empty_error_second_invalid_and_invented_payment_fail_closed(self):
        cases = [
            ('empty', Mock(return_value='')),
            ('error', Mock(side_effect=RuntimeError('offline'))),
            ('invalid', Mock(return_value=VALID.replace('{room}', 'X9'))),
            ('invented-payment', Mock(return_value=VALID + ' Zahlung bestätigt.')),
        ]
        for label, callback in cases:
            with self.subTest(label=label):
                output = self.finalize('bad draft', callback)
                callback.assert_called_once_with(FACTS, 'bad draft')
                self.assertEqual(output['final_response'], sent())
                self.assertIsNotNone(output['final_response'])

    def test_invalid_draft_claiming_payment_is_rewritten(self):
        callback = Mock(return_value=VALID)
        invalid = VALID + ' Payment confirmed.'
        output = self.finalize(invalid, callback)
        self.assertEqual(output['final_response'], sent())
        callback.assert_called_once()

    def test_recovery_projection_reaches_the_same_finalizer_boundary(self):
        messages = [self.messages[0], {'role': 'assistant', 'content': 'bad draft'}]
        receipt = deepcopy(self.state['completion'])
        callback = Mock(return_value=VALID)
        output = self.finalize('bad draft', callback, projection=receipt, messages=messages)
        self.assertEqual(output['final_response'], sent())
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

    def test_contradictory_payment_booking_code_cannot_replace_link(self):
        self.state['completion']['secure_payment_url'] = FACTS['payment_links'][0]
        payment = {'tool': 'create_payment_link', 'success': True,
                   'booking_code': 'WH-OTHER',
                   'secure_payment_url': 'https://evil.invalid/other'}
        messages = deepcopy(self.messages)
        messages.insert(-1, {'role': 'tool', 'content': json.dumps(payment)})
        callback = Mock(return_value=VALID)
        self.finalize('bad draft', callback, messages=messages)
        facts = callback.call_args.args[0]
        self.assertEqual(facts['payment_links'], FACTS['payment_links'])
        self.assertNotIn('https://evil.invalid/other', facts['payment_links'])

    def test_fresh_room_projection_overrides_owed_snapshot(self):
        self.state['confirmation_owed'] = deepcopy(FACTS)
        self.state['completion']['guest_rooms'] = [
            {'guest_name': 'Anna Smith', 'room_label': 'Casa Blanca',
             'room_type': 'shared'}]
        callback = Mock(return_value=None)
        self.finalize('bad draft', callback)
        facts = callback.call_args.args[0]
        self.assertEqual(facts['room'], ['Casa Blanca'])
        self.assertEqual(facts['room_type'], 'shared')

    def test_partial_fresh_projection_cannot_erase_owed_facts(self):
        self.state['confirmation_owed'] = deepcopy(FACTS)
        self.state['plan'] = {}
        self.state.pop('checked_offer')
        self.state['completion'] = {'success': True, 'booking_code': 'WH-1644'}
        callback = Mock(return_value=VALID)
        self.finalize('bad draft', callback)
        facts = callback.call_args.args[0]
        for key in ('guest_names', 'check_in', 'check_out', 'room',
                    'total_cents', 'deposit_cents', 'payment_links'):
            self.assertEqual(facts[key], FACTS[key])

    def test_payment_result_without_positive_identity_cannot_replace_link(self):
        payment = {'tool': 'create_payment_link', 'success': True,
                   'secure_payment_url': 'https://evil.invalid/unbound'}
        messages = deepcopy(self.messages)
        messages.insert(-1, {'role': 'tool', 'content': json.dumps(payment)})
        callback = Mock(return_value=VALID)
        self.finalize('bad draft', callback, messages=messages)
        facts = callback.call_args.args[0]
        self.assertEqual(facts['payment_links'], FACTS['payment_links'])

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

    def test_failed_rewrite_sends_slot_confirmation(self):
        state = deepcopy(self.state)
        ingress = {'MESSAGE_ID': 'm', 'tenant': 'wolfhouse-somo'}
        first = {'completed': True, 'final_response': 'bad draft',
                 'messages': deepcopy(self.messages)}
        first['messages'][-1]['content'] = 'bad draft'
        with patch.object(accepted_quote, '_transaction',
                          side_effect=lambda fn: fn(state, ingress)):
            first_out = accepted_quote.finalize_offer_response(first, Mock(return_value=None))
            self.assertEqual(first_out['final_response'], sent())
            self.assertNotIn('confirmation_owed', state)


class ExactSemanticBoundaryTests(unittest.TestCase):
    def test_split_payment_slot_pairs_each_saved_link_with_its_guest(self):
        facts = dict(FACTS,
            guest_names=['Sam Evans', 'Lucy Evans', 'Tom Evans'],
            payment_links=['https://pay.invalid/g1', 'https://pay.invalid/g2',
                           'https://pay.invalid/g3'],
            payment_link_rows=[
                {'name': 'Sam Evans', 'url': 'https://pay.invalid/g1', 'amount_cents': 20000},
                {'name': 'Lucy Evans', 'url': 'https://pay.invalid/g2', 'amount_cents': 20000},
                {'name': 'Tom Evans', 'url': 'https://pay.invalid/g3', 'amount_cents': 20000},
            ])
        filled = sent(facts)
        for name, url in zip(facts['guest_names'], facts['payment_links']):
            self.assertIn(f'{name}: {url}', filled)

    def test_remaining_balance_requires_model_wording_and_checkout_settlement(self):
        facts = dict(FACTS, remains_owed_cents=40000,
                     balance_settlement='checkout')
        self.assertFalse(accepted_quote._confirmation_has_all_facts(VALID, facts))
        english = VALID.replace('.\n{payment_link}',
                                '; {balance} remains and is paid at checkout.\n{payment_link}')
        filled = sent(facts, english)
        self.assertIn('€400.00', filled)
        self.assertIn('paid at checkout', filled)

        spanish_facts = dict(facts, rewrite_context={'language': 'es'})
        spanish = ('Reserva {ref} para {guest_names}, del {check_in} al {check_out}, '
                   'habitación {room}, total {total}, depósito {deposit}; quedan {balance} '
                   'y se pagan al hacer el check-out.\n{payment_link}')
        self.assertTrue(accepted_quote._confirmation_has_all_facts(spanish, spanish_facts))

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

    def test_amounts_are_filled_from_saved_cents_not_nearby_text(self):
        facts = dict(FACTS, total_cents=100, deposit_cents=200)
        filled = sent(facts)
        self.assertEqual(filled.count('€1.00'), 1)
        self.assertEqual(filled.count('€2.00'), 1)
        self.assertFalse(accepted_quote._confirmation_has_all_facts(
            VALID + ' total 10.00', facts))

    def test_due_now_is_not_a_second_money_slot(self):
        facts = dict(FACTS, amount_due_now_cents=10000)
        self.assertTrue(accepted_quote._confirmation_has_all_facts(VALID, facts))
        self.assertFalse(accepted_quote._confirmation_has_all_facts(
            VALID + ' now due 100.00 EUR', facts))

    def test_room_slot_is_the_saved_label(self):
        facts = dict(FACTS, room_type='private')
        self.assertTrue(accepted_quote._confirmation_has_all_facts(VALID, facts))
        self.assertEqual(sent(facts).count('M1'), 1)
        self.assertFalse(accepted_quote._confirmation_has_all_facts(
            VALID + ' room 99', facts))

    def test_money_roles_reject_extra_negative_and_swapped_amounts(self):
        facts = dict(FACTS, total_cents=49900, deposit_cents=10000)
        filled = sent(facts)
        self.assertEqual(filled.count('€499.00'), 1)
        self.assertEqual(filled.count('€100.00'), 1)
        self.assertFalse(accepted_quote._confirmation_has_all_facts(
            VALID + ' 499.50 EUR', facts))
        self.assertFalse(accepted_quote._confirmation_has_all_facts(
            VALID + ' -499.00 EUR', facts))
        self.assertFalse(accepted_quote._confirmation_has_all_facts(
            VALID + '\nTotal 100.00 EUR deposit 499.00 EUR', facts))

    def test_foreign_ref_name_date_and_room_fail_closed(self):
        facts = dict(FACTS, total_cents=49900, deposit_cents=10000)
        self.assertTrue(accepted_quote._confirmation_has_all_facts(VALID, facts))
        contradictions = (
            VALID + ' WH-9999',
            VALID.replace('{guest_names}', 'Other Person'),
            VALID.replace('{check_out}', '2026-11-06'),
            VALID + ' room X9',
            VALID.replace('{total}', '{total} {total}'),
        )
        for draft in contradictions:
            self.assertFalse(accepted_quote._confirmation_has_all_facts(draft, facts))

    def test_german_dotted_dates_are_filled_for_german(self):
        facts = dict(FACTS, rewrite_context={'language': 'de'})
        draft = ('Buchung {ref} für {guest_names}, {check_in} bis {check_out}, '
                 'Zimmer {room}, Gesamtpreis {total}, Anzahlung {deposit}.\n{payment_link}')
        filled = sent(facts, draft)
        self.assertIn('01.11.2026', filled)
        self.assertIn('05.11.2026', filled)
        self.assertIn('500,00 €', filled)
        self.assertIn('100,00 €', filled)
        self.assertTrue(accepted_quote._confirmation_has_all_facts(draft, facts))
        self.assertFalse(accepted_quote._confirmation_has_all_facts(VALID, facts))

    def test_solo_full_payment_deposit_slot_is_amount_due(self):
        facts = dict(FACTS, total_cents=12000, deposit_cents=10000,
                     amount_due_now_cents=12000)
        filled = sent(facts)
        self.assertIn('€120.00', filled)
        self.assertNotIn('€100.00', filled)
        self.assertTrue(accepted_quote._confirmation_has_all_facts(VALID, facts))

    def test_group_full_payment_separate_links_use_full_amount(self):
        facts = dict(
            FACTS,
            guest_names=['Ada Lovelace', 'Grace Hopper', 'Alan Turing'],
            total_cents=149700, deposit_cents=60000, amount_due_now_cents=149700,
            payment_links=['https://pay.invalid/a', 'https://pay.invalid/b',
                           'https://pay.invalid/c'],
        )
        filled = sent(facts)
        self.assertIn('€1497.00', filled)
        self.assertNotIn('€600.00', filled)
        for link in facts['payment_links']:
            self.assertIn(link, filled)

    def test_german_group_package_confirmation_requires_package_and_all_rooms(self):
        facts = dict(
            FACTS,
            guest_names=['Lukas Hoffmann', 'Sophie Hoffmann', 'Tim Hoffmann'],
            room=['R1-B4', 'R1-B5', 'R3-B4'], package='Uluwatu',
            total_cents=104700, deposit_cents=60000, amount_due_now_cents=60000,
            remains_owed_cents=44700,
            rewrite_context={'language': 'de'},
        )
        draft = (
            'Buchung {ref} ist für {guest_names} gespeichert.\n'
            'Daten: {check_in} bis {check_out}\n'
            'Betten: {room}\nPaket: {package}\n'
            'Gesamt: {total}\nAnzahlung: {deposit}\nRestbetrag: {balance}\n'
            '{payment_link}'
        )
        filled = accepted_quote._fill_confirmation_slots(draft, facts)
        self.assertIsNotNone(filled)
        self.assertIn('Lukas Hoffmann, Sophie Hoffmann und Tim Hoffmann', filled)
        self.assertIn('R1-B4, R1-B5, R3-B4', filled)
        self.assertIn('Paket: Uluwatu', filled)
        missing_package = draft.replace('\nPaket: {package}', '')
        self.assertFalse(accepted_quote._confirmation_has_all_facts(missing_package, facts))
        self.assertIn('missing_package',
                      accepted_quote._confirmation_reject_reasons(missing_package, facts))

    def test_german_group_rewrite_accepts_natural_noch_zu_zahlen_balance_label(self):
        facts = dict(
            FACTS,
            reference='WH-20261101-14898176',
            guest_names=['Anna Weber', 'Lisa Weber', 'Max Weber'],
            check_in='2026-11-01', check_out='2026-11-08',
            room=['R1-B4', 'R1-B5', 'R3-B4'], package='Uluwatu',
            total_cents=74700, deposit_cents=60000, amount_due_now_cents=60000,
            remains_owed_cents=14700, balance_settlement='checkout',
            payment_links=['https://pay.invalid/anna', 'https://pay.invalid/lisa',
                           'https://pay.invalid/max'],
            payment_link_rows=[
                {'name': 'Anna Weber', 'url': 'https://pay.invalid/anna'},
                {'name': 'Lisa Weber', 'url': 'https://pay.invalid/lisa'},
                {'name': 'Max Weber', 'url': 'https://pay.invalid/max'},
            ],
            rewrite_context={'language': 'de'},
        )
        rewritten = (
            'Eure Buchung {ref} ist gespeichert.\n'
            'Gäste: {guest_names}\n'
            'Daten: {check_in} bis {check_out}\n'
            'Betten: {room}\nPaket: {package}\n'
            'Gesamt: {total}\nAnzahlung: {deposit}\n'
            'Noch zu zahlen: {balance} beim Check-out.\n'
            '{payment_link}'
        )
        filled = accepted_quote._fill_confirmation_slots(rewritten, facts)
        self.assertIsNotNone(filled)
        self.assertTrue(accepted_quote._filled_confirmation_matches_facts(filled, facts),
                        accepted_quote._confirmation_reject_reasons(filled, facts))
        self.assertEqual(accepted_quote._sendable_saved_confirmation(filled, facts), filled)
        self.assertIn('Noch zu zahlen: 147,00 € beim Check-out.', filled)
        self.assertNotIn('Booked ', filled)
        for name in facts['guest_names']:
            self.assertIn(name, filled)
        for room in facts['room']:
            self.assertIn(room, filled)
        for row in facts['payment_link_rows']:
            self.assertIn(f"{row['name']}: {row['url']}", filled)

    def test_filled_confirmation_rejects_an_omitted_saved_package(self):
        facts = dict(FACTS, package='Uluwatu')
        complete = accepted_quote._fill_confirmation_slots(
            'Booked {ref} for {guest_names}, {check_in} to {check_out}, room {room}, '
            'package {package}, total {total}, deposit {deposit}.\n{payment_link}', facts)
        self.assertIsNotNone(complete)
        self.assertTrue(accepted_quote._filled_confirmation_matches_facts(complete, facts))
        self.assertFalse(accepted_quote._filled_confirmation_matches_facts(
            complete.replace(', package Uluwatu', ''), facts))

    def test_group_deposit_confirmation_shows_balance(self):
        facts = dict(
            FACTS,
            guest_names=['Ada Lovelace', 'Grace Hopper', 'Alan Turing'],
            total_cents=149700, deposit_cents=60000, amount_due_now_cents=60000,
            remains_owed_cents=89700,
            payment_links=['https://pay.invalid/a', 'https://pay.invalid/b',
                           'https://pay.invalid/c'],
        )
        with_balance = (
            'Booked WH-1644 for Ada Lovelace, Grace Hopper and Alan Turing, '
            'Sun 1 Nov to Thu 5 Nov, room M1, total €1497.00, deposit €600.00, '
            'balance €897.00.\nhttps://pay.invalid/a\nhttps://pay.invalid/b\n'
            'https://pay.invalid/c'
        )
        without_balance = (
            'Booked WH-1644 for Ada Lovelace, Grace Hopper and Alan Turing, '
            'Sun 1 Nov to Thu 5 Nov, room M1, total €1497.00, deposit €600.00.\n'
            'https://pay.invalid/a\nhttps://pay.invalid/b\nhttps://pay.invalid/c'
        )
        self.assertTrue(accepted_quote._confirmation_has_all_facts(with_balance, facts))
        self.assertTrue(accepted_quote._confirmation_has_all_facts(without_balance, facts))

    def test_package_code_projects_trusted_confirmation_label_without_optional_label(self):
        facts = accepted_quote._saved_confirmation_facts(
            {'check_in': '2026-11-01', 'check_out': '2026-11-05',
             'guests': [{'name': 'Anna Smith'}], 'package_code': 'uluwatu'},
            {'room_arrangement': [{'guest_safe_room_label': 'M1'}],
             'total_cents': 12000, 'deposit_required_cents': 10000,
             'package_code': 'uluwatu'},
            {'booking_code': 'WH-1644',
             'secure_payment_url': 'https://pay.invalid/WH-1644'})
        self.assertEqual(facts['package'], 'Uluwatu')

    def test_full_payment_receipt_deposit_slot_matches_link_amount(self):
        facts = accepted_quote._saved_confirmation_facts(
            {'check_in': '2026-11-01', 'check_out': '2026-11-05',
             'guests': [{'name': 'Anna Smith'}]},
            {'room_arrangement': [{'guest_safe_room_label': 'M1'}],
             'total_cents': 12000, 'deposit_required_cents': 10000},
            {'booking_code': 'WH-1644',
             'secure_payment_url': 'https://pay.invalid/WH-1644',
             'amount_due_cents': 12000,
             'guest_rooms': [{'guest_name': 'Anna Smith', 'number': 'M1',
                              'room_kind': 'private'}]})
        self.assertEqual(facts['amount_due_now_cents'], 12000)
        filled = accepted_quote._fill_confirmation_slots(VALID, facts)
        self.assertIn('€120.00', filled)
        self.assertNotIn('€100.00', filled)

    def test_group_full_payment_link_amounts_sum_to_due(self):
        links = [
            {'guest_name': 'Ada Lovelace', 'secure_payment_url': 'https://pay.invalid/a',
             'amount_due_cents': 49900},
            {'guest_name': 'Grace Hopper', 'secure_payment_url': 'https://pay.invalid/b',
             'amount_due_cents': 49900},
            {'guest_name': 'Alan Turing', 'secure_payment_url': 'https://pay.invalid/c',
             'amount_due_cents': 49900},
        ]
        facts = accepted_quote._saved_confirmation_facts(
            {'check_in': '2026-11-01', 'check_out': '2026-11-05',
             'guests': [{'name': row['guest_name']} for row in links]},
            {'room_arrangement': [{'guest_safe_room_label': 'M1'}],
             'total_cents': 149700, 'deposit_required_cents': 60000},
            {'booking_code': 'WH-1644', 'amount_due_cents': 149700,
             'guest_payment_links': links,
             'guest_rooms': [{'guest_name': 'Ada Lovelace', 'number': 'M1',
                              'room_kind': 'private'}]})
        self.assertEqual(facts['amount_due_now_cents'], 149700)
        filled = accepted_quote._fill_confirmation_slots(VALID, facts)
        self.assertIn('€1497.00', filled)
        self.assertNotIn('€600.00', filled)
        for row in links:
            self.assertIn(row['secure_payment_url'], filled)

    def test_staff_guest_rooms_projection_is_the_room_contract(self):
        facts = accepted_quote._saved_confirmation_facts(
            {'check_in': '2026-11-01', 'check_out': '2026-11-05',
             'guests': [{'name': 'Anna Smith'}]},
            {'room_arrangement': [], 'total_cents': 50000,
             'deposit_required_cents': 10000},
            {'booking_code': 'WH-1644', 'secure_payment_url': 'https://pay.invalid/x',
             'guest_rooms': [{'guest_name': 'Anna Smith', 'number': '12',
                              'room_kind': 'private'}]})
        self.assertEqual(facts['room'], ['12'])
        self.assertEqual(facts['room_type'], 'private')

    def test_rewrite_context_carries_explicit_date_style(self):
        facts = accepted_quote._saved_confirmation_facts(
            {'check_in': '2026-11-01', 'check_out': '2026-11-05', 'guests': [],
             'language': 'de', 'personality_style': 'warm', 'date_style': 'DMY'},
            {'room_arrangement': [], 'total_cents': 50000,
             'deposit_required_cents': 10000},
            {'booking_code': 'WH-1644'})
        self.assertEqual(facts['rewrite_context'], {
            'language': 'de', 'personality_style': 'warm', 'date_style': 'DMY'})


MAPS_URL = 'https://maps.app.goo.gl/oPRckhqozVBvXxL16'


class ConfirmationPolishM18Tests(unittest.TestCase):
    def test_internal_pay_tags_and_english_location_are_rejected(self):
        for language in ('de', 'es'):
            with self.subTest(language=language):
                facts = dict(FACTS, rewrite_context={'language': language})
                draft = ({
                    'de': ('Buchung {ref} für {guest_names}, {check_in} bis {check_out}, '
                           'Zimmer {room}, Gesamtpreis {total}, Anzahlung {deposit}.\n{payment_link}'),
                    'es': ('Reserva {ref} para {guest_names}, del {check_in} al {check_out}, '
                           'habitación {room}, total {total}, depósito {deposit}.\n{payment_link}'),
                })[language]
                filled = sent(facts, draft)
                self.assertFalse(accepted_quote._confirmation_has_all_facts(
                    filled.replace(
                        'https://pay.invalid/WH-1644',
                        'https://pay.invalid/WH-1644 (deposit)'), facts))
                self.assertFalse(accepted_quote._confirmation_has_all_facts(
                    filled.replace(
                        'https://pay.invalid/WH-1644',
                        'https://pay.invalid/WH-1644 (full)'), facts))
                self.assertFalse(accepted_quote._confirmation_has_all_facts(
                    filled + f'\n📍 Here is our Location: {MAPS_URL}', facts))

    def test_wrong_stated_balance_is_still_rejected(self):
        facts = dict(FACTS, remains_owed_cents=44700, amount_due_now_cents=10000,
                     total_cents=54700)
        wrong = (
            'Booked WH-1644 for Anna Smith, Sun 1 Nov to Thu 5 Nov, room M1, '
            'total €547.00, deposit €100.00, balance €1.00.\n'
            'https://pay.invalid/WH-1644'
        )
        self.assertFalse(accepted_quote._confirmation_has_all_facts(wrong, facts))

    def test_extra_private_draft_naming_real_room_is_kept(self):
        facts = dict(
            FACTS, room=['R2'], room_type='private',
            rewrite_context={'language': 'en', 'personality_style': 'extra'})
        original = (
            '🎉 Booked WH-1644 for Anna Smith\n'
            '📅 Sun 1 Nov to Thu 5 Nov\n'
            '🏠 room R2\n'
            '💶 total €500.00, deposit €100.00\n'
            '🔗 https://pay.invalid/WH-1644'
        )
        self.assertTrue(accepted_quote._confirmation_has_all_facts(original, facts))
        self.assertEqual(
            accepted_quote._sendable_saved_confirmation(original, facts), original)
        self.assertIn('🎉', original)
        self.assertIn('R2', original)


class OwedConfirmationRecoveryTests(unittest.TestCase):
    def test_owed_contract_recovers_without_ephemeral_receipt_or_checked_offer(self):
        state = {'plan': {'language': 'de'}, 'confirmation_owed': deepcopy(FACTS)}
        result = {'completed': True, 'final_response': VALID,
                  'messages': [{'role': 'assistant', 'content': VALID}]}
        callback = Mock(return_value=None)
        with patch.object(accepted_quote, '_transaction',
                          side_effect=lambda fn: fn(state, {
                              'MESSAGE_ID': 'next', 'tenant': 'wolfhouse-somo'})):
            output = accepted_quote.finalize_offer_response(result, callback)
        self.assertIsNone(output['final_response'])
        self.assertTrue(output['confirmation_withheld'])
        self.assertIn('confirmation_owed', state)
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
            self.assertNotIn('tools', create.call_args.kwargs)
            self.assertNotIn('tool_choice', create.call_args.kwargs)
            payload = json.loads(create.call_args.kwargs['messages'][1]['content'])
            guide = payload['booking_confirmation_guide']
            self.assertIn('every guest name', guide)
            self.assertIn('selected Staff personality style', guide)
            self.assertIn('self-selected emoji', guide)
            agent._close_request_openai_client.assert_called_once_with(client)
        finally:
            conversation_loop.run_conversation = prior
            accepted_quote.close_turn()
    def test_failed_rewrite_status_survives_following_non_confirmation_turn(self):
        from agent import conversation_loop
        from wolfhouse import original_inbound

        normal_loop = Mock(return_value={
            'completed': True, 'final_response': 'Gern geschehen!',
            'messages': [{'role': 'assistant', 'content': 'Gern geschehen!'}],
        })
        agent = SimpleNamespace(
            model='offline-model', api_mode='chat_completions',
            _create_request_openai_client=Mock(side_effect=AssertionError('ordinary turn must not rewrite')),
            _close_request_openai_client=Mock(), session_id='s')
        inbound = SimpleNamespace(lock=RLock(), text='Danke.')
        state = {'confirmation_owed': deepcopy(FACTS),
                 'plan': {'language': 'de'}, 'status': 'accepted'}
        booking_handler = Mock(side_effect=AssertionError('booking must not run'))
        ingress = {'MESSAGE_ID': 'retry', 'tenant': 'wolfhouse-somo'}

        def bind_owner(bound_agent, _text):
            accepted_quote._current.set(accepted_quote.TurnCapability(
                bound_agent, None, None, None))

        prior = conversation_loop.run_conversation
        prior_create = accepted_quote._registered_create
        try:
            with patch.object(accepted_quote, '_transaction',
                              side_effect=lambda fn: fn(state, ingress)):
                first = accepted_quote.finalize_offer_response(
                    {'completed': True, 'final_response': VALID,
                     'messages': [{'role': 'assistant', 'content': VALID}]},
                    Mock(side_effect=['', '']))
            self.assertTrue(first['confirmation_withheld'])
            self.assertEqual(first['confirmation_status']['booking_reference'], 'WH-1644')

            conversation_loop.run_conversation = normal_loop
            accepted_quote._registered_create = booking_handler
            with patch.object(original_inbound, 'consume', return_value=inbound), \
                    patch.object(accepted_quote, 'observe_owner_turn', side_effect=bind_owner), \
                    patch.object(accepted_quote, '_transaction',
                                 side_effect=lambda fn: fn(state, ingress)), \
                    self.assertLogs(accepted_quote.logger, level='WARNING') as logs:
                accepted_quote.install_owner_hook()
                output = conversation_loop.run_conversation(agent, inbound.text)
            self.assertEqual(output['final_response'], 'Gern geschehen!')
            self.assertTrue(output['confirmation_withheld'])
            self.assertEqual(output['confirmation_status'], {
                'status': 'owed', 'booking_reference': 'WH-1644',
                'reason': 'confirmation_rewrite_failed',
            })
            self.assertIn('confirmation_owed reference=WH-1644', '\n'.join(logs.output))
            self.assertIn('confirmation_owed', state)
            normal_loop.assert_called_once()
            booking_handler.assert_not_called()
            agent._create_request_openai_client.assert_not_called()
        finally:
            conversation_loop.run_conversation = prior
            accepted_quote._registered_create = prior_create
            accepted_quote.close_turn()


if __name__ == '__main__':
    unittest.main()
