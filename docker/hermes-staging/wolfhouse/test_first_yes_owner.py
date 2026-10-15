"""Focused owner units. Staff HTTP is substituted; no business persistence claim."""
import json
import os
import subprocess
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from hermes_state import SessionDB
from gateway.session_context import set_session_vars, clear_session_vars
from wolfhouse import accepted_quote as ledger
import wolfhouse_staff_api as plugin


class FirstYesOwnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.db.create_session('first-yes', source='whatsapp')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='first-yes')
        self.env = patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        self.env.start()
        self.tokens = None
        self.plan = dict(check_in='2026-11-01', check_out='2026-11-08', guest_count=2,
                         package_code='package_none', room_type='shared', room_preference='mixed',
                         guests=[{'name': 'Alex'}, {'name': 'Sam'}], payment_choice='full',
                         email='alex@example.test')
        root = Path(__file__).resolve().parents[3]
        source = "const {buildCheckedWolfhousePreviewOffer:b}=require('./scripts/lib/luna-front-desk-accommodation-availability-service'); console.log(JSON.stringify(b(JSON.parse(process.argv[1]))));"
        quote = dict(success=True, total_cents=70000, deposit_required_cents=20000,
                     payment_link_amount_cents=70000, currency='EUR', package_code='package_none')
        checked = json.loads(subprocess.check_output(['node', '-e', source, json.dumps(dict(
            client_slug='wolfhouse-somo', quote=quote, guests=self.plan['guests'],
            payment_choice='full', availability={**self.plan, 'status': 'checked',
            'selected_bed_codes': ['M1', 'M2']}, room_rows=[
                dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                dict(bed_code='M2', room_code='M', gender_strategy='mixed')]))], cwd=root))
        self.response = dict(success=True, total_cents=70000, deposit_required_cents=20000,
                             payment_choice_needed=False, currency='EUR', **checked)
        self.turn('q1', 'Quote this please')

    def tearDown(self):
        ledger.close_turn()
        if self.tokens:
            clear_session_vars(self.tokens)
        self.env.stop()
        self.db.close()
        self.temp.cleanup()

    def turn(self, message, raw):
        if self.tokens:
            clear_session_vars(self.tokens)
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='c1',
            user_id='g1', session_key='k1', session_id=self.agent.session_id, message_id=message)
        ledger.observe_owner_turn(self.agent, raw)

    def interpret_accept(self, evidence):
        return ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': evidence,
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {},
        })

    def test_only_owner_final_question_authorizes_contextual_yes(self):
        ledger.record_quote(self.plan, self.response)
        self.turn('not-presented', 'yes')
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})
        ledger.record_quote({}, self.response)
        finalize = getattr(ledger, 'finalize_offer_response', None)
        self.assertTrue(callable(finalize), 'missing owner final-response boundary')
        result = finalize({'completed': True, 'final_response': 'model says reserved',
                           'messages': [{'role': 'assistant', 'content': 'model says reserved'}]})
        self.assertNotIn('reserved', result['final_response'])
        self.assertIn('Alex', result['final_response'])
        self.assertNotIn('M1', result['final_response'])
        self.assertIn('Alex and Sam: two beds in the same mixed room.', result['final_response'])
        self.assertIn('700.00 EUR', result['final_response'])
        self.assertIn('full', result['final_response'].lower())
        self.assertTrue(result['final_response'].endswith('Shall I create this booking?'))
        self.assertEqual(result['messages'][-1]['content'], result['final_response'])
        self.turn('contextual-yes', 'Yes!')
        self.interpret_accept('Yes!')
        self.assertIs(ledger.prepare_create({})['require_offer_identity'], True)

    def _checked_offer(self, plan, beds):
        root = Path(__file__).resolve().parents[3]
        source = "const {buildCheckedWolfhousePreviewOffer:b}=require('./scripts/lib/luna-front-desk-accommodation-availability-service'); console.log(JSON.stringify(b(JSON.parse(process.argv[1]))));"
        quote = dict(success=True, total_cents=20000, deposit_required_cents=10000,
                     payment_link_amount_cents=20000, currency='EUR', package_code=plan['package_code'])
        checked = json.loads(subprocess.check_output(['node', '-e', source, json.dumps(dict(
            client_slug='wolfhouse-somo', quote=quote, guests=plan['guests'],
            payment_choice=plan['payment_choice'], availability={**plan, 'status': 'checked',
            'selected_bed_codes': [bed['bed_code'] for bed in beds]}, room_rows=beds))], cwd=root))
        return dict(success=True, total_cents=20000, deposit_required_cents=10000,
                    payment_choice_needed=False, currency='EUR', **checked)

    def test_exact_france_confirmation_preserves_same_checked_offer_consent(self):
        plan = dict(check_in='2027-05-20', check_out='2027-05-23', guest_count=1,
                    package_code='package_none', room_type='shared', room_preference='mixed',
                    guests=[{'name': 'Test Unpaid Alpha'}], payment_choice='deposit')
        beds = [dict(bed_code='R1-B1', room_code='R1', gender_strategy='flexible')]
        response = self._checked_offer(plan, beds)
        self.agent.session_id = 'france-exact-confirmation'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('france-quote', 'I accept the quote and choose the 100 euro deposit option.')
        ledger.record_quote(plan, response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})

        self.turn('france-confirm-1', 'Yes, create it.')
        self.interpret_accept('Yes, create it.')
        first = ledger.prepare_create({})
        self.assertEqual(first['accepted_offer']['offer_fingerprint'],
                         response['offer_revision']['offer_fingerprint'])
        first_key = first['idempotency_key']

        self.turn('france-confirm-2', 'Yes, create it.')
        retry = ledger.prepare_create({})
        self.assertEqual(retry['idempotency_key'], first_key)
        self.assertEqual(retry['accepted_offer'], first['accepted_offer'])

    def test_requote_after_yes_uses_plain_lines_and_does_not_ask_again(self):
        plan = dict(check_in='2026-10-19', check_out='2026-10-22', guest_count=1,
                    package_code='package_none', room_type='shared', room_preference='mixed',
                    guests=[{'name': 'Alex'}], payment_choice='deposit')
        beds = [dict(bed_code='DORM-12', room_code='ROOM-9', gender_strategy='mixed')]
        response = self._checked_offer(plan, beds)
        self.agent.session_id = 'plain-requote'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('plain-q', 'Quote this please')
        ledger.record_quote(plan, response)
        first = ledger.finalize_offer_response({
            'completed': True, 'final_response': 'draft',
            'messages': [{'role': 'assistant', 'content': 'draft'}],
        })
        text = first['final_response']
        self.assertIn('Mon 19 Oct to Thu 22 Oct — 1 guest.', text)
        self.assertNotIn('1 guests', text)
        self.assertNotIn('2026-10-19', text)
        self.assertIn('Alex: a bed in the mixed room.', text)
        self.assertNotIn('DORM-12', text)
        self.assertNotIn('ROOM-9', text)
        self.assertTrue(text.endswith('Shall I create this booking?'))

    def packet_offer(self):
        plan = dict(
            check_in='2027-05-10', check_out='2027-05-12', guest_count=1,
            package_code='package_none', room_type='shared', room_preference='shared',
            group_gender='male', guests=[{'name': 'Alex Test', 'explicit_gender': 'male'}],
            payment_choice='deposit', add_ons=[{'code': 'meals', 'quantity': 1}],
            selected_bed_codes=['R4-B1'])
        root = Path(__file__).resolve().parents[3]
        source = "const {buildCheckedWolfhousePreviewOffer:b}=require('./scripts/lib/luna-front-desk-accommodation-availability-service'); console.log(JSON.stringify(b(JSON.parse(process.argv[1]))));"
        quote = dict(success=True, total_cents=9500, deposit_required_cents=9500,
                     payment_link_amount_cents=9500, currency='EUR', package_code='package_none')
        checked = json.loads(subprocess.check_output(['node', '-e', source, json.dumps(dict(
            client_slug='wolfhouse-somo', quote=quote, guests=plan['guests'],
            payment_choice='deposit', add_ons=plan['add_ons'],
            availability={**plan, 'status': 'checked',
                          'allocation_reason': 'cram_gender_eligible_rooms'},
            room_rows=[dict(bed_code='R4-B1', room_code='R4',
                            gender_strategy='male preferred')]))], cwd=root))
        response = dict(success=True, total_cents=9500, deposit_required_cents=9500,
                        payment_choice_needed=False, currency='EUR', **checked)
        exact = ('Yes, I accept this exact quote for 10 to 12 May 2027, shared male room, '
                 'total and deposit 95 euros. Please create the TEST booking and payment link.')
        return plan, response, exact

    def owner_state(self):
        rows = self.db._conn.execute(
            "SELECT value FROM state_meta WHERE key LIKE 'wolfhouse.accepted_quote.v1:%'"
        ).fetchall()
        return next(json.loads(row[0]) for row in rows
                    if json.loads(row[0]).get('scope', {}).get('ID') == self.agent.session_id)

    def present_packet_offer(self):
        plan, response, exact = self.packet_offer()
        ledger.record_quote(plan, response)
        result = ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        state = self.owner_state()
        self.assertIsInstance(result.get('final_response'), str)
        self.assertEqual(state.get('presented_offer'), state.get('checked_offer'), state)
        return plan, response, exact, result

    def test_complete_packet_consent_requires_matching_presented_offer(self):
        _plan, response, exact, _result = self.present_packet_offer()
        self.turn('packet-consent', exact)
        self.interpret_accept(exact)
        prepared = ledger.prepare_create({})
        self.assertEqual(prepared['selected_bed_codes'], ['R4-B1'])
        self.assertEqual(prepared['guests'],
                         [{'name': 'Alex Test', 'explicit_gender': 'male'}])

    def test_neutral_offer_treats_empty_room_hints_as_absent_at_create(self):
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('neutral-a', 'yes')
        self.interpret_accept('yes')
        prepared = ledger.prepare_create({})
        self.assertIsNone(prepared.get('room_name_hints'), prepared)

    def test_capture_schema_allows_explicit_gender_for_named_traveler(self):
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        plugin.register(registry)
        item = registry.tools['capture_booking_names']['schema']['parameters']['properties']['guests']['items']
        self.assertFalse(item['additionalProperties'])
        self.assertEqual(item['properties']['explicit_gender']['enum'], ['male', 'female'])

    def test_partial_named_eligibility_keeps_offer_fingerprint_at_commit(self):
        root = Path(__file__).resolve().parents[3]
        script = r'''
const svc = require('./scripts/lib/luna-front-desk-accommodation-availability-service');
const guests = [{name:'Alex'}, {name:'Sam', explicit_gender:'female'}];
const beds = [
  {bed_code:'M1', room_code:'M', gender_strategy:'mixed'},
  {bed_code:'M2', room_code:'M', gender_strategy:'mixed'},
];
const quote = {success:true,total_cents:20000,deposit_required_cents:10000,
  payment_link_amount_cents:10000,currency:'EUR',package_code:'package_none'};
const availability = {status:'checked',check_in:'2027-06-01',check_out:'2027-06-03',
  guest_count:2,selected_bed_codes:['M1','M2'],room_type:'shared',room_preference:'mixed'};
const accepted = svc.buildCheckedWolfhousePreviewOffer({client_slug:'wolfhouse-somo',quote,
  availability,guests,payment_choice:'deposit',room_rows:beds}).offer_revision;
const current = svc.currentWolfhouseOfferFromCreateCommand({clientSlug:'wolfhouse-somo',quote,
  assignedBedCodes:['M1','M2'],availabilityChecked:true,checkIn:'2027-06-01',checkOut:'2027-06-03',
  quoteGuestCount:2,roomType:'shared',roomPreference:'mixed',paymentChoice:'deposit',
  effectivePackageCode:'package_none',authoritativeRoomRows:beds,
  guestsNorm:{guests:[{guest_name:'Alex'},{guest_name:'Sam'}]},
  transportBody:{room_name_hints:accepted.room_name_hints,accepted_offer:accepted}});
console.log(JSON.stringify({accepted,current}));
'''
        result = json.loads(subprocess.check_output(['node', '-e', script], cwd=root))
        self.assertEqual(result['accepted']['room_name_hints'],
                         [{'name': 'Sam', 'explicit_gender': 'female'}])
        self.assertEqual(result['current']['room_name_hints'],
                         result['accepted']['room_name_hints'])
        self.assertEqual(result['current']['offer_fingerprint'],
                         result['accepted']['offer_fingerprint'])

    def test_checked_offer_freezes_explicit_person_eligibility_and_room_resolution(self):
        plan, _response, _exact = self.packet_offer()
        plan['guests'] = [{'name': 'Alex Test', 'explicit_gender': 'male'}]
        root = Path(__file__).resolve().parents[3]
        source = "const {buildCheckedWolfhousePreviewOffer:b}=require('./scripts/lib/luna-front-desk-accommodation-availability-service'); console.log(JSON.stringify(b(JSON.parse(process.argv[1]))));"
        quote = dict(success=True, total_cents=9500, deposit_required_cents=9500,
                     payment_link_amount_cents=9500, currency='EUR', package_code='package_none')
        checked = json.loads(subprocess.check_output(['node', '-e', source, json.dumps(dict(
            client_slug='wolfhouse-somo', quote=quote, guests=plan['guests'],
            payment_choice='deposit', add_ons=plan['add_ons'],
            availability={**plan, 'status': 'checked', 'allocation_reason': 'gendered_fit'},
            room_rows=[dict(bed_code='R4-B1', room_code='R4',
                            gender_strategy='male preferred')]))], cwd=root))
        offer = checked['offer_revision']
        self.assertEqual(offer.get('room_name_hints'),
                         [{'name': 'Alex Test', 'explicit_gender': 'male'}])
        self.assertEqual(offer.get('resolved_room_claim'), 'male_shared')
        self.turn('eligibility-q', 'Quote this please')
        ledger.record_quote(plan, dict(success=True, total_cents=9500,
            deposit_required_cents=9500, payment_choice_needed=False,
            currency='EUR', **checked))
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('eligibility-a', self.packet_offer()[2])
        self.interpret_accept(self.packet_offer()[2])
        prepared = ledger.prepare_create({})
        self.assertEqual(prepared.get('room_name_hints'),
                         [{'name': 'Alex Test', 'explicit_gender': 'male'}])

    def test_named_price_consent_accepts_only_matching_frozen_guest(self):
        plan, response, _exact = self.packet_offer()
        plan['guests'] = [{'name': 'Liam Carter', 'explicit_gender': 'male'}]
        response['offer_revision']['guest_bed_assignments'][0]['guest_name'] = 'liam carter'
        self.turn('liam-q', 'Quote this please')
        ledger.record_quote(plan, response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        wording = "Yes, I accept that price, please book it under Liam Carter. I'll pay the deposit later."
        self.turn('liam-a', wording)
        self.interpret_accept(wording)
        self.assertEqual(ledger.prepare_create({})['guests'][0]['name'], 'Liam Carter')

        self.turn('liam-q2', 'Quote this please')
        ledger.record_quote(plan, response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        foreign = wording.replace('Liam Carter', 'Alex Other')
        self.turn('liam-a2', foreign)
        with self.assertRaisesRegex(ledger.QuoteBoundaryError,
                                    'quote_completion_identity_changed'):
            ledger.interpret_owner_turn({
                'action': 'accept', 'action_evidence': foreign,
                'ambiguous': False, 'negated': False, 'conditional': False,
                'material_changes': [],
                'completions': {'guests': [{
                    'guest_index': 0, 'name': 'Alex Other', 'evidence': 'Alex Other'}]},
            })
        with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'quote_owner_acceptance_required'):
            ledger.prepare_create({})

    def test_packet_consent_rejects_contradictory_terms(self):
        replacements = (
            ('10 to 12 May 2027', '11 to 12 May 2027'),
            ('95 euros', '96 euros'),
            ('shared male room', 'shared female room'),
            ('95 euros', '95 dollars'),
        )
        for index, (old, new) in enumerate(replacements):
            with self.subTest(term=new):
                if index:
                    self.agent.session_id = f'contradiction-{index}'
                    self.db.create_session(self.agent.session_id, source='whatsapp')
                    self.turn(f'q-{index}', 'Quote this please')
                _plan, _response, exact, _result = self.present_packet_offer()
                self.turn(f'contradiction-{index}', exact.replace(old, new))
                with self.assertRaises(ledger.QuoteBoundaryError):
                    ledger.prepare_create({})

    def test_pronoun_confirmation_rejects_missing_presentation(self):
        plan, response, _exact = self.packet_offer()
        ledger.record_quote(plan, response)
        self.turn('packet-without-presentation', 'Yes, create it.')
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})

    def test_packet_consent_rejects_foreign_owner_and_replay(self):
        _plan, _response, exact, _result = self.present_packet_offer()
        self.turn('packet-consent', exact)
        self.interpret_accept(exact)
        ledger.prepare_create({})
        with self.assertRaises(ledger.QuoteBoundaryError):
            self.turn('packet-consent', exact)
        self.db.create_session('foreign-packet', source='whatsapp')
        self.agent.session_id = 'foreign-packet'
        self.turn('foreign-packet-consent', exact)
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})

    def test_packet_consent_closed_owner_cannot_prepare(self):
        _plan, _response, exact, _result = self.present_packet_offer()
        self.turn('packet-consent', exact)
        ledger.close_turn()

    def test_unchanged_offer_keeps_consent_and_revised_offer_asks_again(self):
        plan = dict(check_in='2026-10-19', check_out='2026-10-22', guest_count=1,
                    package_code='package_none', room_type='shared', room_preference='mixed',
                    guests=[{'name': 'Alex'}], payment_choice='deposit')
        beds = [dict(bed_code='DORM-12', room_code='ROOM-9', gender_strategy='mixed')]
        response = self._checked_offer(plan, beds)
        self.agent.session_id = 'revised-consent'
        self.db.create_session(self.agent.session_id, source='whatsapp')
        self.turn('revised-q', 'Quote this please')
        ledger.record_quote(plan, response)
        first = ledger.finalize_offer_response({
            'completed': True, 'final_response': 'draft',
            'messages': [{'role': 'assistant', 'content': 'draft'}],
        })
        self.assertTrue(first['final_response'].endswith('Shall I create this booking?'))
        self.turn('revised-yes', 'yes')
        self.interpret_accept('yes')
        ledger.record_quote({}, {**response, 'reply_draft': 'cosmetic only'})
        unchanged = ledger.finalize_offer_response({
            'completed': True, 'final_response': 'kept draft',
            'messages': [{'role': 'assistant', 'content': 'kept draft'}],
        })
        self.assertEqual(unchanged['final_response'], 'kept draft')
        self.assertIs(ledger.prepare_create({})['require_offer_identity'], True)
        changed = deepcopy(response)
        changed['total_cents'] += 1000
        changed['offer_revision']['total_cents'] += 1000
        ledger.record_quote(plan, changed)
        again = ledger.finalize_offer_response({
            'completed': True, 'final_response': 'draft',
            'messages': [{'role': 'assistant', 'content': 'draft'}],
        })
        self.assertIn('210.00 EUR', again['final_response'])
        self.assertTrue(again['final_response'].endswith('Shall I create this updated booking?'))
        self.assertNotIn('DORM-12', again['final_response'])
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})
        self.turn('revised-yes-2', 'yes')
        self.interpret_accept('yes')
        self.assertIs(ledger.prepare_create({})['require_offer_identity'], True)

    def test_same_room_and_split_room_copy_differ_without_codes(self):
        plan = dict(check_in='2026-11-01', check_out='2026-11-08', guest_count=2,
                    package_code='package_none', room_type='shared', room_preference='mixed',
                    guests=[{'name': 'Alex'}, {'name': 'Sam'}], payment_choice='full')
        same_beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                     dict(bed_code='M2', room_code='M', gender_strategy='mixed')]
        split_beds = [dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                      dict(bed_code='N1', room_code='N', gender_strategy='mixed')]
        texts = {}
        for label, beds in (('same', same_beds), ('split', split_beds)):
            self.agent.session_id = 'rooms-' + label
            self.db.create_session(self.agent.session_id, source='whatsapp')
            self.turn('rooms-q-' + label, 'Quote this please')
            ledger.record_quote(plan, self._checked_offer(plan, beds))
            shown = ledger.finalize_offer_response({
                'completed': True, 'final_response': 'draft',
                'messages': [{'role': 'assistant', 'content': 'draft'}],
            })
            texts[label] = shown['final_response']
            self.assertNotIn('M1', texts[label])
            self.assertNotIn('N1', texts[label])
            self.assertNotIn('room M', texts[label])
            self.assertNotIn('room N', texts[label])
        self.assertIn('Alex and Sam: two beds in the same mixed room.', texts['same'])
        self.assertIn('Alex and Sam: beds in two separate mixed rooms.', texts['split'])
        self.assertNotEqual(texts['same'], texts['split'])

    def test_preview_tool_shows_room_type_includes_line(self):
        root = Path(__file__).resolve().parents[3]
        script = """
const { computePackagePricePreview } = require('./scripts/lib/booking-guests');
const { loadConfig } = require('./scripts/lib/wolfhouse-quote-calculator');
const input = JSON.parse(process.argv[1]);
console.log(JSON.stringify(computePackagePricePreview(input, loadConfig())));
"""
        for room, expected in (
            ('shared', 'Includes: 7 nights in a dorm bed, T-shirt'),
            ('private', 'Includes: 7 nights in a private room, T-shirt'),
            ('double', 'Includes: 7 nights in a double room, T-shirt'),
        ):
            preview = json.loads(subprocess.check_output(['node', '-e', script, json.dumps({
                'client_slug': 'wolfhouse-somo', 'check_in': '2027-07-01', 'check_out': '2027-07-08',
                'guest_count': 2, 'room_type': room,
            })], cwd=root))
            with patch.object(plugin, '_post_bot', return_value=preview):
                visible = json.loads(plugin.preview_package_prices({
                    'check_in': '2027-07-01', 'check_out': '2027-07-08', 'guest_count': 2,
                    'room_type': room,
                }))
            self.assertEqual(visible['malibu']['includes_line'], expected)
            self.assertEqual(visible['packages']['malibu']['includes_line'], expected)
            self.assertEqual(visible['malibu']['total_cents'], preview['packages']['malibu']['total_cents'])
            self.assertEqual(visible['malibu']['inclusions'], preview['packages']['malibu']['inclusions'])
            self.assertNotIn('dorm', visible['malibu']['includes_line']) if room != 'shared' else None

    def test_incomplete_checked_responses_never_present_accept_ready_question(self):
        mutations = [
            lambda r: r.update(success=False),
            lambda r: r.update(payment_choice_needed=True),
            lambda r: r['offer_revision'].update(payment_choice=None),
            lambda r: r['offer_revision'].update(payment_link_amount_cents=None),
            lambda r: r['offer_revision'].update(total_cents=1),
            lambda r: r['offer_revision'].update(room_arrangement=[]),
            lambda r: r['offer_revision']['guest_bed_assignments'][1].update(bed_code='M1'),
            lambda r: r['availability'].update(selected_bed_codes=['M2', 'M1']),
            lambda r: r['offer_revision']['guest_bed_assignments'][1].update(guest_name=None),
            lambda r: r['offer_revision'].update(check_in=None),
            lambda r: r.update(offer_revision=None),
        ]
        for index, mutate in enumerate(mutations):
            with self.subTest(index=index):
                self.agent.session_id = 'invalid-' + str(index)
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn('invalid-q-' + str(index), 'Quote this please')
                response = deepcopy(self.response)
                mutate(response)
                ledger.record_quote(self.plan, response)
                result = ledger.finalize_offer_response({'completed': True, 'final_response': 'Information only'})
                self.assertEqual(result['final_response'], 'Information only')
                self.turn('invalid-yes-' + str(index), 'yes')
                with self.assertRaises(ledger.QuoteBoundaryError):
                    ledger.prepare_create({})

    def test_unchanged_revalidation_preserves_acceptance_and_operation_key(self):
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('accept', 'I accept the quote')
        self.interpret_accept('I accept the quote')
        before = ledger.prepare_create({})
        ledger.record_quote({}, {**self.response, 'reply_draft': 'different cosmetic text'})
        self.assertEqual(ledger.prepare_create({}), before)
        for changed in ({**self.response, 'success': False},
                        {**self.response, 'availability': {'status': 'unavailable'}, 'offer_revision': None}):
            ledger.record_quote({}, changed)
            with self.assertRaises(ledger.QuoteBoundaryError):
                ledger.prepare_create({})

    def test_changed_price_revokes_acceptance(self):
        ledger.record_quote(self.plan, self.response)
        self.turn('accept', 'I accept the quote')
        changed = deepcopy(self.response)
        changed['total_cents'] += 100
        changed['offer_revision']['total_cents'] += 100
        ledger.record_quote({}, changed)
        with self.assertRaises(ledger.QuoteBoundaryError):
            ledger.prepare_create({})

    def test_successful_staff_receipt_is_durable_and_not_redispatched(self):
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('accept', 'I accept the quote')
        self.interpret_accept('I accept the quote')
        prepared = ledger.prepare_create({})
        receipt = {'success': True, 'write_performed': True, 'booking_id': 'offline-unit-booking'}
        calls = []
        self.assertEqual(ledger.dispatch_create(prepared, lambda: calls.append(1) or receipt), receipt)
        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.agent._session_db = self.db
        self.turn('retry', 'Please proceed')
        retried = ledger.prepare_create({})
        self.assertEqual(retried['idempotency_key'], prepared['idempotency_key'])
        self.assertEqual(ledger.dispatch_create(retried, lambda: calls.append(2) or {}), receipt)
        self.assertEqual(calls, [1])

    def test_crash_after_staff_commit_reuses_original_frozen_operation(self):
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('accept', 'I accept the quote')
        self.interpret_accept('I accept the quote')
        before = ledger.prepare_create({})
        committed = {}
        def lost_response():
            committed[before['idempotency_key']] = dict(before)
            raise ConnectionError('unit: committed but response lost')
        with self.assertRaises(ConnectionError):
            ledger.dispatch_create(before, lost_response)
        self.turn('retry', 'Please proceed')
        after = ledger.prepare_create({})
        self.assertEqual(after, committed[after['idempotency_key']])

    def test_post_booking_contact_pending_unknown_and_completed_survive_reopen(self):
        ledger.record_quote(self.plan, self.response)
        presented = ledger.finalize_offer_response({
            'completed': True, 'final_response': 'draft',
            'messages': [{'role': 'assistant', 'content': 'draft'}],
        })
        self.assertTrue(presented['final_response'].endswith('Shall I create this booking?'))
        self.turn('accept-contact', 'yes')
        self.interpret_accept('yes')
        prepared = ledger.prepare_create({})
        receipt = {'success': True, 'write_performed': True,
                   'booking_id': 'unit-booking', 'booking_code': 'UNIT-1'}
        ledger.dispatch_create(prepared, lambda: receipt)
        identity = {'email': 'alex@example.test', 'booking_code': 'UNIT-1'}
        self.assertEqual(ledger.post_booking_contact_status(prepared, **identity)['status'], 'pending')

        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.agent._session_db = self.db
        self.turn('accept-contact', 'yes')
        prepared = ledger.prepare_create({})
        begun = ledger.begin_post_booking_contact(prepared, **identity)
        self.assertTrue(begun['perform'])
        self.assertEqual(begun['contact']['status'], 'unknown')

        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.agent._session_db = self.db
        self.turn('accept-contact', 'yes')
        prepared = ledger.prepare_create({})
        replay = ledger.begin_post_booking_contact(prepared, **identity)
        self.assertFalse(replay['perform'], 'a maybe-started contact write must not retry')
        self.assertEqual(replay['contact']['status'], 'unknown')
        outcome = {'requested': True, 'saved': True, 'sent': False,
                   'send_performed': False, 'outcome': 'saved'}
        ledger.complete_post_booking_contact(prepared, **identity, outcome=outcome)

        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.agent._session_db = self.db
        self.turn('accept-contact', 'yes')
        prepared = ledger.prepare_create({})
        completed = ledger.post_booking_contact_status(prepared, **identity)
        self.assertEqual(completed['status'], 'completed')
        self.assertEqual(completed['outcome'], outcome)

    def test_hook_requires_registered_interpreter_then_model_create(self):
        from agent import conversation_loop
        from wolfhouse import booking_names
        from wolfhouse.offline_ingress_harness import gateway_ingress
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        calls, model_calls = [], []
        def staff(path, body):
            calls.append((path, deepcopy(body)))
            if path == '/booking-preview': return deepcopy(self.response)
            if path == '/availability-check':
                return {'success': True, 'has_enough_beds': True, 'available_beds': [
                    {'bed_code': 'M1', 'room_type': 'mixed'}, {'bed_code': 'M2', 'room_type': 'mixed'}]}
            if path == '/payments/unit-payment/create-stripe-link':
                # Explicit unit-only HTTP substitution, not Stripe/persistence proof.
                return {'success': True, 'guest_payment_url': 'https://example.invalid/pay/unit-payment'}
            if path == '/bookings/update-contact':
                return {'success': True, 'write_performed': True, 'email_saved': True,
                        'email_sent': True}  # must not be trusted as send proof
            self.assertEqual(path, '/booking-create-from-plan')
            return {'success': True, 'write_performed': True, 'booking_id': 'unit-booking',
                    'booking_code': 'UNIT-1', 'payment_id': 'unit-payment'}
        def model(agent, text, *args, **kwargs):
            model_calls.append(text)
            booking_names.begin_turn(session_id=agent.session_id, scope=plugin._booking_name_scope())
            if text == 'Please quote this':
                self.assertTrue(json.loads(registry.tools['quote_booking']['handler'](self.plan))['success'])
            if text == 'yes':
                interpreted = json.loads(registry.tools['interpret_booking_turn']['handler']({
                    'action': 'accept', 'action_evidence': 'yes',
                    'ambiguous': False, 'negated': False, 'conditional': False,
                    'material_changes': [], 'completions': {},
                }))
                self.assertTrue(interpreted['accepted'], interpreted)
                created = json.loads(registry.tools['create_booking_from_plan']['handler']({}))
                reply = f"{created['booking_code']} {created['secure_payment_url']}"
                return {'completed': True, 'final_response': reply,
                        'booking_result': created,
                        'messages': [{'role': 'assistant', 'content': reply}]}
            if text == 'Check the booking without prior successful-turn history':
                readback = {
                    'success': False, 'tool': 'list_my_bookings',
                    'lookup_status': 'unavailable', 'bookings': None,
                    'prior_create_receipt': {'booking_id': 'unit-booking', 'booking_code': 'UNIT-1'},
                    'do_not_retract_successful_create': True, 'do_not_retry_create': True,
                }
                false_reply = 'Sorry, your booking was not created. Please try booking again.'
                return {'completed': True, 'final_response': false_reply, 'messages': [
                    {'role': 'user', 'content': text},
                    {'role': 'tool', 'content': json.dumps(readback)},
                    {'role': 'assistant', 'content': false_reply},
                ]}
            if text == 'Honor the newer authoritative booking readback':
                receipt = {'booking_id': 'unit-booking', 'booking_code': 'UNIT-1'}
                stale = {'success': False, 'tool': 'list_my_bookings',
                         'lookup_status': 'unavailable', 'bookings': None,
                         'prior_create_receipt': receipt,
                         'do_not_retract_successful_create': True,
                         'do_not_retry_create': True}
                payment = {'success': True, 'tool': 'get_payment_status',
                           'payment_truth_known': False}
                found = {'success': True, 'tool': 'list_my_bookings',
                         'lookup_status': 'found',
                         'bookings': [{'booking_code': 'UNIT-1'}],
                         'prior_create_receipt': receipt,
                         'do_not_retract_successful_create': True,
                         'do_not_retry_create': True}
                model_reply = 'Latest authoritative booking readback was used.'
                return {'completed': True, 'final_response': model_reply, 'messages': [
                    {'role': 'user', 'content': text},
                    {'role': 'tool', 'content': json.dumps(stale)},
                    {'role': 'tool', 'content': json.dumps(payment)},
                    {'role': 'tool', 'content': json.dumps(found)},
                    {'role': 'assistant', 'content': model_reply},
                ]}
            return {'completed': True, 'final_response': 'Model did not book',
                    'messages': [{'role': 'assistant', 'content': 'Model did not book'}]}
        with patch.object(conversation_loop, 'run_conversation', model), patch.object(plugin, '_post_bot', side_effect=staff):
            plugin.register(registry)
            offered = gateway_ingress(self.agent, 'Please quote this', 'hook-q',
                lambda raw: conversation_loop.run_conversation(self.agent, raw))
            self.assertIn('Shall I create this booking?', offered['final_response'])
            accepted = gateway_ingress(self.agent, 'yes', 'hook-a',
                lambda raw: conversation_loop.run_conversation(self.agent, raw))
            self.assertIn('UNIT-1', accepted['final_response'])
            self.assertIn('https://example.invalid/pay/unit-payment', accepted['final_response'])
            calls_before_retry = deepcopy(calls)
            self.db.close()
            self.db = SessionDB(Path(self.temp.name) / 'state.db')
            self.agent._session_db = self.db
            retried = gateway_ingress(self.agent, 'yes', 'hook-a',
                lambda raw: conversation_loop.run_conversation(self.agent, raw))
            self.assertIn('https://example.invalid/pay/unit-payment', retried['final_response'])
            self.assertEqual(retried['booking_result']['secure_payment_url'],
                             accepted['booking_result']['secure_payment_url'])
            self.assertEqual(calls, calls_before_retry, 'No duplicate booking or payment-link side effect')
            readback = gateway_ingress(
                self.agent, 'Check the booking without prior successful-turn history', 'hook-readback',
                lambda raw: conversation_loop.run_conversation(self.agent, raw))
            self.assertIn('UNIT-1', readback['final_response'])
            self.assertIn('created successfully earlier', readback['final_response'])
            self.assertNotIn('not created', readback['final_response'].lower())
            self.assertEqual(readback['messages'][-1]['content'], readback['final_response'])
            newer = gateway_ingress(
                self.agent, 'Honor the newer authoritative booking readback',
                'hook-readback-newer-authoritative',
                lambda raw: conversation_loop.run_conversation(self.agent, raw))
            self.assertEqual(newer['final_response'],
                             'Latest authoritative booking readback was used.')
            with patch.dict(os.environ, {
                    'LUNA_CLIENT_SLUG': 'sunset-somo',
                    'LUNA_TENANT_ID': 'sunset-somo'}):
                foreign_tenant = gateway_ingress(
                    self.agent, 'Check the booking without prior successful-turn history',
                    'hook-readback-foreign-tenant',
                    lambda raw: conversation_loop.run_conversation(self.agent, raw))
            self.assertNotIn('UNIT-1', foreign_tenant['final_response'])
            self.assertIn('not created', foreign_tenant['final_response'].lower())
            self.assertEqual(model_calls, [
                'Please quote this', 'yes',
                'Check the booking without prior successful-turn history',
                'Honor the newer authoritative booking readback',
                'Check the booking without prior successful-turn history'])
            creates = [body for path, body in calls if path == '/booking-create-from-plan']
            self.assertEqual(len(creates), 1)
            self.assertEqual(creates[0]['accepted_offer'], self.response['offer_revision'])
            self.assertEqual(creates[0]['guests'], self.plan['guests'])
            self.assertEqual(creates[0]['selected_bed_codes'], ['M1', 'M2'])
            email_updates = [body for path, body in calls if path == '/bookings/update-contact']
            self.assertEqual(email_updates, [{'client_slug': 'wolfhouse-somo', 'booking_code': 'UNIT-1',
                                              'email': 'alex@example.test'}])
            self.assertTrue(accepted['booking_result']['post_booking_email']['saved'])
            self.assertFalse(accepted['booking_result']['post_booking_email']['sent'])
            self.assertEqual(accepted['booking_result']['post_booking_email']['outcome'], 'saved')

    def test_fresh_cancellation_reaches_model_before_any_accepted_create_dispatch(self):
        from agent import conversation_loop
        from wolfhouse.offline_ingress_harness import gateway_ingress
        class Registry:
            def __init__(self): self.tools, self.hooks = {}, {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, name, handler, *args, **kw): self.hooks[name] = handler
        registry, model_calls, creates = Registry(), [], []
        def staff(path, body):
            self.assertEqual(path, '/booking-preview')
            return deepcopy(self.response)
        def model(agent, text, *args, **kwargs):
            model_calls.append(text)
            registry.hooks['pre_llm_call'](session_id=agent.session_id)
            if text == 'Please quote this':
                self.assertTrue(json.loads(
                    registry.tools['quote_booking']['handler'](self.plan))['success'])
            elif text == 'Yes, book it':
                result = json.loads(registry.tools['interpret_booking_turn']['handler']({
                    'action': 'accept', 'action_evidence': text,
                    'ambiguous': False, 'negated': False, 'conditional': False,
                    'material_changes': [], 'completions': {},
                }))
                self.assertTrue(result['create_ready'])
            return {'completed': True, 'final_response': 'offline model reply', 'messages': []}
        def inert(params):
            creates.append(deepcopy(dict(params)))
            return json.dumps({'success': False, 'error': 'inert_no_write_boundary',
                               'write_performed': False})
        with patch.object(conversation_loop, 'run_conversation', model), \
                patch.object(plugin, '_post_bot', side_effect=staff), \
                patch.object(ledger, '_registered_create', inert):
            plugin.register(registry)
            ledger._registered_create = inert
            gateway_ingress(self.agent, 'Please quote this', 'fresh-q',
                            lambda raw: conversation_loop.run_conversation(self.agent, raw))
            gateway_ingress(self.agent, 'Yes, book it', 'fresh-a',
                            lambda raw: conversation_loop.run_conversation(self.agent, raw))
            reply = gateway_ingress(self.agent, 'No, do not book.', 'fresh-cancel',
                                    lambda raw: conversation_loop.run_conversation(self.agent, raw))
        self.assertEqual(creates, [])
        self.assertIn('No, do not book.', model_calls)
        self.assertEqual(reply['final_response'], 'offline model reply')

    def test_capture_to_registered_create_preserves_explicit_person_eligibility(self):
        from wolfhouse import booking_names
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        plan, response, exact = self.packet_offer()
        quote_params = {key: deepcopy(value) for key, value in plan.items() if key != 'guests'}
        calls = []
        def staff(path, body):
            calls.append((path, deepcopy(body)))
            if path == '/booking-preview': return deepcopy(response)
            if path == '/availability-check':
                return {**deepcopy(response['availability']), 'success': True,
                        'has_enough_beds': True,
                        'allocation_reason': 'cram_gender_eligible_rooms',
                        'available_beds': [{'bed_code': 'R4-B1', 'room_code': 'R4',
                                            'room_type': 'male_only',
                                            'gender_strategy': 'male preferred'}]}
            if path.startswith('/payments/') and path.endswith('/create-stripe-link'):
                return {'success': True, 'guest_payment_url': 'https://example.invalid/pay/alex'}
            self.assertEqual(path, '/booking-create-from-plan')
            self.assertEqual(body.get('room_name_hints'),
                             [{'name': 'Alex Test', 'explicit_gender': 'male'}])
            return {'success': True, 'write_performed': True, 'booking_id': 'alex-booking',
                    'booking_code': 'ALEX-1', 'payment_id': 'alex-payment'}
        with patch.object(plugin, '_post_bot', side_effect=staff):
            plugin.register(registry)
            agent_token = booking_names._agent.set(self.agent)
            self.addCleanup(booking_names._agent.reset, agent_token)
            booking_names.begin_turn(session_id=self.agent.session_id, scope=plugin._booking_name_scope())
            captured = json.loads(registry.tools['capture_booking_names']['handler']({
                'guest_count': 1,
                'guests': [{'name': 'Alex Test', 'explicit_gender': 'male'}],
            }))
            self.assertTrue(captured['success'], captured)
            quoted = json.loads(registry.tools['quote_booking']['handler'](quote_params))
            self.assertTrue(quoted['success'])
            ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
            self.turn('alex-a', exact)
            self.interpret_accept(exact)
            created = json.loads(registry.tools['create_booking_from_plan']['handler']({}))
            self.assertTrue(created['success'], {'created': created, 'calls': calls})
            self.assertEqual(created['booking_code'], 'ALEX-1')
            creates = [body for path, body in calls if path == '/booking-create-from-plan']
            self.assertEqual(len(creates), 1)
            self.assertEqual(creates[0]['guests'], [{'name': 'Alex Test'}])
            self.assertEqual(creates[0]['room_name_hints'],
                             [{'name': 'Alex Test', 'explicit_gender': 'male'}])

    def _run_sparse_registered_create(self, room_rows, available_beds):
        from wolfhouse import booking_names
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        guests = [{'name': 'Alex'}, {'name': 'Sam', 'explicit_gender': 'female'}]
        plan = {**self.plan, 'guests': guests, 'selected_bed_codes': ['M1', 'M2']}
        root = Path(__file__).resolve().parents[3]
        source = "const {buildCheckedWolfhousePreviewOffer:b}=require('./scripts/lib/luna-front-desk-accommodation-availability-service'); console.log(JSON.stringify(b(JSON.parse(process.argv[1]))));"
        quote = dict(success=True, total_cents=70000, deposit_required_cents=20000,
                     payment_link_amount_cents=70000, currency='EUR', package_code='package_none')
        checked = json.loads(subprocess.check_output(['node', '-e', source, json.dumps(dict(
            client_slug='wolfhouse-somo', quote=quote, guests=guests, payment_choice='full',
            availability={**plan, 'status': 'checked'}, room_rows=room_rows))], cwd=root))
        response = dict(success=True, total_cents=70000, deposit_required_cents=20000,
                        payment_choice_needed=False, currency='EUR', **checked)
        quote_params = {key: deepcopy(value) for key, value in plan.items() if key != 'guests'}
        calls = []
        def staff(path, body):
            calls.append((path, deepcopy(body)))
            if path == '/booking-preview': return deepcopy(response)
            if path == '/availability-check':
                return {**deepcopy(response['availability']), 'success': True,
                        'has_enough_beds': True, 'available_beds': deepcopy(available_beds)}
            if path.startswith('/payments/') and path.endswith('/create-stripe-link'):
                return {'success': True, 'guest_payment_url': 'https://example.invalid/pay/sparse'}
            if path == '/bookings/update-contact':
                return {'success': True, 'write_performed': True, 'email_sent': False}
            self.assertEqual(path, '/booking-create-from-plan')
            return {'success': True, 'write_performed': True, 'booking_id': 'sparse-booking',
                    'booking_code': 'SPARSE-1', 'payment_id': 'sparse-payment'}
        with patch.object(plugin, '_post_bot', side_effect=staff):
            plugin.register(registry)
            agent_token = booking_names._agent.set(self.agent)
            self.addCleanup(booking_names._agent.reset, agent_token)
            booking_names.begin_turn(session_id=self.agent.session_id, scope=plugin._booking_name_scope())
            captured = json.loads(registry.tools['capture_booking_names']['handler']({
                'guest_count': 2, 'guests': guests}))
            self.assertTrue(captured['success'], captured)
            quoted = json.loads(registry.tools['quote_booking']['handler'](quote_params))
            self.assertTrue(quoted['success'], quoted)
            ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
            self.turn('sparse-a', 'yes')
            self.interpret_accept('yes')
            created = json.loads(registry.tools['create_booking_from_plan']['handler']({}))
        return created, calls

    def test_sparse_explicit_eligibility_reaches_registered_create_on_mixed_beds(self):
        room_rows = [dict(bed_code=code, room_code='M', gender_strategy='mixed')
                     for code in ('M1', 'M2')]
        available = [dict(bed_code=code, room_code='M', room_type='mixed',
                          gender_strategy='mixed') for code in ('M1', 'M2')]
        created, calls = self._run_sparse_registered_create(room_rows, available)
        self.assertTrue(created['success'], {'created': created, 'calls': calls})
        creates = [body for path, body in calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['room_name_hints'],
                         [{'name': 'Sam', 'explicit_gender': 'female'}])
        self.assertEqual(creates[0]['guests'], [{'name': 'Alex'}, {'name': 'Sam'}])

    def test_sparse_unknown_person_cannot_use_gendered_bed(self):
        room_rows = [dict(bed_code='M1', room_code='A', gender_strategy='male preferred'),
                     dict(bed_code='M2', room_code='S', gender_strategy='female preferred')]
        available = [dict(bed_code='M1', room_code='A', room_type='male_only',
                          gender_strategy='male preferred'),
                     dict(bed_code='M2', room_code='S', room_type='female_only',
                          gender_strategy='female preferred')]
        created, calls = self._run_sparse_registered_create(room_rows, available)
        self.assertFalse(created['success'], created)
        self.assertEqual(created['error'], 'accepted_bed_selection_revalidation_required')
        self.assertEqual([body for path, body in calls if path == '/booking-create-from-plan'], [])
        self.assertEqual(created['accepted_setup']['room_name_hints'],
                         [{'name': 'Sam', 'explicit_gender': 'female'}])

    def test_post_booking_email_save_outcomes_and_no_write_fences(self):
        payload = {'client_slug': 'wolfhouse-somo', 'email': 'alex@example.test'}
        created = {'success': True, 'write_performed': True}
        fields = {'booking_code': 'UNIT-EMAIL'}
        cases = (
            ({'success': True, 'write_performed': True, 'email_sent': True}, True, 'saved'),
            ({'success': False, 'write_performed': False, 'error': 'refused'}, False, 'refused'),
            ({'success': False, 'error': 'timeout'}, False, 'unknown'),
        )
        for adapter_result, saved, outcome in cases:
            with self.subTest(outcome=outcome), patch.object(plugin, '_post_bot', return_value=adapter_result) as post:
                result = plugin._save_post_booking_email(payload, created, fields)
                self.assertEqual(result['saved'], saved)
                self.assertEqual(result['outcome'], outcome)
                self.assertFalse(result['sent'])
                self.assertFalse(result['send_performed'])
                post.assert_called_once_with('/bookings/update-contact', {
                    'client_slug': 'wolfhouse-somo', 'booking_code': 'UNIT-EMAIL',
                    'email': 'alex@example.test',
                })

        prior = {'post_booking_email': {'requested': True, 'saved': True, 'sent': False,
                                        'send_performed': False, 'outcome': 'saved'}}
        with patch.object(plugin, '_post_bot') as post:
            self.assertEqual(plugin._save_post_booking_email(payload, created, fields, prior),
                             prior['post_booking_email'])
            post.assert_not_called()
            self.assertIsNone(plugin._save_post_booking_email(payload,
                {'success': False, 'write_performed': False}, fields))
            self.assertIsNone(plugin._save_post_booking_email(payload,
                {'success': True, 'write_performed': False}, fields))
            self.assertIsNone(plugin._save_post_booking_email({}, created, fields))
            post.assert_not_called()

    def test_checked_offer_freezes_staff_order_payment_and_identity(self):
        hints = [{'name': 'Alex', 'hint': 'unknown'}, {'name': 'Sam', 'hint': 'unknown'}]
        ledger.record_quote({**self.plan, 'room_name_hints': hints}, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('a1', 'I accept the quote')
        self.interpret_accept('I accept the quote')
        prepared = ledger.prepare_create({'accepted_offer': {'forged': True}, 'require_offer_identity': False})
        self.assertEqual(prepared.get('accepted_offer'), self.response['offer_revision'])
        self.assertIs(prepared.get('require_offer_identity'), True)
        self.assertEqual(prepared.get('selected_bed_codes'), ['M1', 'M2'])
        self.assertEqual(prepared.get('guests'), self.plan['guests'])
        self.assertEqual(prepared.get('room_name_hints'), hints)
        self.assertEqual(prepared.get('payment_choice'), 'full')
        for changed in ({'guests': list(reversed(self.plan['guests']))},
                        {'payment_choice': 'deposit'}, {'selected_bed_codes': ['M2', 'M1']},
                        {'room_name_hints': list(reversed(hints))}):
            with self.subTest(changed=changed), self.assertRaises(ledger.QuoteBoundaryError):
                ledger.prepare_create(changed)

    def test_adapter_preserves_staff_checked_offer_not_model_offer(self):
        with patch.object(plugin, '_post_bot', return_value=self.response):
            result = json.loads(plugin.quote_booking({**self.plan,
                'offer_revision': {'forged': True}, 'availability': {'status': 'held'}}))
        self.assertEqual(result.get('availability'), self.response['availability'])
        self.assertEqual(result.get('offer_revision'), self.response['offer_revision'])
