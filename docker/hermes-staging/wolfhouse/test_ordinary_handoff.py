"""Offline ordinary worker -> real flag -> patched send ordering regressions.

Only provider/Staff HTTP and model boundaries are fake. No live calls.
"""
import asyncio
import json
import os
import sys
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / 'plugins')]
import apply_gateway_patches as gw
import wolfhouse_staff_api as plugin
from wolfhouse import luna_intelligence as li
from wolfhouse import explicit_human_handoff as handoff, pause_gate, luna_personality as lp
from wolfhouse.whatsapp_burst_coalesce import BurstCoalescer, AdapterDispatch
from wolfhouse.test_luna_personality_gateway_bind import skeleton, _invoke_emitted
from wolfhouse.test_draft_mode_inbox_persist import _SendResult, _install_gateway_stub


class OrdinaryHandoffTests(unittest.TestCase):
    def run_turn(self, tenant, *, crash=False, provider='ok', duplicate=False, research=None,
                 reason='urgent_safety', raw_executor=False, extra_env=None, blocked=False,
                 installed=False, persist_failures=0, cancel_during_ack=False,
                 lookup_query='Somo weather September 26 and 27, 2026', lookup_delay=0):
        timeline, flags, finals = [], [], []
        public_calls, sent_content = [], []
        phone = '+34900000001'
        state = {'paused': False}
        source = SimpleNamespace(platform='whatsapp', chat_id=phone, user_id=phone)
        event = SimpleNamespace(source=source, text='There is an urgent safety problem',
                                message_id='ordinary-test-' + tenant)
        env = {'LUNA_CLIENT_SLUG': tenant, 'HERMES_ROLE': 'luna' if tenant == 'wolfhouse-somo' else 'sunset-luna',
               'WOLFHOUSE_STAFF_API_BASE_URL': 'https://staff-staging.lunafrontdesk.com' if tenant == 'wolfhouse-somo' else 'https://sunset-staging.lunafrontdesk.com',
               'LUNA_AUTO_SEND_ENABLED': 'true', 'WHATSAPP_DRY_RUN': 'false',
               'LUNA_BOT_INTERNAL_TOKEN': 'offline', 'SUNSET_INGRESS_LOCATION_ID': 'sunset-somo'}
        env.update(extra_env or {})
        def public_provider(operation, value, **kw):
            public_calls.append((operation, value))
            self.assertNotIn(phone, value)
            self.assertNotIn(tenant, value)
            if research != 'success':
                return {'success': False}
            from wolfhouse import guest_public_worker as worker
            if operation == 'search':
                fake = ModuleType('tools.web_tools')
                fake.web_search_tool = lambda query, limit: json.dumps({
                    'success': True, 'data': {'web': [{
                        'url': 'https://example.org/weather', 'title': None, 'description': None,
                    }]}})
                with patch.dict(sys.modules, {'tools.web_tools': fake}):
                    result = worker._execute(operation, value)
                return {'success': result['ok'], 'results': result.get('results')}
            with patch.object(worker, '_https_get', side_effect=[
                (b'User-agent: *\nDisallow:\n', 'text/plain'),
                (b'Offline source fixture: forecast unavailable beyond Saturday.', 'text/plain'),
            ]):
                result = worker._execute(operation, value)
            return {'success': result['ok'], 'content': result.get('text')}
        def post(path, payload):
            self.assertEqual(path, '/conversation/needs-human')
            self.assertEqual(payload['phone'], phone)
            self.assertNotIn('client_slug', payload)
            self.assertNotIn('conversation_id', payload)
            timeline.append('persist')
            if timeline.count('persist') <= persist_failures:
                return {'success': False, 'needs_human': False}
            state['paused'] = tenant == 'wolfhouse-somo'
            return {'success': True, 'needs_human': True, 'conversation_paused': state['paused']}
        def disposition(*a, **kw):
            return {'send_blocked': blocked or state['paused'], 'stage_as_draft': blocked == 'draft'}
        async def provider_send(_self, chat_id, content, **kw):
            sent_content.append(content)
            timeline.append('correction' if 'couldn’t confirm the handoff' in content else 'send')
            self.assertEqual(chat_id, phone)
            if cancel_during_ack:
                adapter.ack_started.set()
                await adapter.release_ack.wait()
            if provider == 'raise':
                raise RuntimeError('offline provider failure')
            return _SendResult(success=provider == 'ok', message_id='wamid.accepted' if provider == 'ok' else None)
        class Adapter:
            send = gw._patched_whatsapp_cloud_send
            _wolfhouse_internal_status_send_filter = True

            async def _process_message_background(self, evt, session_key):
                await self.release.wait()
                await dispatch(evt)

            async def handle_message(self, evt):
                self.task = asyncio.create_task(self._process_message_background(evt, 'offline-session'))

            async def _handle_webhook(self, evt):
                await self.handle_message(evt)
                return 'webhook-accepted'
        class Agent:
            def __init__(self, **kw): pass
            def run_conversation(self, *a, **kw):
                if research:
                    now = li.time.monotonic()
                    with patch.object(li.time, 'monotonic', return_value=now + lookup_delay):
                        lookup = json.loads(li.search_public_info({'query': lookup_query}))
                        if lookup['success']:
                            evidence = json.loads(li.read_public_source({'source_id': lookup['sources'][0]['source_id']}))
                            return {'final_response': evidence['content'] + ' ' + evidence['url']}
                flags.append(json.loads(plugin.flag_needs_human({'reason': reason, 'phone': '+34900009999'})))
                if duplicate:
                    flags.append(json.loads(plugin.flag_needs_human({'reason': reason})))
                if crash:
                    raise RuntimeError('agent failed AFTER flag')
                return {'final_response': flags[-1].get('guest_safe_next_action') or 'A teammate will take over.'}
        # Model the real nested worker/submission boundary, not an executor
        # outside the emitted gateway (which cannot capture the caller's context).
        worker_source = skeleton(12).replace(
            '        return run_sync()',
            '        return await asyncio.get_running_loop().run_in_executor(None, run_sync)',
        ) if raw_executor else skeleton(8)
        emitted, _ = gw.apply_luna_personality_gateway_patches(worker_source)
        emitted = gw.apply_luna_intelligence_cleanup(emitted)
        self.assertEqual(gw.apply_luna_intelligence_cleanup(emitted), emitted)
        ns = {'AIAgent': Agent, 'asyncio': asyncio}
        exec(emitted, ns)
        async def dispatch(evt):
            if raw_executor:
                runner = ns['Gateway']()
                runner._agent_cache = {}
                runner._agent_cache_lock = None
                runner._evict_cached_agent = lambda key: None
                adapter.worker = asyncio.create_task(runner._run_agent_inner(source))
                result = await asyncio.shield(adapter.worker)
            else:
                result, _ = await asyncio.to_thread(_invoke_emitted, ns, source)
            finals.append(await adapter.send(phone, result['final_response'], metadata={'wolfhouse_guest_reply': True}))
        async def run():
            if installed:
                from wolfhouse import whatsapp_burst_coalesce as burst
                adapter.release = asyncio.Event()
                adapter.ack_started = asyncio.Event()
                adapter.release_ack = asyncio.Event()
                cloud = SimpleNamespace(WhatsAppCloudAdapter=Adapter)
                with patch.dict(sys.modules, {'gateway.platforms.whatsapp_cloud': cloud}), \
                     patch.object(sys.modules['gateway.platforms'], 'whatsapp_cloud', cloud, create=True), \
                     patch.object(burst, '_COALESCER', None), \
                     patch.object(burst, 'coalesce_enabled', return_value=False), \
                     patch.object(pause_gate, 'install_whatsapp_pause_webhook_patch', return_value=False):
                    gw.install_runtime_whatsapp_patches()
                    gw.install_runtime_whatsapp_patches()  # installation is idempotent
                    self.assertEqual(await asyncio.wait_for(adapter._handle_webhook(event), 1), 'webhook-accepted')
                    self.assertFalse(adapter.task.done(), 'webhook must not await model work')
                    adapter.release.set()
                    if cancel_during_ack:
                        await asyncio.wait_for(adapter.ack_started.wait(), 2)
                        adapter.task.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await adapter.task
                        adapter.release_ack.set()
                        await asyncio.wait_for(adapter.worker, 3)
                    else:
                        await adapter.task
                return
            coalescer = BurstCoalescer(debounce_ms=0)
            ad = AdapterDispatch(adapter=adapter, dispatch_fn=dispatch)
            await coalescer._dispatch_one(ad, event)
        adapter = Adapter()
        _install_gateway_stub()
        handoff._ACKED_WAMIDS.clear()
        handoff._LOCAL_AUTOMATION_BLOCKED.clear()
        with patch.dict(os.environ, env), patch.object(plugin, '_session_guest_phone', return_value=phone), \
             patch.object(plugin, '_post_bot', side_effect=post), \
             patch.object(lp, 'default_fetch_setting', return_value={}), \
             patch.object(li, 'fetch_setting', return_value={'success': True, 'client_slug': tenant, 'enabled': research != 'off'}), \
             patch.object(li, 'run_bounded', side_effect=public_provider), \
             patch.object(pause_gate, 'guest_paused_for_event', return_value=False), \
             patch.object(pause_gate, 'whatsapp_outbound_disposition', side_effect=disposition), \
             patch.object(gw, '_orig_whatsapp_cloud_send', provider_send, create=True):
            asyncio.run(run())
            if persist_failures or cancel_during_ack:
                self.assertEqual(handoff.is_local_automation_blocked(phone), not flags[-1]['success'])
            if research == 'success':
                self.assertEqual(public_calls, [('search', lookup_query),
                                                ('read', 'https://example.org/weather')])
                self.assertEqual(sent_content, ['Offline source fixture: forecast unavailable beyond Saturday. https://example.org/weather'])
        return timeline, flags, finals

    def test_delayed_general_date_lookup_through_ordinary_guest_worker(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            for query in ('Somo weather 2026-09-26 2026-09-27',
                          'Santander museums 2026-09-26', 'Somo ferry 2026-09-27'):
                with self.subTest(tenant=tenant, query=query):
                    timeline, flags, finals = self.run_turn(
                        tenant, installed=True, raw_executor=True, research='success',
                        lookup_query=query, lookup_delay=31)
                    self.assertEqual(timeline, ['send'])
                    self.assertEqual(flags, [])
                    self.assertTrue(finals[0].success)

    def test_revocation_during_ack_cannot_persist_from_late_worker(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            timeline, flags, finals = self.run_turn(
                tenant, installed=True, raw_executor=True, cancel_during_ack=True)
            self.assertEqual(timeline, ['send'])
            self.assertFalse(flags[0]['success'])
            self.assertTrue(flags[0]['ack_sent'], 'a real late receipt remains truthful')
            self.assertEqual(flags[0]['error'], 'handoff_scope_closed')
            self.assertTrue(flags[0]['needs_operator_reconciliation'])
            self.assertTrue(flags[0]['local_fail_closed'])
            self.assertEqual(finals, [])

    def test_successful_public_lookup_uses_source_evidence_without_handoff(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            timeline, flags, finals = self.run_turn(tenant, installed=True, raw_executor=True, research='success')
            self.assertEqual(timeline, ['send'])
            self.assertEqual(flags, [])
            self.assertEqual(finals[0].message_id, 'wamid.accepted')

    def test_suppressed_ack_preserves_guards_and_never_claims_delivery(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            for options in ({'blocked': True}, {'blocked': 'draft'},
                            {'extra_env': {'LUNA_AUTO_SEND_ENABLED': 'false'}},
                            {'extra_env': {'WHATSAPP_DRY_RUN': 'true'}}):
                timeline, flags, _ = self.run_turn(tenant, installed=True, raw_executor=True, **options)
                self.assertEqual(timeline, ['persist'])
                self.assertFalse(flags[0]['ack_sent'])
                self.assertTrue(flags[0]['ack_send_failed'])
                self.assertTrue(flags[0]['needs_human'])

    def test_source_identity_precedes_legacy_root_and_legacy_events_still_work(self):
        self.assertEqual(handoff._event_chat_id(SimpleNamespace(source=SimpleNamespace(chat_id='trusted'), chat_id='wrong')), 'trusted')
        for event in (SimpleNamespace(chat_id='legacy'), {'from': 'legacy'},
                      {'source': {'chat_id': 'legacy'}}):
            self.assertEqual(handoff._event_chat_id(event), 'legacy')

    def test_fail_closed_state_is_scoped_to_tenant_origin_and_phone(self):
        handoff._LOCAL_AUTOMATION_BLOCKED.clear()
        with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'WOLFHOUSE_STAFF_API_BASE_URL': 'https://wh.invalid'}):
            handoff.mark_local_automation_blocked('1001')
            self.assertTrue(handoff.is_local_automation_blocked('1001'))
            self.assertFalse(handoff.is_local_automation_blocked('1002'))
            with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'sunset'}):
                self.assertFalse(handoff.is_local_automation_blocked('1001'))
            with patch.dict(os.environ, {'WOLFHOUSE_STAFF_API_BASE_URL': 'https://other.invalid'}):
                self.assertFalse(handoff.is_local_automation_blocked('1001'))

    def test_failed_persistence_retries_without_repeating_ack_and_fails_closed(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            for failures in (1, 2):
                with self.subTest(tenant=tenant, failures=failures):
                    timeline, flags, _ = self.run_turn(
                        tenant, installed=True, raw_executor=True, duplicate=True,
                        persist_failures=failures)
                    self.assertEqual(timeline, ['send', 'persist', 'correction', 'persist'])
                    self.assertFalse(flags[0]['success'])
                    self.assertTrue(flags[0]['ack_sent'])
                    self.assertTrue(flags[0]['local_fail_closed'])
                    self.assertTrue(flags[0]['needs_operator_reconciliation'])
                    self.assertIn('couldn’t confirm the handoff', flags[0]['guest_safe_next_action'])
                    self.assertEqual(flags[1]['success'], failures == 1)
                    self.assertEqual(flags[1]['local_fail_closed'], failures == 2)

    def test_installed_notice_without_optional_coalescing_keeps_webhook_async(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            timeline, flags, finals = self.run_turn(tenant, installed=True, raw_executor=True)
            self.assertEqual(timeline, ['send', 'persist'])
            self.assertTrue(flags[0]['ack_sent'])
            self.assertIsNone(finals[0].message_id)

    def test_executor_worker_does_not_depend_on_optional_context_copy_wrapper(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            timeline, flags, _ = self.run_turn(tenant, raw_executor=True)
            self.assertEqual(timeline, ['send', 'persist'])
            self.assertTrue(flags[0]['ack_sent'])

    def test_registered_flag_contract_does_not_treat_public_failure_as_tool_error(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            registered = {}
            with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': tenant}):
                plugin.register(SimpleNamespace(register_tool=lambda **kw: registered.update({kw['name']: kw})))
            schema = registered['flag_needs_human']['schema']
            self.assertIn('public research', schema['description'].lower())
            self.assertIn('business_tool_error', schema['parameters']['properties']['reason']['description'])

    def test_public_failure_alone_is_not_handoff_even_with_free_text_reason(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            for research in ('off', 'failed'):
                for reason in ('Weather lookup failed. Guest requests Somo forecast.',
                               'Could not research museum opening hours', 'tool_errors'):
                    with self.subTest(tenant=tenant, research=research, reason=reason):
                        timeline, flags, finals = self.run_turn(tenant, research=research, reason=reason)
                        self.assertEqual(timeline, ['send'])
                        self.assertFalse(flags[0]['needs_human'])
                        self.assertFalse(flags[0]['staff_review_needed'])
                        self.assertEqual(flags[0]['blocked_reasons'], ['public_research_not_handoff'])
                        self.assertTrue(flags[0]['guest_safe_next_action'])
                        self.assertEqual(finals[0].message_id, 'wamid.accepted')

    def test_failure_does_not_hide_independent_safety_human_complaint_cancellation(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            for reason in ('human_requested', 'urgent_safety', 'complaint', 'paid_cancellation_or_reschedule'):
                with self.subTest(tenant=tenant, reason=reason):
                    timeline, flags, _ = self.run_turn(tenant, research='failed', reason=reason)
                    self.assertEqual(timeline, ['send', 'persist'])
                    self.assertTrue(flags[0]['needs_human'])

    def test_agent_exception_after_flag_does_not_lose_handoff(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            timeline, flags, finals = self.run_turn(tenant, crash=True)
            self.assertEqual(timeline, ['send', 'persist'])
            self.assertTrue(flags[0]['needs_human'])
            self.assertEqual(finals, [])

    def test_duplicate_flags_only_ack_and_persist_once(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            timeline, flags, _ = self.run_turn(tenant, duplicate=True)
            self.assertEqual(timeline, ['send', 'persist'])
            self.assertEqual(flags[0], flags[1])

    def test_failed_provider_never_claims_delivery_but_still_persists(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            for provider in ('false', 'raise'):
                timeline, flags, _ = self.run_turn(tenant, provider=provider)
                self.assertEqual(timeline, ['send', 'persist'])
                self.assertTrue(flags[0]['needs_human'])
                self.assertFalse(flags[0]['ack_sent'])
                self.assertTrue(flags[0]['ack_send_failed'])

    def test_ordinary_worker_acknowledges_before_pause_for_both_tenants(self):
        for tenant in ('wolfhouse-somo', 'sunset'):
            with self.subTest(tenant=tenant):
                timeline, flags, finals = self.run_turn(tenant)
                self.assertEqual(timeline, ['send', 'persist'])
                self.assertTrue(flags[0]['needs_human'])
                self.assertTrue(flags[0]['ack_sent'])
                self.assertIsNone(finals[0].message_id, 'final notice must not duplicate the deterministic ack')


if __name__ == '__main__':
    unittest.main()
