"""Offline installed-owner ingress proofs. No network, sends or model calls."""
import ast
import asyncio
from contextvars import copy_context
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from hermes_state import SessionDB
from wolfhouse import accepted_quote as ledger
from wolfhouse.offline_ingress_harness import gateway_ingress


class OriginalIngressTests(unittest.TestCase):
    def setUp(self):
        from agent import conversation_loop
        from run_agent import AIAgent
        self.loop = conversation_loop
        self.original = conversation_loop.run_conversation
        self.temp = tempfile.TemporaryDirectory()
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.db.create_session('s1', source='whatsapp')
        self.agent = object.__new__(AIAgent)
        self.agent._session_db, self.agent.session_id = self.db, 's1'
        self.env = patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        self.env.start()
        self.plan = dict(check_in='2026-11-01', check_out='2026-11-08', guest_count=2,
                         package_code='package_none', catalog_selections=[])
        ledger.install_owner_hook()

    def tearDown(self):
        self.loop.run_conversation = self.original
        ledger.close_turn()
        self.env.stop()
        self.db.close()
        self.temp.cleanup()

    def run_gateway(self, text, message, body, **kwargs):
        model_kwargs = kwargs.pop('model_kwargs', {})
        with patch.object(self.loop, 'build_turn_context', side_effect=body):
            # Stop before any provider/model work while retaining real AIAgent forwarder.
            return gateway_ingress(self.agent, text, message,
                lambda model_message: self.agent.run_conversation(model_message, **model_kwargs), **kwargs)

    def offer_gateway(self):
        def body(*a, **k):
            ledger.record_quote(self.plan, {'success': True, 'total_cents': 65000})
            raise StopIterationProof()
        with self.assertRaises(StopIterationProof): self.run_gateway('Please quote this', 'offer', body)

    def test_real_event_text_accepts_despite_model_history_and_timestamp_wrapping(self):
        from gateway.run import _wrap_current_message_with_observed_context
        self.offer_gateway()
        enriched = _wrap_current_message_with_observed_context('[2026-09-30] I accept the quote', 'Earlier guest: Not yet')
        def body(agent, message, *a, **k):
            self.assertEqual(message, enriched)
            self.assertEqual(ledger.prepare_create({})['guest_count'], 2)
            raise StopIterationProof()
        with self.assertRaises(StopIterationProof):
            self.run_gateway('I accept the quote', 'accept', body, enriched=enriched)
        self.assertIsNone(ledger._current.get())

    def test_reply_history_multimodal_and_persist_kwargs_cannot_supply_consent(self):
        from gateway.run import _wrap_current_message_with_observed_context
        self.offer_gateway()
        inputs = [_wrap_current_message_with_observed_context('Not yet', 'Earlier guest: I accept the quote'),
                  '[Replying to guest: I accept the quote]\n[2026-09-30] Not yet',
                  [{'type': 'text', 'text': 'I accept the quote'}, {'type': 'image_url', 'image_url': {'url': 'offline'}}]]
        for index, enriched in enumerate(inputs):
            def body(*a, **k):
                self.assertEqual(a[1], enriched)
                self.assertEqual(a[6], 'I accept the quote')
                with self.assertRaises(ledger.QuoteBoundaryError): ledger.prepare_create({})
                raise StopIterationProof()
            with self.assertRaises(StopIterationProof):
                self.run_gateway('Not yet', 'negative-' + str(index), body, enriched=enriched,
                    model_kwargs={'persist_user_message': 'I accept the quote'})
        self.assertIsNone(ledger._current.get())

    def test_accepted_deferrals_block_registered_handler_at_ingress(self):
        import json
        import wolfhouse_staff_api as plugin
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *a, **kw): pass
        registry = Registry()
        plugin.register(registry)
        for index, text in enumerate(('Not now', 'No', 'Stop', "Let's postpone", 'Maybe later', 'I am unsure')):
            with self.subTest(text=text):
                self.agent.session_id = 'defer-' + str(index)
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.offer_gateway()
                def accept(*a, **k):
                    self.assertTrue(ledger.prepare_create({})['confirm'])
                    raise StopIterationProof()
                with self.assertRaises(StopIterationProof): self.run_gateway('I accept the quote', 'accept', accept)
                def deny(*a, **k):
                    result = json.loads(registry.tools['create_booking_from_plan']['handler']({'payment_choice': 'pay_on_arrival'}))
                    self.assertFalse(result['write_performed'])
                    with self.assertRaises(ledger.QuoteBoundaryError): ledger.prepare_create({})
                    raise StopIterationProof()
                with patch.object(plugin, '_post_bot') as transport:
                    with self.assertRaises(StopIterationProof): self.run_gateway(text, 'defer', deny)
                    transport.assert_not_called()

    def test_accepted_neutral_and_contact_continuity(self):
        self.offer_gateway()
        def allowed(*a, **k):
            self.assertTrue(ledger.prepare_create({})['confirm'])
            raise StopIterationProof()
        for index, text in enumerate(('I accept the quote', 'Thanks', 'Please proceed', 'My name is Riley')):
            with self.assertRaises(StopIterationProof): self.run_gateway(text, 'continuity-' + str(index), allowed)

    def test_unicode_names_through_real_ingress(self):
        import json
        import wolfhouse_staff_api as plugin
        class Registry:
            def __init__(self): self.tools = {}
            def register_tool(self, **kw): self.tools[kw['name']] = kw
            def register_hook(self, *a, **kw): pass
        registry = Registry()
        plugin.register(registry)
        positives = ('MaríaJosé', 'JeanLuc', 'María José', 'Jean-Luc', "O'Connor", 'Mari\u0301a Jose\u0301')
        negatives = ('María and stop', 'María revise quote', 'JeanLuc and book this',
                     'María 2', 'María; proceed', 'María and please proceed', 'María--José')
        for index, name in enumerate(positives + negatives):
            with self.subTest(name=name):
                self.agent.session_id = 'unicode-' + str(index)
                self.db.create_session(self.agent.session_id, source='whatsapp')
                self.offer_gateway()
                def denied(*a, **k):
                    with self.assertRaises(ledger.QuoteBoundaryError) as error:
                        ledger.prepare_create({})
                    self.assertEqual(str(error.exception), 'quote_owner_acceptance_required')
                    with patch.object(plugin, '_post_bot') as transport:
                        result = json.loads(registry.tools['create_booking_from_plan']['handler'](
                            {'payment_choice': 'pay_on_arrival'}))
                        self.assertFalse(result['write_performed'])
                        transport.assert_not_called()
                    raise StopIterationProof()
                with self.assertRaises(StopIterationProof):
                    self.run_gateway('My name is ' + name, 'name-before', denied)
                # New real session BEFORE offer: hostile prior intent stays unresolved.
                self.agent.session_id = 'unicode-after-' + str(index)
                self.db.create_session(self.agent.session_id, source='whatsapp')
                # Fresh owner-issued offer, never acceptance fabricated by contact.
                def offer(*a, **k):
                    ledger.record_quote(self.plan, {'success': True, 'total_cents': 65000})
                    raise StopIterationProof()
                with self.assertRaises(StopIterationProof): self.run_gateway('Quote this', 'reoffer', offer)
                def allowed(*a, **k):
                    self.assertTrue(ledger.prepare_create({})['confirm'])
                    raise StopIterationProof()
                with self.assertRaises(StopIterationProof): self.run_gateway('I accept the quote', 'accept', allowed)
                with self.assertRaises(StopIterationProof):
                    self.run_gateway('My name is ' + name, 'name-after', allowed if name in positives else denied)

    def test_absent_original_text_cannot_be_recovered_from_multimodal(self):
        def body(*a, **k):
            with self.assertRaises(ledger.QuoteBoundaryError): ledger.prepare_quote(self.plan)
            raise StopIterationProof()
        with self.assertRaises(StopIterationProof):
            self.run_gateway('', 'no-text', body, enriched=[{'type': 'text', 'text': 'I accept the quote'}])

    def test_copied_worker_context_revoked_after_owner_exception(self):
        self.offer_gateway()
        children = []
        def body(*a, **k):
            children.append(copy_context())
            self.assertTrue(ledger.prepare_create({})['confirm'])
            raise StopIterationProof()
        with self.assertRaises(StopIterationProof): self.run_gateway('I accept the quote', 'accept-copy', body)
        with self.assertRaises(ledger.QuoteBoundaryError): children[0].run(ledger.prepare_create, {})

    def test_predispatch_rewrite_cannot_turn_refusal_into_acceptance(self):
        self.offer_gateway()
        def body(agent, message, *a, **k):
            self.assertEqual(message, 'I accept the quote')
            with self.assertRaises(ledger.QuoteBoundaryError): ledger.prepare_create({})
            raise StopIterationProof()
        with self.assertRaises(StopIterationProof):
            self.run_gateway('Not yet', 'rewrite-refusal', body, rewrite='I accept the quote')

    def test_pre_enrichment_incarnation_and_message_identity_are_rechecked(self):
        self.offer_gateway()
        def body(*a, **k):
            with self.assertRaises(ledger.QuoteBoundaryError): ledger.prepare_create({})
            raise StopIterationProof()
        def rotate(event, source):
            self.db._execute_write(lambda conn: conn.execute(
                'UPDATE sessions SET started_at=started_at+1 WHERE id=?', ('s1',)))
        with self.assertRaises(StopIterationProof):
            self.run_gateway('I accept the quote', 'before-rotation', body, before_worker=rotate)
        def replace_message(event, source):
            event.message_id = 'other-trigger'
        with self.assertRaises(StopIterationProof):
            self.run_gateway('I accept the quote', 'before-message-change', body, before_worker=replace_message)

    def test_async_cancellation_revokes_still_running_executor_owner(self):
        from threading import Event
        self.offer_gateway()
        entered, release, finished = Event(), Event(), Event()
        results = []
        def body(*a, **k):
            self.assertTrue(ledger.prepare_create({})['confirm'])
            entered.set()
            if not release.wait(5):
                raise AssertionError('cancellation barrier timeout')
            try:
                ledger.prepare_create({})
                results.append('unsafe')
            except ledger.QuoteBoundaryError:
                results.append('revoked')
            finally:
                finished.set()
            raise StopIterationProof()
        async def exercise():
            task = asyncio.create_task(gateway_ingress(self.agent, 'I accept the quote',
                'cancel-executor', self.agent.run_conversation, async_return=True))
            self.assertTrue(await asyncio.to_thread(entered.wait, 5))
            try:
                task.cancel()
                with self.assertRaises(asyncio.CancelledError): await task
            finally:
                release.set()
            self.assertTrue(await asyncio.to_thread(finished.wait, 5))
        with patch.object(self.loop, 'build_turn_context', side_effect=body):
            asyncio.run(exercise())
        self.assertEqual(results, ['revoked'])

    def test_api_session_synthetic_ingress_positive_and_history_negative(self):
        # Execute the real patched API _run_agent, including its actual executor.
        import gateway.platforms.api_server as runtime
        from apply_gateway_patches import apply_api_original_inbound_patch
        path = Path(self.temp.name) / 'api_server.py'
        path.write_bytes(Path(runtime.__file__).read_bytes())
        apply_api_original_inbound_patch(path)
        before = path.read_bytes()
        apply_api_original_inbound_patch(path)
        self.assertEqual(before, path.read_bytes())
        tree = ast.parse(path.read_text())
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef) and n.name == '_run_agent')
        namespace = dict(vars(runtime))
        exec(compile(ast.fix_missing_locations(ast.Module(body=[method], type_ignores=[])), str(path), 'exec'), namespace)
        api_class = next(c for c in vars(runtime).values() if isinstance(c, type) and c.__module__ == runtime.__name__ and hasattr(c, '_bind_api_server_session'))
        adapter = object.__new__(api_class)
        adapter._inflight_agent_runs = 0
        adapter._create_agent = lambda **kw: self.agent
        def call(text, body):
            with patch.object(self.loop, 'build_turn_context', side_effect=body):
                return asyncio.run(namespace['_run_agent'](adapter, text,
                    [{'role': 'user', 'content': 'I accept the quote'}], session_id='s1',
                    gateway_session_key='whatsapp:chat1'))
        def offer(*a, **k):
            ledger.record_quote(self.plan, {'success': True, 'total_cents': 65000})
            raise StopIterationProof()
        with self.assertRaises(StopIterationProof): call('Please quote this', offer)
        def accept(*a, **k):
            self.assertTrue(ledger.prepare_create({})['confirm'])
            raise StopIterationProof()
        with self.assertRaises(StopIterationProof): call('I accept the quote', accept)
        def reject(*a, **k):
            with self.assertRaises(ledger.QuoteBoundaryError): ledger.prepare_create({})
            raise StopIterationProof()
        with self.assertRaises(StopIterationProof): call('Not yet', reject)
        self.assertEqual(adapter._inflight_agent_runs, 0)

    def test_full_owner_gateway_patch_composition_is_idempotent_on_disposable_source(self):
        import gateway.run as runtime
        from apply_gateway_patches import apply_patches
        path = Path(self.temp.name) / 'run.py'
        original = Path(runtime.__file__).read_bytes()
        path.write_bytes(original)
        result = apply_patches(path)
        self.assertTrue(result['ok'])
        first = path.read_bytes()
        self.assertIn(b'@_wh_gateway_event_owner', first)
        self.assertIn(b'_wh_bind_original(self._session_db', first)
        apply_patches(path)
        self.assertEqual(first, path.read_bytes())
        self.assertEqual(original, Path(runtime.__file__).read_bytes())

    def test_gateway_keeps_original_event_identity_separate_from_reply_anchor(self):
        import gateway.run as runtime
        from apply_gateway_patches import apply_patches
        path = Path(self.temp.name) / 'run-original-id.py'
        original = Path(runtime.__file__).read_text(encoding='utf-8')
        path.write_text(original, encoding='utf-8')
        apply_patches(path)
        patched = path.read_text(encoding='utf-8')
        self.assertEqual(patched.count('_wh_original_message_id=event.message_id,'), 1)
        self.assertEqual(patched.count('_wh_original_message_id: Optional[str] = None,'), 2)
        self.assertEqual(patched.count('_wh_original_message_id=_wh_original_message_id,'), 2)
        self.assertIn('event_message_id=self._reply_anchor_for_event(event),', patched)
        first = path.read_bytes()
        apply_patches(path)
        self.assertEqual(first, path.read_bytes())


class StopIterationProof(Exception):
    pass


if __name__ == '__main__':
    unittest.main()
