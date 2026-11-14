"""Offline installed-Hermes worker + real WhatsApp background delivery regression.

Compile the real worker's conversation/final-result tail from patched gateway
source in memory; only construction/runtime selection before that tail is omitted.
Use the installed AIAgent forwarder, quote owner, context-preserving executor,
BasePlatformAdapter background processing and production outbound guard. No
upstream file writes, network, provider calls or business DB.
"""
import ast
import asyncio
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import unittest

import apply_gateway_patches as patches
import gateway.run as runtime
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, SendResult
from gateway.platforms.whatsapp_cloud import WhatsAppCloudAdapter
from gateway.session import SessionSource
from run_agent import AIAgent
from agent import conversation_loop
from wolfhouse import accepted_quote, explicit_human_handoff as handoff, pause_gate
from wolfhouse import test_final_response_handoff as final_tests
from wolfhouse_staff_api import handoff_guest_note as notes


def installed_worker_tail(source):
    """Keep actual conversation try/finally and all result reduction statements."""
    tree = ast.parse(source)
    owner = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef)
                 and n.name == '_run_agent_inner')
    worker = next(n for n in owner.body if isinstance(n, ast.FunctionDef) and n.name == 'run_sync')
    start = next(i for i, n in enumerate(worker.body) if isinstance(n, ast.Try)
                 and any(isinstance(c, ast.Call) and isinstance(c.func, ast.Attribute)
                         and ast.unparse(c.func) == 'agent.run_conversation' for c in ast.walk(n)))
    worker.body = ast.parse('agent = agent_holder[0]').body + worker.body[start:]
    worker.decorator_list = []
    return compile(ast.fix_missing_locations(ast.Module(body=[worker], type_ignores=[])),
                   '<installed-patched-handoff-worker-tail>', 'exec')


class WorkerHandoffTests(unittest.IsolatedAsyncioTestCase):
    # Reuse offline transport setup, not the dispatch-return simulator tests.
    asyncTearDown = final_tests.FinalResponseHandoffTests.asyncTearDown

    @classmethod
    def setUpClass(cls):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'run.py'
            target.write_text(Path(runtime.__file__).read_text())
            patches.apply_patches(target)
            emitted = target.read_text()
            patches.apply_patches(target)
            if target.read_text() != emitted:
                raise AssertionError('boot patch must be idempotent')
        cls.code = installed_worker_tail(emitted)
        cls.emitted = emitted

    async def asyncSetUp(self):
        await final_tests.FinalResponseHandoffTests.asyncSetUp(self)
        self.enterContext(patch.dict('os.environ', {
            'WHATSAPP_DRY_RUN': 'false', 'LUNA_AUTO_SEND_ENABLED': 'true'}))
        self.enterContext(patch('socket.socket.connect', side_effect=AssertionError('network forbidden')))
        self.paused = False
        self.worker_results = []
        self.turns = []
        self.owner_results = []
        self.enterContext(patch.object(pause_gate, 'whatsapp_outbound_disposition',
            side_effect=lambda *a, **k: {'send_blocked': self.paused,
                'stage_as_draft': False, 'reason': 'paused' if self.paused else 'active',
                'whatsapp_channel_mode': 'auto'}))
        self.enterContext(patch.object(handoff, '_active_handoff_pause_matches', return_value=True))
        # Guard mirror transport too, if the image includes its absolute path.
        self.enterContext(patch('urllib.request.OpenerDirector.open',
                                side_effect=AssertionError('network forbidden')))
        test = self
        async def provider(adapter, chat_id, content, **kwargs):
            test.sent.append(content)
            test.order.append('note')
            return SendResult(success=test.delivery_ok,
                              message_id='offline-receipt' if test.delivery_ok else None)
        self.enterContext(patch.object(patches, '_orig_whatsapp_cloud_send', provider, create=True))
        # Avoid plugin hook installation affecting another test; use actual
        # installed class only for the duration of this test.
        self.enterContext(patch.object(WhatsAppCloudAdapter, '_process_message_background',
                                      BasePlatformAdapter._process_message_background))
        self.enterContext(patch.object(WhatsAppCloudAdapter, '_wolfhouse_ordinary_handoff', False, create=True))
        self.enterContext(patch.object(WhatsAppCloudAdapter, 'send', patches._patched_whatsapp_cloud_send))
        handoff.install_ordinary_handoff_patch()
        self.adapter = object.__new__(WhatsAppCloudAdapter)
        BasePlatformAdapter.__init__(self.adapter, PlatformConfig(), Platform.WHATSAPP_CLOUD)
        self.adapter._keep_typing = AsyncMock()
        self.adapter.stop_typing = AsyncMock()
        self.adapter._run_processing_hook = AsyncMock()
        self.adapter._should_auto_tts_for_chat = lambda _: False
        self.event = MessageEvent(source=SessionSource(platform=Platform.WHATSAPP_CLOUD,
            chat_id=self.phone, user_id=self.phone), text='deposit', message_id='offline-worker')

    def post(self, path, payload):
        result = final_tests.FinalResponseHandoffTests.post(self, path, payload)
        self.paused = bool(result['success'])
        return result

    async def run_worker(self, result, *, saved=None, preflag=False, owner_failure=False):
        agent = object.__new__(AIAgent)
        agent.session_id = 'offline-worker'
        agent._session_db = None
        agent._create_request_openai_client = lambda: (_ for _ in ()).throw(RuntimeError('offline'))
        runner = object.__new__(runtime.GatewayRunner)
        runner._session_db = None
        runner._consume_pending_native_image_paths = lambda _: []
        agent.run_conversation = AIAgent.run_conversation.__get__(agent)
        def model(*args, **kwargs):
            self.order.append('owner')
            if owner_failure:
                raise accepted_quote.QuoteBoundaryError('offline owner failure')
            if saved:
                handoff.note_successful_booking_create(saved)
            if preflag:
                import wolfhouse_staff_api as plugin
                plugin.flag_needs_human({'reason': 'human_requested'})
            return deepcopy(result)
        self.enterContext(patch.object(conversation_loop, 'run_conversation', model))
        accepted_quote.install_owner_hook()
        scope = dict(vars(runtime), agent=agent, self=runner, source=self.event.source,
            message=self.event.text, session_id=agent.session_id, session_key='offline-key',
            observed_group_context=None, agent_history=[], result_holder=[None],
            agent_holder=[agent], tools_holder=[[]], _stream_consumer=None,
            _persist_user_message_override=None, _persist_user_timestamp_override=None,
            _approval_session_key='offline-key', _approval_session_token=None,
            unregister_gateway_notify=lambda _: None, reset_current_session_key=lambda _: None,
            _history_media_paths=set())
        exec(self.code, scope)
        async def handle(event):
            self.turns.append(handoff._ORDINARY_TURN.get())
            output = await runner._run_in_executor_with_context(scope['run_sync'])
            self.worker_results.append(scope['result_holder'][0])
            return output['final_response']
        self.adapter._message_handler = handle
        actual = await self.adapter._process_message_background(self.event, 'offline-key')
        self.assertIsNone(actual, 'ordinary WA returns None, unlike simulator')
        return self.worker_results[-1]

    async def test_worker_repairs_note_before_reduction_and_adapter_send(self):
        note = notes.default_guest_note('en', 'Camila')
        result = await self.run_worker({'completed': True, 'final_response': notes.WARM_NOTES['en'],
                                       'messages': []})
        self.assertEqual(self.order, ['owner', 'note', 'flag'])
        self.assertEqual(self.sent, [note])
        self.assertIn('shortly', self.sent[0])
        self.assertEqual(result['final_response'], note)
        self.assertEqual(self.posts[0]['reason'], 'handoff_notice_without_persistence')
        self.assertTrue(self.turns[0].closed)


    async def test_worker_failed_note_flags_before_single_sixty_second_retry(self):
        self.delivery_ok = False
        release = asyncio.Event()
        delays = []
        async def clock(seconds):
            delays.append(seconds)
            await release.wait()
        with patch.object(handoff, '_retry_sleep', clock):
            await self.run_worker({'completed': True, 'final_response': notes.WARM_NOTES['en']})
            self.assertEqual(self.order, ['owner', 'note', 'flag'])
            await asyncio.sleep(0)
            self.assertEqual(delays, [60])
            self.assertTrue(self.turns[0].closed)
            self.delivery_ok = True
            release.set()
            await asyncio.gather(*tuple(handoff._RETRY_TASKS))
            self.assertEqual(self.order, ['owner', 'note', 'flag', 'note'])
            self.assertEqual(self.sent, [notes.default_guest_note('en', 'Camila')] * 2)
            self.assertEqual(len(self.posts), 1)
            self.assertEqual(delays, [60])

    async def test_worker_consumes_real_owner_failure_before_marker_is_lost(self):
        result = await self.run_worker({}, owner_failure=True)
        self.assertEqual(self.order, ['owner', 'note', 'flag'])
        self.assertTrue(result['handoff_required'])
        self.assertEqual(result['error'], 'owner_reply_unavailable')
        self.assertEqual(result['final_response'], notes.default_guest_note('en', 'Camila'))
        self.assertEqual(self.posts[0]['reason'], 'business_tool_error: owner_handoff_required')

    async def test_worker_preserves_saved_receipt_without_reflagging_suppressed_note(self):
        receipt = {'success': True, 'write_performed': True, 'booking_code': 'WH-SAVED'}
        original = {'completed': True, 'final_response': notes.WARM_NOTES['en'],
                    'booking_result': receipt, 'messages': []}
        result = await self.run_worker(original, saved=receipt)
        self.assertEqual(result['booking_result'], receipt)
        self.assertEqual(original['final_response'], notes.WARM_NOTES['en'])
        self.assertTrue(self.turns[0].booking_saved)
        self.assertEqual(self.turns[0].booking_reference, 'WH-SAVED')
        self.assertEqual(self.order, ['owner', 'note', 'flag'])
        self.assertEqual(len(self.posts), 1)


    async def test_worker_existing_flag_does_not_repeat_note_or_persistence(self):
        await self.run_worker({'completed': True,
                               'final_response': notes.default_guest_note('en', 'Camila')}, preflag=True)
        self.assertEqual(self.order, ['owner', 'note', 'flag'])
        self.assertEqual(self.posts[0]['reason'], 'human_requested')

    async def test_worker_leaves_saved_confirmation_and_payment_reply_unchanged(self):
        receipt = {'success': True, 'write_performed': True, 'booking_code': 'WH-SAVED'}
        original = {'completed': True,
                    'final_response': 'Booking WH-SAVED is saved. Your deposit is pending.',
                    'booking_result': receipt, 'messages': []}
        result = await self.run_worker(original, saved=receipt)
        self.assertEqual(result, original)
        self.assertEqual(self.sent, [original['final_response']])
        self.assertEqual(self.posts, [])
        self.assertTrue(self.turns[0].booking_saved)

    async def test_worker_saved_failed_note_does_not_reflag_or_retry_twice(self):
        self.delivery_ok = False
        delays = []
        release = asyncio.Event()
        async def clock(seconds):
            delays.append(seconds)
            await release.wait()
        receipt = {'success': True, 'write_performed': True, 'booking_code': 'WH-SAVED'}
        with patch.object(handoff, '_retry_sleep', clock):
            result = await self.run_worker({'completed': True, 'final_response': notes.WARM_NOTES['en'],
                                           'booking_result': receipt}, saved=receipt)
            self.assertEqual(self.order, ['owner', 'note', 'flag'])
            self.assertEqual(result['booking_result'], receipt)
            await asyncio.sleep(0)
            self.assertEqual(delays, [60])
            self.delivery_ok = True
            release.set()
            await asyncio.gather(*tuple(handoff._RETRY_TASKS))
            self.assertEqual(self.order, ['owner', 'note', 'flag', 'note'])
            self.assertEqual(delays, [60])

    def test_worker_patch_rejects_moved_changed_duplicate_and_marker_only_hooks(self):
        call = '            result = _wh_finalize_handoff(result)\n'
        marker = ('            from wolfhouse.explicit_human_handoff import '
                  'finalize_handoff_response as _wh_finalize_handoff\n')
        block = marker + call
        self.assertIn(block, self.emitted)
        mutants = {
            'changed_argument': self.emitted.replace(call, call.replace('(result)', '({})'), 1),
            'duplicate': self.emitted.replace(call, call + call, 1),
            'marker_only': self.emitted.replace(call, '', 1),
            'nested': self.emitted.replace(call, '            if False:\n    ' + call, 1),
            'after_reduction': self.emitted.replace(block, '', 1).replace(
                '            final_response = result.get("final_response")\n',
                '            final_response = result.get("final_response")\n' + block, 1),
            'wrong_owner': self.emitted.replace('async def _run_agent_inner(', 'async def unrelated('),
        }
        for name, text in mutants.items():
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                patches.apply_handoff_worker_source(text)


if __name__ == '__main__':
    unittest.main()
