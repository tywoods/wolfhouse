"""Full-stay shuttle uses package default_nights — no hard-coded night count."""

from __future__ import annotations

import ast
import unittest
from pathlib import Path


def _load_helper():
    path = Path(__file__).with_name('accepted_quote.py')
    tree = ast.parse(path.read_text(), filename=str(path))
    fn = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == 'full_stay_shuttle_applies'
    )
    module = ast.Module(body=[fn], type_ignores=[])
    ast.fix_missing_locations(module)
    ns = {}
    exec(compile(module, str(path), 'exec'), ns)  # noqa: S102 — load helper only
    return ns['full_stay_shuttle_applies'], path.read_text()


applies, SOURCE = _load_helper()


class FullStayShuttleDefaultNightsTests(unittest.TestCase):
    def test_under_default_nights_skips_shuttle(self):
        self.assertFalse(applies(
            {'nights': 4, 'package_code': 'waimea'},
            {'default_nights': 6, 'nights': 4}))

    def test_meeting_default_nights_keeps_shuttle(self):
        self.assertTrue(applies(
            {'nights': 6, 'package_code': 'waimea'},
            {'default_nights': 6, 'nights': 6,
             'package_includes': ['airport shuttle']}))

    def test_no_hard_coded_night_count(self):
        self.assertNotIn('nights < 6', SOURCE)
        self.assertNotIn('nights < 7', SOURCE)
        self.assertIn('default_nights', SOURCE)

    def test_includes_without_shuttle_skips(self):
        self.assertFalse(applies(
            {'nights': 6},
            {'default_nights': 6, 'nights': 6,
             'package_includes': ['daily yoga', 'breakfast']}))


if __name__ == '__main__':
    unittest.main()
