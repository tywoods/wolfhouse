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
    @staticmethod
    def _exact_recheck(body, beds):
        codes = list(body.get('selected_bed_codes') or [b['bed_code'] for b in beds])
        guests = body.get('guests') or []
        return {'success': True, 'has_enough_beds': True, 'available_beds': deepcopy(beds),
                'exact_bed_eligibility': {'eligible': True,
                    'selected_bed_codes': codes,
                    'guest_bed_assignments': [
                        {'guest_index': i, 'guest_name': guests[i].get('name', ''),
                         'bed_code': code} for i, code in enumerate(codes)]}}

    def _provisional_refresh_case(self, complete=False, price_change=False):
        plan = dict(check_in='2026-10-21', check_out='2026-10-24', guest_count=1,
                    room_type='shared', room_preference='male_only', package_code='package_none',
                    guest_name='Mateo', guests=[{'name': 'Mateo', 'explicit_gender': 'male'}],
                    room_name_hints=[{'name': 'Mateo', 'explicit_gender': 'male'}])
        beds = [dict(bed_code='R4-B3', room_code='R4', gender_strategy='male preferred')]
        money = dict(total_cents=12000, deposit_required_cents=10000, payment_link_amount_cents=10000)
        response = self._checked_offer({**plan, 'payment_choice': 'deposit'}, beds, quote_overrides=money)
        response['payment_choice_needed'] = True
        ledger.record_quote(plan, response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.assertTrue(ledger._transaction(lambda state, ingress: bool(state.get('presentation'))))
        self.turn('refresh-accept', 'Book it, Mateo Ríos, deposit please')
        args = {'payment_choice': 'deposit'}
        if complete:
            plan.update(guest_name='Mateo Ríos', guests=[{'name': 'Mateo Ríos', 'explicit_gender': 'male'}],
                        room_name_hints=[{'name': 'Mateo Ríos', 'explicit_gender': 'male'}],
                        payment_choice='deposit', add_ons=[], catalog_selections=[])
            response = self._checked_offer(plan, beds, quote_overrides=money)
            args = {**plan, 'confirm': True, 'gender_preference': 'male'}
        if price_change:
            response['total_cents'] += 100
            response['offer_revision']['total_cents'] += 100
        ledger.record_quote(plan, response)
        if price_change:
            with self.assertRaises(ledger.QuoteBoundaryError):
                ledger.prepare_create(args)
        else:
            self.assertTrue(ledger._transaction(lambda state, ingress: bool(state.get('presentation'))))
            ledger.prepare_create(args)

    def test_provisional_identical_quote_before_create(self):
        self._provisional_refresh_case()

    def test_provisional_completed_quote_before_create(self):
        self._provisional_refresh_case(complete=True)

    def test_provisional_changed_price_requires_presentation(self):
        self._provisional_refresh_case(price_change=True)

    def test_sim9_complete_create_restatements(self):
        # Supplied trace argument shapes; synthetic shown plans/Staff refreshes,
        # not reconstructed historical intermediate owner snapshots.
        cases = [
            ('G1', '2026-10-19', '2026-10-23', 'shared', 'male_only',
             ['Emre'], ['Emre Yilmaz'], 'male', ['R4-B3'], 16000, 10000),
            ('G2', '2026-10-23', '2026-10-25', 'shared', 'female_only',
             ['Nora'], ['Nora Lefevre'], 'female', ['R5-B4'], 8000, 8000),
            ('G4', '2026-10-21', '2026-10-24', 'shared', 'male_only',
             ['Mateo'], ['Mateo Ríos'], 'male', ['R4-B3'], 12000, 10000),
            ('G5', '2026-10-25', '2026-10-28', 'private', 'couple_private',
             ['Holly', 'Jake'], ['Holly Bennett', 'Jake Bennett'], None,
             ['R6-B1', 'R6-B2'], 27000, 20000),
        ]
        for label, start, end, room_type, preference, names, completed, gender, codes, total, deposit in cases:
            with self.subTest(scenario=label):
                self.agent.session_id = 'sim9-full-' + label
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn('shown-' + label, 'Quote this stay')
                guests = [{'name': name, **({'explicit_gender': gender} if gender else {})}
                          for name in names]
                plan = dict(check_in=start, check_out=end, guest_count=len(names),
                            room_type=room_type, room_preference=preference,
                            guests=guests, package_code='package_none')
                if gender:
                    plan['room_name_hints'] = deepcopy(guests)
                priced = {**plan, 'payment_choice': 'deposit'}
                beds = [dict(bed_code=code, room_code=code.split('-')[0],
                             gender_strategy='private' if not gender else gender + ' preferred')
                        for code in codes]
                response = self._checked_offer(priced, beds, quote_overrides={
                    'total_cents': total, 'deposit_required_cents': deposit,
                    'payment_link_amount_cents': deposit})
                response.update(full_payment_only=total == deposit,
                                payment_choice_needed=total != deposit)
                ledger.record_quote(plan, response)
                ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn('create-' + label, 'Book that offer; deposit please')
                args = dict(confirm=True, check_in=start, check_out=end,
                            guest_count=len(names), room_type=room_type,
                            room_preference=preference, package_code='package_none',
                            guest_name=completed[0], payment_choice='deposit', language='en',
                            guests=[{'name': name, **({'explicit_gender': gender} if gender else {})}
                                    for name in completed])
                if label != 'G2':
                    args['add_ons'] = []
                if gender:
                    args['gender_preference'] = gender
                if label == 'G1':
                    args.update(client_slug='wolfhouse-somo', selected_bed_codes=codes)
                if label == 'G4':
                    first_args = {key: value for key, value in args.items()
                                  if key not in ('confirm', 'guest_name', 'language')}
                    first_args['catalog_selections'] = []
                    prepared = ledger.prepare_create(first_args)
                    self.assertTrue(prepared.revalidation)
                    self.turn('create-' + label + '-second', 'Same accepted offer')
                prepared = ledger.prepare_create(args)
                self.assertTrue(prepared.revalidation)
                self.assertEqual(prepared['guests'], args['guests'])
                self.assertEqual(prepared['payment_choice'], 'full' if label == 'G2' else 'deposit')

    def test_sim9_restatement_material_negatives(self):
        self.plan['guests'] = [{'name': 'Alex', 'explicit_gender': 'male'},
                               {'name': 'Sam', 'explicit_gender': 'male'}]
        self.plan['add_ons'] = [{'code': 'yoga_class', 'quantity': 1}]
        self.response = self._checked_offer(self.plan, [
            dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
            dict(bed_code='M2', room_code='M', gender_strategy='mixed')])
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('sim9-material-negatives', 'Book that')
        # Retired gender alias case: carried explicit per-person facts own eligibility.
        ledger.prepare_create({'gender_preference': 'female'})
        for changed in ({'add_ons': []}, {'guest_count': 3}, {'room_preference': 'private'},
                        {'selected_bed_codes': ['M2', 'M1']}):
            with self.subTest(changed=changed), self.assertRaises(ledger.QuoteBoundaryError):
                ledger.prepare_create(changed)

    def test_sim9_registered_quote_whole_party_fact_reaches_staff(self):
        from wolfhouse import booking_names
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        plugin.register(registry)
        plan = {**self.plan, 'guest_count': 3, 'group_gender': 'female',
                'room_preference': 'female_only', 'guests': [
                    {'name': 'Aisha', 'explicit_gender': 'female'},
                    {'name': 'Priya'}, {'name': 'Leila'}]}
        complete = {**plan, 'guests': [{**guest, 'explicit_gender': 'female'}
                                      for guest in plan['guests']]}
        response = self._checked_offer(complete, [
            dict(bed_code='R5-B' + str(i + 1), room_code='R5', gender_strategy='female preferred')
            for i in range(3)])
        calls = []
        def staff(path, body):
            if path == '/availability-check':
                return {'success': True, 'has_enough_beds': True,
                        'available_beds': deepcopy(response['offer_revision']['room_arrangement']),
                        **deepcopy(response['availability'])}
            self.assertEqual(path, '/booking-preview')
            calls.append(deepcopy(body))
            return deepcopy(response)
        token = booking_names._agent.set(self.agent)
        try:
            with patch.object(plugin, '_post_bot', side_effect=staff):
                booking_names.begin_turn(session_id=self.agent.session_id,
                                         scope=plugin._booking_name_scope())
                result = json.loads(registry.tools['quote_booking']['handler'](plan))
            self.assertTrue(result['success'], result)
            self.assertFalse(result['room_decision']['clarification_needed'], result)
            self.assertEqual([guest.get('explicit_gender') for guest in calls[0]['guests']],
                             ['female'] * 3)
        finally:
            booking_names.end_turn()
            booking_names._agent.reset(token)

    def test_sim9_plugin_group_gender_survives_sparse_roster(self):
        params = {'guest_count': 3, 'group_gender': 'female',
                  'room_preference': 'female_only', 'room_name_hints': [
                      {'name': 'Aisha', 'explicit_gender': 'female'},
                      {'name': 'Priya'}, {'name': 'Leila'}]}
        decision = plugin._room_decision_for_tool(
            params, {'girls_room_available': True})
        self.assertEqual(decision['resolved_composition'], 'female')
        self.assertFalse(decision['clarification_needed'])
        params['room_name_hints'][1]['explicit_gender'] = 'male'
        contradictory = plugin._room_decision_for_tool(
            params, {'girls_room_available': True})
        self.assertNotIn('female_only', contradictory['allowed_room_preferences'])

    def test_sim9_ordinary_equivalent_requote_retains_shown_authority(self):
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        before = ledger._transaction(lambda state, ingress: deepcopy(state['presentation']))
        self.turn('sim9-read-refresh', 'Please book that offer')
        ledger.record_quote(self.plan, self.response)
        after = ledger._transaction(lambda state, ingress: deepcopy(state.get('presentation')))
        self.assertEqual(after, before)
        self.assertTrue(ledger.prepare_create({}).revalidation)

    def test_sim9_explicit_empty_extras_match_shown_empty_extras(self):
        self._registered_create_with_completion({'add_ons': [], 'payment_choice': 'deposit'})

    def test_sim9_redundant_gender_matches_person_bound_shown_facts(self):
        self.plan['guests'] = [{'name': 'Alex', 'explicit_gender': 'male'},
                               {'name': 'Sam', 'explicit_gender': 'male'}]
        self.response = self._checked_offer(self.plan, [
            dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
            dict(bed_code='M2', room_code='M', gender_strategy='mixed')])
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('sim9-gender-restatement', 'Book that please')
        prepared = ledger.prepare_create({**self.plan, 'gender_preference': 'male'})
        self.assertTrue(prepared.revalidation)
        self.assertIsNone(prepared.get('gender_preference'))

    def test_registered_create_refreshes_quote_in_same_invocation(self):
        """Exercise the registered boundary, not its source spelling."""
        self._registered_create_with_completion({})

    def test_registered_create_structured_names_and_payment_without_interpreter(self):
        self._registered_create_with_completion({
            'guests': [{'name': 'Alex Rivera'}, {'name': 'Sam Lee'}],
            'payment_choice': 'deposit'})

    def test_structured_eligibility_completion_on_unchanged_mixed_beds(self):
        self._registered_create_with_completion({'guests': [
            {'name': 'Alex', 'explicit_gender': 'male'},
            {'name': 'Sam', 'explicit_gender': 'female'}]})

    def test_indexed_eligibility_refresh_rejects_transfers_and_factual_changes(self):
        before = {
            'guest_bed_assignments': [
                {'guest_index': 0, 'guest_name': 'Alex', 'bed_code': 'M1'},
                {'guest_index': 1, 'guest_name': 'Sam', 'bed_code': 'M2'}],
            'total_cents': 10000, 'currency': 'EUR',
            'payment_choice': 'per_guest', 'payment_link_amount_cents': 5000}
        after = deepcopy(before)
        after['room_name_hints'] = [
            {'name': 'Alex', 'explicit_gender': 'male'},
            {'name': 'Sam', 'explicit_gender': 'female'}]
        completions = [{'guest_index': 0, 'value': 'male'},
                       {'guest_index': 1, 'value': 'female'}]
        self.assertTrue(ledger._completion_revision_matches(
            before, after, eligibility_completions=completions))
        mutations = []
        swapped = deepcopy(after)
        swapped['room_name_hints'][0]['explicit_gender'] = 'female'
        swapped['room_name_hints'][1]['explicit_gender'] = 'male'
        mutations.append(swapped)
        moved = deepcopy(after)
        moved['guest_bed_assignments'][0]['bed_code'] = 'M2'
        mutations.append(moved)
        for field, value in (('total_cents', 10001), ('currency', 'USD')):
            mutations.append({**deepcopy(after), field: value})
        # Retired payment-helper cases: eligibility completion compares carried
        # eligibility; payment choice/link amount are validated by their owner.
        for field, value in (('payment_link_amount_cents', 1), ('payment_choice', 'full')):
            self.assertTrue(ledger._completion_revision_matches(
                before, {**deepcopy(after), field: value},
                eligibility_completions=completions))
        for changed in mutations:
            with self.subTest(changed=changed):
                self.assertFalse(ledger._completion_revision_matches(
                    before, changed, eligibility_completions=completions))

    def test_unchanged_full_payment_refresh(self):
        self.plan['payment_choice'] = 'full'
        self._registered_create_with_completion({})

    def test_unchanged_deposit_payment_refresh(self):
        self.plan['payment_choice'] = 'deposit'
        self._registered_create_with_completion({})

    def test_unchanged_per_guest_payment_refresh(self):
        self.plan['payment_choice'] = 'per_guest'
        self._registered_create_with_completion({})

    def test_unchanged_pay_on_arrival_payment_refresh(self):
        self.plan['payment_choice'] = 'pay_on_arrival'
        self._registered_create_with_completion({})

    def test_restart_recovery_retains_carried_fields_and_pending_operation_identity(self):
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('first-create', 'yes')
        refresh = ledger.prepare_create({})
        self.assertTrue(refresh.revalidation)
        ledger.record_quote(refresh, self.response)
        first = ledger.prepare_create({})
        attempts = []
        def timeout_transport():
            attempts.append(first['idempotency_key'])
            raise TimeoutError('offline unresolved transport')
        with self.assertRaises(TimeoutError):
            ledger.dispatch_create(first, timeout_transport)
        before = ledger._transaction(lambda state, ingress: deepcopy(state))
        self.assertTrue(before['dispatch_pending'])
        self.assertFalse(before.get('receipt'))
        self.turn('retry-create', 'Please finish that booking')
        ledger._transaction(lambda state, ingress: state.pop('checked_offer', None))
        refresh = ledger.prepare_create({})
        self.assertTrue(refresh.revalidation)
        ledger.record_quote(refresh, self.response)
        second = ledger.prepare_create({})
        after = ledger._transaction(lambda state, ingress: deepcopy(state))
        self.assertEqual(before['acceptance_message'], after['acceptance_message'])
        self.assertEqual(before.get('acceptance_raw_digest'), after.get('acceptance_raw_digest'))
        self.assertEqual(dict(first), dict(second))
        for field in ('guests', 'payment_choice', 'email', 'selected_bed_codes'):
            self.assertEqual(first.get(field), second.get(field), field)
        self.assertEqual(first['idempotency_key'], second['idempotency_key'])
        self.assertTrue(after['dispatch_pending'])
        self.assertFalse(after.get('receipt'))
        self.assertEqual(attempts, [first['idempotency_key']])

    def _registered_create_with_completion(self, completions):
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        registry = Registry()
        plugin.register(registry)
        calls = []
        def staff(path, body):
            calls.append((path, deepcopy(body)))
            if path == '/booking-preview':
                return self._checked_offer(body, [
                    dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                    dict(bed_code='M2', room_code='M', gender_strategy='mixed')])
            if path == '/bookings/update-contact':
                return {'success': True, 'email_saved': True, 'email_sent': False}
            if path == '/availability-check':
                return self._exact_recheck(body, [
                    {'bed_code': 'M1', 'room_type': 'mixed'},
                    {'bed_code': 'M2', 'room_type': 'mixed'}])
            self.assertEqual(path, '/booking-create-from-plan')
            return {'success': True, 'write_performed': True,
                    'booking_id': 'offline-r2', 'booking_code': 'OFFLINE-R2'}
        initial_plan = deepcopy(self.plan)
        initial_response = self._checked_offer(self.plan, [
            dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
            dict(bed_code='M2', room_code='M', gender_strategy='mixed')])
        if completions.get('payment_choice'):
            initial_response = self._checked_offer(
                {**self.plan, 'payment_choice': 'deposit'}, [
                    dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
                    dict(bed_code='M2', room_code='M', gender_strategy='mixed')])
            initial_plan.pop('payment_choice')
            initial_response['payment_choice_needed'] = True
        ledger.record_quote(initial_plan, initial_response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('model-create-no-cache', 'oui')
        ledger._transaction(lambda state, ingress: state.pop('checked_offer', None))
        from wolfhouse import booking_names
        agent_token = booking_names._agent.set(self.agent)
        try:
            with patch.object(plugin, '_session_guest_phone', return_value='+34900001234'), \
                    patch.object(plugin, '_post_bot', side_effect=staff):
                scope = plugin._booking_name_scope()
                self.assertIsNotNone(booking_names.begin_turn(
                    session_id=self.agent.session_id, scope=scope))
                booking_names.remember_names({'guests': self.plan['guests']}, scope)
                result = json.loads(registry.tools['create_booking_from_plan']['handler'](completions))
        finally:
            booking_names.end_turn()
            booking_names._agent.reset(agent_token)
        self.assertTrue(result['success'], result)
        self.assertEqual(sum(path == '/booking-preview' for path, _ in calls), 1)
        writes = [body for path, body in calls if path == '/booking-create-from-plan']
        self.assertEqual(len(writes), 1)
        self.assertTrue(writes[0]['require_offer_identity'])
        expected = {**self.plan, **completions}
        self.assertEqual(writes[0]['accepted_offer'], self._checked_offer(expected, [
            dict(bed_code='M1', room_code='M', gender_strategy='mixed'),
            dict(bed_code='M2', room_code='M', gender_strategy='mixed')])['offer_revision'])
        self.assertEqual(writes[0]['guests'], expected['guests'])
        self.assertEqual(writes[0]['payment_choice'], expected['payment_choice'])

    def test_structured_create_cannot_reorder_or_duplicate_occupant_identity(self):
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('bad-indexed-completion', 'Please book')
        for guests in (list(reversed(self.plan['guests'])),
                       [self.plan['guests'][0], self.plan['guests'][0]]):
            with self.subTest(guests=guests), patch.object(plugin, '_post_bot') as transport:
                with self.assertRaisesRegex(ledger.QuoteBoundaryError,
                                            'quote_completion_identity_changed'):
                    ledger.prepare_create({'guests': guests})
                transport.assert_not_called()

    def test_registered_create_rejects_changed_price_currency_and_unavailable(self):
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        from wolfhouse import booking_names
        for mode in ('price', 'currency', 'unavailable'):
            with self.subTest(mode=mode):
                self.agent.session_id = 'registered-negative-' + mode
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn('shown-' + mode, 'Quote this please')
                ledger.record_quote(self.plan, self.response)
                ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
                self.turn('create-' + mode, 'oui')
                refreshed = deepcopy(self.response)
                if mode == 'price':
                    refreshed['total_cents'] += 100
                    refreshed['offer_revision']['total_cents'] += 100
                    refreshed['offer_revision']['payment_link_amount_cents'] += 100
                elif mode == 'currency':
                    refreshed['currency'] = 'USD'
                    refreshed['offer_revision']['currency'] = 'USD'
                else:
                    refreshed.update(success=False, error='room_unavailable')
                    refreshed['availability']['status'] = 'unavailable'
                calls = []
                def staff(path, body):
                    calls.append((path, deepcopy(body)))
                    self.assertEqual(path, '/booking-preview')
                    return deepcopy(refreshed)
                registry = Registry()
                plugin.register(registry)
                token = booking_names._agent.set(self.agent)
                try:
                    with patch.object(plugin, '_session_guest_phone', return_value='+' + '34' + '7' * 9), \
                            patch.object(plugin, '_post_bot', side_effect=staff):
                        scope = plugin._booking_name_scope()
                        self.assertIsNotNone(booking_names.begin_turn(
                            session_id=self.agent.session_id, scope=scope))
                        booking_names.remember_names({'guests': self.plan['guests']}, scope)
                        result = json.loads(registry.tools['create_booking_from_plan']['handler']({}))
                finally:
                    booking_names.end_turn()
                    booking_names._agent.reset(token)
                self.assertFalse(result.get('success'), result)
                self.assertEqual([path for path, _ in calls], ['/booking-preview'])
                self.assertNotIn('booking_code', result)

    def test_pending_name_completion_revalidates_without_another_interpreter(self):
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('completed-name', 'Use Alex Rivera and proceed')
        ledger.interpret_owner_turn({
            'action': 'accept', 'action_evidence': 'Use Alex Rivera and proceed',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {'guests': [
                {'guest_index': 0, 'name': 'Alex Rivera', 'evidence': 'Alex Rivera'}]},
        })
        prepared = ledger.prepare_create({})
        self.assertTrue(prepared.revalidation)
        self.assertEqual(prepared['guests'], [{'name': 'Alex Rivera'}, {'name': 'Sam'}])

    def test_optional_diagnostic_readiness_is_recomputed_after_revalidation(self):
        ledger.record_quote(self.plan, self.response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})
        self.turn('diagnostic-accept', 'oui')
        interpretation = {'action': 'accept', 'action_evidence': 'oui',
            'ambiguous': False, 'negated': False, 'conditional': False,
            'material_changes': [], 'completions': {}}
        ledger.interpret_owner_turn(interpretation)
        ledger._transaction(lambda state, ingress: state['current_turn'].update(
            interpretation_result={'accepted': True, 'create_ready': False,
                                   'missing': ['staff_checked_offer']}))
        result = ledger.interpret_owner_turn(interpretation)
        self.assertTrue(result['create_ready'], result)
        self.assertEqual(result['missing'], [])

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
        self.assertIn('alex', result['final_response'].lower())
        self.assertNotIn('M1', result['final_response'])
        self.assertIn('alex and sam: two beds in the same mixed room', result['final_response'].lower())
        self.assertIn('€700', result['final_response'])
        self.assertIn('full', result['final_response'].lower())
        self.assertTrue(result['final_response'].endswith('Shall I save this booking?'))
        self.assertEqual(result['messages'][-1]['content'], result['final_response'])
        self.turn('contextual-yes', 'Yes!')
        self.interpret_accept('Yes!')
        self.assertIs(ledger.prepare_create({})['require_offer_identity'], True)

    def _checked_offer(self, plan, beds, quote_overrides=None):
        # Mirror the registered quote's canonical wire aliases before Staff's
        # real JS offer builder fingerprints the deterministic offline response.
        plan = deepcopy(dict(plan))
        if 'add_ons' not in plan and plan.get('catalog_selections'):
            plan['add_ons'] = [{'code': row['service_code'],
                                'quantity': row.get('quantity', 1)}
                               for row in plan['catalog_selections']
                               if row.get('service_code')]
        root = Path(__file__).resolve().parents[3]
        source = "const {buildCheckedWolfhousePreviewOffer:b}=require('./scripts/lib/luna-front-desk-accommodation-availability-service'); console.log(JSON.stringify(b(JSON.parse(process.argv[1]))));"
        quote = dict(success=True, total_cents=20000, deposit_required_cents=10000,
                     payment_link_amount_cents=(10000 if plan['payment_choice'] in ('deposit', 'per_guest') else 20000),
                     currency='EUR', package_code=plan['package_code'])
        quote.update(quote_overrides or {})
        checked = json.loads(subprocess.check_output(['node', '-e', source, json.dumps(dict(
            **{key: value for key, value in plan.items() if key not in ('guests', 'payment_choice')},
            client_slug='wolfhouse-somo', quote=quote, guests=plan['guests'],
            payment_choice=plan['payment_choice'], availability={**plan, 'status': 'checked',
            'selected_bed_codes': [bed['bed_code'] for bed in beds]}, room_rows=beds))], cwd=root))
        return dict(success=True, total_cents=quote['total_cents'],
                    deposit_required_cents=quote['deposit_required_cents'],
                    payment_choice_needed=False, currency=quote['currency'], **checked)

    def test_shown_three_person_quote_survives_missing_name_completion(self):
        plan = dict(check_in='2026-11-03', check_out='2026-11-06', guest_count=3,
                    room_type='shared', room_preference='female_only', package_code='package_none',
                    group_gender='female', guests=[{'name': 'Aisha', 'explicit_gender': 'female'}])
        beds = [dict(bed_code=f'R5-B{index}', room_code='R5', gender_strategy='female only')
                for index in range(1, 4)]
        amounts = dict(total_cents=36000, deposit_required_cents=30000,
                       payment_link_amount_cents=30000)
        response = self._checked_offer({**plan, 'payment_choice': 'deposit'}, beds,
                                       quote_overrides=amounts)
        response['payment_choice_needed'] = True
        ledger.record_quote(plan, response)
        ledger.finalize_offer_response({'completed': True, 'final_response': 'draft'})

        self.turn('sim10-complete',
                  'Yes take it — Aisha Rahman, Priya Shah, Leila Hassan. Deposit for all three.')
        complete = {**plan, 'guests': [
            {'name': name, 'explicit_gender': 'female'}
            for name in ('Aisha Rahman', 'Priya Shah', 'Leila Hassan')],
            'payment_choice': 'deposit'}
        refreshed = self._checked_offer(complete, beds, quote_overrides=amounts)
        ledger.record_quote(complete, refreshed)

        state = ledger._transaction(lambda owner, ingress: deepcopy(owner))
        self.assertTrue(state.get('presentation'), state)
        prepared = ledger.prepare_create(complete)
        self.assertEqual(prepared['guests'], complete['guests'])

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

        # Retry in the unchanged authenticated original ingress context.
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
        self.assertIn('📅 *Dates:* Mon 19 Oct – Thu 22 Oct · 1 guest', text)
        self.assertNotIn('1 guests', text)
        self.assertNotIn('2026-10-19', text)
        self.assertIn('🛏️ *room:* a bed in our mixed shared room', text.lower())
        self.assertNotIn('alex:', text.lower())
        self.assertNotIn('DORM-12', text)
        self.assertNotIn('ROOM-9', text)
        self.assertTrue(text.endswith('Shall I save this booking?'))

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
        # An optional diagnostic failure cannot poison a later create. With no
        # structured roster change, the exact shown Liam roster is retained.
        prepared = ledger.prepare_create({})
        self.assertEqual(prepared['guests'], plan['guests'])
        self.assertNotEqual(prepared['guests'][0]['name'], 'Alex Other')

    def test_packet_contradictions_make_model_stub_skip_create(self):
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
                contradictory = exact.replace(old, new)
                self.turn(f'contradiction-{index}', contradictory)
                from agent import conversation_loop
                from wolfhouse.offline_ingress_harness import gateway_ingress
                seen = []
                def model_stub(agent, text, *args, **kwargs):
                    seen.append(text)
                    return {'completed': True,
                            'final_response': 'I will recheck those terms.', 'messages': []}
                with patch.object(conversation_loop, 'run_conversation', model_stub), \
                        patch.object(plugin, '_post_bot') as transport:
                    result = gateway_ingress(self.agent, contradictory, f'model-revise-{index}',
                        lambda text: conversation_loop.run_conversation(self.agent, text))
                self.assertTrue(any(contradictory in text for text in seen), seen)
                transport.assert_not_called()
                self.assertIn('recheck', result['final_response'])

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
        self.assertTrue(first['final_response'].endswith('Shall I save this booking?'))
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
        self.assertIn('€210', again['final_response'])
        self.assertTrue(again['final_response'].endswith('Shall I save this updated booking?'))
        self.assertNotIn('DORM-12', again['final_response'])
        self.assertFalse(ledger._completion_revision_matches(
            response['offer_revision'], changed['offer_revision']))
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
        self.assertIn('alex and sam: two beds in the same mixed room', texts['same'].lower())
        self.assertIn('alex and sam: beds in two separate mixed rooms', texts['split'].lower())
        self.assertNotEqual(texts['same'], texts['split'])

    def test_preview_tool_shows_room_type_includes_line(self):
        root = Path(__file__).resolve().parents[3]
        script = """
const { computePackagePricePreview } = require('./scripts/lib/booking-guests');
const { loadConfig } = require('./scripts/lib/wolfhouse-quote-calculator');
// Offline Pricing fixture: explicit July coverage, never production calendar mutation.
const input = JSON.parse(process.argv[1]);
const config = loadConfig();
config.seasons = [{code: 'summer', active: true, bookable: true, priority: 0,
    ranges: [{start_month: 7, start_day: 1, end_month: 7, end_day: 31}]}];
console.log(JSON.stringify(computePackagePricePreview(input, config)));
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
            self.assertTrue(preview['success'], preview)
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
                if index == 8:
                    self.assertIn("What are the guests' full names?", result['final_response'])
                    self.assertNotIn('Shall I save this booking?', result['final_response'])
                else:
                    self.assertEqual(result['final_response'], 'Information only')
                self.turn('invalid-yes-' + str(index), 'yes')
                if index != 8:
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
        state = ledger._transaction(lambda stored, ingress: deepcopy(stored))
        frozen = ledger._frozen_recovery(
            state, session_key='k1', session_id=self.agent.session_id,
            identity=('whatsapp', 'c1', 'accept'), message_id='accept',
            raw='I accept the quote')
        self.assertIsNotNone(frozen)
        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.agent._session_db = self.db
        self.assertTrue(ledger._arm_exact_gateway_retry_for_owner(frozen))
        self.turn('accept', 'I accept the quote')
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
        # Crash recovery remains in the unchanged exact original ingress context.
        after = ledger.prepare_create({})
        self.assertEqual(after, committed[after['idempotency_key']])

    def test_post_booking_contact_pending_unknown_and_completed_survive_reopen(self):
        ledger.record_quote(self.plan, self.response)
        presented = ledger.finalize_offer_response({
            'completed': True, 'final_response': 'draft',
            'messages': [{'role': 'assistant', 'content': 'draft'}],
        })
        self.assertTrue(presented['final_response'].endswith('Shall I save this booking?'))
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
                return self._exact_recheck(body, [
                    {'bed_code': 'M1', 'room_type': 'mixed'},
                    {'bed_code': 'M2', 'room_type': 'mixed'}])
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
            self.assertIn('Shall I save this booking?', offered['final_response'])
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
            self.assertIn('saved earlier', readback['final_response'])
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
            if path == '/availability-check':
                return {'success': True, 'has_enough_beds': True,
                        'available_beds': deepcopy(self.response['offer_revision']['room_arrangement']),
                        **deepcopy(self.response['availability'])}
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
            else:
                # A cancellation response is model-owned and must not select
                # create_booking_from_plan at all.
                self.assertEqual(text, 'No, do not book.')
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
                return {**deepcopy(response['availability']),
                        **self._exact_recheck(body, [{'bed_code': 'R4-B1', 'room_code': 'R4',
                                                      'room_type': 'male_only',
                                                      'gender_strategy': 'male preferred'}]),
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
            self.assertEqual(creates[0]['guests'], [{'name': 'Alex Test', 'explicit_gender': 'male'}])
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
                exact = self._exact_recheck(body, available_beds) if all(
                    bed.get('room_type') == 'mixed' for bed in available_beds) else {}
                return {**deepcopy(response['availability']), **exact,
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
        self.assertEqual(creates[0]['guests'], [{'name': 'Alex'},
                         {'name': 'Sam', 'explicit_gender': 'female'}])

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
        # Retired hint-order case: hints are carried metadata and canonical guest
        # slot order remains frozen independently.
        carried = ledger.prepare_create({'room_name_hints': list(reversed(hints))})
        self.assertEqual(carried['room_name_hints'], hints)
        for changed in ({'guests': list(reversed(self.plan['guests']))},
                        {'payment_choice': 'deposit'}, {'selected_bed_codes': ['M2', 'M1']}):
            with self.subTest(changed=changed), self.assertRaises(ledger.QuoteBoundaryError):
                ledger.prepare_create(changed)

    def test_adapter_preserves_staff_checked_offer_not_model_offer(self):
        def staff(path, body):
            if path == '/availability-check':
                return {'success': True, 'has_enough_beds': True,
                        'available_beds': deepcopy(self.response['offer_revision']['room_arrangement']),
                        **deepcopy(self.response['availability'])}
            return deepcopy(self.response)
        with patch.object(plugin, '_post_bot', side_effect=staff):
            result = json.loads(plugin.quote_booking({**self.plan,
                'offer_revision': {'forged': True}, 'availability': {'status': 'held'}}))
        self.assertEqual(result.get('availability'), self.response['availability'])
        self.assertEqual(result.get('offer_revision'), self.response['offer_revision'])
