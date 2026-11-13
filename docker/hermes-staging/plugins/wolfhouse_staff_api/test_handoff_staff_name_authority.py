"""Offline regressions: only configured Staff Info may name handoff staff."""
import asyncio
import json
import os
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import wolfhouse_staff_api as plugin
from wolfhouse_staff_api import handoff_guest_note as notes
from wolfhouse import explicit_human_handoff as handoff


NEUTRAL_NOTES = {
    'en': "I'm getting one of our team to help you, they'll be with you shortly.",
    'es': 'Voy a buscar a alguien del equipo para ayudarte, enseguida estarán contigo.',
    'it': 'Sto chiamando un membro del team per aiutarti, saranno da te a breve.',
    'de': 'Ich hole ein Teammitglied, das dir hilft — jemand ist gleich bei dir.',
    'fr': "Je vais chercher quelqu'un de l'equipe pour t'aider, ils seront la tout de suite.",
}
NAMED_NOTES = {
    'en': "I'm getting Ale to help you, they'll be with you shortly.",
    'es': 'Voy a buscar a Ale para ayudarte, enseguida estará contigo.',
    'it': 'Sto chiamando Ale per aiutarti, sarà da te a breve.',
    'de': 'Ich hole Ale, der dir hilft — jemand ist gleich bei dir.',
    'fr': "Je vais chercher Ale pour t'aider, iels seront la tout de suite.",
}
FABRICATED_NOTE = "I'm getting Camila to help you."


class HandoffStaffNameAuthorityTests(unittest.TestCase):
    def test_only_staff_info_can_name_staff_in_every_supported_language(self):
        cases = (
            ('unconfigured', {}, False),
            ('blank', {'staff_member_name': ' \t\n'}, False),
            ('configured', {'staff_member_name': 'Ale'}, True),
            ('lookup_exception', RuntimeError('Staff Info unavailable'), False),
            ('general_notes_only', {'notes': 'Ask Camila for handoffs.'}, False),
            ('noncanonical_name', {'staff_name': 'Camila'}, False),
            ('malformed_response', None, False),
        )
        self.assertEqual(set(notes.WARM_NOTES), set(NEUTRAL_NOTES))
        for language in NEUTRAL_NOTES:
            for language_key in ('language', 'guest_language'):
                for name_key in ('staff_member_name', 'staff_name'):
                    for label, response, configured in cases:
                        with self.subTest(language=language, language_key=language_key,
                                          name_key=name_key, case=label):
                            fetch = (Mock(side_effect=response) if isinstance(response, Exception)
                                     else Mock(return_value=response))
                            payload = {language_key: language, name_key: 'Camila',
                                       'notes': 'Use Camila for handoffs.',
                                       'guest_note': FABRICATED_NOTE}
                            original = dict(payload)
                            actual = notes.resolve_guest_note(
                                payload, FABRICATED_NOTE, fetch_staff_info=fetch)
                            expected = NAMED_NOTES if configured else NEUTRAL_NOTES
                            self.assertEqual(actual, expected[language])
                            self.assertNotIn('Camila', actual)
                            fetch.assert_called_once_with()
                            self.assertEqual(payload, original)

    def test_unknown_language_uses_neutral_english_without_a_configured_name(self):
        fetch = Mock(return_value={})
        actual = notes.resolve_guest_note(
            {'language': 'unknown', 'staff_member_name': 'Camila'},
            FABRICATED_NOTE, fetch_staff_info=fetch)
        self.assertEqual(actual, NEUTRAL_NOTES['en'])
        fetch.assert_called_once_with()

    def test_authoritative_note_is_sent_before_handoff_persistence(self):
        for configured_name in ('', 'Ale'):
            with self.subTest(configured_name=configured_name):
                timeline, sent, results = [], [], []
                phone = '+34900000001'
                event = SimpleNamespace(source=SimpleNamespace(chat_id=phone),
                                        text='I need a person')

                class Adapter:
                    async def send(self, chat_id, content, **kwargs):
                        timeline.append('send')
                        sent.append((chat_id, content, kwargs))
                        return SimpleNamespace(success=True, message_id='wamid.offline',
                                               raw_response={})

                def persist(path, payload):
                    self.assertEqual(path, '/conversation/needs-human')
                    self.assertEqual(timeline, ['send'])
                    timeline.append('persist')
                    return {'success': True, 'needs_human': True,
                            'conversation_paused': True,
                            'staff_handoff': {'id': 'offline-review'}}

                async def dispatch(_event):
                    params = {'reason': 'human_requested', 'language': 'en',
                              'staff_member_name': 'Camila', 'staff_name': 'Camila',
                              'guest_note': FABRICATED_NOTE}
                    results.append(json.loads(await asyncio.to_thread(
                        plugin.flag_needs_human, params)))

                async def run():
                    await handoff.dispatch_with_handoff_notice(
                        event, SimpleNamespace(adapter=Adapter(), dispatch_fn=dispatch))

                env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
                       'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}
                with patch.dict(os.environ, env), \
                     patch.object(notes, 'default_fetch_staff_info', return_value={
                         'staff_member_name': configured_name}) as fetch, \
                     patch.object(plugin, '_post_bot', side_effect=persist):
                    asyncio.run(run())
                expected = NAMED_NOTES if configured_name else NEUTRAL_NOTES
                self.assertEqual(sent, [(phone, expected['en'], {
                    'metadata': {'wolfhouse_guest_reply': True}})])
                self.assertEqual(timeline, ['send', 'persist'])
                self.assertTrue(results[0]['handoff_persisted'], results)
                self.assertTrue(results[0]['ack_sent'], results)
                fetch.assert_called_once_with()


if __name__ == '__main__':
    unittest.main()
