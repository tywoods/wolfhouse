"""Pass 5 owner lifecycle regressions using the installed conversation owner."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

PLUGIN_DIR = Path(__file__).resolve().parents[1] / "plugins"
sys.path.insert(0, str(PLUGIN_DIR))

from wolfhouse import accepted_quote as ledger
from wolfhouse import pending_question
from wolfhouse import test_first_yes_owner as owner_fixtures
import wolfhouse_staff_api as plugin


class Pass5PaymentQuestionLifecycleTests(unittest.TestCase):
    """Scripted model decisions, real owner boundaries, offline Staff transport.

    Historical test names are retained for incident traceability. Diagnostics
    cannot select an action, and no fixture writes presentation/acceptance state.
    """

    def owner_case(self):
        case = owner_fixtures.FirstYesOwnerTests(methodName="test_only_owner_final_question_authorizes_contextual_yes")
        case.setUp()
        self.addCleanup(case.tearDown)
        return case

    def typed_case(self):
        # Reuse the existing registered-path harness without inheriting/rerunning
        # its nine tests. Its interpreter/binder tripwires remain active.
        case = Phase1BTypedCompletionTests()
        self.addCleanup(case.doCleanups)
        case.setUp()
        return case

    @staticmethod
    def rows(case):
        with case.db._lock:
            return [tuple(row) for row in case.db._conn.execute(
                "SELECT key,value FROM state_meta "
                "WHERE key LIKE 'wolfhouse.accepted_quote.%' ORDER BY key")]

    def diagnostic(self, case, payload):
        before = self.rows(case)
        for _ in range(2):
            result = ledger.interpret_owner_turn(payload)
            self.assertTrue(result['diagnostic_only'])
            self.assertNotIn('accepted', result)
            self.assertNotIn('create_ready', result)
            self.assertEqual(self.rows(case), before)
        return result

    def test_clarify_combined_answers_replace_stale_shuttle_target(self):
        h = self.typed_case()
        transfer = {'direction': 'arrival', 'scheduled_at': '2026-11-01T12:00:00+01:00'}
        plan = {**h.case.plan, 'package_code': 'package_basic',
                'pending_transfers': [transfer]}
        plan.pop('payment_choice')
        h.quote(plan)
        h.show()
        self.assertEqual(h.state()['pending_question']['kind'], 'add_on')
        h.case.turn('combined-pass5', 'No shuttle, separate links, and full payment please.')
        params = {'shuttle_choice': 'declined', 'payment_link_distribution': 'separate',
                  'payment_choice': 'full'}
        h.quote(params)
        state = h.state()
        for key in ('shuttle_choice', 'payment_choice'):
            self.assertEqual(ledger._presentation_plan(state)[key], params[key])
        self.assertFalse(state['plan'].get('pending_transfers'))
        self.assertIs(state['plan']['per_guest_payment_links'], True)
        # Checked state retains the boolean mirror; assert canonical distribution
        # at the actual public Staff boundary, not an internal storage spelling.
        h.quote({})
        retry = [body for path, body in h.requests if path == '/booking-preview'][-1]
        self.assertEqual(retry['payment_link_distribution'], 'separate')
        self.assertIs(retry['per_guest_payment_links'], True)
        self.assertEqual(retry['shuttle_choice'], 'declined')
        self.assertEqual(retry['payment_choice'], 'full')
        self.assertFalse(retry.get('pending_transfers'))
        self.assertNotEqual(state['status'], 'accepted')
        with self.subTest(boundary='refreshed-question-descriptor'):
            self.assertNotEqual(h.state().get('pending_question', {}).get('kind'), 'add_on')

    def test_assignment_completion_preserves_indexed_gender_facts(self):
        supplied = [
            {'name': 'Max Becker', 'explicit_gender': 'male'},
            {'name': 'Nina Becker', 'explicit_gender': 'female'},
            {'name': 'Jan Becker', 'explicit_gender': 'male'},
        ]
        assignments = [
            {'guest_name': guest['name'], 'bed_code': bed}
            for guest, bed in zip(supplied, ('R2-B1', 'R5-B1', 'R2-B2'))
        ]
        self.assertEqual(ledger._assignment_completion_guests(supplied, assignments), supplied)

    def test_split_completion_keeps_same_turn_name_expansion(self):
        h = self.typed_case()
        h.quote(h.case.plan)
        h.show()
        h.case.turn('split-with-name', 'Alex Rivera, and separate links please.')
        guests = [{**h.case.plan['guests'][0], 'name': 'Alex Rivera'}, h.case.plan['guests'][1]]
        h.quote({'guests': guests, 'payment_link_distribution': 'separate'})
        h.show()
        h.case.turn('save-expanded', 'Book that offer')
        body = h.dispatch_without_booking_write({}, expected_guests=guests)
        self.assertEqual(body['payment_link_distribution'], 'separate')
        self.assertEqual(body['payment_choice'], h.case.plan['payment_choice'])
        self.assertEqual(body['selected_bed_codes'], [bed['bed_code'] for bed in h.beds])
        assignments = body['accepted_offer']['guest_bed_assignments']
        self.assertEqual([(row['guest_index'], row['guest_name']) for row in assignments],
                         [(0, 'alex rivera'), (1, 'sam')])

    def test_split_completion_keeps_same_turn_date_revision(self):
        h = self.typed_case()
        h.quote(h.case.plan)
        h.show()
        h.case.turn('split-with-date', 'Change checkout to 2026-11-09 and use separate links.')
        update = h.call('update_booking_plan', {'operation': 'revise',
                                               'changes': {'check_out': '2026-11-09'}})
        self.assertTrue(update['success'], update)
        self.assertFalse(update['accepted'])
        self.assertFalse(h.state().get('presentation'))
        self.assertEqual(h.state()['authorized_revision_changes'],
                         [{'field': 'check_out', 'value': '2026-11-09'}])
        h.quote({'payment_link_distribution': 'separate'})
        self.assertEqual(h.state()['plan']['check_out'], '2026-11-09')
        self.assertIs(h.state()['plan']['per_guest_payment_links'], True)
        h.quote({})
        retry = [body for path, body in h.requests if path == '/booking-preview'][-1]
        self.assertEqual(retry['payment_link_distribution'], 'separate')
        self.assertEqual(retry['check_out'], '2026-11-09')
        count = len(h.requests)
        refused = h.call('create_booking_from_plan', {})
        self.assertFalse(refused.get('success'), refused)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in h.requests[count:]))
        h.show()
        h.case.turn('save-revised', 'Book the changed offer')
        body = h.dispatch_without_booking_write({})
        self.assertEqual(body['check_out'], '2026-11-09')
        self.assertEqual(body['payment_link_distribution'], 'separate')

    def test_conditional_split_completion_still_requires_clarification(self):
        case = self.owner_case()
        ledger.record_quote(case.plan, case.response)
        owner_fixtures.offline_quote_result({'completed': True, 'final_response': 'draft'})
        raw = 'If fees are waived, use separate links.'
        case.turn('conditional-split', raw)
        self.diagnostic(case, {'action': 'clarify', 'conditional': True,
            'action_evidence': raw, 'completions': {
                'payment_link_distribution': {'value': 'separate', 'evidence': 'separate links'}}})
        # Scripted model chooses a clarification reply, not any mutating tool.
        retry = ledger.prepare_quote({})
        self.assertNotIn('payment_link_distribution', retry)
        self.assertIs(retry.get('per_guest_payment_links'), False)

    def test_conditional_amount_choice_stays_unresolved_on_quote_retry(self):
        case = self.owner_case()
        for choice, raw in (
                ('deposit', 'Only if the fee is waived, I will pay the deposit'),
                ('full', 'Only if the fee is waived, I will pay everything')):
            with self.subTest(choice=choice):
                case.agent.session_id = 'conditional-amount-' + choice
                case.db.create_session(case.agent.session_id, source='whatsapp')
                case.turn('quote-' + choice, 'Show the options')
                plan = deepcopy(case.plan)
                plan.pop('payment_choice')
                response = case._checked_offer({**plan, 'payment_choice': 'deposit'},
                                               case.response['offer_revision']['room_arrangement'])
                response['payment_choice_needed'] = True
                ledger.record_quote(plan, response)
                owner_fixtures.offline_quote_result({'completed': True, 'final_response': 'draft'})
                case.turn('conditional-' + choice, raw)
                diagnostic = self.diagnostic(case, {'action': 'clarify', 'conditional': True,
                    'completions': {'payment_choice': {'value': choice, 'evidence': raw}}})
                self.assertNotIn('payment_choice', diagnostic['plan'])
                self.assertNotIn('payment_choice', ledger.prepare_quote({}))
                state = next(json.loads(value) for _, value in self.rows(case)
                             if json.loads(value)['scope']['ID'] == case.agent.session_id)
                self.assertNotIn('pending_payment_completion', state)

    def test_unconditional_amount_choice_keeps_semantic_provenance_without_english_keyword(self):
        h = self.typed_case()
        for choice, raw in (('deposit', 'I will pay the first amount'), ('full', 'pay everything')):
            with self.subTest(choice=choice):
                h.fresh_session('natural-amount-' + choice)
                plan = {**h.case.plan, 'payment_link_distribution': 'together', 'shuttle_choice': 'declined'}
                plan.pop('payment_choice')
                h.quote(plan)
                h.show()
                h.case.turn('amount-' + choice, raw)
                body = h.dispatch_without_booking_write({'payment_choice': choice})
                self.assertEqual(body['payment_choice'], choice)
                self.assertEqual(h.state()['current_turn']['raw'], raw)

    def test_solo_amount_completion_advances_to_localized_save_consent(self):
        # Historical name: displayed deposit/full is itself the save decision;
        # there must be NO additional localized save/confirm turn.
        fixtures = (
            ('en', 'deposit', 'I will pay the deposit.'),
            ('es', 'full', 'Pagaré el importe completo.'),
            ('de', 'deposit', 'Ich zahle die Anzahlung.'),
            ('fr', 'full', 'Je paierai la totalité.'),
            ('it', 'deposit', 'Pagherò il deposito.'),
        )
        h = self.typed_case()
        h.beds = h.beds[:1]
        for language, choice, raw in fixtures:
            with self.subTest(language=language, choice=choice):
                h.fresh_session('solo-' + language)
                plan = {**h.case.plan, 'guest_count': 1, 'language': language,
                        'guests': h.case.plan['guests'][:1], 'shuttle_choice': 'declined',
                        'payment_link_distribution': 'together'}
                plan.pop('payment_choice')
                h.quote(plan)
                h.show()
                h.case.turn('solo-' + language + '-amount', raw)
                body = h.dispatch_without_booking_write({'payment_choice': choice})
                self.assertEqual(body['payment_choice'], choice)
                self.assertEqual(body['guest_count'], 1)
                self.assertEqual(body['guests'], plan['guests'])
                self.assertEqual(h.state()['current_turn']['raw'], raw)

    def test_natural_full_payment_wording_uses_typed_choice_with_turn_provenance(self):
        h = self.typed_case()
        for index, wording in enumerate(('pay everything', 'pay all of it')):
            with self.subTest(wording=wording):
                h.fresh_session('full-wording-' + str(index))
                h.quote(h.case.plan)
                h.show()
                h.case.turn('natural-full-' + str(index), wording)
                body = h.dispatch_without_booking_write({'payment_choice': 'full'})
                self.assertEqual(body['payment_choice'], 'full')
                self.assertEqual(h.state()['current_turn']['raw'], wording)

    def test_split_completion_validates_malformed_sibling_completion(self):
        h = self.typed_case()
        h.quote(h.case.plan)
        h.show()
        h.case.turn('split-malformed-sibling', 'Separate links; Alex Rivera.')
        before, count = h.rows(), len(h.requests)
        result = h.call('quote_booking', {'guests': 'Alex Rivera',
                                         'payment_link_distribution': 'separate'})
        with self.subTest(boundary='reject-invalid-sibling'):
            self.assertFalse(result.get('success'), result)
        with self.subTest(boundary='no-staff-io'):
            self.assertEqual(h.requests[count:], [])
        with self.subTest(boundary='owner-bytes-unchanged'):
            self.assertEqual(h.rows(), before)

    def test_split_completion_rejects_malformed_guests_before_owner_writer(self):
        h = self.typed_case()
        h.quote(h.case.plan)
        h.show()
        h.case.turn('split-before-owner-writer', 'Separate links; Alex Rivera.')
        before, count = h.rows(), len(h.requests)
        # Observe the real owner writer, not a replacement state machine. Even
        # an identical rewrite is too late for pre-mutation input admission.
        with patch.object(ledger, '_transaction', wraps=ledger._transaction) as writer:
            result = h.call('quote_booking', {'guests': 'Alex Rivera',
                                             'payment_link_distribution': 'separate'})
        with self.subTest(boundary='reject-invalid-sibling'):
            self.assertFalse(result.get('success'), result)
        with self.subTest(boundary='before-owner-writer'):
            self.assertEqual([call.args[0].__name__ for call in writer.call_args_list], [])
        with self.subTest(boundary='no-staff-io'):
            self.assertEqual(h.requests[count:], [])
        with self.subTest(boundary='owner-bytes-unchanged'):
            self.assertEqual(h.rows(), before)

    def test_split_completion_preserves_omitted_and_valid_guest_lists(self):
        h = self.typed_case()
        for label, supplied in (
                ('omitted', {}),
                ('objects', {'guests': deepcopy(h.case.plan['guests'])}),
                ('strings', {'guests': [guest['name'] for guest in h.case.plan['guests']]})):
            with self.subTest(guests=label):
                h.fresh_session('split-valid-guests-' + label)
                h.quote(h.case.plan)
                h.show()
                h.case.turn('split-valid-' + label, 'Separate links please.')
                count = len(h.requests)
                result = h.call('quote_booking', {
                    **supplied, 'payment_link_distribution': 'separate'})
                self.assertTrue(result.get('success'), result)
                previews = [body for path, body in h.requests[count:]
                            if path == '/booking-preview']
                self.assertEqual(len(previews), 1)
                self.assertEqual(previews[0]['guests'], h.case.plan['guests'])
                self.assertEqual(previews[0]['payment_link_distribution'], 'separate')
                self.assertIs(previews[0]['per_guest_payment_links'], True)
                self.assertEqual(previews[0]['payment_choice'], h.case.plan['payment_choice'])
                self.assertEqual(previews[0]['selected_bed_codes'],
                                 [bed['bed_code'] for bed in h.beds])
                self.assertNotEqual(h.state()['status'], 'accepted')

    def test_combined_completion_applies_name_date_condition_and_distribution_atomically(self):
        case = self.owner_case()
        ledger.record_quote(case.plan, case.response)
        owner_fixtures.offline_quote_result({'completed': True, 'final_response': 'draft'})
        raw = 'If fees are waived, change checkout to 2026-11-09 for Alex Rivera and use separate links.'
        case.turn('combined-atomic-adjudication', raw)
        result = self.diagnostic(case, {'action': 'revise', 'conditional': True,
            'action_evidence': raw,
            'material_changes': [{'field': 'check_out', 'value': '2026-11-09'}],
            'completions': {'guests': [{'guest_index': 0, 'name': 'Alex Rivera'}],
                            'payment_link_distribution': {'value': 'separate'}}})
        # Unlike the obsolete interpreter, diagnostics cannot partially apply
        # name/date while withholding only distribution. All bytes stay intact.
        self.assertEqual(result['plan']['guests'], case.plan['guests'])
        self.assertEqual(result['plan']['check_out'], case.plan['check_out'])
        self.assertNotIn('payment_link_distribution', result['plan'])
        before = self.rows(case)
        for malformed in (None, [], 'revise'):
            with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'quote_diagnostic_schema_invalid'):
                ledger.interpret_owner_turn(malformed)
            self.assertEqual(self.rows(case), before)
        # After clarification the MODEL explicitly selects date/name revision
        # and a typed quote completion; no code classifies either guest turn.
        case.turn('resolved-combined', 'The new dates and separate links work for Alex Rivera.')
        update = ledger.update_booking_plan({'operation': 'revise', 'changes': {
            'check_out': '2026-11-09', 'guests': [{'guest_index': 0, 'name': 'Alex Rivera'}]}})
        self.assertFalse(update['accepted'])
        prepared = ledger.prepare_quote({'payment_link_distribution': 'separate'})
        self.assertEqual(prepared['guests'][0]['name'], 'Alex Rivera')
        self.assertEqual(prepared['check_out'], '2026-11-09')
        self.assertEqual(prepared['payment_link_distribution'], 'separate')
        self.assertEqual(prepared['payment_choice'], case.plan['payment_choice'])

    def test_unknown_distribution_stays_unknown_on_retry(self):
        self.owner_case()
        retry = ledger.prepare_quote({})
        self.assertNotIn('payment_link_distribution', retry)
        self.assertNotIn('per_guest_payment_links', retry)

    def test_shuttle_acceptance_does_not_fabricate_transfer_requests(self):
        h = self.typed_case()
        h.quote(h.case.plan)
        h.case.turn('shuttle-acceptance', 'Yes, the shuttle please.')
        h.quote({'shuttle_choice': 'accepted'})
        plan = h.state()['plan']
        self.assertEqual(plan['shuttle_choice'], 'accepted')
        self.assertFalse(plan.get('pending_transfers'))
        self.assertFalse(plan.get('pending_transfer'))
        self.assertEqual(plan['guests'], h.case.plan['guests'])
        preview = [body for path, body in h.requests if path == '/booking-preview'][-1]
        self.assertFalse(preview.get('pending_transfers'))
        self.assertFalse(preview.get('pending_transfer'))
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in h.requests))

    def test_fact_equivalent_refresh_replaces_stale_target_atomically(self):
        h = self.typed_case()
        plan = {**h.case.plan, 'package_code': 'package_basic'}
        plan.pop('payment_choice')
        h.quote(plan)
        h.show()
        self.assertEqual(h.state()['pending_question']['kind'], 'add_on')
        h.case.turn('atomic-refresh', 'No shuttle, separate links, and full payment please.')
        h.quote({'shuttle_choice': 'declined', 'payment_link_distribution': 'separate',
                 'payment_choice': 'full'})
        h.show()
        state = h.state()
        with self.subTest(boundary='after-model-finalizer'):
            self.assertNotIn('pending_question', state)
        derived = ledger._quote_authoring_facts(
            ledger._presentation_plan(state), state['checked_offer'], 'en',
            create_ready=True, quote=state['quote'])['pending_question']
        self.assertEqual(derived, {'kind': None, 'options': []})
        h.quote({})
        with self.subTest(boundary='after-fact-equivalent-retry'):
            self.assertNotIn('pending_question', h.state())
        self.assertNotEqual(h.state()['status'], 'accepted')
        # Price was shown; the existing full/separate choice needs no second yes.
        body = h.dispatch_without_booking_write({})
        self.assertEqual(body['payment_choice'], 'full')
        self.assertEqual(body['payment_link_distribution'], 'separate')
        self.assertEqual(body['shuttle_choice'], 'declined')

    def test_registered_create_separate_full_returns_staff_links(self):
        case = self.owner_case()
        plan = {**case.plan, 'payment_choice': 'full',
                'payment_link_distribution': 'separate',
                'payment_distribution': 'separate',
                'per_guest_payment_links': True,
                'shuttle_choice': 'declined', 'pending_transfers': []}
        beds = case.response['offer_revision']['room_arrangement']
        response = case._checked_offer(plan, beds)
        ledger.record_quote(plan, response)
        shown = owner_fixtures.offline_quote_result({'completed': True, 'final_response': 'draft'})
        self.assertTrue(shown['completed'], shown)
        case.turn('pass5-create-full-split', 'Yes, save this booking.')

        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **tool): self.tools[tool['name']] = tool
            def register_hook(self, *args, **kwargs): pass

        registry = Registry()
        plugin.register(registry)
        requests = []

        def staff(path, body):
            # Existing synthetic Staff receipt/link boundary fixture; NOT SQL,
            # real booking persistence, or live payment-link creation evidence.
            requests.append((path, deepcopy(body)))
            if path == '/contact-identity':
                return {'success': True, 'identity_verified': True, 'contact_name': 'Alex'}
            if path == '/booking-preview':
                return response
            if path == '/availability-check':
                return case._exact_recheck(body, beds)
            if path == '/booking-create-from-plan':
                self.assertNotIn('payment_distribution', body)
                self.assertEqual(body['payment_link_distribution'], 'separate')
                self.assertEqual(body['payment_choice'], 'full')
                return {'success': True, 'write_performed': True,
                        'booking_id': 'pass5-booking', 'booking_code': 'PASS5',
                        'uses_per_guest_model': True,
                        'booking_guests': [
                            {'booking_guest_id': 'g1', 'guest_number': 1, 'guest_name': 'Alex'},
                            {'booking_guest_id': 'g2', 'guest_number': 2, 'guest_name': 'Sam'}]}
            if path.startswith('/booking-guests/') and path.endswith('/create-payment-link'):
                guest_id = path.split('/')[2]
                index = 1 if guest_id == 'g1' else 2
                self.assertEqual(body['payment_target'], 'full_share')
                return {'success': True, 'booking_guest_id': guest_id,
                        'guest_number': index, 'guest_name': 'Alex' if index == 1 else 'Sam',
                        'amount_due_cents': 10000, 'currency': 'EUR',
                        'payment_target': 'full_share', 'payment_id': f'pay-{index}',
                        'guest_payment_url': f'https://staff.test/pay/{index}'}
            if path == '/bookings/update-contact':
                return {'success': True, 'email_saved': True, 'email_sent': False}
            self.fail(f'unexpected Staff path {path}')

        from wolfhouse import booking_names
        token = booking_names._agent.set(case.agent)
        try:
            with (patch.object(plugin, '_post_bot', side_effect=staff),
                  patch.object(ledger, 'interpret_owner_turn', side_effect=AssertionError('diagnostic called'))):
                booking_names.begin_turn(session_id=case.agent.session_id, scope=plugin._booking_name_scope())
                result = json.loads(registry.tools['create_booking_from_plan']['handler']({}))
        finally:
            booking_names.end_turn()
            booking_names._agent.reset(token)

        self.assertTrue(result['success'], result)
        links = result['guest_payment_links']
        self.assertEqual([row['guest_name'] for row in links], ['Alex', 'Sam'])
        self.assertEqual([row['amount_due_cents'] for row in links], [10000, 10000])
        self.assertEqual([row['payment_target'] for row in links], ['full_share', 'full_share'])
        self.assertEqual([row['booking_guest_id'] for row in links], ['g1', 'g2'])
        self.assertEqual(len([path for path, _ in requests if path == '/booking-create-from-plan']), 1)
        self.assertTrue(any(path == '/booking-preview' for path, _ in requests))
        self.assertTrue(any(path == '/availability-check' for path, _ in requests))

    def test_full_only_renderer_uses_single_localized_save_question(self):
        for language in ('en', 'es', 'it', 'de', 'fr'):
            with self.subTest(language=language):
                plan = {'check_in': '2026-11-01', 'check_out': '2026-11-02',
                        'guest_count': 1, 'room_type': 'shared',
                        'package_code': 'package_none', 'language': language,
                        'payment_choice': 'full'}
                offer = {**plan, 'currency': 'EUR', 'total_cents': 10000,
                         'deposit_required_cents': 10000, 'full_payment_only': True,
                         'room_arrangement': [{'bed_code': 'M1', 'room_code': 'M'}]}
                # Retained legacy-renderer characterization, not a requirement
                # that the production finalizer replace model-authored wording.
                text = ledger._styled_quote_copy(plan, offer, language, create_ready=False)
                save = ledger._style_copy(language)['save']
                self.assertEqual(text.count(save), 1)
                self.assertNotIn('exact', text.casefold())
                self.assertNotIn('exacte', text.casefold())
                self.assertEqual(pending_question.quote_question_kind(plan, offer, language, False), 'go_ahead')
                self.assertIsNone(pending_question.rendered_options(plan, offer, language, False))


class Phase1BTypedCompletionTests(unittest.TestCase):
    """Registered-path characterization, NOT SQL booking-persistence proof.

    Real SessionDB and Staff's JS checked-offer builder; only external Staff
    transport is substituted. Create stops with an explicit no-write response,
    never a fabricated successful booking/save receipt. No prose adjudication.
    """

    def setUp(self):
        self.case = owner_fixtures.FirstYesOwnerTests(
            methodName="test_only_owner_final_question_authorizes_contextual_yes")
        self.case.setUp()
        self.addCleanup(self.case.tearDown)
        for module, name in ((ledger, "interpret_owner_turn"),
                             (pending_question, "bind_answer")):
            # create=True retains the tripwire after the obsolete binder is deleted.
            tripwire = patch.object(module, name, create=True, side_effect=AssertionError(
                "typed completion must not call " + name))
            spy = tripwire.start()
            self.addCleanup(tripwire.stop)
            self.addCleanup(spy.assert_not_called)

        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **tool): self.tools[tool["name"]] = tool
            def register_hook(self, *args, **kwargs): pass

        self.registry = Registry()
        plugin.register(self.registry)
        self.beds = deepcopy(self.case.response["offer_revision"]["room_arrangement"])
        self.requests = []
        transport = patch.object(plugin, "_post_bot", side_effect=self.staff_unit_transport)
        transport.start()
        self.addCleanup(transport.stop)

    def staff_unit_transport(self, path, body):
        """Unit transport responses only: no database booking/source writes."""
        self.requests.append((path, deepcopy(body)))
        if path == "/availability-check":
            return self.case._exact_recheck(body, self.beds)
        if path == "/booking-preview":
            priced = {**body, "payment_choice": body.get("payment_choice") or "deposit"}
            response = self.case._checked_offer(priced, self.beds)
            if not body.get("payment_choice"):
                response.update(payment_choice_needed=True, missing_fields=["payment_choice"])
            return response
        if path == "/booking-create-from-plan":
            return {"success": False, "write_performed": False,
                    "error": "phase1b_unit_transport_no_booking_write"}
        self.fail("unexpected external Staff path: " + path)

    def call(self, tool, params):
        from wolfhouse import booking_names
        token = booking_names._agent.set(self.case.agent)
        try:
            booking_names.begin_turn(session_id=self.case.agent.session_id,
                                     scope=plugin._booking_name_scope())
            return json.loads(self.registry.tools[tool]["handler"](deepcopy(params)))
        finally:
            booking_names.end_turn()
            booking_names._agent.reset(token)

    def rows(self):
        # Do not use the writing ledger._transaction for observation.
        # Scope atomicity to the owner rows, not booking_names' independent
        # begin_turn lifecycle/cache (which this test does not claim is atomic).
        with self.case.db._lock:
            return [tuple(row) for row in self.case.db._conn.execute(
                "SELECT key,value FROM state_meta "
                "WHERE key LIKE 'wolfhouse.accepted_quote.%' ORDER BY key")]

    def state(self):
        owners = [json.loads(value) for key, value in self.rows()
                  if key.startswith("wolfhouse.accepted_quote.")]
        owners = [state for state in owners
                  if state["scope"]["ID"] == self.case.agent.session_id]
        self.assertEqual(len(owners), 1)
        return owners[0]

    def quote(self, params):
        result = self.call("quote_booking", params)
        self.assertTrue(result.get("success"), result)
        self.assertTrue(self.state().get("quote", {}).get("offer_revision"), result)
        return result

    def show(self):
        shown = owner_fixtures.offline_quote_result(
            {"completed": True, "final_response": "offline model fixture"})
        self.assertTrue(shown.get("completed"), shown)
        self.assertTrue(self.state().get("presentation"), shown)

    def fresh_session(self, label):
        self.case.agent.session_id = "phase1b-" + label
        self.case.db.create_session(self.case.agent.session_id, source="whatsapp")
        self.case.turn(label, "structured fixture input")
        self.requests.clear()

    def dispatch_without_booking_write(self, params, expected_guests=None):
        start = len(self.requests)
        result = self.call("create_booking_from_plan", params)
        calls = self.requests[start:]
        writes = [body for path, body in calls if path == "/booking-create-from-plan"]
        self.assertEqual(len(writes), 1, result)
        self.assertFalse(result.get("success"), result)
        self.assertFalse(result.get("write_performed"), result)
        self.assertFalse(self.state().get("receipt"))
        if expected_guests is not None:
            self.assertEqual(writes[0].get("guests"), expected_guests, writes[0])
        self.assertTrue(writes[0].get("require_offer_identity"), writes[0])
        self.assertTrue(any(path == "/booking-preview" for path, _ in calls))
        self.assertTrue(any(path == "/availability-check" for path, _ in calls))
        return writes[0]

    def test_phase1b_distribution_quote_does_not_choose_amount(self):
        for distribution in ("together", "separate"):
            with self.subTest(distribution=distribution):
                self.fresh_session("distribution-" + distribution)
                plan = {**self.case.plan, "payment_link_distribution": distribution}
                plan.pop("payment_choice")
                result = self.quote(plan)
                preview = [body for path, body in self.requests if path == "/booking-preview"][-1]
                self.assertNotIn("payment_choice", preview)
                self.assertNotIn("payment_distribution", preview)
                self.assertEqual(preview["payment_link_distribution"], distribution)
                self.assertIs(preview["per_guest_payment_links"], distribution == "separate")
                self.assertTrue(result["payment_choice_needed"])
                state = self.state()
                self.assertNotIn("payment_choice", state.get("completion_plan", {}))
                self.assertNotEqual(state["status"], "accepted")
                self.assertFalse(any(path == "/booking-create-from-plan" for path, _ in self.requests))

    def test_provisional_refresh_never_authorizes_unchecked_dispatch(self):
        for refresh in ('unchosen', 'failed', 'incomplete'):
            with self.subTest(refresh=refresh):
                self.fresh_session('provisional-refresh-' + refresh)
                plan = {**self.case.plan, 'package_code': 'package_basic',
                        'pending_transfers': [{'direction': 'arrival',
                            'scheduled_at': '2026-11-01T12:00:00+01:00'}]}
                plan.pop('payment_choice')
                self.quote(plan)
                self.show()
                self.case.turn('provisional-completion', 'No shuttle; separate links please.')
                self.quote({'shuttle_choice': 'declined',
                            'payment_link_distribution': 'separate'})
                self.assertIsNone(self.state().get('checked_offer'))
                self.assertFalse(self.state()['presentation']['create_ready'])
                self.assertNotIn('payment_choice', ledger._presentation_plan(self.state()))
                count = len(self.requests)

                def refresh_transport(path, body):
                    response = self.staff_unit_transport(path, body)
                    if path == '/booking-preview':
                        if refresh == 'failed':
                            return {'success': False, 'error': 'offline_refresh_failed'}
                        if refresh == 'incomplete':
                            response.update(payment_choice_needed=True,
                                            missing_fields=['payment_choice'])
                    return response

                # Failed/incomplete Staff refresh must not gain authority even
                # when the model supplies a displayed amount in this invocation.
                params = {} if refresh == 'unchosen' else {'payment_choice': 'full'}
                with patch.object(plugin, '_post_bot', side_effect=refresh_transport):
                    result = self.call('create_booking_from_plan', params)
                calls = self.requests[count:]
                self.assertFalse(result.get('success'), result)
                self.assertFalse(result.get('write_performed'), result)
                self.assertTrue(any(path == '/booking-preview' for path, _ in calls))
                self.assertEqual([body for path, body in calls
                                  if path == '/booking-create-from-plan'], [])
                self.assertFalse(self.state().get('receipt'))
                self.assertFalse(self.state().get('dispatch_pending'))

    def test_provisional_same_call_explicit_choice_keeps_checked_dispatch(self):
        plan = {**self.case.plan, 'package_code': 'package_basic'}
        plan.pop('payment_choice')
        self.quote(plan)
        self.show()
        self.case.turn('provisional-completion', 'No shuttle; separate links please.')
        self.quote({'shuttle_choice': 'declined', 'payment_link_distribution': 'separate'})
        self.assertIsNone(self.state().get('checked_offer'))
        # No new shown offer, second confirmation, or readiness override.
        self.case.turn('provisional-full', 'Pay everything.')
        body = self.dispatch_without_booking_write({'payment_choice': 'full'})
        self.assertEqual(body['payment_choice'], 'full')
        self.assertEqual(body['payment_link_distribution'], 'separate')
        self.assertEqual(body['accepted_offer']['payment_choice'], 'full')
        self.assertEqual(body['accepted_offer'], self.state()['checked_offer'])

    def test_phase1b_presented_amount_create_preserves_distribution(self):
        for distribution in ("together", "separate"):
            for choice in ("deposit", "full"):
                with self.subTest(distribution=distribution, choice=choice):
                    self.fresh_session(distribution + "-" + choice)
                    plan = {**self.case.plan, "payment_link_distribution": distribution,
                            "shuttle_choice": "declined"}
                    plan.pop("payment_choice")
                    self.quote(plan)
                    self.show()
                    self.case.turn("typed-amount", "structured fixture input")
                    body = self.dispatch_without_booking_write({"payment_choice": choice})
                    self.assertEqual(body["payment_choice"], choice)
                    self.assertEqual(body["payment_link_distribution"], distribution)
                    self.assertIs(body["per_guest_payment_links"], distribution == "separate")
                    self.assertNotIn("payment_distribution", body)
                    self.assertEqual(body["accepted_offer"]["payment_choice"], choice)

    def test_phase1b_same_person_partial_and_full_names_keep_indices_and_beds(self):
        for names in (("Alex Rivera", "Sam"), ("Alex Rivera", "Sam Taylor")):
            with self.subTest(names=names):
                self.fresh_session("names-" + names[1])
                guests = [{"name": "Alex", "explicit_gender": "male"},
                          {"name": "Sam", "explicit_gender": "female"}]
                self.quote({**self.case.plan, "guests": guests,
                            "payment_link_distribution": "together"})
                self.show()
                self.case.turn("typed-names", "structured fixture input")
                completed = [{**guest, "name": name} for guest, name in zip(guests, names)]
                body = self.dispatch_without_booking_write(
                    {"guests": completed}, expected_guests=completed)
                self.assertEqual(body["guests"], completed)
                self.assertEqual(body["selected_bed_codes"], [bed["bed_code"] for bed in self.beds])
                assignments = body["accepted_offer"]["guest_bed_assignments"]
                self.assertEqual([(row["guest_index"], row["guest_name"], row["bed_code"])
                                  for row in assignments],
                                 [(i, name.casefold(), self.beds[i]["bed_code"])
                                  for i, name in enumerate(names)])
                self.assertEqual(body["room_name_hints"], completed)

    def test_phase1b_create_reordered_or_colliding_names_refuses_atomically(self):
        self.quote(self.case.plan)
        self.show()
        self.case.turn("invalid-person-order", "structured fixture input")
        for guests in ([{"name": "Sam Taylor"}, {"name": "Alex Rivera"}],
                       [{"name": "Alex Rivera"}, {"name": "Alex Rivera"}]):
            with self.subTest(guests=guests):
                before, count = self.rows(), len(self.requests)
                result = self.call("create_booking_from_plan", {"guests": guests})
                self.assertFalse(result.get("success"), result)
                self.assertEqual(result.get("error"), "quote_completion_identity_changed", result)
                self.assertEqual(self.requests[count:], [])
                self.assertEqual(self.rows(), before)

    def test_phase1b_indexed_eligibility_through_typed_quote(self):
        self.quote(self.case.plan)
        self.case.turn("typed-eligibility", "structured fixture input")
        # The public schema uses stable array order, NOT an invented guest_index
        # input field. Staff's checked output supplies the explicit index/bed map.
        guests = [{"name": "Alex", "explicit_gender": "male"},
                  {"name": "Sam", "explicit_gender": "female"}]
        result = self.quote({"guests": guests})
        preview = [body for path, body in self.requests if path == "/booking-preview"][-1]
        self.assertEqual(preview["guests"], guests)
        self.assertEqual(preview["room_name_hints"], guests)
        self.assertEqual(self.state()["plan"]["guests"], guests)
        assignments = result["offer_revision"]["guest_bed_assignments"]
        self.assertEqual([(row["guest_index"], row["guest_name"], row["bed_code"])
                          for row in assignments], [(0, "alex", "M1"), (1, "sam", "M2")])
        self.assertNotEqual(self.state()["status"], "accepted")

    def test_phase1b_shuttle_decline_clears_consumed_transfer_representations(self):
        transfer = {"direction": "arrival", "scheduled_at": "2026-11-01T12:00:00+01:00",
                    "flight_number": "UNIT123"}
        # These are existing adapter-consumed legacy keys, not newly advertised
        # schema fields. Exercise both list and singular fallback explicitly.
        for field, value in (("pending_transfers", [transfer]), ("pending_transfer", transfer)):
            with self.subTest(field=field):
                self.fresh_session("decline-" + field)
                self.quote({**self.case.plan, "shuttle_choice": "accepted", field: value})
                self.case.turn("typed-shuttle-decline", "structured fixture input")
                # Singular alias is not retained by the owner; restating that
                # already-consumed adapter input exposes the same cleanup gap.
                params = {"shuttle_choice": "declined",
                          **({field: value} if field == "pending_transfer" else {})}
                self.quote(params)
                preview = [body for path, body in self.requests if path == "/booking-preview"][-1]
                state = self.state()
                with self.subTest(boundary="staff-wire"):
                    self.assertFalse(preview.get("pending_transfers"), preview)
                    self.assertFalse(preview.get("pending_transfer"), preview)
                with self.subTest(boundary="retained-plan"):
                    self.assertEqual(state["plan"]["shuttle_choice"], "declined")
                    self.assertFalse(state["plan"].get("pending_transfers"), state["plan"])
                    self.assertFalse(state["plan"].get("pending_transfer"), state["plan"])
                    self.assertEqual(state["plan"]["check_in"], self.case.plan["check_in"])
                    self.assertEqual(state["plan"]["guests"], self.case.plan["guests"])
                with self.subTest(boundary="create-wire"):
                    self.show()
                    self.case.turn("create-after-decline", "structured fixture input")
                    body = self.dispatch_without_booking_write(
                        {field: value} if field == "pending_transfer" else {})
                    self.assertEqual(body["shuttle_choice"], "declined")
                    self.assertFalse(body.get("pending_transfers"), body)
                    self.assertFalse(body.get("pending_transfer"), body)

    def test_phase1b_combined_typed_quote_completes_without_diagnostic_mutation(self):
        self.quote(self.case.plan)
        self.case.turn("typed-combined", "structured fixture input")
        params = {"guests": [{"name": "Alex Rivera"}, {"name": "Sam Taylor"}],
                  "payment_link_distribution": "separate", "payment_choice": "deposit",
                  "per_guest_payment_links": True,
                  "shuttle_choice": "declined"}
        self.quote(params)
        state = self.state()
        for field, value in params.items():
            if field != "payment_link_distribution":
                self.assertEqual(state["plan"].get(field), value, field)
        self.assertNotEqual(state["status"], "accepted")
        self.show()
        self.case.turn("typed-combined-create", "structured fixture input")
        body = self.dispatch_without_booking_write({})
        for field, value in params.items():
            self.assertEqual(body.get(field), value, field)

    def test_phase1b_canonical_distribution_completion_replaces_stale_mirror(self):
        self.quote({**self.case.plan, "payment_link_distribution": "together"})
        self.case.turn("typed-distribution-change", "structured fixture input")
        # No new API: the advertised canonical field alone must be sufficient;
        # omission of its compatibility mirror is not a contradictory answer.
        self.quote({"payment_link_distribution": "separate"})
        preview = [body for path, body in self.requests if path == "/booking-preview"][-1]
        self.assertEqual(preview["payment_link_distribution"], "separate")
        self.assertIs(preview["per_guest_payment_links"], True)
        self.assertEqual(preview["payment_choice"], "full")

    def test_phase1b_invalid_sibling_preserves_combined_quote_atomically(self):
        self.quote(self.case.plan)
        self.show()
        self.case.turn("typed-invalid-sibling", "structured fixture input")
        before, count = self.rows(), len(self.requests)
        result = self.call("quote_booking", {
            "guests": [{"name": "Alex Rivera"}, {"name": "Sam Taylor"}],
            "shuttle_choice": "declined", "payment_choice": "deposit",
            "payment_link_distribution": "separate", "per_guest_payment_links": "true"})
        self.assertFalse(result.get("success"), result)
        self.assertEqual(result.get("error"), "payment_distribution_invalid", result)
        self.assertEqual(self.requests[count:], [])
        prior = json.loads(before[0][1])
        current = self.state()
        changed = sorted(key for key in prior.keys() | current.keys()
                         if prior.get(key) != current.get(key))
        self.assertEqual(self.rows(), before,
                         "invalid sibling changed owner fields: " + repr(changed)
                         + "; completion_plan=" + repr(current.get("completion_plan")))


if __name__ == "__main__":
    unittest.main()
