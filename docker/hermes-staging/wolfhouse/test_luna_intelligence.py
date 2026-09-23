"""Offline ordinary-entrypoint contract tests; network boundaries are injected."""
import importlib
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'plugins'))

class IntelligenceTests(unittest.TestCase):
    def test_registered_handlers_default_off_then_on_without_changing_booking_tools(self):
        import wolfhouse_staff_api as plugin
        registered = {}
        ctx = SimpleNamespace(register_tool=lambda **kw: registered.update({kw['name']: kw}))
        with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'sunset', 'HERMES_ROLE': 'sunset-luna',
                                     'WOLFHOUSE_STAFF_API_BASE_URL': 'https://sunset-staging.lunafrontdesk.com'}):
            plugin.register(ctx)
            self.assertIn('search_public_info', registered, 'Guest public search boundary missing')
            self.assertIn('read_public_source', registered)
            self.assertIn('get_sunset_lesson_availability', registered)
            self.assertNotIn('web_search', registered)
            from wolfhouse import luna_intelligence as li
            source = SimpleNamespace(platform='whatsapp', user_id='synthetic-user', chat_id='synthetic-chat')
            li.bind_guest_turn(source)
            setting = {'success': True, 'client_slug': 'sunset', 'enabled': False}
            with patch.object(li, 'fetch_setting', lambda: setting), patch.object(li, 'run_bounded') as worker:
                result = json.loads(registered['search_public_info']['handler']({'query': 'soft versus hard surfboard'}))
                self.assertEqual(result['error'], 'intelligence_off')
                worker.assert_not_called()
                setting['enabled'] = True
                worker.return_value = {'success': True, 'results': [{'url': 'https://example.org/boards', 'title': 'Boards', 'description': 'Soft and hard'}]}
                result = json.loads(registered['search_public_info']['handler']({'query': 'soft versus hard surfboard'}))
                self.assertTrue(result['success'])
                self.assertEqual(result['sources'][0]['source_id'], 's1')
                worker.assert_called_once()
                setting['enabled'] = False
                result = json.loads(registered['read_public_source']['handler']({'source_id': 's1'}))
                self.assertEqual(result['error'], 'intelligence_off')
                self.assertEqual(worker.call_count, 1)
            li.clear_guest_turn()

    def test_ordinary_turn_bind_clear_closes_copied_context_and_non_guest_is_denied(self):
        import contextvars
        from wolfhouse import luna_intelligence as li, luna_personality as lp
        source = SimpleNamespace(platform='whatsapp', user_id='synthetic-user', chat_id='synthetic-chat')
        env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
               'WOLFHOUSE_STAFF_API_BASE_URL': 'https://staff-staging.lunafrontdesk.com'}
        with patch.dict(os.environ, env), patch.object(li, 'fetch_setting', return_value={'success': True, 'client_slug': 'wolfhouse-somo', 'enabled': True}):
            li.clear_guest_turn()
            lp.bind_whatsapp_turn_personality(source, fetch_setting=lambda _: {'personality_id': 'sunny'})
            self.assertIsNotNone(li._admitted(), 'ordinary gateway bind must initialize research scope')
            copied = contextvars.copy_context()
            lp.clear_bound_personality()
            self.assertIsNone(copied.run(li._admitted), 'late worker must lose authority after turn clears')
            lp.bind_whatsapp_turn_personality(SimpleNamespace(platform='discord'), fetch_setting=lambda _: {})
            self.assertIsNone(li._admitted())

    def test_emitted_ordinary_worker_closes_scope_even_on_exception(self):
        import apply_gateway_patches as gw
        from wolfhouse import luna_intelligence as li, luna_personality as lp
        from wolfhouse.test_luna_personality_gateway_bind import skeleton, _invoke_emitted
        self.assertTrue(hasattr(gw, 'apply_luna_intelligence_cleanup'), 'worker cleanup emitter missing')
        for indent in (8, 12):
            emitted, _ = gw.apply_luna_personality_gateway_patches(skeleton(indent))
            emitted = gw.apply_luna_intelligence_cleanup(emitted)
            self.assertEqual(emitted, gw.apply_luna_intelligence_cleanup(emitted))
            gw.validate_luna_personality_emitted_ast(emitted)
            seen = []
            class Agent:
                def __init__(self, **kw): pass
                def run_conversation(self, *a, **kw):
                    seen.append(li._current.get())
                    raise RuntimeError('test-provider-error')
            ns = {'AIAgent': Agent}
            exec(emitted, ns)
            with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'sunset', 'HERMES_ROLE': 'sunset-luna', 'WOLFHOUSE_STAFF_API_BASE_URL': 'https://sunset-staging.lunafrontdesk.com'}), patch.object(lp, 'default_fetch_setting', return_value={}):
                with self.assertRaisesRegex(RuntimeError, 'test-provider-error'):
                    _invoke_emitted(ns, SimpleNamespace(platform='whatsapp'))
                self.assertIsNotNone(seen[0])
                self.assertTrue(seen[0].closed)
                self.assertIsNone(li._current.get())

    def test_privacy_inputs_rejected_before_provider(self):
        from wolfhouse import luna_intelligence as li
        env = {'LUNA_CLIENT_SLUG': 'sunset', 'HERMES_ROLE': 'sunset-luna', 'WOLFHOUSE_STAFF_API_BASE_URL': 'https://sunset-staging.lunafrontdesk.com'}
        with patch.dict(os.environ, env), patch.object(li, 'fetch_setting', return_value={'success': True, 'client_slug': 'sunset', 'enabled': True}), patch.object(li, 'run_bounded') as worker:
            li.bind_guest_turn(SimpleNamespace(platform='whatsapp', user_id='+34600000001', user_name='Private Guestname'))
            for query in ['food for Private Guestname', 'email person@example.org', 'my number +34600000001', 'read https://example.org/pay/secret', 'booking id abc-def', 'guest: hello assistant: private transcript']:
                with self.subTest(query=query):
                    result = json.loads(li.search_public_info({'query': query}))
                    self.assertEqual(result.get('error'), 'invalid_public_query')
            worker.assert_not_called()
            li.clear_guest_turn()

if __name__ == '__main__':
    unittest.main()
