#!/usr/bin/env python3
"""Lookout: shuttle_offer_context reads checked_offer (Cap owns prove-shuttle-offer-context.py).

5 nights vs package default 6 must not require the shuttle question.
"""
import ast
from copy import deepcopy
import json
from pathlib import Path

OLD = 'Trusted package workflow: proactively offer the Santander airport shuttle now, '
REPLACEMENT = ('Trusted package workflow: only if current Staff stay-filtered Includes qualify '
               'the Santander airport shuttle for this stay (full-stay-only items require actual '
               'stay nights at least the current package default_nights, never a fixed number), '
               'offer it; if excluded, skip the shuttle question and continue booking without '
               'an added save condition or consent. For a qualifying shuttle only, offer it ')
ROOT = Path(__file__).resolve().parents[1]


def main():
    path = ROOT / 'docker/hermes-staging/wolfhouse/accepted_quote.py'
    tree = ast.parse(path.read_text())
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                    and n.name == 'shuttle_offer_context')
    executable = compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec')
    observations = []
    failures = []
    for default_nights in (6, 5):
        plan = {'package_code': 'malibu', 'check_in': '2027-08-15', 'check_out': '2027-08-20',
                'guest_count': 2, 'room_preference': 'shared', 'nights': 5,
                'default_nights': default_nights}
        checked_offer = {
            'nights': 5,
            'default_nights': default_nights,
            'package_includes': (
                [{'text': 'Free Santander airport shuttle', 'full_stay_only': True}]
                if 5 >= default_nights else []
            ),
        }
        state = {'plan': plan, 'checked_offer': checked_offer, 'guest_language': 'en'}
        scope = {'deepcopy': deepcopy,
                 '_transaction': lambda callback, value=state: callback(deepcopy(value), None)}
        exec(executable, scope)
        actual = scope['shuttle_offer_context']()
        observations.append({'nights': 5, 'default_nights': default_nights, 'actual_hint': actual})
        if default_nights == 6:
            if not actual or actual.get('shuttle_offer_required') is not False:
                failures.append('5n/default-6: shuttle_offer_required must be false')
        else:
            context = (actual or {}).get('context', '')
            if OLD in context or REPLACEMENT not in context:
                failures.append('5n/default-5: hint must defer to stay-filtered Includes')
            if not actual or actual.get('shuttle_offer_required') is not True:
                failures.append('5n/default-5: shuttle_offer_required must be true')
        for extra in ({'shuttle_needed': False}, {'shuttle_choice': 'accepted'},
                      {'package_code': 'package_none'}):
            state['plan'] = dict(plan, **extra)
            assert scope['shuttle_offer_context']() is None, extra
    print(json.dumps({'observations': observations, 'failures': failures}, indent=2, default=str))
    if failures:
        raise SystemExit(1)
    print('PASS checked_offer fixture: 5 vs default 6 is not required')


if __name__ == '__main__':
    main()
