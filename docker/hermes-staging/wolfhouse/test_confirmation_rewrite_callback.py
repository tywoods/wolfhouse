"""Focused contracts for model-written, fact-checked post-save confirmations."""
import inspect
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from wolfhouse import accepted_quote

MAP = 'https://maps.app.goo.gl/oPRckhqozVBvXxL16'
BASE = {
    'reference': 'WH-20270310-13389959',
    'guest_names': ['Kathi', 'Jamie'],
    'check_in': '2027-03-10',
    'check_out': '2027-03-17',
    'room': ['Uluwatu'],
    'total_cents': 69800,
    'deposit_cents': 40000,
    'amount_due_now_cents': 40000,
    'remains_owed_cents': 29800,
    'balance_settlement': 'checkout',
    'payment_links': ['https://pay.invalid/kathi', 'https://pay.invalid/jamie'],
    'location_url': MAP,
    'rewrite_context': {'language': 'de'},
}
GERMAN = (
    'Eure Buchung WH-20270310-13389959 für Kathi und Jamie ist gespeichert. '
    'Check-in 10.03.2027, Check-out 17.03.2027, Zimmer Uluwatu. '
    'Gesamtpreis 698,00 €, Anzahlung 400,00 €, Restbetrag 298,00 € bei der Abreise.\n'
    'Kathi: https://pay.invalid/kathi\nJamie: https://pay.invalid/jamie\n'
    f'Anfahrt: {MAP}'
)
ENGLISH_FACTS = dict(
    BASE,
    reference='WH-20270402-20001111', guest_names=['Alex', 'Robin'],
    check_in='2027-04-02', check_out='2027-04-06', room=['Mavericks'],
    total_cents=52000, deposit_cents=20000, amount_due_now_cents=20000,
    remains_owed_cents=32000,
    payment_links=['https://pay.invalid/alex', 'https://pay.invalid/robin'],
    rewrite_context={'language': 'en'},
)
ENGLISH = (
    'Booking WH-20270402-20001111 is saved for Alex and Robin, 2 Apr 2027 to 6 Apr 2027, '
    'room Mavericks. Total €520.00, deposit €200.00, balance €320.00 paid at checkout.\n'
    'Alex: https://pay.invalid/alex\nRobin: https://pay.invalid/robin\n'
    f'Location: {MAP}'
)
SPANISH_FACTS = dict(
    BASE,
    reference='WH-20270501-30001111', guest_names=['Lucía'],
    check_in='2027-05-01', check_out='2027-05-04', room=['Somo'],
    total_cents=18000, deposit_cents=6000, amount_due_now_cents=6000,
    remains_owed_cents=12000,
    payment_links=['https://pay.invalid/lucia'], rewrite_context={'language': 'es'},
)
SPANISH = (
    'Reserva WH-20270501-30001111 guardada para Lucía, del 1 may 2027 al 4 may 2027, '
    'habitación Somo. Total 180,00 €, depósito 60,00 €, saldo 120,00 € al salir.\n'
    'https://pay.invalid/lucia\n'
    f'Ubicación: {MAP}'
)


class FactCheckerTests(unittest.TestCase):
    def test_accepts_complete_german_confirmation(self):
        self.assertEqual(accepted_quote._confirmation_reject_reasons(GERMAN, BASE), [])
        self.assertEqual(accepted_quote._sendable_saved_confirmation(GERMAN, BASE), GERMAN)

    def test_accepts_complete_english_confirmation(self):
        self.assertEqual(accepted_quote._confirmation_reject_reasons(ENGLISH, ENGLISH_FACTS), [])

    def test_accepts_complete_spanish_confirmation(self):
        self.assertEqual(accepted_quote._confirmation_reject_reasons(SPANISH, SPANISH_FACTS), [])

    def test_placeholders_are_never_sendable(self):
        self.assertIsNone(accepted_quote._sendable_saved_confirmation(
            'Buchung {ref} für {guest_names}', BASE))

    def test_specific_balance_and_checkout_reasons(self):
        text = GERMAN.replace('Restbetrag 298,00 € bei der Abreise.', '')
        reasons = accepted_quote._confirmation_reject_reasons(text, BASE)
        self.assertIn('remaining_balance_not_stated:298,00 €', reasons)
        self.assertIn('missing_checkout_settlement_wording', reasons)

    def test_specific_name_room_link_and_map_reasons(self):
        text = GERMAN.replace('Jamie', 'Gast').replace('Uluwatu', 'Andere')
        text = text.replace('https://pay.invalid/jamie', 'https://pay.invalid/wrong')
        text = text.replace(MAP, MAP + 'x')
        reasons = accepted_quote._confirmation_reject_reasons(text, BASE)
        self.assertIn('missing_guest_name:Jamie', reasons)
        self.assertIn('missing_room:Uluwatu', reasons)
        self.assertIn('missing_payment_link:https://pay.invalid/jamie', reasons)
        self.assertIn('missing_location', reasons)

    def test_wrong_total_or_deposit_is_rejected(self):
        self.assertIsNone(accepted_quote._sendable_saved_confirmation(
            GERMAN.replace('698,00 €', '699,00 €'), BASE))
        self.assertIsNone(accepted_quote._sendable_saved_confirmation(
            GERMAN.replace('400,00 €', '401,00 €'), BASE))

    def test_package_wording_is_not_a_rigid_gate(self):
        self.assertEqual(accepted_quote._confirmation_reject_reasons(
            GERMAN.replace('Zimmer Uluwatu', 'Zimmer Uluwatu, Surf-Paket nach Auswahl'), BASE), [])


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
        return agent, create

    def test_codex_uses_hermes_normal_stream_consumer(self):
        agent, create = self._agent('codex_responses')
        with patch.object(accepted_quote, '_run_codex_confirmation_stream',
                          return_value=GERMAN) as streamed:
            self.assertEqual(accepted_quote._rewrite_saved_confirmation(
                agent, BASE, 'bad'), GERMAN)
        streamed.assert_called_once()
        create.assert_not_called()
        source = inspect.getsource(accepted_quote._run_codex_confirmation_stream)
        self.assertIn('run_codex_stream', source)
        self.assertIn("'store': False", source)
        self.assertNotIn("'tools'", source)
        self.assertNotIn("'tool_choice'", source)
        agent._close_request_openai_client.assert_called_once()

    def test_chat_request_is_tool_free(self):
        result = SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=ENGLISH))])
        agent, create = self._agent('chat_completions', result)
        self.assertEqual(accepted_quote._rewrite_saved_confirmation(
            agent, ENGLISH_FACTS, 'bad'), ENGLISH)
        request = create.call_args.kwargs
        self.assertFalse(request['stream'])
        self.assertNotIn('tools', request)
        self.assertNotIn('tool_choice', request)

    def test_retry_receives_specific_checker_reasons(self):
        incomplete = GERMAN.replace('Restbetrag 298,00 € bei der Abreise.', '')
        calls = []
        def streamed(_agent, _client, messages, _timeout):
            calls.append(messages)
            return incomplete if len(calls) == 1 else GERMAN
        agent, _create = self._agent('codex_responses')
        with patch.object(accepted_quote, '_run_codex_confirmation_stream',
                          side_effect=streamed):
            self.assertEqual(accepted_quote._rewrite_saved_confirmation(
                agent, BASE, 'bad'), GERMAN)
        retry = json.loads(calls[1][1]['content'])
        self.assertIn('remaining_balance_not_stated:298,00 €', retry['reject_reasons'])
        self.assertIn('missing_checkout_settlement_wording', retry['reject_reasons'])

    def test_transport_errors_are_logged_and_backup_receives_reasons(self):
        agent, _create = self._agent('codex_responses')
        with patch.object(accepted_quote, '_run_codex_confirmation_stream',
                          side_effect=RuntimeError('provider rejected')), patch.object(
                              accepted_quote, '_rewrite_saved_confirmation_with_grok',
                              return_value=GERMAN) as backup, self.assertLogs(
                                  accepted_quote.logger, level='WARNING') as logs:
            self.assertEqual(accepted_quote._rewrite_saved_confirmation(
                agent, BASE, 'bad'), GERMAN)
        self.assertTrue(any('detail=provider rejected' in line for line in logs.output))
        self.assertEqual(backup.call_count, 1)

    def test_payload_forbids_templates_and_placeholders(self):
        payload = accepted_quote._confirmation_rewrite_payload(BASE, 'bad', ['missing_reference'])
        guide = payload['booking_confirmation_guide'] + payload['requirements']
        self.assertIn('natural wording', guide)
        self.assertIn('placeholders are forbidden', guide)
        self.assertNotIn('exactly once', guide)


class NoFallbackTests(unittest.TestCase):
    def test_finalizer_has_no_fixed_fallback_call(self):
        source = inspect.getsource(accepted_quote.finalize_offer_response)
        self.assertNotIn('_saved_confirmation_fallback_template', source)
        self.assertNotIn('_fill_confirmation_slots', source)

    def test_failed_generation_is_not_sendable(self):
        self.assertIsNone(accepted_quote._sendable_saved_confirmation('', BASE))
        self.assertIsNone(accepted_quote._sendable_saved_confirmation('bad draft', BASE))


if __name__ == '__main__':
    unittest.main()
