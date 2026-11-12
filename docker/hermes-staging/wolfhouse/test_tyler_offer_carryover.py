"""Tyler €190 regression: real plugin, owner and reopened Hermes SessionDB.

Trace 333/343/351 sends atomic two-day rentals; Staff 334/344/352 returns
wetsuit_hard_board_combo, quantity=1, days=2. Scripted HTTP receipts below are
fixtures, not live business-write evidence. No consent/owner guard is mocked.
Finalization is followed by simulated provider acknowledgement only for a new,
matching priced presentation; failed repairs and unpriced followups are no-ops.
"""
import json
import unittest
from copy import deepcopy
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock, patch

from hermes_state import SessionDB
from wolfhouse import accepted_quote as ledger, booking_names
from wolfhouse import test_first_yes_owner as first_yes_owner
from wolfhouse.test_quote_delivery_support import offline_finalize_and_send
import wolfhouse_staff_api as plugin


class TylerOfferCarryoverTests(unittest.TestCase):
    tearDown = first_yes_owner.FirstYesOwnerTests.tearDown
    _checked_offer = first_yes_owner.FirstYesOwnerTests._checked_offer
    _exact_recheck = staticmethod(first_yes_owner.FirstYesOwnerTests._exact_recheck)

    def setUp(self):
        first_yes_owner.FirstYesOwnerTests.setUp(self)
        self.plan = dict(check_in='2027-08-20', check_out='2027-08-23',
                         guest_count=1, guest_name='Tyler', guests=[{'name': 'Tyler'}],
                         language='en', package_code='package_none', room_type='shared',
                         room_preference='mixed', selected_bed_codes=['R1-B1'],
                         add_ons=[{'code': 'hard_board_rental', 'days': 2},
                                  {'code': 'wetsuit_rental', 'days': 2}],
                         payment_choice='full', per_guest_payment_links=False)
        self.beds = [dict(bed_code='R1-B1', room_code='R1', gender_strategy='flexible')]
        self.responses = {}
        for choice in ('deposit', 'full'):
            canonical = {**self.plan, 'payment_choice': choice,
                         'add_ons': [{'code': 'wetsuit_hard_board_combo', 'quantity': 1, 'days': 2}]}
            self.responses[choice] = self._checked_offer(canonical, self.beds, {
                'total_cents': 19000, 'deposit_required_cents': 10000,
                'payment_link_amount_cents': 10000 if choice == 'deposit' else 19000})
        for response in self.responses.values():
            # Staff invoice rows from trace 344; the copy guard must know the
            # €150 accommodation/€40 board/free wetsuit breakdown as well.
            response['included_items'] = [
                dict(label='Accommodation only (august, 3 nights, 1 guest, Malibu ref nightly)',
                     code='accommodation_only', package_code=None, nights=3, guest_count=1,
                     unit_cents=5000, total_cents=15000, free=False),
                dict(label='Hard board', code='hard_board_rental', days=2, people_count=1,
                     unit_label='days', unit_cents=2000, total_cents=4000, free=False,
                     display_line='Hard board — 2 rental days × 1 person = €40.00'),
                dict(label='Wetsuit', code='wetsuit_rental', days=2, people_count=1,
                     unit_label='days', unit_cents=0, total_cents=0, free=True,
                     free_note='free with board 🤙',
                     display_line='Wetsuit — 2 rental days × 1 person — free with board 🤙')]
        self.calls = []
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        self.registry = Registry()
        plugin.register(self.registry)
        self.transport = patch.object(plugin, '_post_bot', side_effect=self.staff)
        self.transport.start()
        self.addCleanup(self.transport.stop)
        self.turn('tyler-quote', 'Quote this stay please')

    def turn(self, message, raw):
        # No cached agent/SQLite connection may supply cross-turn authority.
        ledger.close_turn()
        self.db.close()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='first-yes')
        first_yes_owner.FirstYesOwnerTests.turn(self, message, raw)
        token = booking_names._agent.set(self.agent)
        self.addCleanup(booking_names._agent.reset, token)
        booking_names.begin_turn(session_id=self.agent.session_id, scope=plugin._booking_name_scope())

    def staff(self, path, body):
        self.calls.append((path, deepcopy(body)))
        if path == '/booking-preview':
            return deepcopy(self.responses[body.get('payment_choice', 'deposit')])
        if path == '/availability-check':
            return self._exact_recheck(body, self.beds)
        if path == '/booking-create-from-plan':
            return dict(success=True, write_performed=True, booking_id='offline-tyler',
                        booking_code='OFFLINE-TYLER', payment_id='offline-payment')
        if path.startswith('/payments/') and path.endswith('/create-stripe-link'):
            return dict(success=True, guest_payment_url='https://example.invalid/tyler')
        self.fail('Unexpected transport: ' + path)

    def call(self, name, params):
        return json.loads(self.registry.tools[name]['handler'](deepcopy(params)))

    def state(self):
        return ledger._read_owner_state(lambda state, _: deepcopy(state))

    def show(self, plan=None):
        result = self.call('quote_booking', self.plan if plan is None else plan)
        self.assertTrue(result['success'], result)
        # Trace message 345, with its missing deposit added to meet the priced
        # presentation contract. Scripted test copy, not runtime wording.
        text = ('Full payment is €190, Tyler 🌊😊 Nothing has been booked for this August stay yet.\n\n'
                '📅 August 20–23, 2027 · 3 nights\n🛏️ Shared mixed dorm: €150\n'
                '🏄 Hard board for August 21 and 22: €40\n🤙 Wetsuit for those same days: free\n'
                'Deposit requirement: €100.\n'
                '💳 €190 payable now, with nothing remaining once paid.\n\n'
                'Would you like to proceed with this €190 full-payment offer?')
        return offline_finalize_and_send({'completed': True, 'final_response': text})

    def _show_deposit_options_after_beach_faq(self, *, declare=True):
        # Trace 333 omitted payment while 334 returned chosen deposit; the
        # export starts mid-chat, so retain that established structured tier.
        ledger.record_availability_context({'payment_choice': 'deposit'})
        params = {key: value for key, value in self.plan.items() if key != 'payment_choice'}
        if declare:
            # Prospective declaration, NOT present in historical trace 333.
            params['present_payment_options'] = ['deposit', 'full']
        quoted = self.call('quote_booking', params)
        self.assertFalse(quoted['payment_choice_needed'])
        text = ('Lovely! Here’s your August stay, Tyler 🌊😊\n\n'
                '📅 August 20–23, 2027 · 3 nights\n🛏️ Shared mixed dorm · accommodation: €150\n'
                '🏄 Hard board for August 21 and 22: €40\n🤙 Wetsuit for those same days: free with the board\n'
                '💶 Total: €190\n\nWould you prefer the €100 deposit now, leaving €90 due at check-in '
                'once it’s paid, or the full €190?')
        shown = offline_finalize_and_send({'completed': True, 'final_response': text})
        self.assertTrue(shown['completed'], shown)
        self.assertIsNotNone(self.state().get('presentation'))
        self.turn('336-' + str(len(self.calls)), 'How far is the walk to the beach?')
        offline_finalize_and_send({'completed': True,
            'final_response': 'Playa de Somo is about a 10-minute walk from the house—roughly 1.2 km! 🌊😊'})
        self.assertEqual(self.state()['presentation']['displayed_text'], text)
        self.assertEqual(self.state()['presentation']['payment_choices'],
                         ['deposit', 'full'] if declare else ['deposit'])

    def test_historical_undeclared_options_remain_ambiguous_and_refused(self):
        self._show_deposit_options_after_beach_faq(declare=False)
        self.turn('historical-full', "I'll pay the full amount now")
        result = self.call('create_booking_from_plan', self.plan)
        self.assertFalse(result['success'], result)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_deposit_offer_full_option_after_beach_faq(self):
        self._show_deposit_options_after_beach_faq()
        self.turn('340', "I'll pay the full amount now")
        created = self.call('create_booking_from_plan', {**self.plan, 'confirm': True})
        self.assertTrue(created['success'], created)
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['accepted_offer']['payment_choice'], 'full')
        self.assertEqual(creates[0]['accepted_offer']['payment_link_amount_cents'], 19000)

    def test_undeclared_unchanged_requote_preserves_presented_options_and_decision(self):
        self._show_deposit_options_after_beach_faq()
        before = self.state()
        self.turn('included-refresh', 'Are the board and wetsuit included?')
        quoted = self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit'})
        self.assertTrue(quoted['success'], quoted)
        refreshed = self.state()
        self.assertEqual(refreshed.get('pending_question'), before['pending_question'])
        self.assertNotIn('question_refresh_message', refreshed)
        shown = offline_finalize_and_send({'completed': True, 'final_response':
            'Your board and wetsuit are included. Which payment option would you prefer?'})
        self.assertTrue(shown['completed'], shown)
        after = self.state()
        self.assertEqual(after['presentation']['payment_choices'], ['deposit', 'full'])
        self.assertEqual(after['presentation']['displayed_text'],
                         before['presentation']['displayed_text'])
        self.assertEqual(after['pending_question'], before['pending_question'])
        self.turn('full-after-refresh', 'Full please')
        created = self.call('create_booking_from_plan', self.plan)
        self.assertTrue(created['success'], created)
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['accepted_offer']['payment_choice'], 'full')
        self.assertEqual(creates[0]['accepted_offer']['payment_link_amount_cents'], 19000)

    def test_declared_unchanged_payment_followup_preserves_priced_offer(self):
        self._show_deposit_options_after_beach_faq()
        before = self.state()['presentation']
        self.turn('repeat-payment-options', 'Which payment options are available?')
        quoted = self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                           'present_payment_options': ['deposit', 'full']})
        self.assertTrue(quoted['success'], quoted)
        text = 'You can pay the deposit or pay in full. Which would you prefer?'
        shown = offline_finalize_and_send({'completed': True, 'final_response': text})
        self.assertTrue(shown['completed'], shown)
        self.assertEqual(shown['final_response'], text)
        self.assertEqual(self.state()['presentation']['displayed_text'], before['displayed_text'])
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit', 'full'])
        self.assertEqual(self.state()['pending_question'],
                         {'kind': 'payment_choice', 'options': ['deposit', 'full']})
        self.turn('full-after-declared-refresh', 'Full please')
        created = self.call('create_booking_from_plan', self.plan)
        self.assertTrue(created['success'], created)
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['accepted_offer']['payment_choice'], 'full')

    def test_declared_full_cannot_change_fresh_staff_distribution_mirror(self):
        self._show_deposit_options_after_beach_faq()
        canonical = {**self.plan, 'per_guest_payment_links': True,
                     'add_ons': [{'code': 'wetsuit_hard_board_combo', 'quantity': 1, 'days': 2}]}
        changed = self._checked_offer(canonical, self.beds, {
            'total_cents': 19000, 'deposit_required_cents': 10000,
            'payment_link_amount_cents': 19000})
        # Actual Staff builder: distribution rows can stay identical even when
        # the independent split boolean changes; request still says together.
        self.assertEqual(changed['offer_revision']['payment_distribution'],
                         self.responses['full']['offer_revision']['payment_distribution'])
        self.assertIs(changed['offer_revision']['per_guest_payment_links'], True)
        changed['included_items'] = deepcopy(self.responses['full']['included_items'])
        self.responses['full'] = changed
        self.turn('distribution-drift', 'Full please')
        result = self.call('create_booking_from_plan', self.plan)
        self.assertFalse(result['success'], result)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_registered_schema_exposes_only_quote_authoring_declaration(self):
        schema = self.registry.tools['quote_booking']['schema']['parameters']
        field = schema['properties'].get('present_payment_options')
        self.assertIsNotNone(field)
        self.assertEqual(field['items']['enum'], ['deposit', 'full'])
        # Codex rejects whole-array enums as unsupported constant values.
        # The owner still validates deposit membership and distinct choices.
        self.assertNotIn('enum', field)
        self.assertNotIn('const', field)
        self.assertEqual((field['minItems'], field['maxItems']), (1, 2))
        self.assertTrue(field['uniqueItems'])
        self.assertNotIn('present_payment_options', schema.get('required', []))
        create = self.registry.tools['create_booking_from_plan']['schema']['parameters']
        self.assertNotIn('present_payment_options', create['properties'])

    def test_repair_without_record_cannot_authorize_or_later_finalize_full(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        text = 'Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'
        # Exact blocker: numerically valid repair, but no same-writer record.
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?'},
            quote_rewrite_callback=lambda facts, draft: text)
        self.assertFalse(shown['completed'], shown)
        self.assertIsNone(shown['final_response'])
        self.assertIsNone(self.state().get('presentation'))
        self.assertNotIn('_present_payment_options', self.state()['quote'])
        offline_finalize_and_send({'completed': True, 'final_response': text})
        self.assertIsNone(self.state().get('presentation'))
        self.turn('full-after-missing-record', 'Full please')
        result = self.call('create_booking_from_plan', self.plan)
        self.assertFalse(result['success'], result)
        self.assertEqual(result['error'], 'quote_owner_presented_offer_required')
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_rewrite_preserves_declared_options_and_final_text_authority(self):
        quoted = self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                           'present_payment_options': ['deposit', 'full']})
        self.assertEqual(quoted['pending_question'],
                         {'kind': 'payment_choice', 'options': ['deposit', 'full']})
        self.assertIsNone(self.state().get('presentation'))
        for _, body in self.calls:
            self.assertNotIn('present_payment_options', body)
            self.assertNotIn('_present_payment_options', body)
        captured = []
        text = 'Total €190. Pay €100 deposit now and €90 at check-in once paid, or €190 in full?'
        def complete(**kwargs):
            captured.append(json.loads(kwargs['messages'][1]['content']))
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(
                content=json.dumps({'reply': text,
                                    'present_payment_options': ['deposit', 'full']})))])
        create = Mock(side_effect=complete)
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)))
        self.agent.model = 'offline-repair-model'
        self.agent._create_request_openai_client = Mock(return_value=client)
        self.agent._close_request_openai_client = Mock()
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?',
             'messages': [{'role': 'assistant', 'content': 'Total €9999?'}]},
            quote_rewrite_callback=ledger._quote_rewrite_callback(self.agent))
        self.assertTrue(shown['completed'], shown)
        self.assertEqual(create.call_count, 1)
        self.assertEqual(captured[0]['authoritative_staff_quote'].get('present_payment_options'),
                         ['deposit', 'full'])
        self.assertEqual(captured[0]['authoritative_staff_quote']['next_decision']['options'],
                         ['deposit', 'full'])
        self.assertIn('present_payment_options', captured[0]['instructions'])
        self.assertEqual(shown['final_response'], text)
        self.assertEqual(shown['messages'][-1]['content'], text)
        presentation = self.state()['presentation']
        self.assertEqual(presentation['payment_choices'], ['deposit', 'full'])
        self.assertEqual(presentation['displayed_text'], text)
        self.assertEqual(presentation['displayed_text_digest'],
                         __import__('hashlib').sha256(text.encode()).hexdigest())
        self.assertEqual(self.state()['pending_question'], quoted['pending_question'])
        self.turn('accept-atomic-repair', 'Full please')
        self.assertTrue(self.call('create_booking_from_plan', self.plan)['success'])
        self.turn('retry-atomic-repair', 'Full please')
        self.assertTrue(self.call('create_booking_from_plan', self.plan)['success'])
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['accepted_offer']['payment_link_amount_cents'], 19000)

    def _repair_agent(self, content):
        create = Mock(return_value=SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=content))]))
        client = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=create)),
                                 close=Mock())
        self.agent.model = 'offline-repair-model'
        self.agent._create_request_openai_client = Mock(return_value=client)
        self.agent._close_request_openai_client = Mock()
        return client, create

    def test_grok_repair_returns_atomic_record_after_bounded_primary_attempts(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        text = 'Total €190. Pay €100 deposit now and €90 at check-in once paid, or €190 in full?'
        record = {'reply': text, 'present_payment_options': ['deposit', 'full']}
        backup_create = Mock(return_value=SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content=json.dumps(record)))]))
        backup = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
            create=backup_create)), close=Mock())
        _, primary_create = self._repair_agent('Total €190. Deposit €100 now, €90 at check-in.')
        callback = ledger._quote_rewrite_callback(self.agent)
        repaired = []
        def rewrite(facts, draft):
            value = callback(facts, draft)
            repaired.append(value)
            return value
        with patch.dict('os.environ', {'XAI_API_KEY': 'offline-placeholder'}), \
                patch('openai.OpenAI', return_value=backup):
            shown = offline_finalize_and_send(
                {'completed': True, 'final_response': 'Total €9999?'},
                quote_rewrite_callback=rewrite)
        self.assertEqual(repaired, [record])
        self.assertTrue(shown['completed'], shown)
        self.assertEqual(shown['final_response'], text)
        self.assertEqual(primary_create.call_count, 3)
        self.assertEqual(backup_create.call_count, 1)
        backup.close.assert_called_once()
        payload = json.loads(backup_create.call_args.kwargs['messages'][1]['content'])
        self.assertIn('payment_options_record_invalid', payload['reject_reasons'])
        self.assertIn('present_payment_options', payload['instructions'])
        self.turn('accept-grok-repair', 'Full please')
        self.assertTrue(self.call('create_booking_from_plan', self.plan)['success'])
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['accepted_offer']['payment_link_amount_cents'], 19000)

    def test_duplicate_json_record_members_are_not_payment_authority(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        content = ('{"reply":"Total €190. Deposit €100 now, €90 at check-in.",'
                   '"present_payment_options":["deposit"],'
                   '"present_payment_options":["deposit","full"]}')
        _, create = self._repair_agent(content)
        callback = ledger._quote_rewrite_callback(self.agent)
        with patch.dict('os.environ', {'XAI_API_KEY': ''}):
            shown = offline_finalize_and_send(
                {'completed': True, 'final_response': 'Total €9999?'},
                quote_rewrite_callback=callback)
        self.assertFalse(shown['completed'], shown)
        self.assertEqual(create.call_count, 3)
        self.assertIn('payment_options_record_invalid', callback.last_failure['primary_cause'])
        self.assertIsNone(self.state().get('presentation'))
        self.turn('duplicate-record-full', 'Full please')
        self.assertFalse(self.call('create_booking_from_plan', self.plan)['success'])
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_legacy_undeclared_repair_still_returns_trimmed_plain_text(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit'})
        text = 'Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'
        _, create = self._repair_agent('  ' + text + '\n')
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?'},
            quote_rewrite_callback=ledger._quote_rewrite_callback(self.agent))
        self.assertTrue(shown['completed'], shown)
        self.assertEqual(shown['final_response'], text)
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit'])
        self.assertEqual(create.call_count, 1)

    def test_invalid_repair_records_fail_primary_grok_and_finalizer_closed(self):
        text = 'Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'
        good = {'reply': text, 'present_payment_options': ['deposit', 'full']}
        cases = {
            'plain-missing': text,
            'missing': {'reply': text},
            'deposit-only': {**good, 'present_payment_options': ['deposit']},
            'full-only-mismatch': {**good, 'present_payment_options': ['full']},
            'null': {**good, 'present_payment_options': None},
            'empty': {**good, 'present_payment_options': []},
            'string': {**good, 'present_payment_options': 'deposit,full'},
            'extra-option': {**good, 'present_payment_options': ['deposit', 'full', 'per_guest']},
            'duplicate-option': {**good, 'present_payment_options': ['deposit', 'full', 'full']},
            'wrong-order': {**good, 'present_payment_options': ['full', 'deposit']},
            'extra-field': {**good, 'amount_cents': 19000},
            'bad-reply': {**good, 'reply': 19000},
            'empty-reply': {**good, 'reply': ''},
            'wrong-money': {**good, 'reply': 'Total €9999?'},
            'broken-json': '{"reply":"Total €190",',
            'duplicate-key': ('{"reply":"Total €190","present_payment_options":["deposit"],'
                              '"present_payment_options":["deposit","full"]}'),
        }
        for name, record in cases.items():
            for route in ('models', 'direct-finalizer'):
                with self.subTest(record=name, route=route):
                    self.turn(name + route, 'Quote this stay')
                    self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                               'present_payment_options': ['deposit', 'full']})
                    raw = json.dumps(record) if isinstance(record, dict) else record
                    client, create = self._repair_agent(raw)
                    callback = ledger._quote_rewrite_callback(self.agent)
                    rewrite = callback if route == 'models' else lambda facts, draft: record
                    with patch.dict('os.environ', {'XAI_API_KEY': 'offline-placeholder'}), \
                            patch('openai.OpenAI', return_value=client):
                        shown = offline_finalize_and_send(
                            {'completed': True, 'final_response': 'Total €9999?',
                             'messages': [{'role': 'assistant', 'content': 'Total €9999?'}]},
                            quote_rewrite_callback=rewrite)
                    self.assertFalse(shown['completed'], shown)
                    self.assertIsNone(shown['final_response'])
                    self.assertEqual(shown['messages'], [])
                    if route == 'models':
                        self.assertEqual(create.call_count, 4)  # Three primary + one Grok.
                        self.assertEqual(callback.last_failure['stage'], 'backup_validation')
                        self.assertEqual(callback.last_failure['primary_stage'], 'primary_validation')
                    self.assertIsNone(self.state().get('presentation'))
                    self.assertNotIn('_present_payment_options', self.state()['quote'])
                    offline_finalize_and_send({'completed': True, 'final_response': text})
                    self.assertIsNone(self.state().get('presentation'))
                    self.turn(name + route + '-full', 'Full please')
                    refused = self.call('create_booking_from_plan', self.plan)
                    self.assertEqual(refused['error'], 'quote_owner_presented_offer_required')
                    self.assertFalse(refused['success'], refused)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_record_cannot_change_checked_options_via_callback_facts(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        def rewrite(facts, draft):
            facts['present_payment_options'][:] = ['deposit']
            return {'reply': 'Total €190. Deposit €100 now, €90 at check-in.',
                    'present_payment_options': ['deposit']}
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?'},
            quote_rewrite_callback=rewrite)
        self.assertFalse(shown['completed'], shown)
        self.assertIsNone(self.state().get('presentation'))

    def test_declared_valid_draft_needs_no_record_or_extra_model_call(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        rewrite = Mock(side_effect=AssertionError('No repair needed'))
        text = 'Total €190. Deposit €100 now or full €190?'
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': text}, quote_rewrite_callback=rewrite)
        self.assertTrue(shown['completed'], shown)
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit', 'full'])
        rewrite.assert_not_called()

    def _codex_repair_agent(self, content, *, reasoning=None, ending=None):
        # Import real emission methods without loading source-tree credentials;
        # skip AIAgent.__init__ (provider discovery), not the stream consumer.
        with patch('hermes_cli.env_loader.load_hermes_dotenv', return_value=[]):
            from run_agent import AIAgent
        from agent.memory_manager import StreamingContextScrubber
        from agent.think_scrubber import StreamingThinkScrubber
        agent = AIAgent.__new__(AIAgent)
        agent.__dict__.update(vars(self.agent))
        self.agent = agent
        agent.model = 'offline-repair-model'
        agent.api_mode = 'codex_responses'
        agent._interrupt_requested = False
        agent._codex_streamed_text_parts = ['outer draft']
        agent._current_streamed_assistant_text = 'outer draft'
        agent._stream_needs_break = True
        agent._stream_think_scrubber = StreamingThinkScrubber()
        agent._stream_context_scrubber = StreamingContextScrubber()
        agent.stream_delta_callback = Mock()
        agent._stream_callback = Mock()
        agent.reasoning_callback = Mock()
        agent._codex_stream_last_event_ts = 0
        agent._last_activity_ts = 0
        agent._last_activity_desc = 'outer activity'
        agent._client_log_context = lambda: 'offline fixture'
        self.scrubber_states = {name: deepcopy(vars(getattr(agent, name))) for name in (
            '_stream_think_scrubber', '_stream_context_scrubber')}
        # No event-consumer or emission-method mock: only the transport supplies
        # scripted SSE frames, including close(), like responses.create does.
        streams = []
        def create(**kwargs):
            self.assertTrue(kwargs['stream'])
            self.assertFalse(kwargs['store'])
            self.assertEqual(kwargs['timeout'], 12)
            self.assertNotIn('tools', kwargs)
            self.assertNotIn('tool_choice', kwargs)
            def events():
                if reasoning is not None:
                    yield {'type': 'response.reasoning_summary_text.delta', 'delta': reasoning}
                yield {'type': 'response.output_text.delta', 'delta': content[:20]}
                if isinstance(ending, BaseException):
                    raise ending
                if ending == 'interrupt':
                    agent._interrupt_requested = True
                yield {'type': 'response.output_text.delta', 'delta': content[20:]}
                if ending in ('cancel-timeout-first', 'cancel-timeout-last'):
                    cancel_at = 1 if ending == 'cancel-timeout-first' else 3
                    if len(streams) == cancel_at:
                        agent._interrupt_requested = True
                        raise TimeoutError('Offline timeout concurrent with cancellation')
                    yield {'type': 'response.failed', 'response': {'status': 'failed'}}
                    return
                if ending == 'complete-interrupt':
                    agent._interrupt_requested = True
                if ending == 'eof':
                    return
                status = ending if ending in ('failed', 'incomplete') else 'completed'
                yield {'type': 'response.' + status, 'response': {'id': 'offline', 'status': status}}
            iterator = events()
            class EventStream:
                def __iter__(self):
                    return iterator
            stream = EventStream()
            stream.close = Mock(side_effect=iterator.close)
            streams.append(stream)
            return stream
        client = SimpleNamespace(responses=SimpleNamespace(create=Mock(side_effect=create)))
        agent._create_request_openai_client = Mock(return_value=client)
        agent._close_request_openai_client = Mock()
        self.enterContext(patch('socket.socket.connect',
                                side_effect=AssertionError('Offline: sockets forbidden')))
        self.enterContext(patch.dict('os.environ', {'XAI_API_KEY': '', 'HERMES_KANBAN_TASK': ''}))
        snapshot = {key: getattr(agent, key) for key in (
            '_codex_streamed_text_parts', '_current_streamed_assistant_text',
            '_stream_needs_break', '_stream_think_scrubber', '_stream_context_scrubber',
            'stream_delta_callback', '_stream_callback', 'reasoning_callback')}
        return client, streams, snapshot

    def _assert_codex_outer_stream_restored(self, snapshot):
        agent = self.agent
        for callback in (agent.stream_delta_callback, agent._stream_callback, agent.reasoning_callback):
            callback.assert_not_called()
        for name, value in snapshot.items():
            self.assertIs(getattr(agent, name), value, name)
        if '_codex_streamed_text_parts' in snapshot:
            self.assertEqual(agent._codex_streamed_text_parts, ['outer draft'])
        else:
            self.assertNotIn('_codex_streamed_text_parts', vars(agent))
        for name in ('_fire_stream_delta', '_fire_reasoning_delta'):
            if name not in snapshot:
                self.assertNotIn(name, vars(agent))
        for name, state in self.scrubber_states.items():
            self.assertEqual(vars(getattr(agent, name)), state, name)
        self.assertGreater(agent._codex_stream_last_event_ts, 0)
        self.assertGreater(agent._last_activity_ts, 0)
        self.assertEqual(agent._last_activity_desc, 'receiving stream response')
        # The original active consumers still work; nested text must not spend
        # the paragraph break or poison either stateful scrubber.
        agent._fire_stream_delta('outer continuation')
        agent._fire_reasoning_delta('outer reasoning')
        for callback in (agent.stream_delta_callback, agent._stream_callback):
            callback.assert_called_once_with('\n\nouter continuation')
        agent.reasoning_callback.assert_called_once_with('outer reasoning')
        self.assertEqual(agent._current_streamed_assistant_text, 'outer draft\n\nouter continuation')

    def test_codex_unsuccessful_terminal_cannot_authorize_complete_record(self):
        for ending in ('failed', 'incomplete', 'eof'):
            with self.subTest(ending=ending):
                self.turn('terminal-' + ending, 'Quote please')
                self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                           'present_payment_options': ['deposit', 'full']})
                record = json.dumps({'reply': 'Total €190. Deposit €100 or full €190?',
                                     'present_payment_options': ['deposit', 'full']})
                client, streams, snapshot = self._codex_repair_agent(record, ending=ending)
                with patch.object(ledger, '_mark_quote_needs_human', return_value={}), \
                        patch.object(ledger, '_rewrite_quote_with_grok', return_value=None) as backup:
                    shown = offline_finalize_and_send(
                        {'completed': True, 'final_response': 'Total €9999?'},
                        quote_rewrite_callback=ledger._quote_rewrite_callback(self.agent))
                self.assertFalse(shown['completed'], shown)
                self.assertIsNone(shown['final_response'])
                self.assertEqual(client.responses.create.call_count, 3)
                backup.assert_called_once()
                self.assertIsNone(self.state().get('presentation'))
                self.assertNotIn('_present_payment_options', self.state()['quote'])
                self._assert_codex_outer_stream_restored(snapshot)
                for stream in streams:
                    stream.close.assert_called_once()
                self.agent._close_request_openai_client.assert_called_once_with(
                    client, reason='quote-card-rewrite')
                offline_finalize_and_send({'completed': True, 'final_response': 'Total €190.'})
                self.assertIsNone(self.state().get('presentation'))
                self.turn('terminal-full-' + ending, 'Full please')
                self.assertFalse(self.call('create_booking_from_plan', self.plan)['success'])
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_codex_cancellation_stops_quote_retries_backup_and_handoff(self):
        for ending in ('complete-interrupt', InterruptedError('offline cancellation'),
                       'cancel-timeout-first', 'cancel-timeout-last'):
            with self.subTest(ending=str(ending)):
                self.turn('cancel-' + str(ending), 'Quote please')
                self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                           'present_payment_options': ['deposit', 'full']})
                record = {'reply': 'Total €190. Deposit €100 or full €190?',
                          'present_payment_options': ['deposit', 'full']}
                client, streams, snapshot = self._codex_repair_agent(json.dumps(record), ending=ending)
                # An available, valid backup must not author anything after cancellation.
                with patch.object(ledger, '_rewrite_quote_with_grok', return_value=record) as backup, \
                        patch.object(ledger, '_mark_quote_needs_human') as handoff:
                    shown = offline_finalize_and_send(
                        {'completed': True, 'final_response': 'Total €9999?',
                         'messages': [{'role': 'assistant', 'content': 'Total €9999?'}]},
                        quote_rewrite_callback=ledger._quote_rewrite_callback(self.agent))
                self.assertFalse(shown['completed'], shown)
                self.assertTrue(shown.get('interrupted'), shown)
                self.assertNotEqual(shown.get('error'), 'quote_card_model_exhausted')
                self.assertIsNone(shown['final_response'])
                self.assertEqual(shown['messages'], [])
                self.assertNotIn('handoff_status', shown)
                backup.assert_not_called()
                handoff.assert_not_called()
                self.assertEqual(client.responses.create.call_count,
                                 3 if ending == 'cancel-timeout-last' else 1)
                self.agent._close_request_openai_client.assert_called_once_with(
                    client, reason='quote-card-rewrite')
                for stream in streams:
                    stream.close.assert_called_once()
                self._assert_codex_outer_stream_restored(snapshot)
                self.assertIsNone(self.state().get('presentation'))
                self.assertNotIn('_present_payment_options', self.state()['quote'])
                offline_finalize_and_send({'completed': True, 'final_response': record['reply']})
                self.assertIsNone(self.state().get('presentation'))
                self.turn('cancel-full-' + str(ending), 'Full please')
                self.assertFalse(self.call('create_booking_from_plan', self.plan)['success'])
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_codex_cancelled_saved_confirmation_preserves_saved_write_without_handoff(self):
        self._assert_cancelled_saved_confirmation('complete-interrupt', 1)

    def test_codex_final_timeout_cancellation_preserves_saved_confirmation_debt(self):
        self._assert_cancelled_saved_confirmation('cancel-timeout-last', 3)

    def _assert_cancelled_saved_confirmation(self, ending, expected_attempts):
        self.show()
        self.turn('save-before-cancel', 'Full please')
        saved = self.call('create_booking_from_plan', self.plan)
        self.assertTrue(saved['success'], saved)
        before = self.state()
        content = ('Booking OFFLINE-TYLER saved for Tyler, 20 Aug 2027 to 23 Aug 2027. '
                   'Total €190, deposit €100, due now €190, balance €0. '
                   'https://example.invalid/tyler')
        client, streams, snapshot = self._codex_repair_agent(content, ending=ending)
        def rewrite(facts, draft):
            self.assertIsNotNone(ledger._sendable_saved_confirmation(content, facts), facts)
            return ledger._rewrite_saved_confirmation(self.agent, facts, draft)
        with patch.object(ledger, '_rewrite_saved_confirmation_with_grok', return_value=content) as backup, \
                patch.object(ledger, '_mark_confirmation_needs_human') as handoff:
            shown = offline_finalize_and_send(
                {'completed': True, 'final_response': 'Total €9999?',
                 'messages': [{'role': 'assistant', 'content': 'Total €9999?'}]},
                saved_booking_projection=saved, rewrite_callback=rewrite)
        self.assertFalse(shown['completed'], shown)
        self.assertTrue(shown.get('interrupted'), shown)
        self.assertIsNone(shown['final_response'])
        self.assertEqual(shown['messages'], [])
        self.assertTrue(shown.get('confirmation_withheld'), shown)
        self.assertEqual(shown['confirmation_status']['reason'], 'confirmation_rewrite_cancelled')
        backup.assert_not_called()
        handoff.assert_not_called()
        self.assertEqual(client.responses.create.call_count, expected_attempts)
        for stream in streams:
            stream.close.assert_called_once()
        self.agent._close_request_openai_client.assert_called_once_with(
            client, reason='saved-booking-confirmation-rewrite')
        self._assert_codex_outer_stream_restored(snapshot)
        after = self.state()
        for key in ('completion', 'partial_completion', 'receipt', 'operation_key',
                    'dispatch_payload', 'dispatch_pending', 'presentation'):
            self.assertEqual(after.get(key), before.get(key), key)
        self.assertEqual(after['confirmation_owed']['reference'], 'OFFLINE-TYLER')
        self.turn('after-cancelled-save', 'Proceed with the same booking')
        repeated = self.call('create_booking_from_plan', self.plan)
        self.assertTrue(repeated['success'], repeated)
        self.assertTrue(repeated['idempotent'], repeated)
        self.assertEqual(sum(path == '/booking-create-from-plan' for path, _ in self.calls), 1)

    def test_codex_final_timeout_cancellation_preserves_only_prior_shown_options(self):
        for choices in (['deposit'], ['deposit', 'full']):
            with self.subTest(prior_choices=choices):
                self.turn('prior-' + str(choices), 'Quote please')
                deposit = {**self.plan, 'payment_choice': 'deposit'}
                self.call('quote_booking', {**deposit, 'present_payment_options': choices})
                text = ('Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'
                        if choices == ['deposit'] else 'Total €190. Deposit €100 or full €190?')
                shown = offline_finalize_and_send({'completed': True, 'final_response': text})
                self.assertTrue(shown['completed'], shown)
                self.turn('cancel-expansion-' + str(choices), 'Remind me of the options')
                self.call('quote_booking', {**deposit, 'present_payment_options': ['deposit', 'full']})
                # Requote refreshes authoritative_quote metadata, not the shown
                # choices/text. Cancellation must preserve this pending baseline.
                before = self.state()['presentation']
                self.assertEqual(before['payment_choices'], choices)
                self.assertEqual(before['displayed_text'], text)
                record = {'reply': 'Total €190. Deposit €100 or full €190?',
                          'present_payment_options': ['deposit', 'full']}
                client, streams, snapshot = self._codex_repair_agent(
                    json.dumps(record), ending='cancel-timeout-last')
                calls_before = deepcopy(self.calls)
                with patch.object(ledger, '_rewrite_quote_with_grok', return_value=record) as backup, \
                        patch.object(ledger, '_mark_quote_needs_human') as handoff:
                    shown = offline_finalize_and_send(
                        {'completed': True, 'final_response': 'Total €9999?'},
                        quote_rewrite_callback=ledger._quote_rewrite_callback(self.agent))
                self.assertFalse(shown['completed'], shown)
                self.assertTrue(shown.get('interrupted'), shown)
                backup.assert_not_called()
                handoff.assert_not_called()
                self.assertEqual(self.calls, calls_before)
                self.assertEqual(client.responses.create.call_count, 3)
                for stream in streams:
                    stream.close.assert_called_once()
                self._assert_codex_outer_stream_restored(snapshot)
                self.assertEqual(self.state()['presentation'], before)
                self.assertNotIn('_present_payment_options', self.state()['quote'])
                offline_finalize_and_send({'completed': True, 'final_response': record['reply']})
                self.assertEqual(self.state()['presentation'], before)
                self.turn('use-prior-' + str(choices), 'Full please')
                created = self.call('create_booking_from_plan', self.plan)
                self.assertEqual(created['success'], 'full' in choices, created)
        self.assertEqual(sum(path == '/booking-create-from-plan' for path, _ in self.calls), 1)

    def test_codex_concrete_response_requires_explicit_completion(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        record = {'reply': 'Total €190. Deposit €100 or full €190?',
                  'present_payment_options': ['deposit', 'full']}
        client, _, snapshot = self._codex_repair_agent(json.dumps(record))
        # Supported non-iterable concrete Responses objects have no SSE marker,
        # but must explicitly report completed; missing status never means success.
        response = SimpleNamespace(output=[], output_text=json.dumps(record),
                                   status='completed', close=Mock())
        client.responses.create.side_effect = None
        client.responses.create.return_value = response
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?'},
            quote_rewrite_callback=ledger._quote_rewrite_callback(self.agent))
        self.assertTrue(shown['completed'], shown)
        self.assertEqual(shown['final_response'], record['reply'])
        client.responses.create.assert_called_once()
        response.close.assert_called_once()
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit', 'full'])
        for name, value in snapshot.items():
            self.assertIs(getattr(self.agent, name), value)
        for callback in (self.agent.stream_delta_callback, self.agent._stream_callback,
                         self.agent.reasoning_callback):
            callback.assert_not_called()
        for fields in ({}, {'status': 'failed'}, {'status': 'incomplete'},
                       {'status': 'completed', 'terminal_event_type': None},
                       {'status': 'completed', 'terminal_event_type': 'response.failed'}):
            with self.subTest(fields=fields):
                response = SimpleNamespace(output=[], output_text=json.dumps(record), close=Mock(), **fields)
                client.responses.create.return_value = response
                with self.assertRaises(RuntimeError):
                    ledger._run_codex_confirmation_stream(self.agent, client, [
                        {'role': 'system', 'content': 'offline'},
                        {'role': 'user', 'content': 'offline'}], 12)
                response.close.assert_called_once()

    def test_codex_retry_authorizes_only_independently_completed_record(self):
        import httpx
        for ending in ('failed', 'incomplete', 'eof', 'read-timeout'):
            with self.subTest(ending=ending):
                self.turn('retry-' + ending, 'Quote please')
                self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                           'present_payment_options': ['deposit', 'full']})
                failed_record = {'reply': 'First attempt: total €190. Deposit €100 or full €190?',
                                 'present_payment_options': ['deposit', 'full']}
                completed_record = {**failed_record, 'reply': 'Completed retry: total €190. Deposit €100 or full €190?'}
                client, _, snapshot = self._codex_repair_agent(json.dumps(failed_record))
                def events(record, terminal):
                    yield {'type': 'response.output_text.delta', 'delta': json.dumps(record)}
                    if terminal == 'read-timeout':
                        raise httpx.ReadTimeout('offline transport retry')
                    if terminal != 'eof':
                        yield {'type': 'response.' + terminal, 'response': {'status': terminal}}
                class Stream:
                    def __init__(self, record, terminal):
                        self.iterator = events(record, terminal)
                        self.close = Mock(side_effect=self.iterator.close)
                    def __iter__(self):
                        return self.iterator
                streams = [Stream(failed_record, ending), Stream(completed_record, 'completed')]
                client.responses.create.side_effect = streams
                with patch.object(ledger, '_rewrite_quote_with_grok') as backup:
                    shown = offline_finalize_and_send(
                        {'completed': True, 'final_response': 'Total €9999?'},
                        quote_rewrite_callback=ledger._quote_rewrite_callback(self.agent))
                self.assertTrue(shown['completed'], shown)
                self.assertEqual(shown['final_response'], completed_record['reply'])
                self.assertEqual(client.responses.create.call_count, 2)
                backup.assert_not_called()
                for stream in streams:
                    stream.close.assert_called_once()
                self._assert_codex_outer_stream_restored(snapshot)
                self.assertEqual(self.state()['presentation']['displayed_text'], completed_record['reply'])
        self.turn('retry-full', 'Full please')
        self.assertTrue(self.call('create_booking_from_plan', self.plan)['success'])
        self.assertEqual(sum(path == '/booking-create-from-plan' for path, _ in self.calls), 1)

    def test_terminal_outer_reply_retires_only_current_pending_declaration(self):
        deposit = {**self.plan, 'payment_choice': 'deposit'}
        self.call('quote_booking', deposit)
        original = 'Total €190. Deposit €100 now, €90 at check-in. Book it?'
        offline_finalize_and_send({'completed': True, 'final_response': original})
        prior = self.state()['presentation']
        for outcome in ({'completed': True, 'interrupted': True},
                        {'completed': False, 'failed': True}, {'completed': False}):
            with self.subTest(outcome=outcome):
                self.turn('outer-' + str(outcome), 'Remind me of the options')
                self.call('quote_booking', {**deposit, 'present_payment_options': ['deposit', 'full']})
                refreshed_prior = self.state()['presentation']
                self.assertEqual(refreshed_prior['displayed_text'], prior['displayed_text'])
                self.assertEqual(refreshed_prior['payment_choices'], ['deposit'])
                rewrite = Mock(side_effect=AssertionError('Terminal reply must not author'))
                offline_finalize_and_send(
                    {**outcome, 'final_response': 'Total €190. Deposit €100 or full €190?'},
                    quote_rewrite_callback=rewrite)
                rewrite.assert_not_called()
                self.assertNotIn('_present_payment_options', self.state()['quote'])
                self.assertEqual(self.state()['presentation'], refreshed_prior)
                offline_finalize_and_send({'completed': True, 'final_response':
                    'Total €190. Deposit €100 or full €190?'})
                self.assertEqual(self.state()['presentation'], refreshed_prior)
        self.turn('outer-full-rejected', 'Full please')
        self.assertFalse(self.call('create_booking_from_plan', self.plan)['success'])
        self.turn('outer-deposit-still-valid', 'Deposit please')
        self.assertTrue(self.call('create_booking_from_plan', deposit)['success'])
        self.assertEqual(sum(path == '/booking-create-from-plan' for path, _ in self.calls), 1)

    def test_outer_cancellation_after_save_does_not_restart_confirmation_authorship(self):
        self.show()
        self.turn('save-outer-cancel', 'Full please')
        saved = self.call('create_booking_from_plan', self.plan)
        before = self.state()
        rewrite = Mock(return_value='Booking OFFLINE-TYLER. Total €190. Deposit €100. '
                       'https://example.invalid/tyler')
        with patch.object(ledger, '_mark_confirmation_needs_human') as handoff:
            shown = offline_finalize_and_send(
                {'completed': False, 'interrupted': True, 'final_response': 'Total €9999?'},
                saved_booking_projection=saved, rewrite_callback=rewrite)
        rewrite.assert_not_called()
        handoff.assert_not_called()
        self.assertFalse(shown['completed'])
        self.assertTrue(shown['interrupted'])
        self.assertIsNone(shown['final_response'])
        self.assertTrue(shown['confirmation_withheld'])
        after = self.state()
        for key in ('completion', 'partial_completion', 'receipt', 'operation_key',
                    'dispatch_payload', 'dispatch_pending', 'presentation'):
            self.assertEqual(after.get(key), before.get(key), key)
        self.assertEqual(after['confirmation_owed']['reference'], 'OFFLINE-TYLER')
        self.assertEqual(sum(path == '/booking-create-from-plan' for path, _ in self.calls), 1)

    def test_codex_stream_record_stays_internal_and_preserves_outer_stream(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        text = 'Total €190. Deposit €100 now or full €190?'
        content = json.dumps({'reply': text, 'present_payment_options': ['deposit', 'full']})
        client, streams, snapshot = self._codex_repair_agent(content, reasoning='INTERNAL valid reasoning')
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?',
             'messages': [{'role': 'assistant', 'content': 'Total €9999?'}]},
            quote_rewrite_callback=ledger._quote_rewrite_callback(self.agent))
        self.assertTrue(shown['completed'], shown)
        self.assertEqual(shown['final_response'], text)
        self.assertEqual(shown['messages'][-1]['content'], text)
        self._assert_codex_outer_stream_restored(snapshot)
        client.responses.create.assert_called_once()
        streams[0].close.assert_called_once()
        self.agent._close_request_openai_client.assert_called_once_with(client, reason='quote-card-rewrite')
        self.turn('codex-full', 'Full please')
        self.assertTrue(self.call('create_booking_from_plan', self.plan)['success'])

    def test_codex_rejected_record_and_reasoning_never_reach_consumers(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        content = json.dumps({'reply': 'Total €9999. Deposit €100 or full €9999?',
                              'present_payment_options': ['deposit', 'full']}, ensure_ascii=False)
        client, streams, snapshot = self._codex_repair_agent(
            content, reasoning='INTERNAL reasoning: rejected €9999')
        callback = ledger._quote_rewrite_callback(self.agent)
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?',
             'messages': [{'role': 'assistant', 'content': 'Total €9999?'}]},
            quote_rewrite_callback=callback)
        self.assertFalse(shown['completed'], shown)
        self.assertIsNone(shown['final_response'])
        self.assertEqual(shown['messages'], [])
        self.assertIsNone(self.state().get('presentation'))
        self.assertNotIn('_present_payment_options', self.state()['quote'])
        self.assertEqual(callback.last_failure['primary_stage'], 'primary_validation')
        self.assertEqual(callback.last_failure['stage'], 'backup_unavailable')
        self._assert_codex_outer_stream_restored(snapshot)
        self.assertEqual(client.responses.create.call_count, 3)
        for stream in streams:
            stream.close.assert_called_once()
        self.agent._close_request_openai_client.assert_called_once_with(client, reason='quote-card-rewrite')
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_codex_stream_exceptions_restore_live_outer_emitters(self):
        import httpx
        for failure in (RuntimeError('offline broken stream'), TimeoutError('offline watchdog'),
                        InterruptedError('offline cancellation'), KeyboardInterrupt(),
                        httpx.ReadTimeout('offline read timeout')):
            with self.subTest(failure=type(failure).__name__):
                client, streams, snapshot = self._codex_repair_agent(
                    '<think>private €9999', reasoning='INTERNAL failed reasoning', ending=failure)
                with self.assertRaises(type(failure)):
                    ledger._run_codex_confirmation_stream(self.agent, client, [
                        {'role': 'system', 'content': 'offline'},
                        {'role': 'user', 'content': 'offline'}], 12)
                self._assert_codex_outer_stream_restored(snapshot)
                expected_attempts = 2 if isinstance(failure, httpx.ReadTimeout) else 1
                self.assertEqual(client.responses.create.call_count, expected_attempts)
                for stream in streams:
                    stream.close.assert_called_once()
                self.assertFalse(self.agent._interrupt_requested)

    def test_codex_interrupted_repair_cannot_finalize_partial_record(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        content = json.dumps({'reply': 'Total €190. Deposit €100 or full €190?',
                              'present_payment_options': ['deposit', 'full']})
        client, streams, snapshot = self._codex_repair_agent(
            content, reasoning='INTERNAL interrupted reasoning', ending='interrupt')
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?'},
            quote_rewrite_callback=ledger._quote_rewrite_callback(self.agent))
        self.assertFalse(shown['completed'], shown)
        self.assertIsNone(shown['final_response'])
        self.assertIsNone(self.state().get('presentation'))
        self.assertNotIn('_present_payment_options', self.state()['quote'])
        self.assertTrue(self.agent._interrupt_requested)
        client.responses.create.assert_called_once()  # No transport restart after cancellation.
        streams[0].close.assert_called_once()
        self.agent._close_request_openai_client.assert_called_once_with(client, reason='quote-card-rewrite')
        self._assert_codex_outer_stream_restored(snapshot)

    def test_codex_timeout_repair_exhaustion_keeps_outer_consumers_live(self):
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        client, streams, snapshot = self._codex_repair_agent(
            '{"reply":"€9999', reasoning='INTERNAL timeout reasoning',
            ending=TimeoutError('offline watchdog'))
        callback = ledger._quote_rewrite_callback(self.agent)
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?'}, quote_rewrite_callback=callback)
        self.assertFalse(shown['completed'], shown)
        self.assertIsNone(shown['final_response'])
        self.assertIsNone(self.state().get('presentation'))
        self.assertEqual(callback.last_failure['primary_stage'], 'primary_transport')
        self.assertEqual(callback.last_failure['primary_cause'], 'TimeoutError')
        self.assertEqual(client.responses.create.call_count, 3)
        for stream in streams:
            stream.close.assert_called_once()
        self.agent._close_request_openai_client.assert_called_once_with(client, reason='quote-card-rewrite')
        self._assert_codex_outer_stream_restored(snapshot)

    def test_codex_saved_confirmation_uses_same_private_stream_boundary(self):
        from wolfhouse.test_confirmation_rewrite_callback import ENGLISH, ENGLISH_FACTS
        for content, expected_calls, expected in ((ENGLISH, 1, ENGLISH),
                                                  ('Total €9999.', 3, None)):
            with self.subTest(valid=expected is not None):
                client, streams, snapshot = self._codex_repair_agent(
                    content, reasoning='INTERNAL saved confirmation reasoning')
                result = ledger._rewrite_saved_confirmation(
                    self.agent, deepcopy(ENGLISH_FACTS), 'Total €9999?')
                self.assertEqual(result, expected)
                self._assert_codex_outer_stream_restored(snapshot)
                self.assertEqual(client.responses.create.call_count, expected_calls)
                for stream in streams:
                    stream.close.assert_called_once()
                self.agent._close_request_openai_client.assert_called_once_with(
                    client, reason='saved-booking-confirmation-rewrite')

    def test_codex_restores_instance_emitters_and_absent_outer_buffer(self):
        for failure in (None, RuntimeError('offline stream failure')):
            with self.subTest(failure=type(failure).__name__):
                self.turn('instance-emitter-' + str(failure), 'Offline repair')
                client, streams, snapshot = self._codex_repair_agent(
                    'private repair', reasoning='INTERNAL reasoning', ending=failure)
                del self.agent._codex_streamed_text_parts
                del snapshot['_codex_streamed_text_parts']
                # Real bound methods, stored as instance overrides by an outer
                # adapter. Cleanup must restore these exact objects, not delete.
                for name in ('_fire_stream_delta', '_fire_reasoning_delta'):
                    bound = getattr(self.agent, name)
                    setattr(self.agent, name, bound)
                    snapshot[name] = bound
                messages = [{'role': 'system', 'content': 'offline'},
                            {'role': 'user', 'content': 'offline'}]
                if failure is None:
                    self.assertEqual(ledger._run_codex_confirmation_stream(
                        self.agent, client, messages, 12), 'private repair')
                else:
                    with self.assertRaises(RuntimeError):
                        ledger._run_codex_confirmation_stream(self.agent, client, messages, 12)
                self._assert_codex_outer_stream_restored(snapshot)
                streams[0].close.assert_called_once()

    def test_failed_repair_keeps_prior_shown_options_not_pending_expansion(self):
        deposit = {**self.plan, 'payment_choice': 'deposit'}
        self.call('quote_booking', deposit)
        text = 'Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'
        offline_finalize_and_send({'completed': True, 'final_response': text})
        self.turn('failed-expansion', 'What about full?')
        self.call('quote_booking', {**deposit, 'present_payment_options': ['deposit', 'full']})
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?'},
            quote_rewrite_callback=lambda facts, draft: {'reply': text,
                                                       'present_payment_options': ['deposit']})
        self.assertFalse(shown['completed'], shown)
        offline_finalize_and_send({'completed': True, 'final_response': text})
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit'])
        self.assertEqual(self.state()['presentation']['displayed_text'], text)
        self.turn('failed-expansion-full', 'Full please')
        self.assertFalse(self.call('create_booking_from_plan', self.plan)['success'])
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_failed_unchanged_repair_retains_legitimate_prior_full_authority(self):
        self._show_deposit_options_after_beach_faq()
        before = self.state()['presentation']['displayed_text']
        self.turn('failed-unchanged', 'Remind me of the options')
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?'},
            quote_rewrite_callback=lambda facts, draft: 'Total €190.')
        self.assertFalse(shown['completed'], shown)
        self.assertEqual(self.state()['presentation']['displayed_text'], before)
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit', 'full'])
        self.turn('prior-shown-full', 'Full please')
        self.assertTrue(self.call('create_booking_from_plan', self.plan)['success'])
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['accepted_offer']['payment_link_amount_cents'], 19000)

    def test_failed_material_repair_cannot_reuse_prior_full_authority(self):
        self._show_deposit_options_after_beach_faq()
        changed = {**self.plan, 'check_out': '2027-08-24', 'payment_choice': 'deposit'}
        canonical = {**changed, 'add_ons':
                     [{'code': 'wetsuit_hard_board_combo', 'quantity': 1, 'days': 2}]}
        self.responses['deposit'] = self._checked_offer(canonical, self.beds, {
            'total_cents': 19000, 'deposit_required_cents': 10000,
            'payment_link_amount_cents': 10000})
        self.turn('failed-new-offer', 'Stay another night')
        self.call('quote_booking', {**changed, 'present_payment_options': ['deposit', 'full']})
        shown = offline_finalize_and_send(
            {'completed': True, 'final_response': 'Total €9999?'},
            quote_rewrite_callback=lambda facts, draft: 'Total €190.')
        self.assertFalse(shown['completed'], shown)
        offline_finalize_and_send({'completed': True, 'final_response': 'Total €190.'})
        self.assertIsNone(self.state().get('presentation'))
        self.turn('failed-new-full', 'Full please')
        self.assertFalse(self.call('create_booking_from_plan',
                                  {**changed, 'payment_choice': 'full'})['success'])
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_same_quote_new_declaration_requires_current_reply_finalization(self):
        deposit_plan = {**self.plan, 'payment_choice': 'deposit'}
        self.call('quote_booking', deposit_plan)
        offline_finalize_and_send({'completed': True, 'final_response':
            'Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'})
        self.turn('offer-both', 'Could I also pay in full?')
        quoted = self.call('quote_booking', {**deposit_plan,
                           'present_payment_options': ['deposit', 'full']})
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit'])
        self.assertEqual(quoted.get('pending_question'),
                         {'kind': 'payment_choice', 'options': ['deposit', 'full']})
        text = 'Total €190. Would you prefer €100 deposit or €190 full payment?'
        offline_finalize_and_send({'completed': True, 'final_response': text})
        self.assertEqual(self.state()['presentation']['displayed_text'], text)
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit', 'full'])
        self.turn('accept-expanded', 'Full please')
        self.assertTrue(self.call('create_booking_from_plan', self.plan)['success'])

    def test_invalid_declarations_never_reach_staff(self):
        for value in (None, [], 'deposit', ['full'], ['deposit', 'deposit'],
                      ['deposit', 'per_guest'], ['deposit', 'pay_on_arrival'],
                      [{'choice': 'deposit', 'amount_cents': 1}], ['deposit', 19000]):
            with self.subTest(value=value):
                before = len(self.calls)
                result = self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                                    'present_payment_options': value})
                self.assertFalse(result['success'], result)
                self.assertEqual(len(self.calls), before)
                self.assertIsNone(self.state().get('presentation'))

    def test_unbound_declaration_is_not_sent_to_staff(self):
        ledger.close_turn()
        # The plugin also supports legacy offline callers without the loop.
        # A declaration has no owner in that lane, so it must fail before wire.
        with patch.dict('sys.modules'):
            __import__('sys').modules.pop('agent.conversation_loop', None)
            result = self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                               'present_payment_options': ['deposit', 'full']})
        self.assertFalse(result['success'], result)
        self.assertFalse(self.calls, self.calls)

    def test_declaration_requires_staff_eligible_non_split_deposit(self):
        original = deepcopy(self.responses['deposit'])
        for changes in ({'deposit_required_cents': 0}, {'deposit_required_cents': 19000},
                        {'deposit_required_cents': 20000}, {'per_guest_payment_links': True},
                        {'availability_checked': False}):
            with self.subTest(changes=changes):
                changed = deepcopy(original)
                changed['offer_revision'].update(changes)
                if 'deposit_required_cents' in changes:
                    changed['deposit_required_cents'] = changes['deposit_required_cents']
                    changed['offer_revision']['payment_link_amount_cents'] = changes['deposit_required_cents']
                self.responses['deposit'] = changed
                result = self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
                self.assertFalse(result['success'], result)
                self.assertIsNone(self.state().get('presentation'))
        self.responses['deposit'] = original
        for request in ({'payment_choice': 'full'}, {'per_guest_payment_links': True},
                        {'payment_link_distribution': 'separate'}):
            with self.subTest(request=request):
                result = self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full'], **request})
                self.assertFalse(result['success'], result)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_declared_but_unfinalized_failed_or_interrupted_reply_has_no_authority(self):
        for stage in ('unfinalized', 'failed-rewrite', 'interrupted'):
            with self.subTest(stage=stage):
                self.turn('declare-' + stage, 'Quote please')
                quoted = self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit',
                                   'present_payment_options': ['deposit', 'full']})
                self.assertTrue(quoted['success'], quoted)
                if stage == 'failed-rewrite':
                    shown = offline_finalize_and_send(
                        {'completed': True, 'final_response': 'Total €9999?'})
                    self.assertFalse(shown['completed'])
                elif stage == 'interrupted':
                    offline_finalize_and_send({'completed': True, 'interrupted': True,
                        'final_response': 'Total €190. Deposit €100 or full €190?'})
                self.assertIsNone(self.state().get('presentation'))
                self.turn('accept-' + stage, 'Full please')
                result = self.call('create_booking_from_plan', self.plan)
                self.assertEqual(result['error'], 'quote_owner_presented_offer_required')
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_material_requote_does_not_inherit_declaration(self):
        self._show_deposit_options_after_beach_faq()
        changed_plan = {**self.plan, 'check_out': '2027-08-24', 'payment_choice': 'deposit'}
        canonical = {**changed_plan, 'add_ons':
                     [{'code': 'wetsuit_hard_board_combo', 'quantity': 1, 'days': 2}]}
        self.responses['deposit'] = self._checked_offer(canonical, self.beds, {
            'total_cents': 19000, 'deposit_required_cents': 10000,
            'payment_link_amount_cents': 10000})
        self.turn('new-stay', 'Stay one more night')
        quoted = self.call('quote_booking', changed_plan)
        self.assertTrue(quoted['success'], quoted)
        self.assertIsNone(self.state().get('presentation'))
        offline_finalize_and_send({'completed': True, 'final_response':
            'August 20–24. Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'})
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit'])
        self.turn('new-stay-full', 'Full please')
        self.assertFalse(self.call('create_booking_from_plan',
                                  {**changed_plan, 'payment_choice': 'full'})['success'])
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_declared_offer_cannot_cross_session_scope(self):
        self._show_deposit_options_after_beach_faq()
        ledger.close_turn()
        self.db.create_session('other-session', source='whatsapp')
        self.agent.session_id = 'other-session'
        first_yes_owner.FirstYesOwnerTests.turn(self, 'foreign-accept', 'Full please')
        result = self.call('create_booking_from_plan', self.plan)
        self.assertFalse(result['success'], result)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_superseded_prepared_declaration_cannot_record(self):
        prepared = ledger.prepare_quote({**self.plan, 'payment_choice': 'deposit',
                                        'present_payment_options': ['deposit', 'full']})
        self.call('quote_booking', {**self.plan, 'payment_choice': 'deposit'})
        with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'quote_response_superseded'):
            ledger.record_quote(prepared, self.responses['deposit'])
        offline_finalize_and_send({'completed': True, 'final_response':
            'Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'})
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit'])

    def test_same_quote_older_declaration_response_is_superseded(self):
        deposit_plan = {**self.plan, 'payment_choice': 'deposit'}
        self.assertTrue(self.call('quote_booking', deposit_plan)['success'])
        shown = offline_finalize_and_send({'completed': True, 'final_response':
            'Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'})
        self.assertTrue(shown['completed'], shown)
        self.turn('same-quote-race', 'Check the payment options')
        before = self.state()
        older = ledger.prepare_quote({**deposit_plan,
                                      'present_payment_options': ['deposit', 'full']})
        newer = self.call('quote_booking', {**deposit_plan,
                                          'present_payment_options': ['deposit']})
        self.assertTrue(newer['success'], newer)
        current = self.state()
        self.assertEqual(older.epoch, current['epoch'])
        self.assertEqual(current['presentation']['payment_choices'], ['deposit'])
        self.assertEqual(current['presentation']['displayed_text'],
                         before['presentation']['displayed_text'])
        with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'quote_response_superseded'):
            ledger.record_quote(older, self.responses['deposit'])
        self.assertEqual(self.state(), current)
        shown = offline_finalize_and_send({'completed': True, 'final_response':
            'Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'})
        self.assertTrue(shown['completed'], shown)
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit'])
        self.turn('reject-stale-full', 'Full please')
        self.assertFalse(self.call('create_booking_from_plan', self.plan)['success'])
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_undeclared_refresh_cannot_inherit_unfinalized_expansion(self):
        deposit_plan = {**self.plan, 'payment_choice': 'deposit'}
        self.assertTrue(self.call('quote_booking', deposit_plan)['success'])
        shown = offline_finalize_and_send({'completed': True, 'final_response':
            'Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'})
        self.assertTrue(shown['completed'], shown)
        self.turn('unshown-expansion', 'Check the options')
        self.assertTrue(self.call('quote_booking', {**deposit_plan,
            'present_payment_options': ['deposit', 'full']})['success'])
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit'])
        self.assertTrue(self.call('quote_booking', deposit_plan)['success'])
        shown = offline_finalize_and_send({'completed': True, 'final_response':
            'Total €190. Deposit €100 now, €90 at check-in once paid. Book it?'})
        self.assertTrue(shown['completed'], shown)
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit'])
        self.assertEqual(self.state()['pending_question']['kind'], 'go_ahead')
        self.turn('unshown-full', 'Full please')
        self.assertFalse(self.call('create_booking_from_plan', self.plan)['success'])
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_quote_preparation_fences_replies_without_revoking_frozen_dispatch(self):
        dispatch = self._prepare_declared_deposit_dispatch()
        before = self.state()
        deposit_plan = {**self.plan, 'payment_choice': 'deposit'}
        older = ledger.prepare_quote({**deposit_plan,
                                      'present_payment_options': ['deposit', 'full']})
        ledger.prepare_quote({**deposit_plan, 'present_payment_options': ['deposit']})
        current = self.state()
        self.assertEqual({key: value for key, value in current.items()
                          if key != 'quote_request_generation'},
                         {key: value for key, value in before.items()
                          if key != 'quote_request_generation'})
        with self.assertRaisesRegex(ledger.QuoteBoundaryError, 'quote_response_superseded'):
            ledger.record_quote(older, self.responses['deposit'])
        self.assertEqual(self.state(), current)
        attempts = []
        receipt = dict(success=True, write_performed=True,
                       booking_id='offline-fenced', booking_code='OFFLINE-FENCED')
        result = ledger.dispatch_create(
            dispatch, lambda: attempts.append(deepcopy(dict(dispatch))) or receipt)
        self.assertTrue(result['success'], result)
        self.assertEqual(len(attempts), 1)
        self.assertEqual(attempts[0]['accepted_offer']['payment_choice'], 'deposit')
        self.assertEqual(attempts[0]['idempotency_key'], dispatch['idempotency_key'])

    def test_direct_create_revalidation_keeps_quote_response_authority(self):
        self._show_deposit_options_after_beach_faq()
        self.turn('direct-refresh', 'Deposit please')
        params = {**self.plan, 'payment_choice': 'deposit'}
        prepared = ledger.prepare_create(params)
        self.assertTrue(prepared.revalidation)
        ledger.record_quote(prepared, self.responses['deposit'])
        dispatch = ledger.prepare_create(params)
        self.assertFalse(dispatch.revalidation)
        self.assertEqual(dispatch['accepted_offer']['payment_choice'], 'deposit')
        self.assertEqual(dispatch['accepted_offer']['payment_link_amount_cents'], 10000)

    def test_full_offer_cannot_expand_back_to_deposit(self):
        self.show()
        self.turn('reverse', 'Deposit please')
        result = self.call('create_booking_from_plan', {**self.plan, 'payment_choice': 'deposit'})
        self.assertFalse(result['success'], result)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_deposit_only_offer_does_not_authorize_full_create(self):
        ledger.record_availability_context({'payment_choice': 'deposit'})
        params = {key: value for key, value in self.plan.items() if key != 'payment_choice'}
        quoted = self.call('quote_booking', params)
        self.assertTrue(quoted['success'], quoted)
        shown = offline_finalize_and_send({'completed': True,
            'final_response': 'August 20–23, 2027, shared mixed dorm. Total €190. '
                              'Deposit €100 now, €90 at check-in. Book this offer?'})
        self.assertTrue(shown['completed'], shown)
        self.assertEqual(self.state()['presentation']['payment_choices'], ['deposit'])
        self.turn('deposit-only-accept', 'Yes, proceed')
        # A mistaken full-payment invocation cannot upgrade deposit-only consent.
        result = self.call('create_booking_from_plan', self.plan)
        self.assertFalse(result['success'], result)
        self.assertFalse(result['write_performed'], result)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_full_selection_rechecks_all_nonpayment_facts_and_charge(self):
        original = deepcopy(self.responses['full'])
        mutations = [
            {'total_cents': 19100, 'payment_link_amount_cents': 19100},
            {'currency': 'USD'},
            {'payment_link_amount_cents': 10000},
            {'deposit_required_cents': 11000},
            {'check_out': '2027-08-24'},
            {'add_ons': [{'code': 'wetsuit_hard_board_combo', 'quantity': 1, 'days': 3}]},
        ]
        for index, mutation in enumerate(mutations):
            with self.subTest(mutation=mutation):
                self.turn('switch-quote-' + str(index), 'Quote this stay')
                self._show_deposit_options_after_beach_faq()
                changed = deepcopy(original)
                changed.update(deepcopy(mutation))
                changed['offer_revision'].update(deepcopy(mutation))
                self.responses['full'] = changed
                self.turn('switch-reject-' + str(index), "I'll pay the full amount now")
                result = self.call('create_booking_from_plan', self.plan)
                self.assertFalse(result['success'], result)
                self.assertFalse(result['write_performed'], result)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_full_selection_does_not_reopen_a_completed_deposit_operation(self):
        self._show_deposit_options_after_beach_faq()
        self.turn('choose-deposit', 'Deposit please')
        saved = self.call('create_booking_from_plan', {**self.plan, 'payment_choice': 'deposit'})
        self.assertTrue(saved['success'], saved)
        self.turn('after-save-full', "I'll pay the full amount now")
        result = self.call('create_booking_from_plan', self.plan)
        self.assertFalse(result['success'], result)
        self.assertFalse(result['write_performed'], result)
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['accepted_offer']['payment_link_amount_cents'], 10000)

    def _prepare_declared_deposit_dispatch(self):
        self._show_deposit_options_after_beach_faq()
        self.turn('choose-deposit-for-recovery', 'Deposit please')
        params = {**self.plan, 'payment_choice': 'deposit'}
        prepared = ledger.prepare_create(params)
        if prepared.revalidation:
            refreshed = self.call('quote_booking', dict(prepared))
            self.assertTrue(refreshed['success'], refreshed)
            prepared = ledger.prepare_create(params)
        self.assertFalse(prepared.revalidation)
        return prepared

    def test_declared_options_cannot_switch_partial_deposit_completion(self):
        prepared = self._prepare_declared_deposit_dispatch()
        attempts = []
        receipt = dict(success=True, write_performed=True,
                       booking_id='offline-partial', booking_code='OFFLINE-PARTIAL')
        ledger.dispatch_create(prepared, lambda: attempts.append(dict(prepared)) or receipt)
        partial = {**receipt, 'payment_link_error': 'offline missing payment reply'}
        ledger.record_create_completion(prepared, partial)
        before = self.state()
        self.assertEqual(before['partial_completion'], partial)
        self.turn('partial-wants-full', 'Full please instead')
        result = self.call('create_booking_from_plan', self.plan)
        self.assertFalse(result['success'], result)
        self.assertFalse(result['write_performed'], result)
        after = self.state()
        self.assertEqual(after['partial_completion'], partial)
        self.assertEqual(after['dispatch_payload'], before['dispatch_payload'])
        self.assertEqual(after['operation_key'], before['operation_key'])
        self.assertEqual(len(attempts), 1)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_declared_options_cannot_switch_unknown_deposit_dispatch(self):
        prepared = self._prepare_declared_deposit_dispatch()
        attempts = []
        def lost_reply():
            attempts.append(dict(prepared))
            raise TimeoutError('offline result lost after dispatch')
        with self.assertRaises(TimeoutError):
            ledger.dispatch_create(prepared, lost_reply)
        before = self.state()
        self.assertTrue(before['dispatch_pending'])
        self.turn('unknown-wants-full', 'Full please instead')
        result = self.call('create_booking_from_plan', self.plan)
        self.assertFalse(result['success'], result)
        self.assertFalse(result['write_performed'], result)
        after = self.state()
        self.assertTrue(after['dispatch_pending'])
        self.assertEqual(after['dispatch_payload'], before['dispatch_payload'])
        self.assertEqual(after['operation_key'], before['operation_key'])
        self.assertEqual(len(attempts), 1)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_deposit_selection_after_faq_creates_once(self):
        self.plan['payment_choice'] = 'deposit'
        quoted = self.call('quote_booking', self.plan)
        self.assertTrue(quoted['success'], quoted)
        shown = offline_finalize_and_send({'completed': True,
            'final_response': 'August 20–23, 2027, shared mixed dorm. Total €190. '
                              'Deposit €100 now, €90 at check-in. Book this offer?'})
        self.assertTrue(shown['completed'], shown)
        self.turn('deposit-faq', 'How far is the walk to the beach?')
        offline_finalize_and_send({'completed': True, 'final_response': 'About a 10-minute walk.'})
        self.turn('deposit-accept', 'Deposit please')
        created = self.call('create_booking_from_plan', self.plan)
        self.assertTrue(created['success'], created)
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['accepted_offer']['payment_link_amount_cents'], 10000)

    def test_missing_and_unpresented_offer_cannot_create(self):
        for stage in ('missing', 'unpresented'):
            with self.subTest(stage=stage):
                if stage == 'unpresented':
                    self.assertTrue(self.call('quote_booking', self.plan)['success'])
                self.turn(stage, 'yes')
                result = self.call('create_booking_from_plan', self.plan)
                self.assertEqual(result['error'], 'quote_owner_presented_offer_required')
                self.assertFalse(result['write_performed'])
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_changed_request_cannot_reuse_presented_offer(self):
        self.show()
        changes = [dict(check_in='2027-08-21'), dict(check_out='2027-08-24'),
                   dict(guest_count=2), dict(guests=[{'name': 'Another Guest'}]),
                   dict(selected_bed_codes=['R1-B2']), dict(package_code='package_malibu'),
                   dict(add_ons=[]), dict(add_ons=[{'code': 'yoga_class', 'quantity': 1}]),
                   dict(add_ons=[{'code': 'hard_board_rental', 'days': 3},
                                 {'code': 'wetsuit_rental', 'days': 2}]),
                   dict(add_ons=[{'code': 'hard_board_rental', 'days': 2, 'quantity': 2},
                                 {'code': 'wetsuit_rental', 'days': 2}])]
        for index, changed in enumerate(changes):
            with self.subTest(changed=changed):
                self.turn('changed-' + str(index), 'Book it')
                result = self.call('create_booking_from_plan', {**self.plan, **changed})
                self.assertTrue(result.get('booking_not_created_yet'), result)
                self.assertFalse(result['write_performed'], result)
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_changed_staff_price_requires_reshowing(self):
        self.show()
        self.turn('changed-price', 'yes')
        response = self.responses['full']
        response['total_cents'] = 19100
        response['offer_revision'].update(total_cents=19100, payment_link_amount_cents=19100)
        result = self.call('create_booking_from_plan', self.plan)
        self.assertFalse(result['success'], result)
        self.assertFalse(result['write_performed'], result)
        self.assertIsNone(self.state().get('presentation'))
        self.assertFalse(any(path == '/booking-create-from-plan' for path, _ in self.calls))

    def test_checked_combo_does_not_hide_changed_duration_quantity_or_services(self):
        for addons in ([{'code': 'wetsuit_hard_board_combo', 'quantity': 1, 'days': 3}],
                       [{'code': 'wetsuit_hard_board_combo', 'quantity': 2, 'days': 2}],
                       [{'code': 'wetsuit_soft_top_combo', 'quantity': 1, 'days': 2}],
                       [{'code': 'wetsuit_hard_board_combo', 'quantity': 1}],
                       [{'code': 'hard_board_rental', 'quantity': 1, 'days': 2}],
                       [{'code': 'wetsuit_hard_board_combo', 'quantity': 1, 'days': 2},
                        {'code': 'yoga_class', 'quantity': 1}]):
            with self.subTest(addons=addons):
                response = deepcopy(self.responses['full'])
                response['offer_revision']['add_ons'] = addons
                self.assertIsNone(ledger._checked_plan(self.plan, response, 'wolfhouse-somo'))

    def test_full_requote_then_fresh_turn_yes_creates_once(self):
        self.show()
        self.turn('346', 'yes')
        created = self.call('create_booking_from_plan', {**self.plan, 'confirm': True})
        self.assertTrue(created['success'], created)
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0]['accepted_offer']['total_cents'], 19000)
        self.assertEqual(creates[0]['accepted_offer']['payment_link_amount_cents'], 19000)
        self.assertEqual(creates[0]['add_ons'],
                         self.responses['full']['offer_revision']['add_ons'])
        key = creates[0]['idempotency_key']
        self.turn('retry-new-turn', 'Please proceed with the same booking')
        retry = self.call('create_booking_from_plan', {**self.plan, 'confirm': True})
        self.assertTrue(retry['success'], retry)
        self.assertTrue(retry['idempotent'], retry)
        self.assertEqual(self.state()['dispatch_payload']['idempotency_key'], key)
        for changes in (dict(check_out='2027-08-24'), dict(guests=[{'name': 'Another Guest'}]),
                        dict(add_ons=[]), dict(payment_choice='deposit')):
            with self.subTest(retry_changes=changes):
                rejected = self.call('create_booking_from_plan', {**self.plan, **changes})
                self.assertFalse(rejected['success'], rejected)
                self.assertFalse(rejected['write_performed'], rejected)
        self.assertEqual(sum(path == '/booking-create-from-plan' for path, _ in self.calls), 1)


if __name__ == '__main__':
    unittest.main()
