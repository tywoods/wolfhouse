"""Outbound-only copy tests: no model, send or booking operation."""
import os
import unittest
from unittest.mock import patch
from wolfhouse import accepted_quote as owner, output_guard as guard


class OutboundFormatTests(unittest.TestCase):
    def test_general_guest_replies_use_whatsapp_bold_at_shared_boundary(self):
        for text in ('Hello **Ari**!', '**Weather:** waves tomorrow.', '**Beach guide** is ready.'):
            expected = owner._whatsapp_emphasis(text)
            self.assertNotEqual(expected, text)
            self.assertEqual(guard.guard_reply(text, guest_lang='en')[0], expected)
            with patch.dict(os.environ, {'HERMES_ROLE': 'luna'}):
                self.assertEqual(guard.guard_turn_response(text, history=[], platform='whatsapp'), expected)

    def test_italian_weather_uses_onda_lunga_only_in_prose(self):
        text = '**Swell:** 1 m. `swell` https://example.com/swell'
        expected = '*Onda lunga:* 1 m. `swell` https://example.com/swell'
        self.assertEqual(guard.guard_reply(text, guest_lang='it')[0], expected)
        self.assertEqual(guard.guard_reply(text, guest_lang='en')[0], text.replace('**', '*'))
        self.assertEqual(guard.guard_reply('swell 1 m', guest_lang='it')[0], 'onda lunga 1 m')
        with patch.dict(os.environ, {'HERMES_ROLE': 'luna'}):
            self.assertEqual(guard.guard_turn_response(text, history=[], platform='whatsapp',
                             current_user='Ciao, grazie!'), expected)

    def test_operator_channels_are_byte_preserved(self):
        text = '**Code:** `**literal**` https://example.com/**swell**'
        with patch.dict(os.environ, {'HERMES_ROLE': 'orchestrator'}):
            self.assertEqual(guard.guard_turn_response(text, platform='discord'), text)

    def test_literals_and_existing_whatsapp_bold_are_preserved(self):
        text = r'**Hello** *Ari* `**code**` https://example.com/**literal** \*\*escaped\*\*'
        expected = text.replace('**Hello**', '*Hello*')
        actual = guard.guard_reply(text, guest_lang='en')[0]
        self.assertEqual(actual, expected)
        self.assertEqual(guard.guard_reply(actual, guest_lang='en')[0], expected)


if __name__ == '__main__':
    unittest.main()
