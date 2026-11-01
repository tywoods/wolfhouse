"""Focused contracts for model-written, fact-checked post-save confirmations."""
import inspect
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from wolfhouse_staff_api import _extract_booking_write_fields
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


class ProviderAcceptanceProjectionTests(unittest.TestCase):
    def test_staff_ledger_reconciliation_retires_only_accepted_projection(self):
        state = {
            'confirmation_owed': {'booking_id': 'booking-1', 'reference': 'WH-1'},
            'confirmation_owed_status': {'status': 'ready_to_send'},
        }
        api = SimpleNamespace(_confirmation_owed_open=lambda **_kwargs: {
            'success': True,
            'owed': [{'booking_id': 'booking-1', 'provider_message_id': 'wamid.1'}],
        })
        with patch.dict('sys.modules', {'wolfhouse_staff_api': api}):
            self.assertTrue(accepted_quote._reconcile_confirmation_owed_with_staff(state))
        self.assertNotIn('confirmation_owed', state)
        self.assertEqual(state['confirmation_provider_acceptance']['provider_message_id'], 'wamid.1')

    def test_staff_ledger_reconciliation_does_not_clear_on_absent_row(self):
        state = {'confirmation_owed': {'booking_id': 'booking-1', 'reference': 'WH-1'}}
        api = SimpleNamespace(_confirmation_owed_open=lambda **_kwargs: {
            'success': True, 'owed': [],
        })
        with patch.dict('sys.modules', {'wolfhouse_staff_api': api}):
            self.assertFalse(accepted_quote._reconcile_confirmation_owed_with_staff(state))
        self.assertIn('confirmation_owed', state)

    def test_staff_ledger_reconciliation_keeps_unaccepted_debt(self):
        state = {'confirmation_owed': {'booking_id': 'booking-1', 'reference': 'WH-1'}}
        api = SimpleNamespace(_confirmation_owed_open=lambda **_kwargs: {
            'success': True,
            'owed': [{'booking_id': 'booking-1', 'provider_message_id': None}],
        })
        with patch.dict('sys.modules', {'wolfhouse_staff_api': api}):
            self.assertFalse(accepted_quote._reconcile_confirmation_owed_with_staff(state))
        self.assertIn('confirmation_owed', state)


class RewriteFailureRecoveryTests(unittest.TestCase):
    def test_rewrite_failure_uses_runtime_confirmation_recovery_authority(self):
        with patch(
            'wolfhouse.explicit_human_handoff.flag_blocked_saved_confirmation',
            return_value=True,
        ) as flag:
            result = accepted_quote._mark_confirmation_needs_human(
                {'reference': 'WH-20270310-13389959'},
                ['missing_payment_link:https://pay.invalid/kathi'],
            )
        flag.assert_called_once_with('confirmation_rewrite_failed:missing_payment_link')
        self.assertTrue(result['success'])
        self.assertTrue(result['needs_human'])


class FactCheckerTests(unittest.TestCase):
    def test_accepts_language_free_exact_fact_contract_in_de_en_es(self):
        drafts = (
            f'WH-20270310-13389959 · EUR698 · 400 EUR · 298,00 EUR\n'
            f'https://pay.invalid/kathi\nhttps://pay.invalid/jamie\n{MAP},',
            f'WH-20270310-13389959 — €698.00 / EUR400 / 298 EUR\n'
            f'https://pay.invalid/kathi\nhttps://pay.invalid/jamie\n{MAP}',
            f'WH-20270310-13389959 | 698 EUR | EUR 400 | 298,00 €\n'
            f'https://pay.invalid/kathi\nhttps://pay.invalid/jamie\n{MAP}.',
        )
        for draft in drafts:
            with self.subTest(draft=draft):
                self.assertEqual(accepted_quote._confirmation_reject_reasons(draft, BASE), [])

    def test_wrong_prefix_extended_pay_link_and_negative_amounts_fail(self):
        good = GERMAN
        for bad in (
            good.replace('https://pay.invalid/kathi', 'https://pay.invalid/wrong'),
            good.replace('https://pay.invalid/kathi', 'https://pay.invalid/kathi-extra'),
            good.replace('698,00 €', '699,00 €'),
            good.replace('698,00 €', '-698,00 €'),
            good.replace('400,00 €', '-400,00 €'),
            good.replace('298,00 €', '-298,00 €'),
        ):
            with self.subTest(bad=bad):
                self.assertIsNone(accepted_quote._sendable_saved_confirmation(bad, BASE))

    def test_ascii_and_typographic_negative_amounts_fail_but_positive_total_passes(self):
        for original in ('698,00 €', '400,00 €', '298,00 €'):
            for marker in ('-', '−', '–', '—', '﹣', '－', '⁻', '₋'):
                with self.subTest(original=original, marker=marker):
                    text = GERMAN.replace(original, marker + original)
                    self.assertIsNone(
                        accepted_quote._sendable_saved_confirmation(text, BASE))
        self.assertEqual(
            accepted_quote._sendable_saved_confirmation(GERMAN, BASE), GERMAN)

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

    def test_specific_balance_reason_is_fact_only(self):
        text = GERMAN.replace('Restbetrag 298,00 € bei der Abreise.', '')
        reasons = accepted_quote._confirmation_reject_reasons(text, BASE)
        self.assertIn('remaining_balance_not_stated:298,00 €', reasons)
        self.assertNotIn('missing_checkout_settlement_wording', reasons)

    def test_accepts_arbitrary_money_language_order_and_date_format(self):
        text = (
            f'{MAP}\nhttps://pay.invalid/jamie\n'
            'Ohne Labels: EUR298 / 10. März 2027 / Jamie / Uluwatu / EUR698. '
            'WH-20270310-13389959; 17 Maerz 2027; Kathi; 400 EUR; '
            'https://pay.invalid/kathi'
        )
        self.assertEqual(accepted_quote._confirmation_reject_reasons(text, BASE), [])
        self.assertEqual(accepted_quote._sendable_saved_confirmation(text, BASE), text)

    def test_money_roles_and_checkout_phrasing_are_not_policed(self):
        text = GERMAN.replace(
            'Gesamtpreis 698,00 €, Anzahlung 400,00 €, Restbetrag 298,00 € bei der Abreise.',
            '400 EUR, danach 698 EUR und außerdem 298 EUR.')
        self.assertEqual(accepted_quote._confirmation_reject_reasons(text, BASE), [])

    def test_checker_does_not_police_language_or_internal_word_shape(self):
        text = GERMAN.replace('Eure Buchung', 'Your reservation (deposit)')
        self.assertEqual(accepted_quote._confirmation_reject_reasons(text, BASE), [])

    def test_specific_link_and_map_reasons(self):
        text = GERMAN.replace('Jamie', 'Gast').replace('Uluwatu', 'Andere')
        text = text.replace('https://pay.invalid/jamie', 'https://pay.invalid/wrong')
        text = text.replace(MAP, MAP + 'x')
        reasons = accepted_quote._confirmation_reject_reasons(text, BASE)
        self.assertNotIn('missing_guest_name:Jamie', reasons)
        self.assertNotIn('missing_room:Uluwatu', reasons)
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

    def test_saved_projection_binds_mixed_packages_and_rooms_by_staff_identity(self):
        plan = {
            'guests': [{'name': 'Alex'}, {'name': 'Alex'}, {'name': 'Robin'}],
            'check_in': '2027-06-01', 'check_out': '2027-06-08',
            'package_code': 'malibu',
        }
        offer = {
            'total_cents': 90000, 'deposit_required_cents': 50000,
            'room_arrangement': [{'bed_code': 'R3-B1'}],
            'package_label': 'Malibu',
        }
        receipt = {
            'booking_code': 'WH-MIXED', 'amount_due_cents': 50000,
            'booking_guests': [
                {'booking_guest_id': 'g-1', 'guest_number': 1, 'guest_name': 'Alex One'},
                {'booking_guest_id': 'g-2', 'guest_number': 2, 'guest_name': 'Alex Two'},
                {'booking_guest_id': 'g-3', 'guest_number': 3, 'guest_name': 'Robin',
                 'assigned_bed_code': 'R3-B3'},
            ],
            # Deliberately shuffled: array position and duplicate first names are unsafe joins.
            'per_person': [
                {'booking_guest_id': 'g-3', 'guest_number': 3,
                 'package_code': 'package_none'},
                {'booking_guest_id': 'g-1', 'guest_number': 1,
                 'package_code': 'malibu', 'package_label': 'Malibu'},
                {'booking_guest_id': 'g-2', 'guest_number': 2,
                 'package_code': 'pipeline', 'package_label': 'Pipeline Explorer'},
            ],
            'guest_rooms': [
                {'booking_guest_id': 'g-2', 'guest_number': 2,
                 'room_id': 'room-b', 'room_name': 'Garden Loft'},
                {'booking_guest_id': 'g-1', 'guest_number': 1,
                 'room_id': 'room-a', 'room_name': 'The Lighthouse'},
            ],
            'room_arrangement': [
                {'bed_code': 'R3-B3', 'room_code': 'R3',
                 'guest_safe_room_label': 'Garden Loft'},
            ],
        }

        facts = accepted_quote._saved_confirmation_facts(plan, offer, receipt)

        self.assertNotIn('package', facts)
        self.assertEqual({'The Lighthouse', 'Garden Loft'}, set(facts['room']))
        self.assertEqual([
            ('g-1', 'Alex One', 'Malibu', False, 'The Lighthouse'),
            ('g-2', 'Alex Two', 'Pipeline Explorer', False, 'Garden Loft'),
            ('g-3', 'Robin', None, True, 'Garden Loft'),
        ], [
            (row.get('booking_guest_id'), row.get('name'), row.get('package_label'),
             row.get('accommodation_only'), row.get('room_label'))
            for row in facts['guest_presentations']
        ])

    def test_uniform_saved_packages_keep_aggregate_summary_fact(self):
        facts = accepted_quote._saved_confirmation_facts(
            {'guests': [{'name': 'A'}, {'name': 'B'}]},
            {'package_label': 'Wrong stale offer', 'room_arrangement': []},
            {'booking_code': 'WH-UNIFORM',
             'booking_guests': [
                 {'booking_guest_id': 'g1', 'guest_number': 1, 'guest_name': 'A'},
                 {'booking_guest_id': 'g2', 'guest_number': 2, 'guest_name': 'B'}],
             'per_person': [
                 {'booking_guest_id': 'g2', 'guest_number': 2,
                  'package_code': 'reef', 'package_label': 'Reef Week'},
                 {'booking_guest_id': 'g1', 'guest_number': 1,
                  'package_code': 'reef', 'package_label': 'Reef Week'}]})
        self.assertEqual('Reef Week', facts['package'])

    def test_register_survives_saved_facts_for_initial_and_retry_authoring(self):
        for key, value in (('register', 'formal_sie'),
                           ('guest_register', 'formal_usted'),
                           ('address_register', 'informal_du')):
            with self.subTest(key=key):
                facts = accepted_quote._saved_confirmation_facts(
                    {key: value, 'language': 'de'}, {}, {'booking_code': 'WH-R'})
                self.assertEqual(facts['rewrite_context']['register'], value)

    def test_real_staff_room_projection_reaches_saved_confirmation(self):
        repo = Path(__file__).resolve().parents[3]
        script = """
const {projectGuestRooms} = require('./scripts/lib/staff-guest-room-state');
const rows = projectGuestRooms(
  [{booking_guest_id:'g-1', guest_number:1, guest_name:'Alex', assigned_room_code:'R3'}],
  {R3:{capacity:4, type:'mixed'}},
  {per_person:[]});
process.stdout.write(JSON.stringify(rows));
"""
        guest_rooms = json.loads(subprocess.run(
            ['node', '-e', script], cwd=repo, check=True,
            text=True, capture_output=True).stdout)
        facts = accepted_quote._saved_confirmation_facts(
            {'guests': [{'name': 'Alex'}]}, {}, {
                'booking_code': 'WH-ROOM',
                'booking_guests': [{
                    'booking_guest_id': 'g-1', 'guest_number': 1,
                    'guest_name': 'Alex'}],
                'per_person': [{
                    'booking_guest_id': 'g-1', 'guest_number': 1,
                    'package_code': 'package_none'}],
                'guest_rooms': guest_rooms,
            })
        self.assertEqual(facts['room'], ['R3'])
        self.assertEqual(
            facts['guest_presentations'][0]['room_label'], 'R3')

    def test_real_create_caller_projects_assigned_room_into_confirmation(self):
        repo = Path(__file__).resolve().parents[3]
        script = r"""
const assert = require('node:assert/strict');
const fs = require('node:fs');
const createSource = fs.readFileSync(
  './scripts/lib/luna-front-desk-accommodation-booking-create-service.js', 'utf8');
assert.match(createSource,
  /result\.guest_rooms = projectCreatedGuestRooms\(\s*result\._booking_guests, bedAssignments, quote/);
const {loadConfig} = require('./scripts/lib/wolfhouse-quote-calculator');
const {projectCreatedGuestRooms} = require('./scripts/lib/luna-front-desk-accommodation-booking-create-service');
const cfg = loadConfig();
assert.equal(cfg.rooming, undefined);
assert.equal(cfg.rooms, undefined);
const bookingGuests = [
  {booking_guest_id:'g-1', guest_number:1, guest_name:'Tom',
   assigned_room_code:'R3', assigned_bed_code:'R3-B1'}
];
const perPerson = [{guest_number:1, package_code:'package_none'}];
const guestRooms = projectCreatedGuestRooms(bookingGuests, [
  {guest_number:1, room_code:'R3', bed_code:'R3-B1'}
], {per_person:perPerson});
process.stdout.write(JSON.stringify({
  guest_rooms:guestRooms, booking_guests:bookingGuests, per_person:perPerson
}));
"""
        created = json.loads(subprocess.run(
            ['node', '-e', script], cwd=repo, check=True, text=True,
            capture_output=True).stdout)
        self.assertEqual(created['guest_rooms'][0]['room_label'], 'R3')
        self.assertNotEqual(created['guest_rooms'][0]['room_label'], 'R3-B1')
        fields = _extract_booking_write_fields({
            'success': True,
            'create_outcome': {'create_response': created},
        })
        facts = accepted_quote._saved_confirmation_facts({}, {}, fields)
        self.assertEqual(facts['room'], ['R3'])
        self.assertEqual(
            facts['guest_presentations'][0]['room_label'], 'R3')

    def test_checked_plan_preserves_all_register_aliases(self):
        from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
        for key, value in (('register', 'formal_sie'),
                           ('guest_register', 'formal_usted'),
                           ('address_register', 'informal_du')):
            with self.subTest(key=key):
                plan = {
                    'check_in': '2027-06-01', 'check_out': '2027-06-08',
                    'guest_count': 2, 'package_code': 'malibu',
                    'room_type': 'shared', 'payment_choice': 'deposit',
                    'language': 'de', key: value,
                    'guests': [{'name': 'A'}, {'name': 'B'}],
                }
                beds = [
                    {'bed_code': 'M1', 'room_code': 'M', 'gender_strategy': 'mixed'},
                    {'bed_code': 'M2', 'room_code': 'M', 'gender_strategy': 'mixed'},
                ]
                response = FirstYesOwnerTests._checked_offer(
                    object.__new__(FirstYesOwnerTests), plan, beds)
                checked = accepted_quote._checked_plan(
                    plan, response, 'wolfhouse-somo')
                self.assertEqual(checked[key], value)

    def test_fresh_mixed_projection_replaces_stale_confirmation_debt(self):
        owed = {
            'reference': 'WH-DEBT', 'package': 'Malibu',
            'room': ['R3-B1', 'R3-B2'],
            'guest_presentations': [{'name': 'Old', 'package_label': 'Malibu'}],
            'payment_links': ['https://pay.invalid/a'],
        }
        fresh = {
            'reference': 'WH-DEBT',
            'guest_presentations': [
                {'name': 'A', 'package_label': 'Malibu'},
                {'name': 'B', 'package_label': 'Uluwatu'},
            ],
            'room': ['Garden Loft'],
        }
        merged = accepted_quote._merge_confirmation_debt(owed, fresh)
        self.assertNotIn('package', merged)
        self.assertEqual(merged['room'], ['Garden Loft'])
        self.assertEqual(merged['guest_presentations'], fresh['guest_presentations'])
        self.assertEqual(merged['payment_links'], owed['payment_links'])


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
            _close_request_openai_client=Mock(
                side_effect=lambda _client, *, reason: None),
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
        agent._close_request_openai_client.assert_called_once_with(
            agent._create_request_openai_client.return_value,
            reason='saved-booking-confirmation-rewrite')

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
                          side_effect=streamed), patch.object(
                              accepted_quote, '_rewrite_saved_confirmation_with_grok') as backup:
            self.assertEqual(accepted_quote._rewrite_saved_confirmation(
                agent, BASE, 'bad'), GERMAN)
        backup.assert_not_called()
        retry = json.loads(calls[1][1]['content'])
        self.assertIn('remaining_balance_not_stated:298,00 €', retry['reject_reasons'])
        self.assertNotIn('missing_checkout_settlement_wording', retry['reject_reasons'])

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
    def test_post_model_cleanup_passes_saved_projection_to_finalizer(self):
        source = inspect.getsource(accepted_quote.install_owner_hook)
        self.assertIn("result.get('booking_result')", source)

    def test_finalizer_has_no_fixed_fallback_call(self):
        source = inspect.getsource(accepted_quote.finalize_offer_response)
        self.assertNotIn('_saved_confirmation_fallback_template', source)
        self.assertNotIn('_fill_confirmation_slots', source)

    def test_failed_generation_is_not_sendable(self):
        self.assertIsNone(accepted_quote._sendable_saved_confirmation('', BASE))
        self.assertIsNone(accepted_quote._sendable_saved_confirmation('bad draft', BASE))


if __name__ == '__main__':
    unittest.main()
