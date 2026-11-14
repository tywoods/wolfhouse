"""BC-S-PROVENANCE: real local owner ledger, no network/business writes."""
import hashlib
import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from hermes_state import SessionDB
from gateway.session_context import clear_session_vars, set_session_vars
from wolfhouse import accepted_quote as ledger


class ConsumedIngressProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        self.addCleanup(self.root.cleanup)
        self.db = SessionDB(Path(self.root.name) / 'state.db')
        self.addCleanup(self.db.close)
        self.db.create_session('bc-provenance', source='whatsapp')
        self.agent = SimpleNamespace(_session_db=self.db, session_id='bc-provenance')
        self.tokens = None
        self.addCleanup(self._close_turn)
        env = patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        env.start()
        self.addCleanup(env.stop)
        for target in ('urllib.request.urlopen', 'socket.socket.connect', 'socket.create_connection'):
            guard = patch(target, side_effect=AssertionError('offline only'))
            guard.start()
            self.addCleanup(guard.stop)

    def _close_turn(self):
        ledger.close_turn()
        if self.tokens is not None:
            clear_session_vars(self.tokens)
            self.tokens = None

    def turn(self, message, raw, now=1000.0):
        self._close_turn()
        self.tokens = set_session_vars(
            platform='whatsapp', source='whatsapp', chat_id='bc-chat',
            user_id='bc-guest', session_key='bc-key',
            session_id=self.agent.session_id, message_id=message)
        with patch.object(ledger.time, 'time', return_value=now):
            ledger.observe_owner_turn(self.agent, raw)

    def snapshot(self):
        with self.db._lock:
            return [tuple(row) for row in self.db._conn.execute(
                'SELECT key,value FROM state_meta ORDER BY key').fetchall()]

    def state(self):
        rows = [value for key, value in self.snapshot() if key.startswith(ledger._PREFIX)]
        self.assertEqual(len(rows), 1)
        return json.loads(rows[0])

    def test_nearby_turn_hash_and_raw_both_identify_only_consumed_ingress(self):
        self.turn('first', 'Please quote a shared room')
        raw = '  Cambiar a habitación privada, por favor.\n'
        self.turn('second', raw, now=1003.0)
        state = self.state()
        current = state['current_turn']
        digest = hashlib.sha256(raw.encode()).hexdigest()
        self.assertEqual(current['raw_digest'], digest)
        self.assertEqual(current['ingress_raw'], raw)
        self.assertEqual(current['raw'], raw)
        self.assertEqual(hashlib.sha256(current['raw'].encode()).hexdigest(), digest)
        self.assertEqual(current['message_id'], 'second')
        self.assertEqual([row['raw'] for row in state['recent_guest_turns']],
                         ['Please quote a shared room', raw])
        result = ledger.update_booking_plan(
            {'operation': 'revise', 'changes': {'room_type': 'private'}})
        self.assertEqual(result['next_action'], 'requote_material_changes')
        self.assertEqual(self.state()['plan']['room_type'], 'private')

    def test_single_turn_preserves_whitespace_unicode_and_empty_ingress(self):
        for index, raw in enumerate(('  full amount\n', '\tSí, habitación privada 🏄\r\n', '')):
            with self.subTest(raw=raw):
                self.turn(f'exact-{index}', raw, now=1000.0 + index * 100)
                current = self.state()['current_turn']
                self.assertEqual(current['raw'], raw)
                self.assertEqual(current['raw_digest'], hashlib.sha256(raw.encode()).hexdigest())
                result = ledger.update_booking_plan({'operation': 'decline_offer', 'scope': 'whole_offer'})
                self.assertEqual(result['next_action'], 'offer_declined')

    def test_successive_nearby_revisions_bind_each_new_message_and_are_idempotent(self):
        self.turn('quote', 'Please quote this')
        for index, room in enumerate(('shared', 'private', 'shared')):
            with self.subTest(room=room, index=index):
                message = f'revision-{index}'
                self.turn(message, f'Change to {room}', now=1001.0 + index)
                request = {'operation': 'revise', 'changes': {'room_type': room}}
                result = ledger.update_booking_plan(request)
                state = self.state()
                self.assertEqual(state['plan']['room_type'], room)
                self.assertEqual(state['current_turn']['plan_update']['message_id'], message)
                before = self.snapshot()
                self.assertEqual(ledger.update_booking_plan(request), result)
                self.assertEqual(self.snapshot(), before)

    def test_corrupt_raw_digest_message_or_seen_membership_is_rejected_without_mutation(self):
        self.turn('prior', 'Please quote this')
        self.turn('current', 'Change to private', now=1002.0)
        original = self.state()
        mutations = {
            'raw_changed': lambda s: s['current_turn'].update(raw='Different ingress'),
            'raw_missing': lambda s: s['current_turn'].pop('raw'),
            'raw_wrong_type': lambda s: s['current_turn'].update(raw=123),
            'digest_changed': lambda s: s['current_turn'].update(raw_digest='0' * 64),
            'digest_missing': lambda s: s['current_turn'].pop('raw_digest'),
            'digest_of_history': lambda s: s['current_turn'].update(raw_digest=hashlib.sha256(
                'Please quote this\nChange to private'.encode()).hexdigest()),
            'raw_replaced_with_history': lambda s: s['current_turn'].update(
                raw='Please quote this\nChange to private'),
            'old_message': lambda s: s['current_turn'].update(message_id='prior'),
            'unseen_message': lambda s: s['seen'].remove('current'),
        }
        for name, mutate in mutations.items():
            for request in ({'operation': 'revise', 'changes': {'room_type': 'private'}},
                            {'operation': 'decline_offer', 'scope': 'whole_offer'}):
                with self.subTest(mutation=name, operation=request['operation']):
                    corrupt = deepcopy(original)
                    mutate(corrupt)
                    ledger._transaction(lambda state, ingress: (state.clear(), state.update(corrupt)))
                    before = self.snapshot()
                    with self.assertRaisesRegex(ledger.QuoteBoundaryError,
                                                '^booking_plan_update_turn_invalid$'):
                        ledger.update_booking_plan(request)
                    self.assertEqual(self.snapshot(), before)

    def test_replayed_message_still_fails_closed(self):
        self.turn('first', 'Please quote this')
        self.turn('second', 'Change to private', now=1002.0)
        before = self.snapshot()
        with self.assertRaisesRegex(ledger.QuoteBoundaryError, '^quote_owner_replayed_message$'):
            self.turn('second', 'Change to private', now=1003.0)
        self.assertEqual(self.snapshot(), before)

    def test_history_cannot_make_current_room_choice_an_availability_comparison(self):
        from wolfhouse_staff_api import _availability_is_comparison_turn
        self.turn('compare', 'just checking availability')
        self.assertTrue(_availability_is_comparison_turn({}))
        self.turn('choose', 'Book a private room', now=1002.0)
        self.assertFalse(_availability_is_comparison_turn({}))


if __name__ == '__main__':
    unittest.main()
