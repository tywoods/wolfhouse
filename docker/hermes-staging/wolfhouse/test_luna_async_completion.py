"""Real pinned consumer and gateway-imported scheduler; no whole-ingress claim."""
import asyncio
import unittest
import json
import threading
import time
from unittest import mock
import gateway.run as gateway
from types import SimpleNamespace
from gateway.stream_consumer import GatewayStreamConsumer, StreamConsumerConfig
from wolfhouse import luna_personality_isolation as iso


class Boundary:
    MAX_MESSAGE_LENGTH = 4096

    async def send(self, *args, **kwargs):
        return SimpleNamespace(success=True, message_id='fixture', error=None, raw_response={})


class Completion(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.original_consumer = GatewayStreamConsumer.run
        self.original_scheduler = gateway.safe_schedule_threadsafe
        iso.install_isolation_runtime()
        self.guarded_consumer = GatewayStreamConsumer.run
        self.guarded_scheduler = gateway.safe_schedule_threadsafe
        iso.install_isolation_runtime()
        self.assertIs(GatewayStreamConsumer.run, self.guarded_consumer)
        self.assertIs(gateway.safe_schedule_threadsafe, self.guarded_scheduler)

    def tearDown(self):
        iso.reset_isolation_runtime_for_tests()
        self.assertIs(GatewayStreamConsumer.run, self.original_consumer)
        self.assertIs(gateway.safe_schedule_threadsafe, self.original_scheduler)

    def cap(self, label='OLD'):
        return iso.IsolatedTurnCapture(case_id=label, personality_id='balanced')

    def schedule(self, cap, coro, loop=None):
        token = iso.enter_isolated_turn(cap)
        try:
            return gateway.safe_schedule_threadsafe(coro, loop or asyncio.get_running_loop())
        finally:
            iso.exit_isolated_turn(token)

    async def test_missing_owner_cannot_certify_total_completion(self):
        for owner, attr, original, guarded in (
            (GatewayStreamConsumer, 'run', self.original_consumer, self.guarded_consumer),
            (gateway, 'safe_schedule_threadsafe', self.original_scheduler, self.guarded_scheduler),
        ):
            cap = self.cap()
            setattr(owner, attr, original)
            try:
                with self.assertRaisesRegex(iso.IsolationAbort, 'async_completion_unverified'):
                    await iso.settle_isolated_async_work(cap, 0)
                self.assertFalse(cap.async_work_settled)
            finally:
                setattr(owner, attr, guarded)
            self.assertIs(getattr(owner, attr), guarded)
            await iso.settle_isolated_async_work(cap, 0)
            self.assertTrue(cap.async_work_settled)

    async def test_queued_cancellation_never_enters_and_closes_input(self):
        cap = self.cap()
        entered = []

        async def callback():
            entered.append(True)

        coro = callback()
        future = self.schedule(cap, coro)
        self.assertEqual(cap._async_operations, 1)
        self.assertTrue(future.cancel())
        await iso.settle_isolated_async_work(cap, 0.1)
        self.assertTrue(cap.async_work_settled)
        for _ in range(4):
            await asyncio.sleep(0)
        self.assertEqual(entered, [])
        self.assertIsNone(coro.cr_frame)
        self.assertEqual(cap._async_operations, 0)

    async def test_running_cancel_retains_actual_completion_and_origin_first_cause(self):
        cap = self.cap()
        nxt = self.cap('NEXT')
        entered = asyncio.Event()
        cancelled = asyncio.Event()
        release = asyncio.Event()
        actual = []
        first = iso.IsolationAbort('provider_work_revoked')
        later = iso.IsolationAbort('provider_lifetime_revoked')
        iso.retain_worker_abort(first, cap)

        async def callback():
            actual.append(asyncio.current_task())
            self.assertIs(iso.current_isolated_turn(), cap)
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                await release.wait()
            raise later

        future = self.schedule(cap, callback())
        try:
            await asyncio.wait_for(entered.wait(), 2)
            self.assertTrue(future.cancel())
            await asyncio.wait_for(cancelled.wait(), 2)
            self.assertTrue(future.done())
            self.assertFalse(actual[0].done())
            self.assertEqual(cap._async_operations, 1)
            with self.assertRaisesRegex(iso.IsolationAbort, 'async_work_unsettled'):
                await iso.settle_isolated_async_work(cap, 0.01)
            self.assertIs(cap._worker_abort, first)
            token = iso.enter_isolated_turn(nxt)
            try:
                release.set()
                with self.assertRaises(iso.IsolationAbort) as caught:
                    await actual[0]
                self.assertIs(caught.exception, later)
                with self.assertRaises(iso.IsolationAbort) as settled:
                    await iso.settle_isolated_async_work(cap, 0.1)
                self.assertIs(settled.exception, first)
            finally:
                iso.exit_isolated_turn(token)
            self.assertTrue(cap.async_work_settled)
            self.assertIsNone(nxt._worker_abort)
        finally:
            release.set()
            await asyncio.gather(*actual, return_exceptions=True)

    async def test_submission_failure_missing_closed_loop_and_success_cold_warm(self):
        observed = []

        async def callback():
            observed.append(iso.current_isolated_turn())
            return 'done'

        for phase in ('cold', 'warm'):
            for failure in ('missing', 'closed', 'submit'):
                cap = self.cap(phase + failure)
                coro = callback()
                token = iso.enter_isolated_turn(cap)
                closed = asyncio.new_event_loop()
                closed.close()
                try:
                    if failure == 'submit':
                        with mock.patch.object(asyncio, 'run_coroutine_threadsafe', side_effect=RuntimeError('fixture submit')):
                            future = gateway.safe_schedule_threadsafe(coro, asyncio.get_running_loop())
                    else:
                        future = gateway.safe_schedule_threadsafe(coro, None if failure == 'missing' else closed)
                finally:
                    iso.exit_isolated_turn(token)
                self.assertIsNone(future)
                self.assertIsNone(coro.cr_frame)
                self.assertEqual(cap._async_operations, 0)
                await iso.settle_isolated_async_work(cap, 0)
                self.assertTrue(cap.async_work_settled)
            for cap in (None, self.cap(phase + 'NEXT')):
                future = self.schedule(cap, callback())
                self.assertEqual(await asyncio.wrap_future(future), 'done')
                self.assertIs(observed[-1], cap)

    async def test_canonical_consumer_typed_entry_exception_retains_origin(self):
        cap = self.cap()
        first = iso.IsolationAbort('provider_work_revoked')

        class BrokenCursor:
            def __len__(self):
                raise first

        config = StreamConsumerConfig(buffer_only=True, cursor=BrokenCursor())
        consumer = GatewayStreamConsumer(Boundary(), 'fixture', config)
        token = iso.enter_isolated_turn(cap)
        try:
            task = asyncio.create_task(consumer.run())
        finally:
            iso.exit_isolated_turn(token)
        with self.assertRaises(iso.IsolationAbort) as caught:
            await task
        self.assertIs(caught.exception, first)
        self.assertIs(cap._worker_abort, first)
        self.assertEqual(cap._async_operations, 0)
        with self.assertRaises(iso.IsolationAbort) as settled:
            await iso.settle_isolated_async_work(cap, 0)
        self.assertIs(settled.exception, first)
        self.assertTrue(cap.async_work_settled)

    async def test_scheduler_exception_closes_original_and_discharges(self):
        cap = self.cap()
        error = ValueError('fixture logger')
        coro = asyncio.sleep(0)
        token = iso.enter_isolated_turn(cap)
        try:
            with self.assertRaises(ValueError) as caught:
                gateway.safe_schedule_threadsafe(coro, None, logger=SimpleNamespace(log=mock.Mock(side_effect=error)))
        finally:
            iso.exit_isolated_turn(token)
        self.assertIs(caught.exception, error)
        self.assertIsNone(coro.cr_frame)
        self.assertEqual(cap._async_operations, 0)
        await iso.settle_isolated_async_work(cap, 0)
        self.assertTrue(cap.async_work_settled)

    async def test_cancelled_drain_does_not_discharge_running_callback(self):
        cap = self.cap()
        release = asyncio.Event()
        future = self.schedule(cap, release.wait())
        drain = asyncio.create_task(iso.settle_isolated_async_work(cap, 0.5))
        try:
            await asyncio.sleep(0)
            drain.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await drain
            self.assertFalse(cap.async_work_settled)
            self.assertGreater(cap._async_operations, 0)
        finally:
            release.set()
            await asyncio.wrap_future(future)
        await iso.settle_isolated_async_work(cap, 0)
        self.assertTrue(cap.async_work_settled)
        await iso.settle_isolated_async_work(None, 0)

    async def test_callback_exceptions_discharge_and_retain_only_typed_cause(self):
        for error in (ValueError('fixture'), iso.IsolationAbort('provider_work_revoked')):
            cap = self.cap()

            async def callback():
                raise error

            future = self.schedule(cap, callback())
            with self.assertRaises(type(error)) as caught:
                await asyncio.wrap_future(future)
            self.assertIs(caught.exception, error)
            self.assertEqual(cap._async_operations, 0)
            if isinstance(error, iso.IsolationAbort):
                with self.assertRaises(iso.IsolationAbort) as settled:
                    await iso.settle_isolated_async_work(cap, 0)
                self.assertIs(settled.exception, error)
            else:
                await iso.settle_isolated_async_work(cap, 0)
                self.assertIsNone(cap._worker_abort)
            self.assertTrue(cap.async_work_settled)

    async def test_shared_deadline_includes_provider_helper_and_async_work(self):
        cap = self.cap()
        release = threading.Event()
        entered = threading.Event()
        loop = asyncio.get_running_loop()
        callback_entered = asyncio.Event()
        callback_release = asyncio.Event()

        def worker():
            with iso._isolated_provider_operation(cap):
                entered.set()
                release.wait(2)

        async def callback():
            callback_entered.set()
            await callback_release.wait()

        token = iso.enter_isolated_turn(cap)
        try:
            thread = threading.Thread(target=worker)
            thread.start()
            future = gateway.safe_schedule_threadsafe(callback(), loop)
        finally:
            iso.exit_isolated_turn(token)
        try:
            await asyncio.wait_for(callback_entered.wait(), 2)
            self.assertTrue(entered.is_set())
            start = loop.time()
            heartbeat = []
            loop.call_later(0.005, heartbeat.append, True)
            with self.assertRaisesRegex(iso.IsolationAbort, 'async_work_unsettled'):
                await iso.settle_isolated_async_work(cap, 0.03)
            self.assertLess(loop.time() - start, 0.15)
            self.assertEqual(heartbeat, [True])
            self.assertFalse(cap.provider_work_settled)
            self.assertFalse(cap.async_work_settled)
            loop.call_later(0.005, release.set)
            loop.call_later(0.01, callback_release.set)
            await iso.settle_isolated_async_work(cap, 0.5)
            self.assertTrue(cap.provider_work_settled)
            self.assertTrue(cap.async_work_settled)
            self.assertFalse(thread.is_alive())
        finally:
            release.set()
            callback_release.set()
            await asyncio.wait_for(asyncio.wrap_future(future), 2)
            thread.join(2)
            self.assertFalse(thread.is_alive())

    async def test_effective_consumer_and_scheduler_omissions_are_assertion_killed(self):
        async def consumer_probe():
            cap = self.cap()
            consumer = GatewayStreamConsumer(Boundary(), 'fixture', StreamConsumerConfig(buffer_only=True, cursor=''))
            token = iso.enter_isolated_turn(cap)
            try:
                task = asyncio.create_task(consumer.run())
            finally:
                iso.exit_isolated_turn(token)
            try:
                await asyncio.sleep(0)
                self.assertGreater(cap._async_operations, 0, 'missing consumer custody')
            finally:
                consumer.finish()
                await asyncio.wait_for(task, 2)

        async def scheduler_probe():
            cap = self.cap()
            future = self.schedule(cap, asyncio.sleep(0))
            try:
                self.assertGreater(cap._async_operations, 0, 'missing scheduler custody')
            finally:
                await asyncio.wait_for(asyncio.wrap_future(future), 2)

        for owner, attr, original, guarded, probe in (
            (GatewayStreamConsumer, 'run', self.original_consumer, self.guarded_consumer, consumer_probe),
            (gateway, 'safe_schedule_threadsafe', self.original_scheduler, self.guarded_scheduler, scheduler_probe),
        ):
            await probe()
            setattr(owner, attr, original)
            try:
                with self.assertRaises(AssertionError):
                    await probe()
            finally:
                setattr(owner, attr, guarded)
            self.assertIs(getattr(owner, attr), guarded)
            await probe()
        print('ASYNC_OWNER_OMISSIONS_ASSERTION_KILLED_EXACT_RESTORATION', flush=True)

    async def test_asynchronous_drain_waits_without_blocking_loop(self):
        iso.install_isolation_runtime()
        cap = iso.IsolatedTurnCapture(case_id='drain', personality_id='balanced')
        consumer = GatewayStreamConsumer(Boundary(), 'fixture', StreamConsumerConfig(buffer_only=True, cursor=''))
        token = iso.enter_isolated_turn(cap)
        try:
            task = asyncio.create_task(consumer.run())
        finally:
            iso.exit_isolated_turn(token)
        await asyncio.sleep(0)
        try:
            drain = getattr(iso, 'settle_isolated_async_work', None)
            self.assertTrue(callable(drain), 'real asynchronous completion drain is missing')
            with self.assertRaisesRegex(iso.IsolationAbort, 'async_work_unsettled'):
                await drain(cap, timeout_s=0.01)
            self.assertTrue(cap.provider_work_settled)
            self.assertFalse(cap.async_work_settled)
            self.assertFalse(task.done())
            # Only this loop can release the consumer; a synchronous wait fails.
            asyncio.get_running_loop().call_later(0.01, consumer.finish)
            await drain(cap, timeout_s=0.5)
            self.assertTrue(cap.async_work_settled)
            self.assertTrue(task.done())
        finally:
            consumer.finish()
            await asyncio.wait_for(task, 2)
            iso.reset_isolation_runtime_for_tests()

    async def test_scheduled_admission_retains_until_callback_completion(self):
        import gateway.run as gateway
        iso.install_isolation_runtime()
        cap = iso.IsolatedTurnCapture(case_id='scheduled', personality_id='balanced')
        entered = asyncio.Event()
        release = asyncio.Event()

        async def callback():
            entered.set()
            await release.wait()

        token = iso.enter_isolated_turn(cap)
        try:
            future = gateway.safe_schedule_threadsafe(callback(), asyncio.get_running_loop())
        finally:
            iso.exit_isolated_turn(token)
        try:
            self.assertGreater(cap._async_operations, 0, 'queued canonical callback is not owned')
            await asyncio.wait_for(entered.wait(), 2)
            self.assertGreater(cap._async_operations, 0)
        finally:
            release.set()
            await asyncio.wait_for(asyncio.wrap_future(future), 2)
            self.assertEqual(cap._async_operations, 0)
            iso.reset_isolation_runtime_for_tests()

    async def test_direct_running_consumer_requires_async_completion(self):
        # Use the real production installer, not a test-only completion registry.
        iso.install_isolation_runtime()
        cap = iso.IsolatedTurnCapture(case_id='OLD', personality_id='balanced')
        consumer = GatewayStreamConsumer(Boundary(), 'fixture', StreamConsumerConfig(buffer_only=True, cursor=''))
        token = iso.enter_isolated_turn(cap)
        try:
            task = asyncio.create_task(consumer.run())
        finally:
            iso.exit_isolated_turn(token)
        try:
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            iso.settle_isolated_work(cap, timeout_s=0)
            self.assertTrue(cap.provider_work_settled, 'provider-only contract stays unchanged')
            # Compatibility observation reproduces the historical broader claim,
            # until a distinct real async owner is installed by production.
            self.assertFalse(getattr(cap, 'async_work_settled', cap.provider_work_settled),
                             'running canonical consumer has no total completion owner')
        finally:
            consumer.finish()
            await asyncio.wait_for(task, 2)
            iso.reset_isolation_runtime_for_tests()


class DeliveryBoundary:
    MAX_MESSAGE_LENGTH = 4096
    def __init__(self):
        self.effects = []
    async def send(self, chat_id, content, **kwargs):
        self.effects.append(('send', chat_id, content))
        return SimpleNamespace(success=True, message_id='fixture-message', error=None, raw_response={})
    async def edit_message(self, **kwargs):
        self.effects.append(('edit', kwargs['chat_id'], kwargs['content']))
        return SimpleNamespace(success=True, message_id='fixture-message', error=None, raw_response={})

class RetainedLifecycle(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        iso.install_isolation_runtime()
        self.adapter = DeliveryBoundary()
        self.original_send = self.adapter.send
        self.original_edit = self.adapter.edit_message
        assert iso._wrap_send_owner(self.adapter)
        self.guarded_send = self.adapter.send
        self.guarded_edit = self.adapter.edit_message
        self.tasks = []
    async def asyncTearDown(self):
        for task in self.tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        assert all(t.done() for t in self.tasks)
        iso.reset_isolation_runtime_for_tests()
        print('BOUNDED_TASK_CLEANUP', self._testMethodName, len(self.tasks), flush=True)
    def cap(self, name):
        return iso.IsolatedTurnCapture(case_id=name, personality_id='balanced', tenant_id='sunset')
    def consumer(self):
        return GatewayStreamConsumer(self.adapter, 'fixture', StreamConsumerConfig(buffer_only=True, cursor=''))
    async def consume(self, cap, text):
        token = iso.enter_isolated_turn(cap) if cap is not None else None
        try:
            consumer = self.consumer()
            consumer.on_delta(text)
            consumer.finish()
            task = asyncio.create_task(consumer.run())
            self.tasks.append(task)
        finally:
            if token is not None:
                iso.exit_isolated_turn(token)
        await asyncio.wait_for(task, 2)
        return consumer
    async def test_ordinary_next_and_adapter_omission_control(self):
        await self.consume(None, 'ordinary')
        self.assertEqual(self.adapter.effects, [('send', 'fixture', 'ordinary')])
        old = self.cap('OLD')
        await self.consume(old, 'isolated')
        self.assertGreater(old.sends_attempted, 0)
        self.assertEqual(len(self.adapter.effects), 1)
        nxt = self.cap('NEXT')
        await self.consume(nxt, 'next')
        self.assertGreater(nxt.sends_attempted, 0)
        self.assertIsNone(nxt._worker_abort)
        self.assertFalse(nxt._provider_revoked)
        self.assertEqual(len(self.adapter.effects), 1)
        self.adapter.send = self.original_send
        self.adapter.edit_message = self.original_edit
        try:
            before = len(self.adapter.effects)
            await self.consume(self.cap('MUTANT'), 'omitted-boundary')
            with self.assertRaises(AssertionError):
                self.assertEqual(len(self.adapter.effects), before, 'adapter omission must kill no-delivery assertion')
            self.assertEqual(self.adapter.effects[-1], ('send', 'fixture', 'omitted-boundary'))
        finally:
            self.adapter.send = self.guarded_send
            self.adapter.edit_message = self.guarded_edit
        self.assertIs(self.adapter.send, self.guarded_send)
        self.assertIs(self.adapter.edit_message, self.guarded_edit)
        before = len(self.adapter.effects)
        await self.consume(self.cap('RESTORED'), 'restored')
        self.assertEqual(len(self.adapter.effects), before)
        print('ADAPTER_OMISSION_ASSERTION_KILLED_AND_EXACT_IDENTITIES_RESTORED', flush=True)
    async def test_running_consumer_completion_requirement(self):
        old = self.cap('OLD-consumer')
        token = iso.enter_isolated_turn(old)
        try:
            consumer = self.consumer()
            consumer.on_delta('queued-old')
            task = asyncio.create_task(consumer.run())
            self.tasks.append(task)
        finally:
            iso.exit_isolated_turn(token)
        # A single scheduler turn enters the genuine run and reaches its await.
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        self.assertEqual(consumer._accumulated, 'queued-old')
        iso.settle_isolated_work(old, timeout_s=0.01)
        print('CONSUMER_SETTLEMENT', json.dumps({'task_done': task.done(), 'provider_work_settled': old.provider_work_settled, 'operations': old._provider_operations}), flush=True)
        try:
            self.assertTrue(old.provider_work_settled)
            self.assertGreater(old._async_operations, 0)
            with self.assertRaisesRegex(iso.IsolationAbort, 'async_work_unsettled'):
                await iso.settle_isolated_async_work(old, 0.01)
            self.assertFalse(old.async_work_settled)
        finally:
            consumer.finish()
            await asyncio.wait_for(task, 2)
            await iso.settle_isolated_async_work(old, 0.1)
            self.assertTrue(old.async_work_settled)
            self.assertEqual(self.adapter.effects, [])
    async def test_cancelled_consumer_and_late_delta(self):
        old = self.cap('OLD-cancel')
        token = iso.enter_isolated_turn(old)
        try:
            consumer = self.consumer()
            task = asyncio.create_task(consumer.run())
            self.tasks.append(task)
        finally:
            iso.exit_isolated_turn(token)
        await asyncio.sleep(0)
        task.cancel()
        # Genuine consumer consumes cancellation after best-effort finalization.
        await asyncio.wait_for(task, 2)
        self.assertIsNone(task.exception())
        consumer.on_delta('late-after-cancel')
        consumer.finish()
        self.assertTrue(task.done())
        self.assertEqual(self.adapter.effects, [])
        await self.consume(None, 'ordinary-after-cancel')
        await self.consume(self.cap('NEXT-after-cancel'), 'next-after-cancel')
        self.assertEqual(self.adapter.effects, [('send', 'fixture', 'ordinary-after-cancel')])
    async def test_canonical_scheduled_queued_completion_requirement(self):
        old = self.cap('OLD-scheduled')
        consumer = self.consumer()
        consumer.on_delta('scheduled-old')
        consumer.finish()
        token = iso.enter_isolated_turn(old)
        try:
            future = gateway.safe_schedule_threadsafe(consumer.run(), asyncio.get_running_loop())
        finally:
            iso.exit_isolated_turn(token)
        self.assertIsNotNone(future)
        iso.settle_isolated_work(old, timeout_s=0.01)
        print('SCHEDULED_SETTLEMENT', json.dumps({'future_done': future.done(), 'provider_work_settled': old.provider_work_settled}), flush=True)
        try:
            self.assertTrue(old.provider_work_settled)
            self.assertGreater(old._async_operations, 0)
            self.assertFalse(old.async_work_settled)
        finally:
            await asyncio.wait_for(asyncio.wrap_future(future), 2)
            await iso.settle_isolated_async_work(old, 0.1)
            self.assertTrue(old.async_work_settled)
            self.assertEqual(self.adapter.effects, [])
    async def test_scheduled_running_consumer_completion_requirement(self):
        old = self.cap('OLD-scheduled-running')
        consumer = self.consumer()
        consumer.on_delta('running-scheduled')
        loop = asyncio.get_running_loop()
        token = iso.enter_isolated_turn(old)
        try:
            future = gateway.safe_schedule_threadsafe(consumer.run(), loop)
        finally:
            iso.exit_isolated_turn(token)
        # First turn admits the real run_coroutine_threadsafe callback, second
        # enters the consumer. Assert real state rather than elapsed timing.
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        self.assertEqual(consumer._accumulated, 'running-scheduled')
        self.assertFalse(future.done())
        iso.settle_isolated_work(old, timeout_s=0.01)
        try:
            await self.consume(None, 'ordinary-while-old-running')
            nxt = self.cap('NEXT-while-old-running')
            await self.consume(nxt, 'NEXT-while-old-running')
            self.assertIsNone(nxt._worker_abort)
            self.assertFalse(nxt._provider_revoked)
            self.assertEqual(self.adapter.effects, [('send', 'fixture', 'ordinary-while-old-running')])
            self.assertTrue(old.provider_work_settled)
            self.assertGreater(old._async_operations, 0)
            with self.assertRaisesRegex(iso.IsolationAbort, 'async_work_unsettled'):
                await iso.settle_isolated_async_work(old, 0.01)
            self.assertFalse(old.async_work_settled)
        finally:
            consumer.finish()
            await asyncio.wait_for(asyncio.wrap_future(future), 2)
            self.assertTrue(future.done())
            await iso.settle_isolated_async_work(old, 0.1)
            self.assertTrue(old.async_work_settled)
            self.assertEqual(self.adapter.effects, [('send', 'fixture', 'ordinary-while-old-running')])
    async def test_scheduled_queued_cancellation(self):
        old = self.cap('OLD-queued-cancel')
        consumer = self.consumer()
        coro = consumer.run()
        token = iso.enter_isolated_turn(old)
        try:
            future = gateway.safe_schedule_threadsafe(coro, asyncio.get_running_loop())
        finally:
            iso.exit_isolated_turn(token)
        self.assertTrue(future.cancel())
        for _ in range(4):
            await asyncio.sleep(0)
        self.assertTrue(future.cancelled())
        self.assertIsNone(coro.cr_frame)
        consumer.on_delta('late-queued-cancel')
        consumer.finish()
        self.assertEqual(self.adapter.effects, [])
        await self.consume(None, 'ordinary-queued-cancel')
        await self.consume(self.cap('NEXT-queued-cancel'), 'next-queued-cancel')
        self.assertEqual(self.adapter.effects, [('send', 'fixture', 'ordinary-queued-cancel')])
    async def test_tool_thread_scheduler_late_first_cause_and_next(self):
        iso._wrap_thread_context_propagation()
        old = self.cap('OLD-thread')
        first = iso.IsolationAbort('provider_work_revoked')
        iso.retain_worker_abort(first, old)
        consumer = self.consumer()
        consumer.on_delta('tool-thread-old')
        consumer.finish()
        scheduled = []
        errors = []
        loop = asyncio.get_running_loop()
        def tool_thread():
            try:
                scheduled.append(gateway.safe_schedule_threadsafe(consumer.run(), loop))
            except BaseException as exc:
                errors.append(exc)
        token = iso.enter_isolated_turn(old)
        try:
            thread = threading.Thread(target=tool_thread)
            thread.start()
            thread.join(1)
        finally:
            iso.exit_isolated_turn(token)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(len(scheduled), 1)
        with self.assertRaises(iso.IsolationAbort) as caught:
            iso.settle_isolated_work(old, timeout_s=0.01)
        self.assertIs(caught.exception, first)
        nxt = self.cap('NEXT-thread')
        token = iso.enter_isolated_turn(nxt)
        try:
            await asyncio.wait_for(asyncio.wrap_future(scheduled[0]), 2)
            iso.retain_worker_abort(iso.IsolationAbort('provider_lifetime_revoked'), old)
        finally:
            iso.exit_isolated_turn(token)
        self.assertIs(old._worker_abort, first)
        self.assertIsNone(nxt._worker_abort)
        self.assertGreater(old.sends_attempted, 0)
        self.assertEqual(nxt.sends_attempted, 0)
        self.assertEqual(self.adapter.effects, [])
        await self.consume(None, 'ordinary-thread')
        await self.consume(nxt, 'NEXT-thread')
        self.assertEqual(self.adapter.effects, [('send', 'fixture', 'ordinary-thread')])

if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(Completion)
    suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(RetainedLifecycle))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    print('GATE_EXIT', 0 if result.wasSuccessful() else 1, flush=True)
    raise SystemExit(0 if result.wasSuccessful() else 1)
