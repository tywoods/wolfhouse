"""Disposable real SessionStore/SQLite preservation test; never resident storage."""
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from gateway.config import GatewayConfig, Platform
from gateway.session import SessionStore, SessionSource
from hermes_state import SessionDB
from wolfhouse import crowsnest_guest_door as door

class RealStorage(unittest.IsolatedAsyncioTestCase):
    async def test_sqlite_swallowed_failures_are_not_cleanup_success(self):
        for operation in ('end_session', 'create_session'):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                db = SessionDB(root / 'state.db')
                try:
                    with patch('hermes_state.SessionDB', return_value=db):
                        store = SessionStore(root / 'sessions', GatewayConfig())
                    thread = 'sim:golden-sqlite-failure-' + operation.replace('_', '-')
                    scope = door.golden_scope(thread)
                    old = store.get_or_create_session(door._make_event(scope, 'hello').source)
                    door._PENDING_SIM_REPLIES[scope.session_key] = 'retain-until-confirmed'
                    with patch.object(door, '_golden_runner', return_value=SimpleNamespace(session_store=store)), \
                         patch.object(db, operation, side_effect=RuntimeError('injected SQLite failure')):
                        with self.assertRaisesRegex(RuntimeError, 'golden_sqlite_rotation_unconfirmed'):
                            await door.cleanup_golden_thread(thread)
                    self.assertEqual(door._PENDING_SIM_REPLIES.pop(scope.session_key), 'retain-until-confirmed')
                    self.assertIsNotNone(db.get_session(old.session_id))
                finally:
                    db.close()

    async def test_routing_rotation_preserves_history_and_shared_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = SessionDB(root / 'state.db')
            try:
                with patch('hermes_state.SessionDB', return_value=db):
                    store = SessionStore(root / 'sessions', GatewayConfig())
                scope = door.golden_scope('sim:golden-real-storage')
                event = door._make_event(scope, 'hello')
                old = store.get_or_create_session(event.source)
                self.assertNotEqual(old.session_key, scope.session_key)
                ordinary = store.get_or_create_session(SessionSource(platform=Platform.WHATSAPP_CLOUD,
                    chat_id='ordinary', user_id='ordinary', chat_type='dm'))
                store.append_to_transcript(old.session_id, {'role':'user', 'content':'HISTORY_SENTINEL'})
                store.append_to_transcript(ordinary.session_id, {'role':'user', 'content':'ORDINARY_SENTINEL'})
                for name in ('USER.md', 'MEMORY.md'):
                    (root / name).write_text(name + '_SENTINEL')
                before = {p: p.read_bytes() for p in root.rglob('*') if p.is_file() and p.suffix in ('.md', '.jsonl')}
                history = store.load_transcript(old.session_id)
                ordinary_history = store.load_transcript(ordinary.session_id)
                with patch.object(door, '_golden_runner', return_value=SimpleNamespace(session_store=store)):
                    result = await door.cleanup_golden_thread('sim:golden-real-storage')
                self.assertTrue(result['ok'])
                self.assertNotEqual(store._entries[old.session_key].session_id, old.session_id)
                self.assertEqual(store._entries[ordinary.session_key].session_id, ordinary.session_id)
                self.assertIsNotNone(db.get_session(old.session_id))
                self.assertIsNotNone(db.get_session(ordinary.session_id))
                self.assertEqual(store.load_transcript(old.session_id), history)
                self.assertEqual(store.load_transcript(ordinary.session_id), ordinary_history)
                for path, content in before.items(): self.assertEqual(path.read_bytes(), content)
            finally:
                db.close()
