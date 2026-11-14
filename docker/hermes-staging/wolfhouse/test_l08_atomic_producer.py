"""Additional producer-only controls; the frozen Lookout contract is unchanged."""
from copy import deepcopy
import unittest

from wolfhouse import accepted_quote as owner
from wolfhouse.test_l08_atomic_conversion_contract import _OwnerFixture, LEGACY_PREFIX


class ProducerControls(_OwnerFixture):
    def adopt(self):
        return owner.adopt_legacy_booking_identity(legacy_version=2, expected_revision=0)

    def test_nonadoption_never_attempts_an_owner_write(self):
        self.seed_legacy()
        self.seed_current({'guest_name': 'Current'})
        before = self.snapshot()
        self.reject_owner_write()
        self.assertEqual(self.adopt()['reason'], 'revision_changed')
        self.assertEqual(self.snapshot(), before)

    def test_adopted_result_is_detached_and_projects_identity_only(self):
        self.seed_legacy({'name': 'Alias', 'guests': [
            {'guest_name': 'Occupant', 'total_cents': 123, 'confirm': True}],
            'confirm': True, 'guest_count': 99, 'payment_choice': 'full'})
        result = self.adopt()
        expected = {'revision': 1, 'values': {'guest_name': 'Alias',
                    'guests': [{'name': 'Occupant'}]}, 'tombstones': []}
        self.assertEqual(result['identity'], expected)
        result['identity']['values']['guests'].clear()
        self.assertEqual(owner.read_booking_identity(), expected)

    def test_unprovable_phone_binding_declines_without_writes(self):
        self.close_context()
        from gateway.session_context import set_session_vars
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp',
            chat_id='opaque-chat', user_id='opaque-user', session_key='key',
            session_id=self.agent.session_id, message_id='unprovable')
        owner.observe_owner_turn(self.agent, 'Offline')
        self.seed_legacy()
        before = self.snapshot()
        self.reject_owner_write()
        self.assertEqual(self.adopt()['reason'], 'invalid_legacy')
        self.assertEqual(self.snapshot(), before)

    def test_corrupt_legacy_json_declines_without_repair(self):
        self.db._execute_write(lambda conn: conn.execute(
            'INSERT INTO state_meta(key,value) VALUES (?,?)',
            (LEGACY_PREFIX + self.agent.session_id, '{broken')))
        before = self.snapshot()
        self.reject_owner_write()
        self.assertEqual(self.adopt()['reason'], 'invalid_legacy')
        self.assertEqual(self.snapshot(), before)

    def test_adoption_preserves_existing_create_budget_bytes(self):
        # Seed via owner transaction, then inject an unrelated stored budget
        # directly so ordinary transaction housekeeping cannot remove it first.
        self.seed_legacy()
        state = self.owner_state()
        state['create_attempt_budget'] = {'booking': 'old-operation', 'attempts': 1}
        import json
        key = next(key for key in self.snapshot()
                   if key.startswith('wolfhouse.accepted_quote.v1:'))
        self.db._execute_write(lambda conn: conn.execute(
            'UPDATE state_meta SET value=? WHERE key=?', (json.dumps(state), key)))
        expected = deepcopy(state)
        self.assertEqual(self.adopt()['outcome'], 'adopted')
        actual = self.owner_state()
        actual.pop('booking_identity')
        self.assertEqual(actual, expected)


if __name__ == '__main__':
    unittest.main()
