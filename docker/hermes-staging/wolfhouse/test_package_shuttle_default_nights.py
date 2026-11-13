"""Shuttle context reads checked_offer; 4n vs default 6 is not required."""

from __future__ import annotations

import ast
import unittest
from copy import deepcopy
from pathlib import Path


def _load_shuttle_offer_context():
    path = Path(__file__).with_name('accepted_quote.py')
    tree = ast.parse(path.read_text(), filename=str(path))
    fn = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == 'shuttle_offer_context'
    )
    module = ast.Module(body=[fn], type_ignores=[])
    ast.fix_missing_locations(module)
    return compile(module, str(path), 'exec'), path.read_text()


EXECUTABLE, SOURCE = _load_shuttle_offer_context()
OWNER_HINT = (
    'Trusted package workflow: only if current Staff stay-filtered Includes qualify '
    'the Santander airport shuttle for this stay (full-stay-only items require actual '
    'stay nights at least the current package default_nights, never a fixed number), '
    'offer it; if excluded, skip the shuttle question and continue booking without '
    'an added save condition or consent. For a qualifying shuttle only, offer it '
)
OLD_HINT = 'Trusted package workflow: proactively offer the Santander airport shuttle now, '


def _run(state):
    scope = {
        'deepcopy': deepcopy,
        '_transaction': lambda callback, value=state: callback(deepcopy(value), None),
    }
    exec(EXECUTABLE, scope)  # noqa: S102 — owner AST only
    return scope['shuttle_offer_context']()


class ShuttleCheckedOfferTests(unittest.TestCase):
    def test_owner_hint_one_liner_present(self):
        self.assertIn(OWNER_HINT, SOURCE)
        self.assertNotIn(OLD_HINT, SOURCE)
        self.assertIn("state.get('checked_offer')", SOURCE)
        self.assertNotIn("state.get('offer')", SOURCE.split('def shuttle_offer_context')[1].split('def ')[0])

    def test_four_nights_vs_default_six_not_required(self):
        actual = _run({
            'plan': {'package_code': 'malibu'},
            'checked_offer': {'nights': 4, 'default_nights': 6},
            'guest_language': 'en',
        })
        self.assertIsNotNone(actual)
        self.assertIs(actual.get('shuttle_offer_required'), False)

    def test_state_offer_is_ignored(self):
        actual = _run({
            'plan': {'package_code': 'malibu'},
            'offer': {'nights': 4, 'default_nights': 6},
            'checked_offer': {'nights': 6, 'default_nights': 6},
            'guest_language': 'en',
        })
        self.assertIs(actual.get('shuttle_offer_required'), True)
        self.assertIn(OWNER_HINT, actual.get('context') or '')


if __name__ == '__main__':
    unittest.main()
