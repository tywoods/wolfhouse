"""Offline routed-turn regression; model, Staff HTTP and delivery are fixture edges.

Real patched ingress, registered pre-LLM/tools, durable owner/finalizer and
ack-before-pause run here. Needs-human receipt is HTTP-mocked, NOT SQL/live proof.
The scripted model selects complaint intent; this cannot prove live model recall.
"""
import asyncio
import json
import os
import socket
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from hermes_state import SessionDB
from agent import conversation_loop
import wolfhouse_staff_api as plugin
from wolfhouse_staff_api import handoff_guest_note
from wolfhouse import accepted_quote as owner, explicit_human_handoff as handoff
from wolfhouse.offline_ingress_harness import gateway_ingress
from wolfhouse import test_no_final_ask as fixture
from wolfhouse.test_first_yes_owner import offline_saved_confirmation


class Registry:
    def __init__(self):
        self.tools, self.hooks = {}, {}

    def register_tool(self, **kw):
        self.tools[kw['name']] = kw

    def register_hook(self, name, fn):
        self.hooks.setdefault(name, []).append(fn)


class PaymentComplaintRoutedTests(unittest.TestCase):
    staff = fixture.NoFinalAskTests.staff

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = SessionDB(Path(self.temp.name) / 'state.db')
        self.addCleanup(self.db.close)
        self.db.create_session('complaint', source='whatsapp')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='complaint')
        self.case = deepcopy(fixture.FIXTURES['klein'])
        self.case['create_args']['language'] = 'en'
        self.calls, self.timeline, self.flags, self.sent, self.contexts = [], [], [], [], []
        self.registry = Registry()
        self.paused = False
        self.env = patch.dict(os.environ, {
            'HERMES_HOME': self.temp.name, 'LUNA_CLIENT_SLUG': 'wolfhouse-somo',
            'HERMES_ROLE': 'luna', 'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid',
            'LUNA_BOT_INTERNAL_TOKEN': 'offline',
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.addCleanup(owner.close_turn)
        self.original_loop = conversation_loop.run_conversation
        self.addCleanup(lambda: setattr(conversation_loop, 'run_conversation', self.original_loop))
        conversation_loop.run_conversation = self.model
        plugin.register(self.registry)
        for target in (
            patch.object(plugin, '_post_bot', side_effect=self.http),
            patch.object(plugin, '_contact_identity_read', return_value=(True, 'Marta Klein')),
            patch.object(owner, '_staff_sent_reply_context', return_value={
                'previous_sent_replies': [], 'location_already_sent': False}),
            patch.object(handoff_guest_note, 'default_fetch_staff_info',
                         return_value={'staff_member_name': 'Camila'}),
            patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden')),
        ):
            target.start()
            self.addCleanup(target.stop)
        self.writer = patch.object(owner, '_rewrite_saved_confirmation', return_value=None)
        self.rewrite = self.writer.start()
        self.addCleanup(self.writer.stop)

    def http(self, path, payload):
        if path == '/conversation/needs-human':
            self.calls.append((path, deepcopy(payload)))
            self.timeline.append('needs-human')
            self.assertEqual(payload['reason'], 'complaint: guest reports paid but got nothing')
            self.assertEqual(self.timeline, ['warm-note', 'needs-human'])
            self.paused = True
            return {'success': True, 'needs_human': True, 'conversation_paused': True,
                    'staff_handoff': {'id': 'OFFLINE-HTTP-HANDOFF'}}
        if path == '/house-info':
            return {'success': True}
        return self.staff(path, payload)

    def call(self, name, payload):
        return json.loads(self.registry.tools[name]['handler'](payload))

    def model(self, agent, raw, *a, **kw):
        for hook in self.registry.hooks.get('pre_llm_call', []):
            self.contexts.append(hook(session_id=agent.session_id, user_message=raw))
        messages = [{'role': 'user', 'content': raw}]
        if raw == 'Save the accepted booking':
            self.call('quote_booking', self.case['quote_args'])
            saved = self.call('create_booking_from_plan', self.case['create_args'])
            self.assertTrue(saved['success'], saved)
            messages.append({'role': 'tool', 'content': json.dumps(saved)})
            reply = 'Model confirmation author unavailable.'
        elif raw == 'I paid but got nothing':
            # Model decision is the substituted edge, never a production classifier.
            receipt = self.call('flag_needs_human', {
                'reason': 'complaint: guest reports paid but got nothing', 'language': 'en'})
            self.flags.append(receipt)
            messages.append({'role': 'tool', 'content': json.dumps(receipt)})
            reply = "I'm getting Camila to help you, they'll be with you shortly."
        else:
            reply = 'You can check payment status without opening another booking.'
        messages.append({'role': 'assistant', 'content': reply})
        return {'completed': True, 'final_response': reply, 'messages': messages}

    def turn(self, raw, message_id):
        test = self
        class Adapter:
            async def send(self, chat_id, content, **kw):
                test.assertFalse(test.paused, 'note must precede pause')
                test.sent.append(content)
                test.timeline.append('warm-note')
                return SimpleNamespace(success=True, message_id='offline-note', raw_response={})
        async def dispatch(_):
            return await gateway_ingress(self.agent, raw, message_id,
                lambda text: conversation_loop.run_conversation(self.agent, text), async_return=True)
        async def run():
            event = SimpleNamespace(source=SimpleNamespace(chat_id='+34900000001'), text=raw)
            return await handoff.dispatch_with_handoff_notice(event,
                SimpleNamespace(adapter=Adapter(), dispatch_fn=dispatch))
        return asyncio.run(run())

    def test_existing_booking_confirmation_debt_cannot_replace_complaint_handoff(self):
        saved = self.turn('Save the accepted booking', 'save')
        self.assertTrue(saved['confirmation_withheld'], saved)
        debt = self.durable_state()['confirmation_owed']
        before = deepcopy(self.calls)
        self.rewrite.reset_mock()
        # A healthy confirmation writer must not be invoked on this new intent.
        self.rewrite.side_effect = lambda agent, facts, draft: offline_saved_confirmation(facts, draft)
        result = self.turn('I paid but got nothing', 'complaint')
        self.assertTrue(self.flags[-1]['handoff_persisted'], self.flags)
        self.assertTrue(self.flags[-1]['needs_human'])
        self.assertTrue(self.flags[-1]['ack_sent'])
        self.assertEqual(self.flags[-1]['staff_review_id'], 'OFFLINE-HTTP-HANDOFF')
        self.assertEqual(self.timeline, ['warm-note', 'needs-human'])
        self.assertEqual(len(self.sent), 1)
        self.assertIn('Camila', self.sent[0])
        self.assertEqual(result['final_response'], self.sent[0])
        self.assertNotIn('/pay/', result['final_response'])
        self.assertNotIn('OFFLINE-NO-ASK', result['final_response'])
        self.rewrite.assert_not_called()
        self.assertEqual(self.calls[:-1], before, 'no second create or payment-link operation')
        self.assertEqual(self.durable_state()['confirmation_owed'], debt)

    def durable_state(self):
        rows = self.db._conn.execute('SELECT value FROM state_meta WHERE key LIKE ?',
                                     (owner._PREFIX + '%',)).fetchall()
        self.assertEqual(len(rows), 1)
        return json.loads(rows[0][0])

    def test_no_booking_complaint_uses_same_warm_note_and_receipt(self):
        result = self.turn('I paid but got nothing', 'complaint')
        self.assertTrue(self.flags[-1]['handoff_persisted'])
        self.assertTrue(self.flags[-1]['ack_sent'])
        self.assertEqual(self.timeline, ['warm-note', 'needs-human'])
        self.assertEqual(result['final_response'], self.sent[0])
        self.assertIn('Camila', self.sent[0])
        self.assertEqual([path for path, _ in self.calls], ['/conversation/needs-human'])
        self.rewrite.assert_not_called()

    def test_existing_booking_ordinary_payment_question_does_not_handoff_or_replay(self):
        self.rewrite.side_effect = lambda agent, facts, draft: offline_saved_confirmation(facts, draft)
        saved = self.turn('Save the accepted booking', 'save')
        self.assertIn('/pay/', saved['final_response'])
        before = deepcopy(self.calls)
        self.rewrite.reset_mock()
        result = self.turn('How do I check my payment status?', 'query')
        self.assertEqual(result['final_response'],
                         'You can check payment status without opening another booking.')
        self.assertEqual(self.calls, before)
        self.assertEqual(self.flags, [])
        self.assertEqual(self.sent, [])
        self.rewrite.assert_not_called()

    def test_no_booking_ordinary_payment_question_does_not_handoff(self):
        result = self.turn('How do payments work?', 'query')
        self.assertTrue(result['completed'])
        self.assertEqual(self.flags, [])
        self.assertEqual(self.sent, [])
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
