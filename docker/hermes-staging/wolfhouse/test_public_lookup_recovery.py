"""Offline public handler regressions. Provider and authenticated settings are fixtures."""
import contextvars
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from wolfhouse import luna_intelligence as li


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.clock = patch.object(li.time, 'monotonic', return_value=100)
        self.now = self.clock.start()
        tenant = getattr(self, 'tenant', 'wolfhouse-somo')
        self.env = patch.dict(os.environ, {
            'LUNA_CLIENT_SLUG': tenant, 'HERMES_ROLE': li.ROLES[tenant],
            'WOLFHOUSE_STAFF_API_BASE_URL': li.STAGING_ORIGINS[tenant],
        })
        self.env.start()
        self.setting = {'success': True, 'client_slug': tenant, 'enabled': True}
        self.auth = patch.object(li, 'fetch_setting', side_effect=lambda: self.setting)
        self.auth.start()
        li.bind_guest_turn(SimpleNamespace(platform='whatsapp'))
        self.good = {'success': True, 'results': [{'url': 'https://example.org/guide', 'title': 'OFFLINE'}]}

    def tearDown(self):
        li.clear_guest_turn()
        self.auth.stop()
        self.env.stop()
        self.clock.stop()

    def search(self):
        return json.loads(li.search_public_info({'query': 'Somo ferry timetable 2026-09-27'}))

    def test_planning_time_does_not_consume_research_window(self):
        self.now.return_value = 131
        with patch.object(li, 'run_bounded', return_value=self.good) as worker:
            result = self.search()
            self.assertTrue(result['success'], result)
            self.assertEqual(worker.call_count, 1)
            self.assertEqual(worker.call_args.kwargs['timeout'], 8)
        self.now.return_value = 160
        with patch.object(li, 'run_bounded', return_value={'success': True, 'content': 'OFFLINE ferry evidence'}) as worker:
            result = json.loads(li.read_public_source({'source_id': 's1'}))
            self.assertTrue(result['success'], result)
            self.assertEqual(worker.call_args.kwargs['timeout'], 1)
        self.now.return_value = 161
        with patch.object(li, 'run_bounded') as worker:
            self.assertEqual(self.search()['error'], 'research_budget_exhausted')
            worker.assert_not_called()

    def test_absolute_turn_expiry_is_bounded_and_not_setting_off(self):
        self.now.return_value = 220
        with patch.object(li, 'run_bounded') as worker:
            self.assertEqual(self.search()['error'], 'research_budget_exhausted')
            worker.assert_not_called()

    def test_denied_queries_do_not_start_or_extend_window(self):
        self.now.return_value = 131
        self.assertEqual(json.loads(li.search_public_info({'query': 'token SECRET'}))['error'], 'invalid_public_query')
        self.setting['enabled'] = False
        self.assertEqual(self.search()['error'], 'intelligence_off')
        self.setting['enabled'] = True
        self.now.return_value = 150
        with patch.object(li, 'run_bounded', return_value=self.good):
            self.assertTrue(self.search()['success'])
            self.now.return_value = 179
            self.assertTrue(self.search()['success'])
            self.now.return_value = 180
            self.assertEqual(self.search()['error'], 'research_budget_exhausted')

    def test_late_provider_result_cannot_publish_after_research_expiry(self):
        self.now.return_value = 131
        def late(*args, **kw):
            self.now.return_value = 162
            return self.good
        with patch.object(li, 'run_bounded', side_effect=late):
            result = self.search()
        self.assertEqual(result['error'], 'research_budget_exhausted')
        self.assertEqual(li._current.get().sources, {})

    def test_one_retry_recovers_transient_general_search_failure(self):
        with patch.object(li, 'run_bounded', side_effect=[{'success': False}, self.good]) as worker:
            result = self.search()
            self.assertTrue(result['success'], result)
            self.assertEqual(worker.call_count, 2)
            self.assertEqual(li._current.get().searches, 2)
            self.assertEqual(self.search()['error'], 'research_budget_exhausted')
            self.assertEqual(worker.call_count, 2)

    def test_unconfigured_provider_fails_after_only_two_attempts_without_escalation(self):
        with patch.object(li, 'run_bounded', return_value={'success': False}) as worker:
            result = self.search()
            self.assertEqual(result['error'], 'public_search_unavailable')
            self.assertEqual(worker.call_count, 2)
            self.assertIs(result['do_not_escalate'], True)
            self.assertIs(result['staff_review_needed'], False)
            self.assertNotIn('sources', result)

    def test_revoked_setting_does_not_retry_or_publish(self):
        def revoke(*args, **kw):
            self.setting['enabled'] = False
            return {'success': False}
        with patch.object(li, 'run_bounded', side_effect=revoke) as worker:
            self.assertEqual(self.search()['error'], 'intelligence_off')
            self.assertEqual(worker.call_count, 1)
            self.assertEqual(li._current.get().sources, {})

    def test_rebound_turn_during_provider_exception_cannot_receive_retry(self):
        def rebind(*args, **kw):
            li.bind_guest_turn(SimpleNamespace(platform='whatsapp'))
            raise RuntimeError('OFFLINE provider exception')
        with patch.object(li, 'run_bounded', side_effect=rebind) as worker:
            self.assertFalse(self.search()['success'])
            self.assertEqual(worker.call_count, 1)
            self.assertEqual(li._current.get().searches, 0)

    def test_cleanup_revokes_copied_context_before_new_window(self):
        old = contextvars.copy_context()
        li.clear_guest_turn()
        self.now.return_value = 131
        with patch.object(li, 'run_bounded') as worker:
            self.assertEqual(old.run(self.search)['error'], 'intelligence_off')
            worker.assert_not_called()


class SunsetRecoveryTests(RecoveryTests):
    tenant = 'sunset'


if __name__ == '__main__':
    unittest.main()
