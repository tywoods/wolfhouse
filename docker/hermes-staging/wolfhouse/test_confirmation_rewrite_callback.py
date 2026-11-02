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


class FactCheckerTests(unittest.TestCase):
    def test_quote_checker_only_requires_authoritative_money_tokens(self):
        facts = {'total_cents': 69800, 'deposit_cents': 40000,
                 'amount_due_now_cents': 40000, 'remains_owed_cents': 29800}
        self.assertEqual(accepted_quote._quote_reject_reasons(
            'Whatever Luna likes: EUR 698 / 400 EUR / €298.', facts), [])
        self.assertEqual(accepted_quote._quote_reject_reasons(
            'No names, dates, room labels or question are required: €698, €400, €298.', facts), [])
        self.assertIn('missing_amount:69800', accepted_quote._quote_reject_reasons(
            'A lovely but numerically wrong card: €699, €400, €298.', facts))

    def test_quote_checker_requires_only_total_and_respects_grouped_whole_numbers(self):
        facts = {'total_cents': 116000, 'deposit_cents': 16000,
                 'amount_due_now_cents': 16000, 'remains_owed_cents': 100000}
        self.assertEqual(accepted_quote._quote_reject_reasons('Total: 1 160 €', facts), [])
        self.assertEqual(accepted_quote._quote_reject_reasons('Total: 1\u00a0160 €', facts), [])
        self.assertEqual(accepted_quote._quote_reject_reasons('Total: €1,160', facts), [])
        self.assertEqual(accepted_quote._quote_reject_reasons('Total: 1.160 €', facts), [])
        self.assertIn('missing_amount:116000',
                      accepted_quote._quote_reject_reasons('Total: 160 €', facts))

    def test_quote_authoring_payload_contains_complete_staff_revision(self):
        plan = {'check_in': '2027-03-10', 'check_out': '2027-03-17',
                'guest_count': 2, 'guests': [{'name': 'Kathi'}, {'name': 'Jamie'}]}
        offer = {**plan, 'currency': 'EUR', 'total_cents': 69800,
                 'deposit_required_cents': 40000, 'payment_link_amount_cents': 40000,
                 'room_arrangement': [{'room_code': 'R3', 'guest_safe_room_label': 'Uluwatu'}],
                 'guest_packages': [{'guest_number': 1, 'package_label': 'Malibu'}],
                 'add_ons': [{'code': 'yoga_class', 'quantity': 2}],
                 'payment_distribution': [{'guest_name': 'Kathi', 'amount_cents': 20000},
                                          {'guest_name': 'Jamie', 'amount_cents': 20000}]}
        facts = accepted_quote._quote_authoring_facts(plan, offer, 'de', create_ready=True)
        self.assertEqual(facts['check_in'], plan['check_in'])
        self.assertEqual(facts['rooms'][0]['guest_safe_room_label'], 'Uluwatu')
        self.assertEqual(facts['packages'][0]['package_label'], 'Malibu')
        self.assertEqual(facts['extras'][0]['code'], 'yoga_class')
        self.assertEqual(facts['total_cents'], 69800)
        self.assertEqual(facts['deposit_cents'], 40000)
        self.assertEqual(facts['amount_due_now_cents'], 40000)
        self.assertEqual(facts['remains_owed_cents'], 29800)
        self.assertEqual(len(facts['per_person_splits']), 2)

    def test_quote_authoring_keeps_decisions_splits_and_full_only_due_now(self):
        plan = {'shuttle_choice': 'declined', 'payment_link_distribution': 'per_guest'}
        offer = {'total_cents': 116000, 'deposit_required_cents': 40000,
                 'full_payment_only': True,
                 'per_guest_deposits': [{'guest_number': 1, 'amount_cents': 20000}]}
        facts = accepted_quote._quote_authoring_facts(plan, offer, create_ready=False)
        self.assertEqual(facts['amount_due_now_cents'], 116000)
        self.assertEqual(facts['remains_owed_cents'], 0)
        self.assertEqual(facts['shuttle_decision']['shuttle_choice'], 'declined')
        self.assertEqual(facts['payment_split'], 'per_guest')
        self.assertEqual(facts['per_guest_deposits'], offer['per_guest_deposits'])

    def test_quote_question_descriptor_uses_names_for_chosen_full_missing_names(self):
        plan = {'guest_count': 2, 'payment_choice': 'full'}
        revision = {
            'total_cents': 116000, 'payment_choice': 'full',
            'guest_bed_assignments': [
                {'guest_index': 0, 'guest_name': 'Kathi'},
                {'guest_index': 1, 'guest_name': None},
            ],
        }
        quote = {**revision, 'payment_choice_needed': False,
                 'full_payment_only': False, 'offer_revision': revision}
        facts = accepted_quote._quote_authoring_facts(
            plan, revision, 'en', create_ready=False, quote=quote)
        self.assertEqual(facts['pending_question'], {'kind': 'names', 'options': []})

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
  /const receiptFacts = projectStaffReceiptFacts\(\{[\s\S]*roomRows: liveRoomRows/);
assert.match(createSource, /result\.guest_rooms = receiptFacts\.guest_rooms/);
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

    def test_quote_primary_failure_provenance_survives_terminal_backup_failure(self):
        cases = (
            ('factory', SimpleNamespace(
                _create_request_openai_client=Mock(side_effect=RuntimeError('factory secret')),
                _close_request_openai_client=Mock()), 'primary_client_factory', 'RuntimeError'),
            ('transport', self._agent('chat_completions')[0],
             'primary_transport', 'RuntimeError'),
            ('validation', self._agent('chat_completions', SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content='wrong €1'))]))[0],
             'primary_validation', 'unknown_amount:100'),
        )
        cases[1][1]._create_request_openai_client.return_value.chat.completions.create.side_effect = RuntimeError('provider secret')
        for label, agent, primary_stage, primary_cause in cases:
            diagnostics = {}
            with self.subTest(label=label), patch.dict('os.environ', {}, clear=True):
                self.assertIsNone(accepted_quote._rewrite_quote_with_model(
                    agent, {'total_cents': 30000}, 'wrong €1', diagnostics=diagnostics))
            self.assertEqual(diagnostics['primary_stage'], primary_stage)
            self.assertIn(primary_cause, diagnostics['primary_cause'])
            self.assertEqual((diagnostics['stage'], diagnostics['cause']),
                             ('backup_unavailable', 'missing_key'))

        diagnostics = {'primary_stage': 'primary_transport', 'primary_cause': 'TimeoutError'}
        openai = SimpleNamespace(OpenAI=Mock(side_effect=RuntimeError('backup secret')))
        with patch.dict('sys.modules', {'openai': openai}), patch.dict(
                'os.environ', {'XAI_API_KEY': 'offline-key'}, clear=True):
            self.assertIsNone(accepted_quote._rewrite_quote_with_grok(
                {'total_cents': 30000}, None, ['missing_amount:30000'],
                diagnostics=diagnostics))
        self.assertEqual(diagnostics['primary_cause'], 'TimeoutError')
        self.assertEqual((diagnostics['stage'], diagnostics['cause']),
                         ('backup_transport', 'RuntimeError'))

    def test_quote_rewrite_catches_client_factory_failure(self):
        agent = SimpleNamespace(
            _create_request_openai_client=Mock(side_effect=RuntimeError('factory failed')),
            _close_request_openai_client=Mock())
        self.assertIsNone(accepted_quote._rewrite_quote_with_model(
            agent, {'total_cents': 30000}, 'old draft'))
        agent._close_request_openai_client.assert_not_called()

    def test_quote_primary_cleanup_failure_still_uses_grok_fallback(self):
        agent, _create = self._agent('chat_completions', SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='wrong €1'))]))
        agent._close_request_openai_client.side_effect = RuntimeError('cleanup failed')
        with patch.object(accepted_quote, '_rewrite_quote_with_grok',
                          return_value='Total €300') as backup:
            self.assertEqual(accepted_quote._rewrite_quote_with_model(
                agent, {'total_cents': 30000}, 'wrong €1'), 'Total €300')
        backup.assert_called_once()

    def test_quote_grok_cleanup_failure_keeps_valid_response(self):
        response = SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content='Total €300'))])
        client = SimpleNamespace(
            chat=SimpleNamespace(completions=SimpleNamespace(
                create=Mock(return_value=response))),
            close=Mock(side_effect=RuntimeError('cleanup failed')),
        )
        openai = SimpleNamespace(OpenAI=Mock(return_value=client))
        with patch.dict('sys.modules', {'openai': openai}), patch.dict(
                'os.environ', {'XAI_API_KEY': 'offline-key'}, clear=False):
            self.assertEqual(accepted_quote._rewrite_quote_with_grok(
                {'total_cents': 30000}, None, ['missing_amount:30000']), 'Total €300')

    def test_quote_rewrite_callback_exists_without_primary_client_capability(self):
        agent = SimpleNamespace(model='offline-model')
        callback = accepted_quote._quote_rewrite_callback(agent)
        self.assertTrue(callable(callback))
        with patch.object(accepted_quote, '_rewrite_quote_with_grok',
                          return_value='Total €300') as backup:
            self.assertEqual(callback({'total_cents': 30000}, 'wrong €1'), 'Total €300')
        backup.assert_called_once()

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
