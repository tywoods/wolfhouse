"""Offline owner-ledger tracer bullet; real Hermes SessionDB, no business writes."""
import tempfile
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch
from hermes_state import SessionDB
from gateway.session_context import set_session_vars, clear_session_vars


class AcceptedQuoteOwnerTests(unittest.TestCase):
    def test_real_owner_acceptance_survives_reopen_and_omitted_picks(self):
        from wolfhouse import accepted_quote
        with tempfile.TemporaryDirectory() as root:
            db = SessionDB(Path(root) / 'state.db')
            db.create_session('offline-owner', source='whatsapp')
            agent = SimpleNamespace(_session_db=db, session_id='offline-owner')
            tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='offline-chat',
                                      user_id='offline-guest', session_key='offline-key',
                                      session_id='offline-owner', message_id='offer-1')
            try:
                with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'sunset'}):
                    accepted_quote.observe_owner_turn(agent, 'Please quote this booking')
                    accepted_quote.record_quote({'check_in': '2026-11-01', 'check_out': '2026-11-08',
                        'package_code': 'surf', 'catalog_selections': [{'service_code': 'yoga', 'quantity': 2}]},
                        {'success': True, 'total_cents': 77000})
                    clear_session_vars(tokens)
                    tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='offline-chat',
                        user_id='offline-guest', session_key='offline-key', session_id='offline-owner', message_id='accept-2')
                    accepted_quote.observe_owner_turn(agent, 'Yes, create the booking with the Yoga session included for both of us')
                    db.close()
                    db = SessionDB(Path(root) / 'state.db')
                    agent._session_db = db
                    clear_session_vars(tokens)
                    tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='offline-chat',
                        user_id='offline-guest', session_key='offline-key', session_id='offline-owner', message_id='proceed-3')
                    accepted_quote.observe_owner_turn(agent, 'Please proceed')
                    result = accepted_quote.prepare_create({'confirm': True})
                    self.assertEqual(result['catalog_selections'], [{'service_code': 'yoga', 'quantity': 2}])
                    self.assertEqual(result['check_in'], '2026-11-01')
            finally:
                clear_session_vars(tokens)
                db.close()


class OwnerHostileTests(unittest.TestCase):
    def setUp(self):
        from wolfhouse import accepted_quote
        self.ledger = accepted_quote
        self.temp = tempfile.TemporaryDirectory()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.db.create_session('s1', source='whatsapp')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='s1')
        self.env = patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        self.env.start()
        self.tokens = None
        self.plan = {'check_in': '2026-11-01', 'check_out': '2026-11-08', 'guest_count': 2,
                     'package_code': 'package_none', 'group_gender': 'mixed',
                     'selected_bed_codes': ['M1', 'M2'],
                     'catalog_selections': [{'service_code': 'yoga_class', 'quantity': 2}]}
        self.turn('m1', 'Quote this please')
        self.ledger.record_quote(self.plan, {'success': True, 'total_cents': 77000})

    def tearDown(self):
        if self.tokens:
            clear_session_vars(self.tokens)
        self.ledger._current.set(None)
        self.env.stop()
        self.db.close()
        self.temp.cleanup()

    def turn(self, message, raw, **changes):
        if self.tokens:
            clear_session_vars(self.tokens)
        scope = dict(platform='whatsapp', source='whatsapp', chat_id='chat1', user_id='guest1',
                     session_key='key1', session_id=self.agent.session_id, message_id=message)
        scope.update(changes)
        self.tokens = set_session_vars(**scope)
        return self.ledger.observe_owner_turn(self.agent, raw)

    def accept(self):
        self.turn('m2', 'I accept the quote')

    def test_refusal_and_deferral_revoke_accepted_authority(self):
        for index, text in enumerate(('No thanks', 'Not yet', 'Wait')):
            self.turn('offer-refusal-' + str(index), 'Quote this please')
            self.ledger.record_quote(self.plan, {'success': True, 'total_cents': 77000})
            self.turn('accept-refusal-' + str(index), 'I accept the quote')
            self.turn('refusal-' + str(index), text)
            with self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({})

    def test_unicode_contact_continuity_and_hostile_mixed_names(self):
        positives = ('MaríaJosé', 'JeanLuc', 'María José', 'Jean-Luc', "O'Connor", 'O’Connor', 'Mari\u0301a Jose\u0301')
        negatives = ('María and stop', 'María change dates', 'JeanLuc and book this',
                     'María 2', 'María; proceed', 'María and please proceed',
                     '-María', 'María--José', 'María  José', 'María\nJosé')
        for index, name in enumerate(positives + negatives):
            with self.subTest(name=name):
                # Independent pre/post-consent scenarios require real new owners.
                self.agent.session_id = 'unicode-before-' + str(index)
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn('offer-name-' + str(index), 'Quote this please')
                self.ledger.record_quote(self.plan, {'success': True, 'total_cents': 77000})
                self.turn('name-before-' + str(index), 'My name is ' + name)
                with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                            '^quote_owner_acceptance_required$'):
                    self.ledger.prepare_create({})
                self.agent.session_id = 'unicode-after-' + str(index)
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.turn('reoffer-name-' + str(index), 'Quote this please')
                self.ledger.record_quote(self.plan, {'success': True, 'total_cents': 77000})
                self.turn('accept-name-' + str(index), 'I accept the quote')
                self.turn('name-after-' + str(index), 'My name is ' + name)
                if name in positives:
                    self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])
                else:
                    with self.assertRaises(self.ledger.QuoteBoundaryError):
                        self.ledger.prepare_create({})

    def test_hostile_revision_cannot_be_reoffered_without_clarification(self):
        self.turn('hostile-revision', 'My name is María change dates')
        self.turn('generic-reoffer', 'Quote this please')
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    '^quote_revision_needs_clarification$'):
            self.ledger.record_quote(self.plan, {'success': True, 'total_cents': 77000})
        # Even a supported reprice cannot covertly erase an unresolved date change.
        self.turn('reprice-after-hostile', 'Revise the quote')
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    '^quote_revision_needs_clarification$'):
            self.ledger.prepare_quote(self.plan)

    def test_explicit_bounded_reprice_recovers_with_fresh_acceptance(self):
        self.accept()
        self.turn('bounded-reprice', 'Revise the quote')
        prepared = self.ledger.prepare_quote({})
        self.assertEqual(prepared['catalog_selections'], self.plan['catalog_selections'])
        self.ledger.record_quote(prepared, {'success': True, 'total_cents': 78000})
        with self.assertRaisesRegex(self.ledger.QuoteBoundaryError,
                                    '^quote_owner_acceptance_required$'):
            self.ledger.prepare_create({})
        self.turn('accept-repriced', 'I accept the quote')
        self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])

    def test_contact_revision_retains_omitted_commercial_selections(self):
        self.accept()
        self.turn('contact-only', 'Add my phone number')
        prepared = self.ledger.prepare_quote({'guest_phone': 'offline'})
        self.assertEqual(prepared['catalog_selections'], self.plan['catalog_selections'])
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_quote({'catalog_selections': []})

    def test_named_removal_cannot_change_dates_or_other_selections(self):
        self.turn('remove-yoga', 'Remove the yoga')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_quote({**self.plan, 'catalog_selections': [], 'check_in': '2026-12-01'})

    def test_late_quote_response_cannot_overwrite_newer_intent(self):
        from contextvars import copy_context
        prepared = self.ledger.prepare_quote(self.plan)
        pending = copy_context()
        self.turn('newer-refusal', 'Not yet')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            pending.run(self.ledger.record_quote, prepared, {'success': True, 'total_cents': 1})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_prepared_dispatch_reset_barrier_has_zero_transport(self):
        self.accept()
        prepared = self.ledger.prepare_create({})
        self.db.end_session('s1', 'reset')
        calls = []
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.dispatch_create(prepared, lambda: calls.append('transport'))
        self.assertEqual(calls, [])

    def test_prepared_dispatch_revision_barrier_has_zero_transport(self):
        self.accept()
        prepared = self.ledger.prepare_create({})
        self.turn('dispatch-revision', 'Remove the yoga')
        calls = []
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.dispatch_create(prepared, lambda: calls.append('transport'))
        self.assertEqual(calls, [])

    def test_closed_shared_capability_blocks_copied_child_context(self):
        from contextvars import copy_context
        self.accept()
        prepared = self.ledger.prepare_create({})
        child = copy_context()
        self.ledger.close_turn()
        calls = []
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            child.run(self.ledger.prepare_create, {})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            child.run(self.ledger.dispatch_create, prepared, lambda: calls.append('transport'))
        self.assertEqual(calls, [])

    def test_real_gateway_enrichment_is_not_raw_acceptance_authority(self):
        import json
        from gateway.run import _wrap_current_message_with_observed_context
        from run_agent import AIAgent
        from agent import conversation_loop
        import wolfhouse_staff_api as plugin
        real_agent = object.__new__(AIAgent)
        real_agent._session_db, real_agent.session_id = self.db, 's1'
        original = conversation_loop.run_conversation
        enriched = _wrap_current_message_with_observed_context(
            'Not yet', 'Earlier guest: I accept the quote')
        self.assertIn('I accept the quote', enriched)
        self.assertIn('Not yet', enriched)
        class Stopped(Exception): pass
        def preflight(agent, message, *args, **kwargs):
            self.assertEqual(message, enriched)
            result = json.loads(plugin.create_booking_from_plan({}))
            self.assertFalse(result['write_performed'])
            raise Stopped()
        try:
            self.ledger.install_owner_hook()
            with patch.object(plugin, '_post_bot') as transport, patch.object(
                    conversation_loop, 'build_turn_context', side_effect=preflight):
                with self.assertRaises(Stopped):
                    real_agent.run_conversation(enriched)
                transport.assert_not_called()
            self.assertIsNone(self.ledger._current.get())
        finally:
            conversation_loop.run_conversation = original

    def test_quote_cas_detects_newer_turn_in_independent_context(self):
        from contextvars import copy_context
        prepared = self.ledger.prepare_quote(self.plan)
        other = copy_context()
        def newer():
            # Independent task, not closing the older task's capability.
            self.ledger._current.set(None)
            set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
                user_id='guest1', session_key='key1', session_id='s1', message_id='other-task')
            self.ledger.observe_owner_turn(self.agent, 'Not yet')
            self.ledger.close_turn()
        other.run(newer)
        self.assertFalse(prepared.capability.closed)
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.record_quote(prepared, {'success': True, 'total_cents': 1})

    def test_real_transport_boundary_rechecks_after_prepare_barrier(self):
        import json
        import wolfhouse_staff_api as plugin
        self.db.create_session('transport-barrier', source='whatsapp')
        self.agent.session_id = 'transport-barrier'
        self.turn('barrier-offer', 'Quote this please')
        self.ledger.record_quote({**self.plan, 'group_gender': 'mixed',
            'selected_bed_codes': ['M1', 'M2']}, {'success': True, 'total_cents': 77000})
        self.accept()
        original = self.ledger.prepare_create
        def reset_after_prepare(params):
            prepared = original(params)
            self.db.end_session('transport-barrier', 'reset')
            return prepared
        params = {'guest_name': 'Riley', 'guests': [{'name': 'Riley'}, {'name': 'Morgan'}],
                  'guest_count': 2, 'payment_choice': 'pay_on_arrival'}
        with patch.object(self.ledger, 'prepare_create', side_effect=reset_after_prepare), patch.object(
                plugin, '_post_bot') as transport:
            result = json.loads(plugin.create_booking_from_plan(params))
            self.assertFalse(result['write_performed'])
            self.assertEqual(result['error'], 'quote_owner_ended')
            transport.assert_not_called()

    def test_async_late_child_uses_shared_revocation_not_parent_clear(self):
        import asyncio
        self.accept()
        prepared = self.ledger.prepare_create({})
        calls = []
        async def exercise():
            ready, release = asyncio.Event(), asyncio.Event()
            async def child():
                ready.set()
                await release.wait()
                with self.assertRaises(self.ledger.QuoteBoundaryError):
                    self.ledger.dispatch_create(prepared, lambda: calls.append('transport'))
            task = asyncio.create_task(child())
            await ready.wait()
            self.ledger.close_turn()
            release.set()
            await task
        asyncio.run(exercise())
        self.assertEqual(calls, [])

    def test_unknown_commercial_revision_stays_unresolved_on_neutral_turn(self):
        self.accept()
        self.turn('unknown-delta', 'Add a Drone on another date')
        self.turn('neutral-after-delta', 'Please proceed')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_quote(self.plan)
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_dispatch_first_holds_writer_fence_until_transport_finishes(self):
        from contextvars import copy_context
        from threading import Event, Thread
        self.accept()
        prepared = self.ledger.prepare_create({})
        context = copy_context()
        other_db = SessionDB(Path(self.temp.name) / 'state.db')
        entered, release, attempted, reset_done = Event(), Event(), Event(), Event()
        errors, calls = [], []
        def transport():
            entered.set()
            if not release.wait(5):
                raise AssertionError('test transport barrier timeout')
            calls.append('offline transport')
        def create():
            try:
                context.run(self.ledger.dispatch_create, prepared, transport)
            except BaseException as error:
                errors.append(error)
        def reset():
            attempted.set()
            try:
                other_db.end_session('s1', 'reset')
            except BaseException as error:
                errors.append(error)
            finally:
                reset_done.set()
        writer, resetter = Thread(target=create), Thread(target=reset)
        writer.start()
        try:
            self.assertTrue(entered.wait(5))
            resetter.start()
            self.assertTrue(attempted.wait(5))
            self.assertFalse(reset_done.wait(0.1), 'reset committed inside dispatch critical section')
        finally:
            release.set()
            writer.join(5)
            if resetter.ident is not None:
                resetter.join(5)
            other_db.close()
        self.assertFalse(writer.is_alive())
        self.assertFalse(resetter.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(calls, ['offline transport'])
        self.assertTrue(reset_done.is_set())
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.dispatch_create(prepared, lambda: calls.append('late transport'))
        self.assertEqual(calls, ['offline transport'])

    def test_refusal_registered_handler_has_zero_transport(self):
        import json
        import wolfhouse_staff_api as plugin
        self.accept()
        self.turn('registered-refusal', 'No thanks')
        with patch.object(plugin, '_post_bot') as transport:
            result = json.loads(plugin.create_booking_from_plan({}))
            self.assertEqual(result['error'], 'quote_owner_acceptance_required')
            self.assertFalse(result['write_performed'])
            transport.assert_not_called()

    def test_missing_raw_input_clears_owner_capability(self):
        self.accept()
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.turn('missing-raw', None)
        self.assertIsNone(self.ledger._current.get())
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_concurrent_tasks_do_not_share_acceptance_or_picks(self):
        import asyncio
        self.db.create_session('s2', source='whatsapp')
        other = SimpleNamespace(_session_db=self.db, session_id='s2')
        async def run():
            ready = asyncio.Event()
            finished = asyncio.Event()
            async def accepted():
                tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
                    user_id='guest1', session_key='key1', session_id='s1', message_id='concurrent-accept')
                try:
                    self.ledger.observe_owner_turn(self.agent, 'I accept the quote')
                    ready.set()
                    await finished.wait()
                    self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])
                finally:
                    self.ledger._current.set(None)
                    clear_session_vars(tokens)
            async def rejected():
                await ready.wait()
                tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat2',
                    user_id='guest2', session_key='key2', session_id='s2', message_id='concurrent-confirm')
                try:
                    self.ledger.observe_owner_turn(other, 'I accept the quote')
                    with self.assertRaises(self.ledger.QuoteBoundaryError):
                        self.ledger.prepare_create({'confirm': True})
                finally:
                    self.ledger._current.set(None)
                    clear_session_vars(tokens)
                    finished.set()
            await asyncio.gather(accepted(), rejected())
        asyncio.run(run())

    def test_reused_session_id_cannot_inherit_previous_incarnation(self):
        self.accept()
        self.db._execute_write(lambda conn: conn.execute('UPDATE sessions SET started_at=started_at+1 WHERE id=?', ('s1',)))
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.turn('new-incarnation', 'I accept the quote')
        self.assertIsNone(self.ledger._current.get())

    def test_model_confirm_is_not_acceptance(self):
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({'confirm': True})

    def test_ambiguous_yes_is_not_acceptance(self):
        self.turn('m2', 'yes')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_empty_and_changed_picks_do_not_downgrade(self):
        self.accept()
        for picks in ([], [{'service_code': 'drone', 'quantity': 2}], [{'service_code': 'yoga_class', 'quantity': 1}]):
            with self.subTest(picks=picks), self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({'catalog_selections': picks})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_quote({'catalog_selections': []})
        self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])

    def test_revision_requires_fresh_quote_and_acceptance(self):
        self.accept()
        self.turn('m3', 'Remove the yoga')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})
        revised = self.ledger.prepare_quote({**self.plan, 'catalog_selections': []})
        self.ledger.record_quote(revised, {'success': True, 'total_cents': 65000})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})
        self.turn('m4', 'I accept the quote')
        self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], [])

    def test_replayed_acceptance_cannot_accept_new_offer(self):
        self.accept()
        self.turn('m3', 'Revise the quote')
        self.ledger.record_quote(self.plan, {'success': True, 'total_cents': 78000})
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.turn('m2', 'I accept the quote')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_replayed_accepted_turn_cannot_dispatch_again(self):
        self.accept()
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.turn('m2', 'I accept the quote')
        self.assertIsNone(self.ledger._current.get())
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_tenant_chat_and_session_isolation(self):
        self.accept()
        self.turn('foreign', 'I accept the quote', chat_id='chat2')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})
        with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'other'}):
            self.turn('foreign2', 'I accept the quote')
            with self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({})
        self.db.create_session('s2', source='whatsapp')
        self.agent.session_id = 's2'
        self.turn('foreign3', 'I accept the quote')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_reset_revokes_even_active_turn(self):
        self.accept()
        self.db.end_session('s1', 'reset')
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_changed_raw_acceptance_fails_closed(self):
        for text in ('Yes, create the booking without yoga', 'Yes, create the booking with the Drone session included for both of us',
                     'I accept the quote but change dates to 2026-12-01'):
            self.turn(text, text)
            with self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({})

    def test_refused_selection_cannot_be_erased_by_ambiguous_acceptance(self):
        # This is a FIRST refused offer, not an unauthorized Yoga -> Drone replacement.
        self.db.create_session('first-refused-offer', source='whatsapp')
        self.agent.session_id = 'first-refused-offer'
        self.turn('refused-offer', 'Please quote this')
        self.ledger.record_quote({**self.plan, 'catalog_selections': [{'service_code': 'drone', 'quantity': 2}]},
                                 {'success': False, 'error': 'catalog_selection_not_atomic'})
        self.turn('m2', 'Yes, create the booking with the Drone session included for both of us')
        restored = self.ledger.prepare_quote({'check_in': '2026-11-01'})
        self.assertEqual(restored['catalog_selections'], [{'service_code': 'drone', 'quantity': 2}])
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})

    def test_installed_owner_loop_observes_before_model_body_and_cleans_up(self):
        import gateway.run  # Load the real runtime before the isolated fake loop module.
        import sys
        from types import ModuleType
        package = ModuleType('agent')
        loop = ModuleType('agent.conversation_loop')
        package.conversation_loop = loop
        def model_body(agent, raw):
            self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])
            return 'offline'
        loop.run_conversation = model_body
        self.turn('m2', 'yes')
        with patch.dict(sys.modules, {'agent': package, 'agent.conversation_loop': loop}):
            self.ledger.install_owner_hook()
            # A fresh message id for the actual installed owner entrypoint.
            clear_session_vars(self.tokens)
            self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
                user_id='guest1', session_key='key1', session_id='s1', message_id='m4')
            self.ledger._current.set(None)
            from wolfhouse.offline_ingress_harness import gateway_ingress
            self.assertEqual(gateway_ingress(self.agent, 'I accept the quote', 'm4',
                lambda text: loop.run_conversation(self.agent, text)), 'offline')
            self.assertIsNone(self.ledger._current.get())

    def test_real_aiagent_forwarder_install_observes_before_preflight(self):
        from run_agent import AIAgent
        from agent import conversation_loop
        import wolfhouse_staff_api as plugin
        class Registry:
            def register_tool(self, **kw): pass
            def register_hook(self, *args, **kw): pass
        original = conversation_loop.run_conversation
        class PreflightStopped(Exception): pass
        real_agent = object.__new__(AIAgent)
        real_agent._session_db = self.db
        real_agent.session_id = 's1'
        self.turn('m2', 'yes')
        clear_session_vars(self.tokens)
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
            user_id='guest1', session_key='key1', session_id='s1', message_id='real-entry-m3')
        self.ledger._current.set(None)
        def preflight(agent, raw, *args, **kwargs):
            self.assertIs(agent, real_agent)
            self.assertEqual(raw, 'I accept the quote')
            self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])
            raise PreflightStopped()
        try:
            plugin.register(Registry())
            installed = conversation_loop.run_conversation
            plugin.register(Registry())
            self.assertIs(installed, conversation_loop.run_conversation)
            with patch.object(conversation_loop, 'build_turn_context', side_effect=preflight) as probe:
                with self.assertRaises(PreflightStopped):
                    from wolfhouse.offline_ingress_harness import gateway_ingress
                    gateway_ingress(real_agent, 'I accept the quote', 'real-entry-m3', real_agent.run_conversation)
                self.assertEqual(probe.call_count, 1)
            self.assertIsNone(self.ledger._current.get())
        finally:
            conversation_loop.run_conversation = original

    def test_real_registered_owner_and_name_continuity_share_entrypoint(self):
        from run_agent import AIAgent
        from agent import conversation_loop
        from wolfhouse import booking_names
        import json
        import wolfhouse_staff_api as plugin
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *args, **kw): pass
        class PreflightStopped(Exception): pass
        original = conversation_loop.run_conversation
        real_agent = object.__new__(AIAgent)
        real_agent._session_db, real_agent.session_id = self.db, 's1'
        registry = Registry()
        calls = []
        plan = {**self.plan, 'group_gender': 'mixed', 'selected_bed_codes': ['M1', 'M2'],
                'guest_name': 'Riley', 'guests': [{'name': 'Riley'}, {'name': 'Morgan'}]}
        def transport(path, body):
            calls.append((path, body))
            if path == '/booking-preview':
                return {'success': True, 'total_cents': 77000}
            self.assertEqual(path, '/booking-create-from-plan')
            self.assertEqual(body['guests'], plan['guests'])
            self.assertEqual(body['add_ons'], [{'code': 'yoga_class', 'quantity': 2}])
            return {'success': False, 'write_performed': False, 'error': 'offline_capture'}
        def preflight(agent, raw, *args, **kwargs):
            booking_names.begin_turn(session_id='s1', scope=plugin._booking_name_scope())
            name = 'quote_booking' if raw == 'Please quote this' else 'create_booking_from_plan'
            payload = plan if name == 'quote_booking' else {'payment_choice': 'pay_on_arrival'}
            result = json.loads(registry.tools[name]['handler'](payload))
            if name == 'quote_booking': self.assertTrue(result['success'])
            else:
                self.assertFalse(result['write_performed'])
                self.assertIn('offline_capture', result['blocked_reasons'])
            raise PreflightStopped()
        try:
            plugin.register(registry)
            with patch.object(plugin, '_post_bot', side_effect=transport), patch.object(conversation_loop, 'build_turn_context', side_effect=preflight):
                for message, raw in [('real-offer', 'Please quote this'), ('real-accept', 'I accept the quote')]:
                    clear_session_vars(self.tokens)
                    self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
                        user_id='guest1', session_key='key1', session_id='s1', message_id=message)
                    self.ledger._current.set(None)
                    from wolfhouse.offline_ingress_harness import gateway_ingress
                    with self.assertRaises(PreflightStopped):
                        gateway_ingress(real_agent, raw, message, real_agent.run_conversation)
                    self.assertIsNone(self.ledger._current.get())
            self.assertEqual([p for p, _ in calls], ['/booking-preview', '/booking-create-from-plan'])
        finally:
            conversation_loop.run_conversation = original

    def test_registered_create_restores_missing_picks_and_blocks_changed_picks(self):
        import json
        import wolfhouse_staff_api as plugin
        plan = {**self.plan, 'group_gender': 'mixed', 'selected_bed_codes': ['M1', 'M2']}
        self.ledger.record_quote(plan, {'success': True, 'total_cents': 77000})
        self.accept()
        calls = []
        def api(path, body):
            calls.append(path)
            self.assertEqual(path, '/booking-create-from-plan')
            self.assertEqual(body['add_ons'], [{'code': 'yoga_class', 'quantity': 2}])
            self.assertNotIn('catalog_selections', body)
            self.assertEqual(body['check_in'], '2026-11-01')
            return {'success': True, 'write_performed': True, 'booking_code': 'OFFLINE-ONLY'}
        params = {'guest_name': 'Riley', 'guests': [{'name': 'Riley'}, {'name': 'Morgan'}],
                  'guest_count': 2, 'payment_choice': 'pay_on_arrival'}
        with patch.object(plugin, '_post_bot', side_effect=api):
            result = json.loads(plugin.create_booking_from_plan(params))
            self.assertTrue(result['write_performed'])
            changed = json.loads(plugin.create_booking_from_plan({**params, 'catalog_selections': []}))
            self.assertFalse(changed['write_performed'])
        self.assertEqual(calls, ['/booking-create-from-plan'])

    def test_unbound_ambient_identity_and_corrupt_storage_fail_closed(self):
        self.accept()
        self.db._execute_write(lambda conn: conn.execute("UPDATE state_meta SET value='not-json' WHERE key LIKE 'wolfhouse.accepted_quote.%'"))
        with self.assertRaises(self.ledger.QuoteBoundaryError):
            self.ledger.prepare_create({})
        from contextvars import Context
        with patch.dict('os.environ', {'HERMES_SESSION_ID': 's1', 'HERMES_SESSION_CHAT_ID': 'chat1'}):
            with self.assertRaises(self.ledger.QuoteBoundaryError):
                Context().run(self.ledger.observe_owner_turn, self.agent, 'I accept the quote')

    def test_owner_idempotency_ignores_model_keys_and_totals(self):
        self.accept()
        first = self.ledger.prepare_create({'idempotency_key': 'model-first', 'total_cents': 1})
        self.turn('continue-idempotently', 'Please proceed')
        second = self.ledger.prepare_create({'idempotency_key': 'model-second', 'quote_total_cents': 2})
        self.assertEqual(first['idempotency_key'], second['idempotency_key'])
        self.assertTrue(first['idempotency_key'].startswith('luna-owner-'))
        self.assertNotIn('total_cents', first)
        self.assertNotIn('quote_total_cents', second)

    def test_structurally_corrupt_accepted_quote_fails_closed(self):
        import json
        self.accept()
        key, raw = self.db._conn.execute("SELECT key,value FROM state_meta WHERE key LIKE 'wolfhouse.accepted_quote.%'").fetchone()
        healthy = json.loads(raw)
        from copy import deepcopy
        for field, value in [('status', 'unknown'), ('seen', [True]), ('plan', []),
                             ('quote', {'success': True, 'total_cents': True}),
                             ('acceptance_message', 'not-observed')]:
            broken = deepcopy(healthy)
            broken[field] = value
            self.db._execute_write(lambda conn: conn.execute('UPDATE state_meta SET value=? WHERE key=?', (json.dumps(broken), key)))
            with self.subTest(field=field), self.assertRaises(self.ledger.QuoteBoundaryError):
                self.ledger.prepare_create({})

    def test_catalog_id_cannot_be_reinterpreted_as_atomic_code(self):
        import json
        import wolfhouse_staff_api as plugin
        selection = {'service_id': 'unverified-admin-id', 'service_code': 'yoga_class', 'quantity': 2}
        # Exercise the catalog boundary on a first offer, not a prohibited change.
        self.db.create_session('catalog-first', source='whatsapp')
        self.agent.session_id = 'catalog-first'
        self.turn('revision-for-id', 'Please quote this')
        with patch.object(plugin, '_post_bot') as transport:
            result = json.loads(plugin.quote_booking({**self.plan, 'catalog_selections': [selection]}))
            transport.assert_not_called()
        self.assertEqual(result['error'], 'catalog_selection_not_atomic')

    def test_registered_quote_records_real_offering_and_supported_yoga(self):
        import json
        import wolfhouse_staff_api as plugin
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
        registry = Registry()
        plugin.register(registry)
        def api(path, body):
            self.assertEqual(path, '/booking-preview')
            self.assertEqual(body['add_ons'], [{'code': 'yoga_class', 'quantity': 2}])
            self.assertNotIn('catalog_selections', body)
            return {'success': True, 'total_cents': 77000}
        with patch.object(plugin, '_post_bot', side_effect=api):
            result = json.loads(registry.tools['quote_booking']['handler'](self.plan))
        self.assertTrue(result['success'])
        self.turn('m2', 'I accept the quote')
        self.assertEqual(self.ledger.prepare_create({})['catalog_selections'], self.plan['catalog_selections'])


if __name__ == '__main__':
    unittest.main()
