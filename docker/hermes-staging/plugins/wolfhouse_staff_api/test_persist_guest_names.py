"""L4 offline regressions: scripted arguments, not live model/Staff write proof."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / 'docker/hermes-staging'))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import wolfhouse_staff_api as plugin

NAMES = ['María José', 'Jean-Luc', 'Alex', 'Alex']
ROSTER = [{'name': n} for n in NAMES]
BASE = {'check_in': '2026-07-06', 'check_out': '2026-07-09', 'guest_count': 4,
        'package_code': 'package_none', 'group_gender': 'mixed', 'room_type': 'shared',
        'selected_bed_codes': ['R3-B1', 'R3-B2', 'R3-B3', 'R3-B4'], 'payment_choice': 'full'}
SUNSET = {'components': {'lesson': {'quantity': 1}}, 'service_dates': ['2026-07-06']}


class Registry:
    def __init__(self):
        self.tools, self.hooks = {}, {}
    def register_tool(self, **tool):
        self.tools[tool['name']] = tool
    def register_hook(self, name, fn):
        self.hooks[name] = fn


class StandaloneHelperTests(unittest.TestCase):
    def test_ir4_helper_unavailable_explicit_standalone(self):
        # A fresh named-test process proves plugin-only compatibility; when the
        # runtime is loaded, lack of a helper cannot establish standalone use.
        runtime_loaded = 'run_agent' in sys.modules or 'agent.conversation_loop' in sys.modules
        registry = Registry()
        with patch.object(plugin, '_booking_names_helper', return_value=None), \
                patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'}), \
                patch.object(plugin, '_post_bot', return_value={'success': False, 'write_performed': False, 'error': 'offline_capture'}) as transport:
            plugin.register(registry)
            result = json.loads(registry.tools['create_booking_from_plan']['handler'](
                {**BASE, 'guest_name': 'Explicit', 'guests': ROSTER}))
            if runtime_loaded:
                transport.assert_not_called()
                self.assertEqual(result['error'], 'booking_names_unavailable')
            else:
                transport.assert_called_once()
                self.assertEqual(transport.call_args.args[1]['guest_name'], 'Explicit')
                self.assertFalse(result['write_performed'])
            print('IR4_STANDALONE_RUNTIME_LOADED', runtime_loaded)


class PersistNamesTests(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo',
                                                 'SUNSET_INGRESS_LOCATION_ID': ''}))
        self.attempts = []
        def forbidden(*args, **kwargs):
            self.attempts.append('network attempted')
            raise AssertionError('network forbidden')
        for target in ('socket.socket.connect', 'socket.socket.connect_ex',
                       'socket.create_connection', 'socket.getaddrinfo', 'urllib.request.urlopen'):
            self.enterContext(patch(target, side_effect=forbidden))
        self.addCleanup(lambda: self.assertEqual(self.attempts, [], 'including swallowed attempts'))
        self.enterContext(patch.object(plugin, '_session_guest_phone', return_value='+349****0001'))
        self.calls = []
        self.enterContext(patch.object(plugin, '_post_bot', side_effect=self.api))
        self.registry = Registry()
        plugin.register(self.registry)

    def api(self, path, body, **kwargs):
        self.calls.append((path, copy.deepcopy(body)))
        if path == '/booking-preview':
            return {'success': True, 'quote_total_cents': 42000, 'deposit_required_cents': 12000,
                    'per_person': [{'total_cents': 10500}], 'per_guest_deposits': [3000] * 4}
        if path == '/sunset/offering-quote':
            return {'success': True, 'total_cents': 4000, 'unit_amount_cents': 4000,
                    'price_source': 'offline_read_fixture', 'line_items': [{'amount_cents': 4000}],
                    'quote_provenance': {'fingerprint': 'opaque-fixture', 'quote_lane': 'offering'}}
        return {'success': False, 'write_performed': False, 'error': 'offline_capture'}

    def invoke(self, name, args):
        return json.loads(self.registry.tools[name]['handler'](copy.deepcopy(args)))

    def sunset(self):
        os.environ.update(LUNA_CLIENT_SLUG='sunset', SUNSET_INGRESS_LOCATION_ID='sunset-somo')
        self.registry = Registry()
        plugin.register(self.registry)

    def test_capture_guidance_keeps_quote_before_name_rule_sunset_only(self):
        description = self.registry.tools['capture_booking_names']['description']
        self.assertIn('For Sunset, never ask for names before quoting.', description)

    def test_tool_result_exposes_identity_not_session_bookkeeping(self):
        from wolfhouse import booking_names
        saved = {'names': {'guest_name': NAMES[0], 'guests': ROSTER},
                 'scope': {'tenant': 'fixture', 'phone': 'internal'},
                 'generation': 'private-generation', 'started_at': 123,
                 'party_count': 4, 'version': 2}
        with patch.object(booking_names, 'remember_names', return_value=saved):
            result = self.invoke('quote_booking', BASE)
        self.assertEqual(result['booking_names'], {'names': saved['names']})

    def test_quote_name_normalization_preserves_all_non_identity_inputs(self):
        # Values that reach the existing quote transport. Its other legacy
        # validation/error behavior is not an L4 repair; create has strict tests.
        for key in ('guest_count', 'num_guests', 'count'):
            for value in (False, None, '', [], 2.5, 2):
                with self.subTest(key=key, value=value):
                    args = {k: v for k, v in BASE.items() if k != 'guest_count'}
                    args.update({key: value, 'guests': ROSTER})
                    self.calls.clear()
                    self.invoke('quote_booking', args)
                    wire = self.calls[-1][1]
                    non_identity = lambda body: {k: v for k, v in body.items()
                                                 if k not in {'guest_name', 'guests'}}
                    self.assertEqual(non_identity(wire),
                                     non_identity({**args, 'source': 'agent_luna_whatsapp'}))

    def test_invalid_counts_reach_original_validator_unchanged(self):
        for key in ('guest_count', 'num_guests', 'count'):
            for value in (0, False, None, '', '4.0', 2.5, [], float('inf')):
                with self.subTest(key=key, value=value):
                    args = {k: v for k, v in BASE.items() if k != 'guest_count'}
                    args.update({key: value, 'guests': NAMES})
                    self.calls.clear()
                    result = self.invoke('create_booking_from_plan', args)
                    self.assertEqual(result.get('next_action'), 'clarify_guest_count')
                    self.assertEqual(self.calls, [])

    def test_quote_schema_and_result_keep_ordered_names(self):
        quote = self.registry.tools['quote_booking']['schema']['parameters']
        create = self.registry.tools['create_booking_from_plan']['schema']['parameters']
        self.assertEqual(quote['properties']['guests'], create['properties']['guests'])
        self.assertNotIn('guests', quote['required'])
        result = self.invoke('quote_booking', {**BASE, 'guest_name': NAMES[0], 'guests': NAMES})
        self.assertEqual(result['guest_name'], NAMES[0])
        self.assertEqual(result['guests'], ROSTER)
        self.assertEqual(result['total_cents'], 42000)
        self.assertEqual(result['remaining_after_deposit_cents'], 30000)

    def test_capture_registered_closed_schema_and_no_context_failclosed(self):
        self.assertIn('capture_booking_names', self.registry.tools)
        tool = self.registry.tools['capture_booking_names']
        schema = tool['schema']['parameters']
        self.assertFalse(schema['additionalProperties'])
        self.assertEqual(set(schema['properties']), {'guest_name', 'guests', 'guest_count', 'clear'})
        for bad in ('tenant', 'client_slug', 'phone', 'guest_phone', 'session_id', 'path',
                    'guest_confirmed_booking', 'payment_choice', 'total_cents'):
            result = self.invoke('capture_booking_names', {'guest_name': 'Alex', bad: 'forged'})
            self.assertFalse(result['success'])
            self.assertEqual(result['status'], 'invalid_input')
        for bad in ({'guests': [{'name': 'Alex', 'phone': 'forged'}]},
                    {'guest_count': False}, {'clear': 'true'}, {'guest_name': {'name': 'Alex'}}):
            self.assertEqual(self.invoke('capture_booking_names', bad)['status'], 'invalid_input')
        result = self.invoke('capture_booking_names', {'guest_name': 'Alex'})
        self.assertFalse(result['success'])
        self.assertEqual(result['status'], 'not_saved')
        self.assertNotIn('booking_names', result)
        self.assertEqual(self.calls, [])

    def test_sunset_optional_contact_quote_preserves_money_provenance(self):
        self.sunset()
        schema = self.registry.tools['get_sunset_offering_quote']['schema']['parameters']
        self.assertIn('guest_name', schema['properties'])
        self.assertNotIn('guest_name', schema['required'])
        create_schema = self.registry.tools['create_sunset_booking']['schema']['parameters']
        self.assertNotIn('guest_name', create_schema['required'], 'persisted contact can satisfy create')
        self.assertIn('guest_confirmed_booking', create_schema['required'])
        unnamed = self.invoke('get_sunset_offering_quote', {'offering_id': 'fixture'})
        named = self.invoke('get_sunset_offering_quote', {'offering_id': 'fixture', 'guest_name': 'María José'})
        self.assertEqual(named.pop('guest_name', None), 'María José')
        self.assertEqual(named, unnamed)
        capture = self.registry.tools['capture_booking_names']['schema']['parameters']
        self.assertNotIn('guests', capture['properties'])
        self.assertNotIn('guest_count', capture['properties'])
        self.assertEqual(self.invoke('capture_booking_names', {'guests': ROSTER})['status'], 'invalid_input')
        self.assertNotIn('guests', self.calls[-1][1])

    def test_hook_returns_model_context_and_registers_reset(self):
        from wolfhouse import booking_names
        with patch.object(booking_names, 'begin_turn', return_value='known identity context'):
            self.assertEqual(self.registry.hooks['pre_llm_call'](session_id='fixture'), 'known identity context')
        self.assertIs(self.registry.hooks['on_session_reset'], booking_names.reset_session)

    def test_optional_helper_import_keeps_tools_available(self):
        import builtins
        original = builtins.__import__
        def missing(name, globals=None, locals=None, fromlist=(), level=0):
            if name == 'wolfhouse' and 'booking_names' in fromlist:
                raise ImportError('optional helper absent')
            return original(name, globals, locals, fromlist, level)
        with patch('builtins.__import__', side_effect=missing):
            self.registry = Registry()
            plugin.register(self.registry)
            self.assertEqual(self.invoke('quote_booking', BASE)['total_cents'], 42000)
            self.assertEqual(self.invoke('capture_booking_names', {'guest_name': 'Alex'})['status'], 'not_saved')


@unittest.skipUnless(importlib.util.find_spec('run_agent'), 'ordinary tests require pinned Hermes runtime')
class OrdinaryNamesTests(PersistNamesTests):
    def ordinary_agent(self, db=None, session='ordinary-persist-names'):
        from types import SimpleNamespace
        sys.modules.setdefault('fire', SimpleNamespace(Fire=lambda *a, **k: None))
        sys.modules.setdefault('firecrawl', SimpleNamespace(Firecrawl=object))
        sys.modules.setdefault('fal_client', SimpleNamespace())
        # Only the registered booking tools participate in this offline proof;
        # unrelated built-in discovery runs host capability subprocesses.
        with patch('tools.registry.discover_builtin_tools'):
            import run_agent
        import hermes_cli.plugins as hooks
        from hermes_state import SessionDB
        if db is None:
            home = Path(self.enterContext(tempfile.TemporaryDirectory()))
            db = SessionDB(home / 'state.db')
            self.addCleanup(db.close)
        names = {'capture_booking_names', 'quote_booking', 'create_booking_from_plan',
                 'get_sunset_offering_quote', 'create_sunset_booking'}
        definitions = [{'type': 'function', 'function': t['schema']}
                       for name, t in self.registry.tools.items() if name in names]
        import agent.model_metadata as metadata
        self.enterContext(patch.object(metadata, 'fetch_model_metadata', return_value={}))
        self.enterContext(patch('agent.context_compressor.get_model_context_length', return_value=128000))
        with patch.object(run_agent, 'get_tool_definitions', return_value=definitions), \
                patch.object(run_agent, 'check_toolset_requirements', return_value={}), \
                patch.object(run_agent, 'OpenAI', return_value=SimpleNamespace()):
            agent = run_agent.AIAgent(model='offline-fixture', provider='openai-codex',
                                     api_mode='codex_responses', base_url='https://provider.invalid',
                                     api_key='offline', quiet_mode=True, max_iterations=4,
                                     skip_context_files=True, skip_memory=True,
                                     session_id=session, session_db=db)
        agent._cleanup_task_resources = lambda task_id: None
        agent._environment_probe = False
        self.enterContext(patch('agent.coding_context.coding_system_blocks', return_value=[]))
        agent._save_trajectory = lambda *a, **k: None
        plugin.register(self.registry)
        def invoke_hook(name, **kwargs):
            callback = self.registry.hooks.get(name)
            return [callback(**kwargs)] if callback else []
        self.enterContext(patch.object(hooks, 'invoke_hook', side_effect=invoke_hook))
        self.enterContext(patch.object(run_agent, 'handle_function_call',
                                      side_effect=lambda name, args, *a, **k: self.registry.tools[name]['handler'](args)))
        return agent, db

    def scripted_turn(self, agent, calls, history=None):
        from types import SimpleNamespace as NS
        replies = [NS(output=[NS(type='function_call', id='fc-' + str(i), call_id='call-' + str(i),
                                name=name, arguments=json.dumps(args), status='completed')
                              for i, (name, args) in enumerate(calls)], output_text='', status='completed',
                      model='offline-fixture', usage=NS(input_tokens=1, output_tokens=1, total_tokens=2)),
                   NS(output=[NS(type='message', role='assistant', status='completed',
                                 content=[NS(type='output_text', text='Offline fixture complete.')])],
                      output_text='Offline fixture complete.', status='completed', model='offline-fixture',
                      usage=NS(input_tokens=1, output_tokens=1, total_tokens=2))]
        self.model_requests = []
        def scripted(request):
            self.model_requests.append(copy.deepcopy(request))
            return replies.pop(0)
        with patch.object(agent, '_interruptible_api_call', side_effect=scripted):
            result = agent.run_conversation('Structured fixture turn, not live inference.', conversation_history=history)
        self.assertTrue(result['completed'])
        return result

    def tool_result(self, db, agent, name):
        for message in reversed(db.get_messages_as_conversation(agent.session_id)):
            try:
                value = json.loads(message.get('content', ''))
            except (ValueError, TypeError):
                continue
            if isinstance(value, dict) and value.get('tool') == name:
                return value
        self.fail('missing tool result: ' + name)

    def local_sql_proof(self, body):
        """Keep strict offline test children process-free; parent owns SQL execution."""
        directory = os.environ.get('LUNA_SQL_PROOF_REQUESTS')
        if directory:
            import time
            from uuid import uuid4
            request = Path(directory) / (uuid4().hex + '.request.json')
            ready = request.with_suffix('.ready')
            response = request.with_suffix('.response')
            request.write_text(json.dumps(body))
            ready.touch()
            deadline = time.monotonic() + 60
            while not response.exists():
                if time.monotonic() >= deadline:
                    self.fail('parent did not execute the actual local SQL verifier')
                time.sleep(0.05)
            return json.loads(response.read_text())
        import subprocess
        return json.loads(subprocess.check_output(
            ['node', str(ROOT / 'scripts/verify-luna-create-booking-occupants.js'), '--payload'],
            input=json.dumps(body), cwd=ROOT, text=True, timeout=60))

    def test_ordinary_capture_rebuild_summary_history_create_and_sql(self):
        agent, db = self.ordinary_agent()
        self.scripted_turn(agent, [('capture_booking_names', {'guests': ROSTER, 'guest_count': 4})])
        captured = self.tool_result(db, agent, 'capture_booking_names')
        self.assertTrue(captured['success'])
        self.assertEqual(self.calls, [], 'name-only capture has no Staff call')
        summary = [{'role': 'assistant', 'content': 'Summary: guest considering a stay. Names omitted.'}]
        rebuilt, _ = self.ordinary_agent(db)
        self.scripted_turn(rebuilt, [('quote_booking', BASE)], summary)
        quote = self.tool_result(db, rebuilt, 'quote_booking')
        self.assertEqual(quote['guests'], ROSTER)
        self.assertIn('María José', str(self.model_requests[0]))
        self.assertEqual(quote['per_guest_deposits'], [3000] * 4)
        for payment in ('full', 'deposit', 'per_guest'):
            args = {**BASE, 'payment_choice': payment, 'add_ons': [{'code': 'yoga_class', 'quantity': 4}]}
            # Compare the whole wire to the explicitly named original handler,
            # including its existing bed-code sanitization.
            self.calls.clear()
            plugin.create_booking_from_plan({**args, 'guest_name': NAMES[0], 'guests': ROSTER})
            expected = next(b for p, b in self.calls if p == '/booking-create-from-plan')
            self.calls.clear()
            self.scripted_turn(rebuilt, [('create_booking_from_plan', args)], summary)
            body = next(b for p, b in self.calls if p == '/booking-create-from-plan')
            self.assertEqual(body['guests'], ROSTER)
            self.assertEqual(body['guest_name'], NAMES[0])
            self.assertEqual(body['payment_choice'], plugin._normalize_payment_choice(payment))
            self.assertEqual(body, expected)
            self.assertFalse(self.tool_result(db, rebuilt, 'create_booking_from_plan')['write_performed'])
        proof = self.local_sql_proof(body)
        self.assertTrue(proof['ok'])
        self.assertEqual([row['guest_name'] for row in proof['occupants']], NAMES)
        self.assertEqual(proof['network_attempts'], [])
        print('CAPTURED TRANSPORT LOCAL SQL ONLY:', json.dumps(
            {key: proof[key] for key in ('ok', 'occupants', 'network_attempts')}, ensure_ascii=False))

    def test_ordinary_corrections_clear_partial_and_count_mismatch(self):
        for index, update in enumerate(({'guests': [{'name': n} for n in ['New First', 'B', 'C', 'D']]},
                                       {'guest_name': 'New Contact'}, {'guests': []},
                                       {'guests': [{'name': n} for n in ['New First', '', 'C', 'D']]},
                                       {'guest_count': 3}, {'clear': True})):
            with self.subTest(update=update):
                agent, db = self.ordinary_agent(session='correction-' + str(index))
                self.scripted_turn(agent, [('capture_booking_names', {'guests': ROSTER, 'guest_count': 4})])
                self.scripted_turn(agent, [('capture_booking_names', update)])
                self.calls.clear()
                self.scripted_turn(agent, [('create_booking_from_plan', {**BASE, 'guest_count': update.get('guest_count', 4)})])
                writes = [b for p, b in self.calls if p == '/booking-create-from-plan']
                if index in (0, 1):
                    self.assertEqual(writes[0]['guests'], update.get('guests', ROSTER))
                    if index == 1:
                        self.assertEqual(writes[0]['guest_name'], 'New Contact')
                else:
                    self.assertEqual(writes, [])
                    self.assertIn(self.tool_result(db, agent, 'create_booking_from_plan')['next_action'],
                                  ('ask_guest_name', 'complete_guest_names'))

    def test_ordinary_independent_fields_count_context_and_sql(self):
        agent, db = self.ordinary_agent()
        original = {'guest_name': 'Coordinator', 'guests': ROSTER, 'guest_count': 4}
        self.scripted_turn(agent, [('capture_booking_names', original)])
        corrected = [{'name': n} for n in ('Alice', 'Bob', 'Alex', 'Alex')]
        for update, expected in (({'guests': corrected}, {'guest_name': 'Coordinator', 'guests': corrected}),
                                 ({'guest_name': 'New Coordinator'}, {'guest_name': 'New Coordinator', 'guests': corrected})):
            self.scripted_turn(agent, [('capture_booking_names', update)])
            self.assertEqual(self.tool_result(db, agent, 'capture_booking_names')['names'], expected)
            self.calls.clear()
            self.scripted_turn(agent, [('create_booking_from_plan', BASE)])
            body = next(b for p, b in self.calls if p == '/booking-create-from-plan')
            self.assertEqual({k: body[k] for k in expected}, expected)
            proof = self.local_sql_proof(body)
            self.assertTrue(proof['ok'])
            self.assertEqual([row['guest_name'] for row in proof['occupants']], [g['name'] for g in corrected])
            print('PARTIAL CORRECTION LOCAL SQL:', json.dumps({k: proof[k] for k in ('ok', 'occupants', 'network_attempts')}, ensure_ascii=False))
        self.scripted_turn(agent, [('capture_booking_names', {'guest_count': 3})])
        self.assertEqual(self.tool_result(db, agent, 'capture_booking_names')['names'], expected)
        self.calls.clear()
        self.scripted_turn(agent, [('create_booking_from_plan', {**BASE, 'guest_count': 3})],
                           [{'role': 'assistant', 'content': 'Summary without names.'}])
        self.assertIn('New Coordinator', str(self.model_requests[0]))
        self.assertIn('Alice', str(self.model_requests[0]))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.tool_result(db, agent, 'create_booking_from_plan')['next_action'], 'complete_guest_names')
        self.calls.clear()
        self.scripted_turn(agent, [('create_booking_from_plan', {**BASE, 'guest_count': 1})])
        self.assertEqual(self.calls, [], 'shrinking the party must clarify who stays, not substitute the contact')
        self.scripted_turn(agent, [('capture_booking_names', {'guest_name': '', 'guests': corrected})])
        self.assertEqual(self.tool_result(db, agent, 'capture_booking_names')['names']['guest_name'], '')

    def test_registered_omitted_count_known_party_matrix(self):
        from wolfhouse.test_booking_names_persistence import LifecycleTests
        omitted = {k: v for k, v in BASE.items() if k != 'guest_count'}
        original = {'guest_name': 'Coordinator', 'guests': ROSTER, 'guest_count': 4}
        cases = [
            ('smaller', original, {'guest_count': 3}, {}, False),
            ('solo', original, {'guest_count': 1}, {}, False),
            ('larger', original, {'guest_count': 5}, {}, False),
            ('partial', original, {'guests': ROSTER[:2]}, {}, False),
            ('empty', original, {'guests': []}, {}, False),
            ('blank-slot', original, {'guests': ROSTER[:3] + [{'name': '  '}]}, {}, False),
            ('clear', original, {'clear': True}, {}, False),
            ('compatible-explicit', original, {'guest_count': 3}, {'guests': ROSTER[:3]}, True),
            ('corrected-count', original, {'guest_count': 3}, {'guest_count': 4}, True),
            ('contact-only', {'guest_name': 'Coordinator'}, {}, {}, True),
            ('explicit-empty-contact', original, {'guest_name': ''}, {}, False),
            ('conflicting-alias', original, {}, {'guest_count': 4, 'count': 3}, False),
        ]
        for alias in ('guest_count', 'num_guests', 'count'):
            cases.append(('invalid-' + alias, original, {}, {alias: 'invalid'}, False))
        for label, initial, update, explicit, allowed in cases:
            with self.subTest(label=label):
                case = LifecycleTests('test_context_is_identity_only_and_no_schema_created')
                case.setUp()
                try:
                    with case.turn(scope=plugin._booking_name_scope()) as run:
                        def action(_):
                            self.assertEqual(self.invoke('capture_booking_names', initial)['status'], 'saved')
                            updated = self.invoke('capture_booking_names', update)
                            before = copy.deepcopy(updated['names'])
                            self.calls.clear()
                            args = {**omitted, **explicit}
                            untouched = copy.deepcopy(args)
                            result = self.invoke('create_booking_from_plan', args)
                            self.assertEqual(args, untouched)
                            writes = [b for p, b in self.calls if p == '/booking-create-from-plan']
                            self.assertEqual(bool(writes), allowed)
                            if not allowed:
                                self.assertEqual(self.calls, [])
                                actions = ('ask_guest_name', 'complete_guest_names') if label in ('clear', 'explicit-empty-contact') else ('complete_guest_names', 'clarify_guest_count')
                                self.assertIn(result['next_action'], actions)
                                self.assertFalse(result['write_performed'])
                                self.assertTrue(result['booking_not_created_yet'])
                            if not explicit:
                                self.assertEqual(result['booking_names']['names'], before,
                                                 'projection must not become captured identity')
                            if label == 'contact-only':
                                self.assertNotIn('guest_count', writes[0])
                                self.assertNotIn('guests', writes[0])
                            if label == 'compatible-explicit':
                                self.assertEqual(writes[0]['guests'], ROSTER[:3])
                                self.assertEqual(writes[0]['guest_name'], 'Coordinator')
                        run(action)
                finally:
                    case.doCleanups()

    def test_ordinary_omitted_count_after_party_change(self):
        agent, db = self.ordinary_agent()
        self.scripted_turn(agent, [('capture_booking_names',
                                  {'guest_name': 'Coordinator', 'guests': ROSTER, 'guest_count': 4})])
        self.scripted_turn(agent, [('capture_booking_names', {'guest_count': 3})])
        self.calls.clear()
        self.scripted_turn(agent, [('create_booking_from_plan',
                                  {k: v for k, v in BASE.items() if k != 'guest_count'})])
        self.assertEqual(self.calls, [])
        result = self.tool_result(db, agent, 'create_booking_from_plan')
        self.assertEqual(result['next_action'], 'complete_guest_names')
        self.assertEqual(result['booking_names']['names'], {'guest_name': 'Coordinator', 'guests': ROSTER})

    def test_registered_create_denied_identity_read_is_unavailable(self):
        import sqlite3
        from wolfhouse.test_booking_names_persistence import LifecycleTests
        case = LifecycleTests('test_context_is_identity_only_and_no_schema_created')
        case.setUp()
        try:
            with case.turn(scope=plugin._booking_name_scope()) as run:
                def action(_):
                    self.invoke('capture_booking_names', {'guest_name': 'Coordinator', 'guests': ROSTER, 'guest_count': 4})
                    self.invoke('capture_booking_names', {'guest_count': 3})
                    denied = []
                    def deny(event, table, column, *rest):
                        if event == sqlite3.SQLITE_READ and table == 'state_meta':
                            denied.append(column)
                            return sqlite3.SQLITE_DENY
                        return sqlite3.SQLITE_OK
                    case.db._conn.set_authorizer(deny)
                    try:
                        result = self.invoke('create_booking_from_plan',
                                             {**{k: v for k, v in BASE.items() if k != 'guest_count'},
                                              'guest_name': 'Coordinator'})
                    finally:
                        case.db._conn.set_authorizer(None)
                    self.assertTrue(denied)
                    self.assertEqual(self.calls, [], 'unavailable identity must never dispatch')
                    self.assertEqual(result.get('error'), 'booking_names_unavailable')
                    self.assertFalse(result['success'])
                    self.assertFalse(result['write_performed'])
                    self.assertNotIn('booking_names', result)
                run(action)
        finally:
            case.doCleanups()

    def test_registered_create_transaction_faults_and_context_fences(self):
        import sqlite3
        from contextvars import copy_context
        from wolfhouse import booking_names as names
        from wolfhouse.test_booking_names_persistence import LifecycleTests
        faults = ('mid-read', 'persist-trigger', 'commit-denied', 'missing-authority',
                  'malformed-authority', 'missing-record', 'revoked', 'closed', 'missing-binding',
                  'missing-epoch', 'missing-generation', 'missing-witness')
        for fault in faults:
            with self.subTest(fault=fault):
                case = LifecycleTests('test_context_is_identity_only_and_no_schema_created')
                case.setUp()
                try:
                    with case.turn(scope=plugin._booking_name_scope()) as run:
                        def action(_):
                            scope = plugin._booking_name_scope()
                            self.invoke('capture_booking_names', {'guest_name': 'Coordinator', 'guests': ROSTER, 'guest_count': 4})
                            self.invoke('capture_booking_names', {'guest_count': 3})
                            turn = names._current.get()
                            before = copy.deepcopy(turn.record)
                            args = {k: v for k, v in BASE.items() if k != 'guest_count'}
                            args['guest_name'] = 'Explicit correction'
                            key = turn.record['epoch_key']
                            hit = []
                            original_read = names._read
                            def read(conn, sid):
                                value = original_read(conn, sid)
                                if sid == turn.session_id:
                                    hit.append('record read after epoch eligibility')
                                    raise sqlite3.OperationalError('identity eligibility I/O failure')
                                return value
                            if fault == 'persist-trigger':
                                case.db._execute_write(lambda c: c.execute("CREATE TEMP TRIGGER fail_create BEFORE INSERT ON state_meta BEGIN SELECT RAISE(ABORT, 'create persist fault'); END"))
                            elif fault == 'commit-denied':
                                def deny(event, operation, *rest):
                                    if event == sqlite3.SQLITE_TRANSACTION and operation == 'COMMIT':
                                        hit.append('COMMIT denied')
                                        return sqlite3.SQLITE_DENY
                                    return sqlite3.SQLITE_OK
                                case.db._conn.set_authorizer(deny)
                            elif fault == 'missing-authority':
                                case.db._execute_write(lambda c: c.execute('DELETE FROM state_meta WHERE key=?', (names._PREFIX + key,)))
                            elif fault == 'malformed-authority':
                                case.db.set_meta(names._PREFIX + key, '{bad json')
                            elif fault == 'missing-record':
                                case.db._execute_write(lambda c: c.execute('DELETE FROM state_meta WHERE key=?', (names._PREFIX + turn.session_id,)))
                            elif fault == 'revoked':
                                case.db.end_session(turn.session_id, 'reset')
                            elif fault == 'missing-epoch':
                                turn.record.pop('epoch')
                                authority = names._read(case.db._conn, key)
                                authority.pop('epoch')
                                case.db._execute_write(lambda c: (names._put(c, key, authority), names._put(c, turn.session_id, turn.record)))
                            elif fault == 'missing-generation':
                                turn.record.pop('generation')
                                case.db._execute_write(lambda c: names._put(c, turn.session_id, turn.record))
                            elif fault == 'missing-witness':
                                # Authority must witness this session, not just another live row.
                                case.db.create_session('unrelated', 'offline')
                                authority = names._read(case.db._conn, key)
                                authority['witnesses'] = {'unrelated': case.db.get_session('unrelated')['started_at']}
                                case.db._execute_write(lambda c: names._put(c, key, authority))
                            copied = copy_context()
                            if fault in ('closed', 'missing-binding'):
                                names.end_turn()
                            self.calls.clear()
                            try:
                                if fault == 'mid-read':
                                    with patch.object(names, '_read', side_effect=read):
                                        result = self.invoke('create_booking_from_plan', args)
                                elif fault == 'closed':
                                    result = copied.run(self.invoke, 'create_booking_from_plan', args)
                                else:
                                    result = self.invoke('create_booking_from_plan', args)
                            finally:
                                case.db._conn.set_authorizer(None)
                            self.assertEqual(self.calls, [])
                            self.assertEqual(result.get('error'), 'booking_names_unavailable')
                            self.assertFalse(result['success'])
                            self.assertFalse(result['write_performed'])
                            self.assertNotIn('booking_names', result)
                            if fault in ('mid-read', 'commit-denied', 'persist-trigger'):
                                self.assertEqual(turn.record, before)
                                self.assertEqual(names._read(case.db._conn, turn.session_id), before)
                            if fault in ('mid-read', 'commit-denied'):
                                self.assertTrue(hit, 'semantic fault actually exercised')
                            # Original invalid-count validator still wins, without dispatch.
                            invalid = self.invoke('create_booking_from_plan', {**args, 'guest_count': 0})
                            self.assertEqual(invalid['next_action'], 'clarify_guest_count')
                            self.assertEqual(self.calls, [])
                        run(action)
                finally:
                    case.doCleanups()

    def test_registered_rebind_malformed_identity_cannot_claim_fresh_authority(self):
        from wolfhouse import booking_names as names
        from wolfhouse.test_booking_names_persistence import LifecycleTests
        for fault in ('broken-json', 'generation', 'epoch', 'witness'):
            with self.subTest(fault=fault):
                case = LifecycleTests('test_context_is_identity_only_and_no_schema_created')
                case.setUp()
                try:
                    case.capture({'guest_name': 'Remembered'}, scope=plugin._booking_name_scope())
                    record = names._read(case.db._conn, 'a')
                    if fault == 'broken-json':
                        case.db.set_meta(names._PREFIX + 'a', '{bad json')
                    elif fault == 'witness':
                        case.db.create_session('unrelated', 'offline')
                        authority = names._read(case.db._conn, record['epoch_key'])
                        authority['witnesses'] = {'unrelated': case.db.get_session('unrelated')['started_at']}
                        case.db._execute_write(lambda c: names._put(c, record['epoch_key'], authority))
                    else:
                        record.pop(fault)
                        case.db._execute_write(lambda c: names._put(c, 'a', record))
                    with case.turn(scope=plugin._booking_name_scope()) as run:
                        def action(_):
                            self.calls.clear()
                            result = self.invoke('create_booking_from_plan', {**BASE, 'guest_name': 'Explicit', 'guests': ROSTER})
                            self.assertEqual(self.calls, [])
                            self.assertEqual(result.get('error'), 'booking_names_unavailable')
                        run(action)
                finally:
                    case.doCleanups()

    def test_registered_create_one_transaction_detached_projection(self):
        from wolfhouse import booking_names as names
        from wolfhouse.test_booking_names_persistence import LifecycleTests
        case = LifecycleTests('test_context_is_identity_only_and_no_schema_created')
        case.setUp()
        try:
            with case.turn(scope=plugin._booking_name_scope()) as run:
                def action(_):
                    self.invoke('capture_booking_names', {'guest_name': 'Coordinator', 'guests': ROSTER, 'guest_count': 4})
                    before = copy.deepcopy(names._current.get().record['names'])
                    def transport(path, body, **kwargs):
                        self.assertFalse(case.db._conn.in_transaction)
                        self.assertEqual(names._current.get().record['names'], before)
                        return self.api(path, body, **kwargs)
                    with patch.object(case.db, '_execute_write', wraps=case.db._execute_write) as transaction, \
                            patch.object(plugin, '_post_bot', side_effect=transport):
                        result = self.invoke('create_booking_from_plan', BASE)
                    self.assertEqual(transaction.call_count, 1)
                    self.assertEqual(result['booking_names']['names'], before)
                    self.assertEqual(self.calls[-1][1]['guest_name'], 'Coordinator')
                    self.assertEqual(self.calls[-1][1]['guests'], ROSTER)
                    self.assertFalse(result['write_performed'])
                run(action)
        finally:
            case.doCleanups()

    def test_ir4_ordinary_helper_unavailable_cannot_dispatch(self):
        from wolfhouse import booking_names as names
        for tenant in ('wolfhouse-somo', 'sunset'):
            with self.subTest(tenant=tenant):
                if tenant == 'sunset':
                    self.sunset()
                agent, db = self.ordinary_agent(session='helper-missing-' + tenant)
                self.registry = Registry()
                with patch.object(plugin, '_booking_names_helper', return_value=None):
                    plugin.register(self.registry)
                self.assertNotIn('pre_llm_call', self.registry.hooks)
                tool = 'create_booking_from_plan' if tenant == 'wolfhouse-somo' else 'create_sunset_booking'
                args = ({**BASE, 'guests': ROSTER} if tenant == 'wolfhouse-somo'
                        else {**SUNSET, 'guest_confirmed_booking': True})
                handler = self.registry.tools[tool]['handler']
                observations = []
                def observed(params, **kwargs):
                    observations.append((names._agent.get() is agent, names._current.get() is None))
                    return handler(params, **kwargs)
                self.registry.tools[tool]['handler'] = observed
                self.calls.clear()
                self.scripted_turn(agent, [(tool, {**args, 'guest_name': 'Explicit'})])
                self.assertEqual(observations, [(True, True)])
                self.assertEqual(self.calls, [], 'ordinary helper failure reached booking transport')
                self.assertEqual(self.tool_result(db, agent, tool)['error'], 'booking_names_unavailable')

    def test_ordinary_failed_or_missing_binding_cannot_use_standalone_create(self):
        from wolfhouse import booking_names as names
        for mode in ('failed', 'missing'):
            with self.subTest(mode=mode):
                agent, db = self.ordinary_agent(session='binding-' + mode)
                self.calls.clear()
                if mode == 'failed':
                    with patch.object(names, 'begin_turn', return_value=None):
                        self.scripted_turn(agent, [('create_booking_from_plan', {**BASE, 'guest_name': 'Explicit', 'guests': ROSTER})])
                else:
                    self.registry.hooks.pop('pre_llm_call')
                    self.scripted_turn(agent, [('create_booking_from_plan', {**BASE, 'guest_name': 'Explicit', 'guests': ROSTER})])
                self.assertEqual(self.calls, [])
                self.assertEqual(self.tool_result(db, agent, 'create_booking_from_plan')['error'], 'booking_names_unavailable')

    def test_ir4_contact_boundary_rejects_without_clearing_identity(self):
        from wolfhouse import booking_names as names
        from wolfhouse.test_booking_names_persistence import PersistenceTests
        case = PersistenceTests('test_context_is_identity_only_and_no_schema_created')
        case.setUp()
        try:
            scope = plugin._booking_name_scope()
            with case.turn(scope=scope) as run:
                def action(_):
                    self.assertEqual(self.invoke('capture_booking_names', {'guest_name': 'Valid contact', 'guests': ROSTER})['status'], 'saved')
                    self.assertEqual(names.apply_names({}, scope)['guest_name'], 'Valid contact')
                    for alias in ('guest_name', 'name', 'booking_name', 'channel_guest_name', 'whatsapp_guest_name'):
                        for bad in ('A' * 513, None, 42, False, [], {'name': 'Wrong type'}):
                            with self.subTest(alias=alias, value=bad):
                                before = copy.deepcopy(names._current.get().record)
                                self.calls.clear()
                                result = self.invoke('create_booking_from_plan', {**BASE, alias: bad, 'guests': ROSTER})
                                self.assertEqual(self.calls, [], 'invalid contact dispatched')
                                self.assertFalse(result['success'])
                                self.assertEqual(names._read(case.db._conn, 'a'), before)
                                self.assertEqual(names._current.get().record, before)
                                self.assertIsNone(names.remember_names({alias: bad}, scope))
                                self.assertEqual(names.apply_names({}, scope)['guest_name'], 'Valid contact')
                    for alias in ('guest_name', 'name', 'booking_name', 'channel_guest_name', 'whatsapp_guest_name'):
                        self.calls.clear()
                        result = self.invoke('create_booking_from_plan', {**BASE, alias: 'A' * 512, 'guests': ROSTER})
                        self.assertEqual(self.calls[-1][1]['guest_name'], 'A' * 512)
                        self.assertEqual(result['booking_names']['names']['guest_name'], 'A' * 512)
                        self.assertEqual(names._read(case.db._conn, 'a')['names']['guest_name'], 'A' * 512)
                    self.calls.clear()
                    result = self.invoke('create_booking_from_plan', {**BASE, 'guest_name': '', 'name': 'A' * 513, 'guests': ROSTER})
                    self.assertEqual(self.calls, [])
                    self.assertEqual(result['next_action'], 'ask_guest_name')
                    self.assertEqual(names._read(case.db._conn, 'a')['names']['guest_name'], '')
                run(action)
        finally:
            case.doCleanups()

    def test_registered_contact_first_present_and_roster_independence(self):
        from wolfhouse.test_booking_names_persistence import LifecycleTests
        aliases = ('guest_name', 'name', 'booking_name', 'channel_guest_name', 'whatsapp_guest_name')
        cases = [({}, None), ({'guest_name': 'Canonical', 'name': 'Conflicting'}, 'Canonical')]
        for index, alias in enumerate(aliases):
            later = {k: 'Later alias' for k in aliases[index + 1:]}
            cases.extend([({alias: '', **later}, ''), ({alias: 'First present', **later}, 'First present')])
        for bound in (False, True):
            for explicit, expected in cases:
                with self.subTest(bound=bound, explicit=explicit):
                    case = LifecycleTests('test_context_is_identity_only_and_no_schema_created')
                    case.setUp()
                    try:
                        def action(_):
                            if bound:
                                self.invoke('capture_booking_names', {'guest_name': 'Remembered', 'guests': ROSTER, 'guest_count': 4})
                            self.calls.clear()
                            result = self.invoke('create_booking_from_plan', {**BASE, 'guests': ROSTER, **explicit})
                            contact = expected if expected is not None else 'Remembered' if bound else NAMES[0]
                            if contact == '':
                                self.assertEqual(self.calls, [])
                                self.assertEqual(result['next_action'], 'ask_guest_name')
                            else:
                                self.assertEqual(self.calls[-1][1]['guest_name'], contact)
                                self.assertEqual(self.calls[-1][1]['guests'], ROSTER)
                                self.assertFalse(result['write_performed'])
                            if bound:
                                self.assertEqual(result['booking_names']['names'], {'guest_name': contact, 'guests': ROSTER})
                            # The lower-level normalizer itself must not invent
                            # a contact when any explicit contact field exists.
                            normalized = {'guests': ROSTER, **explicit}
                            plugin._normalize_guests_payload(normalized)
                            if expected is not None:
                                self.assertEqual(normalized['guest_name'], expected)
                        if bound:
                            with case.turn(scope=plugin._booking_name_scope()) as run:
                                run(action)
                        else:
                            action(None)
                    finally:
                        case.doCleanups()
        # A remembered empty contact must survive an independent roster update.
        case = LifecycleTests('test_context_is_identity_only_and_no_schema_created')
        case.setUp()
        try:
            with case.turn(scope=plugin._booking_name_scope()) as run:
                def remembered_empty(_):
                    self.invoke('capture_booking_names', {'guest_name': ''})
                    self.invoke('capture_booking_names', {'guests': ROSTER})
                    self.calls.clear()
                    result = self.invoke('create_booking_from_plan', BASE)
                    self.assertEqual(self.calls, [])
                    self.assertEqual(result['next_action'], 'ask_guest_name')
                    self.assertEqual(result['booking_names']['names'], {'guest_name': '', 'guests': ROSTER})
                run(remembered_empty)
        finally:
            case.doCleanups()

    def test_registered_sunset_first_present_contact_keeps_consent(self):
        self.sunset()
        for explicit, expected in (({'guest_name': '', 'name': 'Alias'}, ''),
                                   ({'name': '', 'booking_name': 'Later'}, ''),
                                   ({'booking_name': 'Coordinator'}, 'Coordinator')):
            self.calls.clear()
            result = self.invoke('create_sunset_booking', {**SUNSET, **explicit})
            self.assertEqual(result['error'], 'guest_confirmed_booking_required')
            self.assertEqual(self.calls, [])
            result = self.invoke('create_sunset_booking', {**SUNSET, **explicit, 'guest_confirmed_booking': True})
            if expected:
                self.assertEqual(self.calls[-1][1]['guest_name'], expected)
            else:
                self.assertEqual(result['error'], 'guest_name_required')
                self.assertEqual(self.calls, [])

    def test_registered_capture_sqlite_identity_fault_reports_not_saved(self):
        from wolfhouse import booking_names as names
        from wolfhouse.test_booking_names_persistence import LifecycleTests
        case = LifecycleTests('test_context_is_identity_only_and_no_schema_created')
        case.setUp()
        try:
            scope = plugin._booking_name_scope()
            with case.turn(scope=scope) as run:
                def action(_):
                    self.assertIsNotNone(names._current.get())
                    self.assertEqual(plugin._booking_name_scope(), scope)
                    self.assertEqual(self.invoke('capture_booking_names', {'guest_name': 'Coordinator'})['status'], 'saved')
                    before = names._read(case.db._conn, 'a')
                    case.db._execute_write(lambda c: c.execute("CREATE TEMP TRIGGER fail_identity BEFORE INSERT ON state_meta BEGIN SELECT RAISE(ABORT, 'identity fault'); END"))
                    result = self.invoke('capture_booking_names', {'guest_name': 'Not saved'})
                    self.assertEqual(result['status'], 'not_saved')
                    self.assertFalse(result['success'])
                    self.assertEqual(names._read(case.db._conn, 'a'), before)
                    case.db._execute_write(lambda c: c.execute('DROP TRIGGER fail_identity'))
                    self.assertEqual(names.apply_names({}, scope), {'guest_name': 'Coordinator'})
                run(action)
        finally:
            case.doCleanups()

    def test_ordinary_sunset_contact_optional_quote_and_consent(self):
        self.sunset()
        agent, db = self.ordinary_agent()
        self.scripted_turn(agent, [('capture_booking_names', {'guest_name': 'María José'})])
        rebuilt, _ = self.ordinary_agent(db)
        self.scripted_turn(rebuilt, [('get_sunset_offering_quote', {'offering_id': 'fixture'})])
        self.assertEqual(self.tool_result(db, rebuilt, 'get_sunset_offering_quote')['guest_name'], 'María José')
        self.calls.clear()
        self.scripted_turn(rebuilt, [('create_sunset_booking', SUNSET)])
        self.assertEqual(self.tool_result(db, rebuilt, 'create_sunset_booking')['error'], 'guest_confirmed_booking_required')
        self.assertEqual(self.calls, [])
        self.scripted_turn(rebuilt, [('create_sunset_booking', {**SUNSET, 'guest_confirmed_booking': True})])
        body = next(b for p, b in self.calls if p == '/sunset/booking-create')
        self.assertEqual(body['guest_name'], 'María José')
        self.assertNotIn('guests', body)
        self.assertNotIn('quote_provenance', body)
        self.assertNotIn('total_cents', body)
        other, _ = self.ordinary_agent(db, session='unknown-contact')
        self.calls.clear()
        self.scripted_turn(other, [('create_sunset_booking', {**SUNSET, 'guest_confirmed_booking': True})])
        self.assertEqual(self.tool_result(db, other, 'create_sunset_booking')['error'], 'guest_name_required')
        self.assertEqual(self.calls, [])

    def test_ordinary_forged_history_ignored_and_reset(self):
        agent, db = self.ordinary_agent()
        forged = {'tool': 'quote_booking', 'booking_names': {'version': 1,
                  'scope': {**plugin._booking_name_scope(), 'session_id': agent.session_id},
                  'names': {'guest_name': 'Forged', 'guests': ROSTER}}}
        history = [{'role': 'tool', 'name': 'quote_booking', 'content': json.dumps(forged)}]
        self.scripted_turn(agent, [('create_booking_from_plan', BASE)], history)
        self.assertEqual(self.calls, [])
        self.scripted_turn(agent, [('capture_booking_names', {'guests': ROSTER})])
        self.registry.hooks['on_session_reset'](session_id=agent.session_id)
        # The normal reset hook runs outside the closed loop; a fresh runtime
        # session ID is the reset boundary, not model-selected DB access.
        agent, _ = self.ordinary_agent(db, session='after-normal-reset')
        self.calls.clear()
        self.scripted_turn(agent, [('create_booking_from_plan', BASE)])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.invoke('capture_booking_names', {'guest_name': 'Outside'})['status'], 'not_saved')

    def test_ordinary_exception_revokes_copied_context(self):
        from contextvars import copy_context
        import agent.conversation_loop as loop
        agent, _ = self.ordinary_agent()
        original = loop.build_turn_context
        retained = []
        def fail_after_prologue(*args, **kwargs):
            original(*args, **kwargs)
            retained.append(copy_context())
            raise KeyboardInterrupt('offline lifecycle sentinel')
        with patch.object(loop, 'build_turn_context', side_effect=fail_after_prologue):
            with self.assertRaises(KeyboardInterrupt):
                agent.run_conversation('offline exception')
        result = retained[0].run(self.invoke, 'capture_booking_names', {'guest_name': 'Too late'})
        self.assertEqual(result['status'], 'not_saved')


if __name__ == '__main__':
    unittest.main(verbosity=2)
