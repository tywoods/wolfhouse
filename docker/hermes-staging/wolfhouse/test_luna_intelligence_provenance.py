"""Offline R1 regression: real adapters, injected subprocess transport only."""
import json
import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from wolfhouse import guest_public_worker as worker, luna_intelligence as li
from wolfhouse.test_guest_public_reader_polish import sequence


class ProvenanceTests(unittest.TestCase):
    requested = 'https://example.com/old'
    final = 'https://other.example/guide'

    def setUp(self):
        self.env = patch.dict(os.environ, {
            'LUNA_CLIENT_SLUG': 'sunset', 'HERMES_ROLE': 'sunset-luna',
            'WOLFHOUSE_STAFF_API_BASE_URL': li.STAGING_ORIGINS['sunset'],
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.setting = {'success': True, 'client_slug': 'sunset', 'enabled': True}
        auth = patch.object(li, 'fetch_setting', side_effect=lambda: self.setting)
        auth.start()
        self.addCleanup(auth.stop)
        li.bind_guest_turn(SimpleNamespace(platform='whatsapp'))
        self.addCleanup(li.clear_guest_turn)
        li._current.get().sources['s1'] = self.requested

    def process(self, redirected=True):
        # The final URL is produced by the actual worker's HTTP/redirect logic,
        # not fabricated as an adapter return value. All wire traffic is offline.
        replies = [(404, {}, b'')]
        if redirected:
            replies += [(302, {'Location': self.final}, b''), (404, {}, b'')]
        replies += [(200, {}, b'OFFLINE public evidence')]
        with sequence(replies):
            receipt = worker._execute('read', self.requested)
        self.assertTrue(receipt['ok'], receipt)
        self.assertEqual(receipt['url'], self.final if redirected else self.requested)
        proc = Mock()
        proc.communicate.return_value = (json.dumps(receipt).encode(), b'')
        proc.returncode = 0
        proc.poll.return_value = 0
        return proc

    def test_run_bounded_preserves_worker_final_url_and_eight_second_cap(self):
        proc = self.process()
        with patch('subprocess.Popen', return_value=proc):
            result = li.run_bounded('read', self.requested, timeout=60)
        self.assertEqual(result.get('url'), self.final)
        self.assertEqual(result['content'], 'OFFLINE public evidence')
        self.assertEqual(json.loads(proc.communicate.call_args.args[0]),
                         {'operation': 'read', 'value': self.requested})
        self.assertEqual(proc.communicate.call_args.kwargs['timeout'], 8.0)

    def test_public_read_reports_final_and_requested_urls_without_rescoping_source(self):
        proc = self.process()
        with patch('subprocess.Popen', return_value=proc):
            result = json.loads(li.read_public_source({'source_id': 's1'}))
        self.assertTrue(result['success'], result)
        self.assertEqual(result['url'], self.final)
        self.assertEqual(result['requested_url'], self.requested)
        self.assertEqual(result['source_id'], 's1')
        self.assertEqual(result['content'], 'OFFLINE public evidence')
        self.assertEqual(li._current.get().sources, {'s1': self.requested})
        self.assertEqual(json.loads(proc.communicate.call_args.args[0])['value'], self.requested)

    def test_nonredirect_read_keeps_original_provenance(self):
        with patch('subprocess.Popen', return_value=self.process(redirected=False)):
            result = json.loads(li.read_public_source({'source_id': 's1'}))
        self.assertEqual(result['url'], self.requested)
        self.assertEqual(result.get('requested_url'), self.requested)

    def test_source_admission_toggle_and_read_budget_remain_in_force(self):
        proc = self.process()
        with patch('subprocess.Popen', return_value=proc) as transport:
            for params in ({'source_id': 'unknown'},
                           {'source_id': 's1', 'url': self.final},
                           {'source_id': 's1', 'final_url': self.final}):
                self.assertEqual(json.loads(li.read_public_source(params))['error'], 'unknown_source')
            self.setting['enabled'] = False
            self.assertEqual(json.loads(li.read_public_source({'source_id': 's1'}))['error'], 'intelligence_off')
            transport.assert_not_called()
            self.setting['enabled'] = True
            li._current.get().research_deadline = time.monotonic() + 1
            for _ in range(3):
                self.assertTrue(json.loads(li.read_public_source({'source_id': 's1'}))['success'])
                self.assertLessEqual(proc.communicate.call_args.kwargs['timeout'], 1)
            self.assertEqual(json.loads(li.read_public_source({'source_id': 's1'}))['error'], 'research_budget_exhausted')
            self.assertEqual(transport.call_count, 3)


if __name__ == '__main__':
    unittest.main()
