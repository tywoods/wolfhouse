"""Narrow ingress-wrapper unit controls; not whole-ingress SDK acceptance."""
import ast
import asyncio
import inspect
import unittest

from wolfhouse import luna_personality_isolation as iso


class IngressDrainTests(unittest.IsolatedAsyncioTestCase):
    def wrapper(self, original):
        # Compile the unchanged lexical owner, not a copied implementation.
        tree = ast.parse(inspect.getsource(iso._wrap_turn_entry))
        node = next(n for n in ast.walk(tree) if isinstance(n, ast.AsyncFunctionDef)
                    and n.name == '_isolated_handle')
        scope = dict(iso.__dict__)
        scope.update(orig_handle=original, runner=None, t=iso.IsolationTargets(),
                     inspect_live_seams=lambda **kw: dict.fromkeys(iso.REQUIRED_LIVE_SEAMS, True),
                     _iter_effective_agents=lambda **kw: ())
        exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])),
                     '<canonical-ingress-wrapper-unit>', 'exec'), scope)
        return scope['_isolated_handle']

    async def asyncSetUp(self):
        iso.install_isolation_runtime()
        self.cap = iso.IsolatedTurnCapture(case_id='wrapper', personality_id='balanced', tenant_id='sunset')

    async def asyncTearDown(self):
        iso.reset_isolation_runtime_for_tests()

    async def invoke(self, original):
        token = iso.enter_isolated_turn(self.cap)
        try:
            return await self.wrapper(original)()
        finally:
            iso.exit_isolated_turn(token)

    async def test_early_return_drains(self):
        async def original():
            return None
        self.assertIsNone(await self.invoke(original))
        self.assertTrue(self.cap.async_work_settled)

    async def test_typed_error_identity_survives_settlement(self):
        error = iso.IsolationAbort('first-ingress-cause')
        async def original():
            raise error
        with self.assertRaises(iso.IsolationAbort) as caught:
            await self.invoke(original)
        self.assertIs(caught.exception, error)
        self.assertIs(self.cap._worker_abort, error)
        self.assertTrue(self.cap.async_work_settled)

    async def test_ordinary_exception_identity_survives_settlement(self):
        error = ValueError('fixture-only')
        async def original():
            raise error
        with self.assertRaises(ValueError) as caught:
            await self.invoke(original)
        self.assertIs(caught.exception, error)
        self.assertTrue(self.cap.async_work_settled)

    async def test_cancellation_drains_without_blocking_loop(self):
        entered = asyncio.Event()
        released = asyncio.Event()
        async def callback():
            await released.wait()
        async def original():
            import gateway.run as gateway
            future = gateway.safe_schedule_threadsafe(callback(), asyncio.get_running_loop())
            self.assertIsNotNone(future)
            entered.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(self.invoke(original))
        try:
            await asyncio.wait_for(entered.wait(), 1)
            task.cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done())
            self.assertFalse(self.cap.async_work_settled)
            released.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, 1)
            self.assertTrue(self.cap.async_work_settled)
        finally:
            released.set()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_uncaptured_original_result_and_error_unchanged(self):
        sentinel = object()
        async def original():
            return sentinel
        self.assertIs(await self.wrapper(original)(), sentinel)
        self.assertFalse(self.cap.async_work_settled)
        error = RuntimeError('ordinary')
        async def failing():
            raise error
        with self.assertRaises(RuntimeError) as caught:
            await self.wrapper(failing)()
        self.assertIs(caught.exception, error)


if __name__ == '__main__':
    unittest.main(verbosity=2)
