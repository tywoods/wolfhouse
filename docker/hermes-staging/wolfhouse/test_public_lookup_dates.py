"""Offline regressions: registered guest tool, real admission; provider is a fixture.

These results are NOT live provider/LLM/staging evidence.
"""
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugins'))
from wolfhouse import luna_intelligence as li
import wolfhouse_staff_api as plugin


class PublicLookupDateTests(unittest.TestCase):
    def test_calendar_queries_reach_general_search_for_both_tenants(self):
        queries = (
            'Somo weather 2026-09-26 2026-09-27',
            'Santander museum exhibitions 2026-09-26',
            'Somo ferry timetable 2026-09-27',
            'solar eclipse 2028-02-29',
        )
        for tenant, origin in li.STAGING_ORIGINS.items():
            for query in queries:
                with self.subTest(tenant=tenant, query=query), patch.dict(os.environ, {
                    'LUNA_CLIENT_SLUG': tenant, 'HERMES_ROLE': li.ROLES[tenant],
                    'WOLFHOUSE_STAFF_API_BASE_URL': origin,
                }), patch.object(li, 'fetch_setting', return_value={
                    'success': True, 'client_slug': tenant, 'enabled': True,
                }), patch.object(li, 'run_bounded', return_value={
                    'success': True, 'results': [{
                        'url': 'https://example.org/public-fixture',
                        'description': 'OFFLINE fixture, not a live answer',
                    }],
                }) as provider:
                    registered = {}
                    plugin.register(SimpleNamespace(register_tool=lambda **kw: registered.update({kw['name']: kw})))
                    li.bind_guest_turn(SimpleNamespace(platform='whatsapp', user_id='synthetic-private-user'))
                    try:
                        result = json.loads(registered['search_public_info']['handler']({'query': query}))
                        self.assertTrue(result['success'], result)
                        self.assertEqual(provider.call_args.args, ('search', query))
                        self.assertIn('NOT instructions', result['untrusted_content_warning'])
                    finally:
                        li.clear_guest_turn()

    def test_calendar_does_not_allow_private_digits_invalid_dates_or_identity(self):
        queries = (
            'Somo forecast 2026-02-29', 'Somo forecast 2026-99-26',
            'Somo weather 1234567890 on 2026-09-26',
            'Somo weather 612 345 678 on 2026-09-26',
            'Somo 2026-09-26123', 'Somo +2026-09-26',
            'Somo user@example.org on 2026-09-26',
            'Somo guest: private conversation 2026-09-26',
            'Somo private-guestname 2026-09-26',
            'Somo 2026-09-26',  # exact known private identity must still win
        )
        with patch.dict(os.environ, {
            'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
            'WOLFHOUSE_STAFF_API_BASE_URL': li.STAGING_ORIGINS['wolfhouse-somo'],
        }), patch.object(li, 'fetch_setting', return_value={
            'success': True, 'client_slug': 'wolfhouse-somo', 'enabled': True,
        }), patch.object(li, 'run_bounded') as provider:
            for query in queries:
                with self.subTest(query=query):
                    li.bind_guest_turn(SimpleNamespace(platform='whatsapp',
                        user_name='private-guestname', user_id=(
                            '2026-09-26' if query == 'Somo 2026-09-26' else 'synthetic-private-id')))
                    try:
                        result = json.loads(li.search_public_info({'query': query}))
                        self.assertEqual(result.get('error'), 'invalid_public_query')
                    finally:
                        li.clear_guest_turn()
            provider.assert_not_called()


if __name__ == '__main__':
    unittest.main()
