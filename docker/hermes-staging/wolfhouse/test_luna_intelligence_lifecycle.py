"""Review regressions: revocation across blocking admission and worker setup."""
import contextvars
import json
import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from wolfhouse import luna_intelligence as li, luna_personality as lp
import apply_gateway_patches as gw
from wolfhouse.test_luna_personality_gateway_bind import skeleton, _invoke_emitted

ON = {'success': True, 'client_slug': 'sunset', 'enabled': True}
ENV = {'LUNA_CLIENT_SLUG': 'sunset', 'HERMES_ROLE': 'sunset-luna',
       'WOLFHOUSE_STAFF_API_BASE_URL': li.STAGING_ORIGINS['sunset']}
SOURCE = SimpleNamespace(platform='whatsapp')

class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, ENV)
        self.env.start()
        li.bind_guest_turn(SOURCE)
    def tearDown(self):
        li.clear_guest_turn()
        self.env.stop()

    def test_initial_setting_expiry_blocks_provider(self):
        turn = li._current.get()
        def expire():
            turn.deadline = time.monotonic() - 1
            return ON
        with patch.object(li, 'fetch_setting', side_effect=expire), patch.object(li, 'run_bounded') as provider:
            result = json.loads(li.search_public_info({'query': 'surf Somo'}))
            self.assertFalse(result['success'])
            provider.assert_not_called()
            self.assertEqual(turn.searches, 0)

    def test_final_setting_revocation_blocks_publication(self):
        for operation in ('search', 'read'):
            with self.subTest(operation=operation):
                li.bind_guest_turn(SOURCE)
                turn = li._current.get()
                turn.sources['s1'] = 'https://example.org/fixture'
                revoke = contextvars.copy_context()
                calls = []
                def setting():
                    calls.append(1)
                    if len(calls) == 2:
                        revoke.run(li.clear_guest_turn)
                    return ON
                fixture = {'success': True, 'results': [{'url': 'https://example.org/new'}], 'content': 'OFFLINE fixture'}
                with patch.object(li, 'fetch_setting', side_effect=setting), patch.object(li, 'run_bounded', return_value=fixture):
                    value = (li.search_public_info({'query': 'surf Somo'}) if operation == 'search'
                             else li.read_public_source({'source_id': 's1'}))
                self.assertTrue(turn.closed)
                self.assertFalse(json.loads(value)['success'])
                self.assertNotIn('https://example.org/new', turn.sources.values())

    def test_runtime_or_bound_turn_change_during_setting_denied(self):
        for change in ('role', 'turn'):
            with self.subTest(change=change), patch.dict(os.environ, ENV):
                li.bind_guest_turn(SOURCE)
                def setting():
                    if change == 'role':
                        os.environ['HERMES_ROLE'] = 'captain'
                    else:
                        li.bind_guest_turn(SOURCE)
                    return ON
                with patch.object(li, 'fetch_setting', side_effect=setting), patch.object(li, 'run_bounded') as provider:
                    self.assertFalse(json.loads(li.search_public_info({'query': 'surf Somo'}))['success'])
                    provider.assert_not_called()

    def test_emitted_worker_early_return_revokes_copied_context(self):
        for indent in (8, 12):
            with self.subTest(indent=indent):
                saved = []
                class Agent:
                    def __init__(self, **kwargs):
                        saved.append((li._current.get(), contextvars.copy_context()))
                source = skeleton(indent).replace("result = agent.run_conversation('synthetic')",
                    "return {'final_response': 'offline early return'}\n" + ' ' * indent + "result = agent.run_conversation('synthetic')")
                emitted, _ = gw.apply_luna_personality_gateway_patches(source)
                emitted = gw.apply_luna_intelligence_cleanup(emitted)
                ns = {'AIAgent': Agent}
                exec(emitted, ns)
                with patch.object(lp, 'default_fetch_setting', return_value={}), patch.object(li, 'fetch_setting', return_value=ON):
                    _invoke_emitted(ns, SOURCE)
                    self.assertTrue(saved[0][0].closed)
                    self.assertIsNone(saved[0][1].run(li._admitted))
                    self.assertIsNone(li._current.get())

    def test_emitted_worker_construction_failure_revokes_copied_context(self):
        for indent in (8, 12):
            with self.subTest(indent=indent):
                saved = []
                class BrokenAgent:
                    def __init__(self, **kwargs):
                        saved.append((li._current.get(), contextvars.copy_context()))
                        raise RuntimeError('fixture constructor failure')
                emitted, _ = gw.apply_luna_personality_gateway_patches(skeleton(indent))
                emitted = gw.apply_luna_intelligence_cleanup(emitted)
                self.assertEqual(gw.apply_luna_intelligence_cleanup(emitted), emitted)
                gw.validate_luna_personality_emitted_ast(emitted)
                ns = {'AIAgent': BrokenAgent}
                exec(emitted, ns)
                with patch.object(lp, 'default_fetch_setting', return_value={}), patch.object(li, 'fetch_setting', return_value=ON):
                    with self.assertRaisesRegex(RuntimeError, 'constructor failure'):
                        _invoke_emitted(ns, SOURCE)
                    self.assertTrue(saved[0][0].closed)
                    self.assertIsNone(saved[0][1].run(li._admitted))
                    self.assertIsNone(li._current.get())

if __name__ == '__main__':
    unittest.main()
