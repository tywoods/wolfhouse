"""Offline work-item lifetime controls; canonical gateway coverage is separate."""
import asyncio
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from wolfhouse import luna_personality_isolation as iso


class ExecutorSettlementTests(unittest.TestCase):
    def setUp(self):
        self.submit = ThreadPoolExecutor.submit
        self.start = threading.Thread.start
        self.executor_orig = iso._EXECUTOR_ORIG
        self.thread_orig = iso._THREAD_START_ORIG
        self.flags = iso._executor_ctx_wrapped, iso._thread_ctx_wrapped
        iso._wrap_executor_context_propagation()
        iso._wrap_thread_context_propagation()
        self.cap = iso.IsolatedTurnCapture('OLD', 'balanced')

    def tearDown(self):
        ThreadPoolExecutor.submit = self.submit
        threading.Thread.start = self.start
        iso._EXECUTOR_ORIG = self.executor_orig
        iso._THREAD_START_ORIG = self.thread_orig
        iso._executor_ctx_wrapped, iso._thread_ctx_wrapped = self.flags

    def submit_as(self, pool, cap, fn):
        token = iso.enter_isolated_turn(cap)
        try:
            return pool.submit(fn)
        finally:
            iso.exit_isolated_turn(token)

    def blocked(self, cap):
        with self.assertRaises(iso.IsolationAbort) as caught:
            iso.settle_isolated_work(cap, 0)
        self.assertEqual(caught.exception.reason, 'provider_work_unsettled')
        self.assertFalse(cap.provider_work_settled)

    def test_submit_failure_discharges(self):
        pool = ThreadPoolExecutor(1)
        pool.shutdown()
        with self.assertRaises(RuntimeError):
            self.submit_as(pool, self.cap, lambda: None)
        iso.settle_isolated_work(self.cap, 0)
        self.assertEqual(self.cap._provider_operations, 0)

    def test_cold_start_failure_discharges(self):
        with ThreadPoolExecutor(1) as pool:
            with patch.object(threading.Thread, 'start', side_effect=RuntimeError('start failed')):
                with self.assertRaises(RuntimeError):
                    self.submit_as(pool, self.cap, lambda: None)
            iso.settle_isolated_work(self.cap, 0)
            self.assertEqual(self.cap._provider_operations, 0)

    def test_failed_start_does_not_run_abandoned_queued_callable(self):
        called = []
        with ThreadPoolExecutor(1) as pool:
            with patch.object(threading.Thread, 'start', side_effect=RuntimeError('start failed')):
                with self.assertRaises(RuntimeError):
                    self.submit_as(pool, self.cap, lambda: called.append(True))
            iso.settle_isolated_work(self.cap, 0)
            pool.submit(lambda: None).result(5)
            self.assertEqual(called, [])

    def test_queued_cancel_discharges_without_calling(self):
        release = threading.Event()
        entered = threading.Event()
        called = []
        def hold():
            entered.set()
            self.assertTrue(release.wait(5))
        with ThreadPoolExecutor(1) as pool:
            ordinary = pool.submit(hold)
            try:
                self.assertTrue(entered.wait(5))
                queued = self.submit_as(pool, self.cap, lambda: called.append(True))
                self.blocked(self.cap)
                self.assertTrue(queued.cancel())
                iso.settle_isolated_work(self.cap, 0)
                self.assertEqual(called, [])
            finally:
                release.set()
                ordinary.result(5)

    def test_running_async_cancel_cold_warm_shared_unrelated(self):
        async def exercise():
            loop = asyncio.get_running_loop()
            with ThreadPoolExecutor(2) as pool:
                for warm in (False, True):
                    cap = iso.IsolatedTurnCapture(str(warm), 'balanced')
                    nxt = iso.IsolatedTurnCapture('NEXT', 'balanced')
                    release = threading.Event()
                    entered = threading.Event()
                    returned = threading.Event()
                    def hold():
                        self.assertIs(iso.current_isolated_turn(), cap)
                        entered.set()
                        try:
                            self.assertTrue(release.wait(5))
                        finally:
                            returned.set()
                    token = iso.enter_isolated_turn(cap)
                    try:
                        future = loop.run_in_executor(pool, hold)
                    finally:
                        iso.exit_isolated_turn(token)
                    try:
                        self.assertTrue(entered.wait(5))
                        future.cancel()
                        with self.assertRaises(asyncio.CancelledError):
                            await future
                        self.blocked(cap)
                        self.assertFalse(returned.is_set())
                        self.assertEqual(cap.in_flight_threads, [])
                        self.assertIsNone(pool.submit(iso.current_isolated_turn).result(5))
                        observed = self.submit_as(pool, nxt, iso.current_isolated_turn).result(5)
                        self.assertIs(observed, nxt)
                        iso.settle_isolated_work(nxt, 0)
                        self.assertIsNone(nxt._worker_abort)
                    finally:
                        release.set()
                        self.assertTrue(returned.wait(5))
                    iso.settle_isolated_work(cap, 1)
                    self.assertTrue(cap.provider_work_settled)
                    self.assertTrue(any(t.is_alive() for t in pool._threads))
        asyncio.run(exercise())

    def test_first_typed_cause_is_retained(self):
        first = iso.IsolationAbort('first')
        second = iso.IsolationAbort('second')
        def fail():
            iso.retain_worker_abort(first)
            raise second
        with ThreadPoolExecutor(1) as pool:
            future = self.submit_as(pool, self.cap, fail)
            with self.assertRaises(iso.IsolationAbort) as caught:
                future.result(5)
            self.assertIs(caught.exception, second)
            with self.assertRaises(iso.IsolationAbort) as settled:
                iso.settle_isolated_work(self.cap, 1)
            self.assertIs(settled.exception, first)
            self.assertTrue(self.cap.provider_work_settled)

    def test_registration_precedes_submit_and_deadline_is_shared(self):
        # Stall actual submit after registration without creating a pool worker.
        original = self.submit
        ThreadPoolExecutor.submit = original
        observed = []
        def submit(pool, fn, *args, **kwargs):
            observed.append(self.cap._provider_operations)
            self.blocked(self.cap)
            return original(pool, fn, *args, **kwargs)
        ThreadPoolExecutor.submit = submit
        iso._wrap_executor_context_propagation()
        with ThreadPoolExecutor(1) as pool:
            self.submit_as(pool, self.cap, lambda: None).result(5)
        self.assertEqual(observed, [1])
        iso.settle_isolated_work(self.cap, 0)
        budgets = []
        class Helper:
            def is_alive(self):
                return True
            def join(self, timeout):
                budgets.append(timeout)
                time.sleep(timeout)
        self.cap.in_flight_threads = [Helper(), Helper()]
        with self.assertRaises(iso.IsolationAbort):
            iso.settle_isolated_work(self.cap, 0.02)
        self.assertEqual(len(budgets), 2)
        self.assertLess(budgets[1], 0.005)


if __name__ == '__main__':
    unittest.main()
