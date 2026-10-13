"""Hostile installed-source mutations must fail closed; no runtime writes."""
import tempfile
from pathlib import Path
import unittest
from apply_gateway_patches import apply_original_inbound_source, apply_api_original_inbound_patch

class PatchMutants(unittest.TestCase):
    def test_gateway_mutants(self):
        import gateway.run as runtime
        original = apply_original_inbound_source(Path(runtime.__file__).read_text())
        followup = ('with _wh_followup_original(self._session_db, pending_event, '
                    'session_id, session_key):')
        self.assertIn(followup, original)
        self.assertEqual(original, apply_original_inbound_source(original))
        call = '_wh_bind_original(self._session_db, session_entry.session_id, session_key, source, event.message_id)'
        mutants = {
            'movedbindowner': original.replace('async def _handle_message_with_agent(', 'async def _other_message_owner('),
            'markeronlyall': 'from contextvars import copy_context\n# Wolfhouse original inbound: bind incarnation before enrichment.\n',
            'markeronly': original.replace('        '+call, '        pass'),
            'changedcall': original.replace(call, call.replace('event.message_id', '"forged"')),
            'duplicate': original.replace('        '+call, '        '+call+'\n        '+call),
            'movedowner': original.replace('    @_wh_gateway_event_owner\n', '').replace('    async def _run_agent(', '    @_wh_gateway_event_owner\n    async def _run_agent('),
            'missingbody': original.replace('    @_wh_gateway_event_owner\n', '    # @_wh_gateway_event_owner\n'),
            'missingqueuedowner': original.replace(
                'with _wh_followup_original(self._session_db, pending_event, session_id, session_key):',
                'with __import__("contextlib").nullcontext():'),
        }
        for name, source in mutants.items():
            with self.subTest(name=name), self.assertRaises(RuntimeError): apply_original_inbound_source(source)

    def test_gateway_owner_reopen_generation_lifecycle(self):
        """Unrelated DB guards must not hide the rejected-generation migration."""
        import gateway.run as runtime
        installed = Path(runtime.__file__).read_text()
        successor = apply_original_inbound_source(installed)
        guard = (
            '        if self._session_db is not None:\n'
            '            _wh_owner_row = self._session_db.get_session(session_entry.session_id)\n'
            '            if _wh_owner_row is not None and _wh_owner_row.get("ended_at") is not None:\n'
            '                self._session_db.reopen_session(session_entry.session_id)\n'
        )
        unguarded = (
            '        _wh_owner_row = self._session_db.get_session(session_entry.session_id)\n'
            '        if _wh_owner_row is not None and _wh_owner_row.get("ended_at") is not None:\n'
            '            self._session_db.reopen_session(session_entry.session_id)\n'
        )
        bind_call = ('        _wh_bind_original(self._session_db, session_entry.session_id, '
                     'session_key, source, event.message_id)\n')
        self.assertEqual(successor.count(guard), 1)
        # Preserve and prove the unrelated guards which caused the broad selector bug.
        self.assertGreater(successor.count('if self._session_db is not None:') - 1, 0)
        paths = {
            'clean/current-runtime': installed,
            'base-generated': successor.replace(guard, '', 1),
            '3c845618-generated': successor.replace(guard, unguarded, 1),
            'successor': successor,
        }
        for name, source in paths.items():
            with self.subTest(name=name):
                migrated = apply_original_inbound_source(source)
                self.assertEqual(migrated, successor)
                self.assertEqual(apply_original_inbound_source(migrated), migrated)
        mutants = {
            'wrong_guard': successor.replace(
                guard, guard.replace('self._session_db is not None', 'True'), 1),
            'missing_bind': successor.replace(bind_call, '', 1),
        }
        for name, source in mutants.items():
            with self.subTest(name=name), self.assertRaises(RuntimeError):
                apply_original_inbound_source(source)

    def test_api_mutants(self):
        import gateway.platforms.api_server as runtime
        with tempfile.TemporaryDirectory() as tmp:
            path=Path(tmp)/'api.py'; path.write_text(Path(runtime.__file__).read_text())
            apply_api_original_inbound_patch(path); original=path.read_text()
            apply_api_original_inbound_patch(path); self.assertEqual(original,path.read_text())
            mutants={
                'markeronly': original.replace('_wh_original = api_original(user_message, session_id)', '_wh_original = None'),
                'changedcall': original.replace('api_original(user_message, session_id)', 'api_original("forged", session_id)'),
                'duplicate': original.replace('        _wh_original = api_original(user_message, session_id)', '        _wh_original = api_original(user_message, session_id)\n        _wh_original = api_original(user_message, session_id)'),
                'missingbody': original.replace('            _wh_original.close()', '            pass'),
                'movedowner': original.replace('async def _run_agent(', 'async def _other_agent('),
                'changedworker': original.replace('api_worker_owner(_wh_original, agent)', 'api_worker_owner(None, agent)'),
            }
            for name, source in mutants.items():
                path.write_text(source)
                with self.subTest(name=name), self.assertRaises(RuntimeError): apply_api_original_inbound_patch(path)
                self.assertEqual(source,path.read_text())

if __name__=='__main__': unittest.main()
