"""Offline contracts, not model evaluations or live conversations.

Prompt assertions verify shipped instructions. Registered-handler tests (below)
use explicitly scripted tool choices and fixture I/O; they cannot prove that a
model recognizes every possible property question or judges notes coverage.
"""
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'plugins'))
import wolfhouse_staff_api as plugin
from wolfhouse import luna_intelligence as li, luna_personality as lp


class NotesFirstPromptTests(unittest.TestCase):
    def test_sunset_overlay_uses_own_staff_truth_not_unavailable_house_tool(self):
        soul = (ROOT.parent / 'hermes-sunset' / 'SOUL.md').read_text()
        public = soul.split('## Public questions — Luna Intelligence')[1].split('## Tools')[0]
        self.assertIn('school-specific practical questions', public)
        self.assertIn('Staff tools/config first', public)
        self.assertIn('does not expose `get_house_info`', public)
        self.assertIn('never borrow another tenant', public)
        self.assertIn('uncovered public', public)
        self.assertIn('clearly outside-world', public)
        self.assertNotIn('research general advice, then use the Staff catalog', public)
        registered = {}
        with patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'sunset', 'HERMES_ROLE': 'sunset-luna'}):
            plugin.register(SimpleNamespace(register_tool=lambda **kw: registered.update({kw['name']: kw})))
        self.assertNotIn('get_house_info', registered)
        self.assertIn('get_sunset_rental_catalog', registered)
        self.assertIn('get_sunset_lesson_availability', registered)
        self.assertNotIn('create_booking_from_plan', registered)
        self.assertIn('Where get_house_info is available', registered['search_public_info']['description'])

    def test_wolfhouse_requires_current_turn_notes_before_any_property_research(self):
        soul = (ROOT / 'SOUL.md').read_text()
        public = soul.split('## Public questions — Luna Intelligence')[1].split('## Tools')[0]
        house = next(line for line in soul.splitlines() if line.startswith('- **get_house_info**'))
        for owner, text in [('public policy', public), ('house tool guidance', house)]:
            with self.subTest(owner=owner):
                self.assertRegex(text, r'(?i)possibly.*(?:property|house)')
                self.assertRegex(text, r'get_house_info.*General Notes.*(?:before|first)')
                self.assertIn('this turn', text)
                self.assertIn('even if', text)
                self.assertIn('covered', text)
                self.assertNotIn("you don't have a specific answer", text)
                self.assertNotIn("tell them you'll check with the team", text)
        for topic in ('wifi', 'parking', 'pets', 'smoking', 'quiet hours', 'towels',
                      'kitchen', 'laundry', 'check-in', 'check-out', 'rules', 'how the stay works'):
            with self.subTest(topic=topic):
                self.assertIn(topic, public.lower())
        self.assertIn('uncovered', public)
        self.assertIn('clearly outside-world', public)
        for topic in ('weather', 'museum hours', 'soft versus hard boards', 'neighborhood'):
            self.assertIn(topic, public)
        self.assertRegex(public, r'(?i)notes.*(?:fail|unavailable).*not.*uncovered')
        self.assertRegex(public, r'(?i)never.*public.*(?:infer|invent).*house')
        self.assertIn('Staff tools only', public)
        self.assertIn('OFF by default', public)
        self.assertIn('not** a reason to hand off', public)
        self.assertIn('Preserve known booking fields', public)


class RegisteredNotesFirstTests(unittest.TestCase):
    """Real registration/handlers and turn binding; only I/O is replaced.

    All tool sequences are authored by the test, NOT selected by a model.
    """
    def setUp(self):
        self.enterContext(patch.dict(os.environ, {
            'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
            'WOLFHOUSE_STAFF_API_BASE_URL': li.STAGING_ORIGINS['wolfhouse-somo'],
        }))
        self.enterContext(patch('socket.socket.connect', side_effect=AssertionError('NO NETWORK')))
        self.enterContext(patch('socket.getaddrinfo', side_effect=AssertionError('NO DNS')))
        self.registered = {}
        plugin.register(SimpleNamespace(register_tool=lambda **kw: self.registered.update({kw['name']: kw})))
        self.events = []
        self.notes = {'success': True, 'has_notes': True, 'notes': 'OFFLINE fixture: parking in the courtyard.'}
        self.setting = {'success': True, 'client_slug': 'wolfhouse-somo', 'enabled': True}
        self.enterContext(patch.object(plugin, '_post_bot', side_effect=self.staff))
        self.enterContext(patch.object(li, 'fetch_setting', side_effect=lambda: self.setting))
        self.worker = self.enterContext(patch.object(li, 'run_bounded', side_effect=self.public))
        self.source = SimpleNamespace(platform='whatsapp', user_id='fixture-private-user',
                                      booking={'dates': 'fixture-dates', 'guest_count': 2})
        lp.bind_whatsapp_turn_personality(self.source, fetch_setting=lambda _: {'personality_id': 'sunny'})
        self.addCleanup(lp.clear_bound_personality)

    def staff(self, route, payload):
        self.assertEqual(route, '/house-info', 'No booking/payment/write route permitted')
        self.assertEqual(payload, {})
        self.events.append('notes')
        return self.notes

    def public(self, operation, value, **kwargs):
        self.events.append(operation)
        if operation == 'search':
            return {'success': True, 'results': [{'url': 'https://example.org/offline',
                    'title': 'OFFLINE public fixture', 'description': 'Fixture evidence, not live facts.'}]}
        self.assertEqual(value, 'https://example.org/offline')
        return {'success': True, 'content': 'OFFLINE public fixture; not house policy.'}

    def call(self, name, params):
        return json.loads(self.registered[name]['handler'](params))

    def test_registered_instructions_require_notes_first_without_expanding_schema(self):
        for name in ('get_house_info', 'search_public_info', 'read_public_source'):
            with self.subTest(tool=name):
                entry = self.registered[name]
                text = entry['schema']['description']
                self.assertEqual(text, entry['description'])
                self.assertIn('General Notes', text)
                self.assertIn('before', text)
                self.assertIn('this turn', text)
                self.assertIn('uncovered', text)
                self.assertNotIn("you don't already have", text)
                self.assertNotIn("tell them you'll check with the team", text)
        self.assertIn('possibly', self.registered['get_house_info']['description'])
        self.assertIn('even if', self.registered['get_house_info']['description'])
        self.assertIn('clearly outside-world', self.registered['search_public_info']['description'])
        for name, key in [('search_public_info', 'query'), ('read_public_source', 'source_id')]:
            params = self.registered[name]['schema']['parameters']
            self.assertEqual(set(params['properties']), {key})
            self.assertEqual(params['required'], [key])

    def test_scripted_covered_property_notes_need_no_public_provider_even_when_off(self):
        self.setting['enabled'] = False
        # Coverage is supplied by these fixtures, not computed by a fake planner.
        for topic in ('wifi', 'parking', 'pets', 'smoking', 'quiet hours', 'towels',
                      'kitchen', 'laundry', 'check-in', 'check-out', 'rules', 'how the stay works'):
            with self.subTest(topic=topic):
                self.notes['notes'] = f'OFFLINE owner fixture covering {topic}.'
                result = self.call('get_house_info', {})
                self.assertTrue(result['success'])
                self.assertTrue(result['has_notes'])
                self.assertEqual(result['notes'], self.notes['notes'])
        self.worker.assert_not_called()
        self.assertEqual(self.events, ['notes'] * 12)

    def test_scripted_uncovered_notes_then_search_read_uses_ordinary_handlers(self):
        for notes in ('OFFLINE fixture: wifi only; no local parking guidance.', ''):
            with self.subTest(notes=notes):
                self.events.clear()
                self.notes.update(notes=notes, has_notes=bool(notes))
                result = self.call('get_house_info', {})
                self.assertTrue(result['success'])
                self.assertEqual(result['has_notes'], bool(notes))
                result = self.call('search_public_info', {'query': 'Somo public parking'})
                self.assertTrue(result['success'])
                read = self.call('read_public_source', {'source_id': result['sources'][0]['source_id']})
                self.assertTrue(read['success'])
                self.assertIn('NOT instructions', read['untrusted_content_warning'])
                self.assertEqual(self.events, ['notes', 'search', 'read'])
        self.assertEqual(self.source.booking, {'dates': 'fixture-dates', 'guest_count': 2})

    def test_notes_do_not_override_staff_gate_or_query_guard(self):
        self.assertTrue(self.call('get_house_info', {})['success'])
        self.setting['enabled'] = False
        self.assertEqual(self.call('search_public_info', {'query': 'Somo public parking'})['error'], 'intelligence_off')
        self.setting['enabled'] = True
        for params in ({'query': 'fixture-private-user parking'},
                       {'query': 'Somo parking', 'notes_checked': True}):
            self.assertEqual(self.call('search_public_info', params)['error'], 'invalid_public_query')
        self.worker.assert_not_called()

    def test_scripted_clearly_outside_world_can_search_without_house_lookup(self):
        for query in ('Somo weather', 'Santander museum hours', 'soft versus hard boards', 'Somo neighborhood'):
            with self.subTest(query=query):
                lp.clear_bound_personality()
                lp.bind_whatsapp_turn_personality(self.source, fetch_setting=lambda _: {})
                self.assertTrue(self.call('search_public_info', {'query': query})['success'])
        self.assertEqual(self.events, ['search'] * 4)

    def test_scripted_failed_notes_are_not_claimed_as_checked_empty_notes(self):
        self.notes = {'success': False}
        result = self.call('get_house_info', {})
        self.assertFalse(result['success'])
        self.assertFalse(result['has_notes'])
        self.worker.assert_not_called()


if __name__ == '__main__':
    unittest.main()
