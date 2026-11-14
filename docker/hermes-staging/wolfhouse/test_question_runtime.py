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
        def model(agent, raw, *args, **kwargs):
            observed.append(owner._read_owner_state(lambda s, _: s.get('pending_question')))
            owner.record_quote(self.case.plan, self.case.response)
            text = owner._styled_quote_copy(self.case.plan, self.case.response['offer_revision'], create_ready=True)
            result = {'completed': True, 'final_response': text,
                      'messages': [{'role': 'user', 'content': raw}, {'role': 'assistant', 'content': text}]}
            agent._flush_messages_to_session_db(result['messages'])
            return result
        with patch.object(agent_package, 'conversation_loop', loop), patch.object(loop, 'run_conversation', model):
            owner.install_owner_hook()
            result = gateway_ingress(agent, 'Please quote this', 'runtime-quote',
                lambda raw: loop.run_conversation(agent, raw))
        rows = self.case.db._conn.execute("SELECT id, content FROM messages WHERE role='assistant'").fetchall()
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
