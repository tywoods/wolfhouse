import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


class SurfWeatherFallbackPromptTests(unittest.TestCase):
    def test_typed_stormglass_failure_requires_bounded_public_fallback(self):
        soul = (ROOT.parent / 'SOUL.md').read_text()
        rule = next(line for line in soul.splitlines() if line.startswith('Use **get_surf_report first**'))
        self.assertIn('With unavailable/typed failure, when Intelligence is ON call **search_public_info** and **read_public_source**', rule)
        self.assertIn('otherwise explain the specific limit without inventing a forecast', rule)
        self.assertIn('Never claim a public-source forecast was Stormglass', rule)
        self.assertIn('never answer beyond the retrieved evidence', rule)

    def test_short_tide_question_requires_automatic_public_lookup(self):
        soul = (ROOT.parent / 'SOUL.md').read_text()
        rule = next(line for line in soul.splitlines() if line.startswith('Use **get_surf_report first**'))
        self.assertIn(
            'For any tide question, including a short request such as “tides today?”, '
            'if `tide_height_m` is named in `missing_fields` and Intelligence is ON, '
            'you must call **search_public_info** and **read_public_source** automatically',
            rule,
        )
        self.assertIn('Do not wait for the guest to ask you to check a public source', rule)


if __name__ == '__main__':
    unittest.main()