"""Real local runtime flush method, ephemeral SQLite; no provider/model calls."""
import ast
from pathlib import Path
from types import MethodType
import logging
import unittest
from unittest.mock import patch
from wolfhouse import test_question_binding
from wolfhouse import accepted_quote as owner


class RuntimeQuestionTests(unittest.TestCase):
    setUp = test_question_binding.OwnerAtomicTests.setUp

    def configure_flush(self):
        agent = self.case.agent
        source = Path('/opt/hermes/run_agent.py').read_text()
        tree = ast.parse(source)
        method = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)
                      and n.name == '_flush_messages_to_session_db')
        method.returns = None
        for arg in method.args.args:
            arg.annotation = None
        ns = {'logger': logging.getLogger(__name__), '_is_multimodal_tool_result': lambda c: False}
        exec(compile(ast.Module(body=[method], type_ignores=[]), '<local-runtime-flush>', 'exec'), ns)
        agent._flush_messages_to_session_db = MethodType(ns[method.name], agent)
        agent._apply_persist_user_message_override = lambda messages: None
        agent._session_db_created = True
        agent._last_flushed_db_idx = 0
        return agent

    def test_multimodal_prefix_matches_normal_runtime_without_mutating_live_content(self):
        from copy import deepcopy
        from agent.tool_dispatch_helpers import _is_multimodal_tool_result, _multimodal_text_summary
        from wolfhouse.question_runtime import final_outbound
        agent = self.configure_flush()
        agent._flush_messages_to_session_db.__func__.__globals__.update(
            _is_multimodal_tool_result=_is_multimodal_tool_result,
            _multimodal_text_summary=_multimodal_text_summary)
        prefix = [{'role': 'user', 'content': [{'type': 'text', 'text': 'look'},
                    {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,SECRET'}}]},
                  {'role': 'tool', 'content': {'_multimodal': True, 'text_summary': 'tool summary',
                    'content': [{'type': 'image', 'data': 'SECRET'}]}}]
        agent._flush_messages_to_session_db(deepcopy(prefix))
        expected = [r[0] for r in self.case.db._conn.execute('SELECT content FROM messages ORDER BY id')]
        owner._transaction(lambda s, _: owner.pending_question.persist(s, 'add_on', ['accepted', 'declined']))
        messages = deepcopy(prefix) + [{'role': 'assistant', 'content': 'Shuttle?'}]
        with final_outbound(agent) as outbound:
            outbound.commit({'messages': messages, 'final_response': 'Shuttle?'})
        actual = [r[0] for r in self.case.db._conn.execute('SELECT content FROM messages ORDER BY id')]
        self.assertEqual(actual[2:4], expected)
        self.assertEqual(messages[:2], prefix)
        self.assertNotIn('SECRET', ''.join(actual))

    def test_prefix_failure_is_atomic(self):
        import sqlite3
        from wolfhouse.question_runtime import final_outbound
        agent = self.configure_flush()
        conn = self.case.db._conn
        owner._transaction(lambda s, _: owner.pending_question.persist(s, 'add_on', ['accepted', 'declined']))
        conn.execute("CREATE TRIGGER reject_prefix BEFORE INSERT ON messages WHEN NEW.role='tool' BEGIN SELECT RAISE(ABORT, 'prefix rejected'); END")
        result = {'messages': [{'role': 'user', 'content': 'hi'},
                               {'role': 'tool', 'content': 'result'},
                               {'role': 'assistant', 'content': 'Shuttle?'}],
                  'final_response': 'Shuttle?'}
        with self.assertRaises(sqlite3.IntegrityError):
            with final_outbound(agent) as outbound:
                outbound.commit(result)
        self.assertEqual(conn.execute('SELECT count(*) FROM messages').fetchone()[0], 0)
        self.assertEqual(conn.execute('SELECT message_count FROM sessions').fetchone()[0], 0)
        self.assertEqual(agent._last_flushed_db_idx, 0)
        self.assertEqual(owner._read_owner_state(lambda s, _: s.get('pending_question')),
                         {'kind': 'add_on', 'options': ['accepted', 'declined']})

    def test_copied_history_is_not_written_again(self):
        from copy import deepcopy
        from wolfhouse.question_runtime import final_outbound
        agent = self.configure_flush()
        history = [{'role': 'user', 'content': 'earlier'},
                   {'role': 'assistant', 'content': 'Earlier answer'}]
        agent._flush_messages_to_session_db(history)
        owner._transaction(lambda s, _: owner.pending_question.persist(s, 'add_on', ['accepted', 'declined']))
        with final_outbound(agent, history) as outbound:
            result = deepcopy({'messages': history + [{'role': 'user', 'content': 'next'},
                {'role': 'assistant', 'content': 'Shuttle?'}], 'final_response': 'Shuttle?'})
            outbound.commit(result)
        agent._flush_messages_to_session_db(result['messages'], history)
        self.assertEqual([r[0] for r in self.case.db._conn.execute('SELECT content FROM messages ORDER BY id')],
                         ['earlier', 'Earlier answer', 'next', 'Shuttle?'])

    def test_assistant_metadata_and_tool_accounting_roundtrip(self):
        import json
        from wolfhouse.question_runtime import final_outbound
        agent = self.configure_flush()
        owner._transaction(lambda s, _: owner.pending_question.persist(s, 'add_on', ['accepted', 'declined']))
        final = {'role': 'assistant', 'content': 'Shuttle?', 'timestamp': 12345.25,
                 'finish_reason': 'stop', 'reasoning': 'reason', 'reasoning_content': 'details',
                 'reasoning_details': [{'type': 'text', 'text': 'why'}],
                 'codex_reasoning_items': [{'type': 'reasoning', 'id': 'r'}],
                 'codex_message_items': [{'type': 'message', 'id': 'm'}]}
        messages = [{'role': 'assistant', 'content': None, 'timestamp': 12340,
                     'tool_calls': [{'id': 'call1', 'type': 'function',
                                     'function': {'name': 'lookup', 'arguments': '{}'}}]},
                    {'role': 'tool', 'content': 'found', 'tool_call_id': 'call1', 'timestamp': 12341}, final]
        with final_outbound(agent) as outbound:
            outbound.commit({'messages': messages, 'final_response': 'Shuttle?'})
        row = self.case.db._conn.execute('SELECT * FROM messages WHERE id=?', (final['id'],)).fetchone()
        for field in ('timestamp', 'finish_reason', 'reasoning', 'reasoning_content'):
            self.assertEqual(row[field], final[field])
        for field in ('reasoning_details', 'codex_reasoning_items', 'codex_message_items'):
            self.assertEqual(json.loads(row[field]), final[field])
        counts = self.case.db._conn.execute('SELECT message_count,tool_call_count FROM sessions').fetchone()
        self.assertEqual(tuple(counts), (3, 1))
        self.assertEqual([r[0] for r in self.case.db._conn.execute('SELECT timestamp FROM messages ORDER BY id')],
                         [12340, 12341, 12345.25])

    def test_automatic_recovery_persists_post_save_payment_question(self):
        import hashlib
        import importlib
        import json
        import agent as agent_package
        from wolfhouse.offline_ingress_harness import gateway_ingress
        from wolfhouse.test_first_yes_owner import offline_saved_confirmation
        loop = importlib.import_module('agent.conversation_loop')
        agent = self.configure_flush()
        receipt = {'success': True, 'write_performed': True, 'booking_id': 74750,
                   'booking_code': 'RECOVERY-74750', 'ask_payment_amount': True,
                   'payment_choice_needed': True}
        observe = owner.observe_owner_turn
        def seed_recovery(agent, raw):
            # Seed the authenticated recovery branch condition, not its writer,
            # finalizer, SessionDB or ledger. No claim of token admission coverage.
            observe(agent, raw)
            owner._transaction(lambda s, ingress: s.update(
                status='accepted', quote=self.case.response,
                checked_offer=self.case.response['offer_revision'],
                plan={**self.case.plan, 'ask_payment_amount': True},
                completion_plan={**self.case.plan, 'ask_payment_amount': True},
                auto_acceptance=True, acceptance_message=ingress['MESSAGE_ID'],
                acceptance_raw_digest=hashlib.sha256(raw.encode()).hexdigest()))
        with patch.object(agent_package, 'conversation_loop', loop), \
             patch.object(loop, 'run_conversation', side_effect=AssertionError('model called')), \
             patch.object(owner, 'observe_owner_turn', side_effect=seed_recovery), \
             patch.object(owner, '_registered_create', return_value=json.dumps(receipt)) as create, \
             patch.object(owner, '_before_create', None), \
             patch.object(owner, '_rewrite_saved_confirmation', side_effect=lambda a, f, d: offline_saved_confirmation(f, d)):
            owner.install_owner_hook()
            result = gateway_ingress(agent, 'yes', 'runtime-recovery', lambda raw: loop.run_conversation(agent, raw))
        create.assert_called_once_with({})
        self.assertTrue(result['completed'], result)
        self.assertEqual(result['api_calls'], 0)
        rows = self.case.db._conn.execute('SELECT id,role,content FROM messages ORDER BY id').fetchall()
        self.assertEqual([r['role'] for r in rows], ['user', 'assistant'])
        self.assertEqual(rows[-1]['content'], result['final_response'])
        states = [json.loads(r[0]) for r in self.case.db._conn.execute("SELECT value FROM state_meta WHERE key LIKE 'wolfhouse%'")]
        question = next(s['pending_question'] for s in states if s.get('pending_question', {}).get('question_id'))
        self.assertEqual(question['kind'], 'payment_choice')
        self.assertEqual(question['options'], ['deposit', 'full'])
        self.assertEqual(question['asked_message_id'], rows[-1]['id'])

    def test_recovery_branch_uses_atomic_outbound(self):
        import inspect
        # Guard the early automatic recovery return, which bypasses normal loop.
        source = inspect.getsource(owner.install_owner_hook)
        recovery = source.split('recovery_result =', 1)[1].split('if exact_retry is not None:', 1)[0]
        self.assertIn('outbound.commit', recovery)

    def test_installed_owner_runs_atomic_final_outbound(self):
        import importlib
        loop = importlib.import_module('agent.conversation_loop')
        import agent as agent_package
        from wolfhouse.offline_ingress_harness import gateway_ingress
        agent = self.configure_flush()
        observed = []
        history = [{'role': 'user', 'content': 'previous turn'},
                   {'role': 'assistant', 'content': 'previous response'}]
        agent._flush_messages_to_session_db(history)
        def model(agent, raw, *args, **kwargs):
            observed.append(owner._read_owner_state(lambda s, _: s.get('pending_question')))
            owner.record_quote(self.case.plan, self.case.response)
            text = owner._styled_quote_copy(self.case.plan, self.case.response['offer_revision'], create_ready=True)
            result = {'completed': True, 'final_response': text,
                      'messages': [*history, {'role': 'user', 'content': raw}, {'role': 'assistant', 'content': text}]}
            agent._flush_messages_to_session_db(result['messages'])
            return result
        with patch.object(agent_package, 'conversation_loop', loop), patch.object(loop, 'run_conversation', model):
            owner.install_owner_hook()
            result = gateway_ingress(agent, 'Please quote this', 'runtime-quote',
                lambda raw: loop.run_conversation(agent, raw, conversation_history=history))
        all_rows = self.case.db._conn.execute('SELECT role,content FROM messages ORDER BY id').fetchall()
        self.assertEqual([tuple(r) for r in all_rows[:2]],
                         [('user', 'previous turn'), ('assistant', 'previous response')])
        self.assertEqual(len(all_rows), 4)
        rows = self.case.db._conn.execute("SELECT id, content FROM messages WHERE role='assistant' AND content != 'previous response'").fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][1], result['final_response'])
        import json
        states = [json.loads(r[0]) for r in self.case.db._conn.execute(
            "SELECT value FROM state_meta WHERE key LIKE 'wolfhouse%'")]
        questions = [s['pending_question'] for s in states if s.get('pending_question', {}).get('question_id')]
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]['asked_message_id'], rows[0][0])
        self.assertEqual(questions[0]['kind'], 'go_ahead')

    def test_finalized_question_is_atomic_and_not_duplicated_by_runtime_flush(self):
        from wolfhouse.question_runtime import final_outbound
        agent = self.configure_flush()
        draft = [{'role': 'assistant', 'content': 'Unfinalized draft'}]
        with final_outbound(agent) as outbound:
            agent._flush_messages_to_session_db(draft)
            self.assertEqual(self.case.db._conn.execute('SELECT count(*) FROM messages').fetchone()[0], 0)
            owner._transaction(lambda s, _: owner.pending_question.persist(s, 'add_on', ['accepted', 'declined']))
            result = {'messages': [{'role': 'assistant', 'content': 'Shuttle?'}], 'final_response': 'Shuttle?'}
            outbound.commit(result)
        agent._flush_messages_to_session_db(result['messages'])
        rows = self.case.db._conn.execute('SELECT id, content FROM messages').fetchall()
        self.assertEqual([row[1] for row in rows], ['Shuttle?'])
        state = owner._read_owner_state(lambda s, _: s.copy())
        self.assertEqual(state['pending_question']['asked_message_id'], rows[0][0])
        self.case.turn('answer-runtime', 'sí')
        self.assertEqual(owner._read_owner_state(lambda s, _: s['plan']['shuttle_choice']), 'accepted')
