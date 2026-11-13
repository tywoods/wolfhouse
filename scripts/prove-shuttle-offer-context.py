#!/usr/bin/env python3
"""Deferred owner-hint regression: default is RED until Lookout's handoff lands.

Run --proposed-handoff to apply ONLY the proposed string replacement in memory.
Executes the real owner's function AST with fixture state, not a substitute
implementation. No runtime imports, network, model calls, or guest-state writes.
This checks advisory text, NOT whether the LLM follows it or a booking succeeds.
"""
import argparse
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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--proposed-handoff', action='store_true')
    args = parser.parse_args()
    path = ROOT / 'docker/hermes-staging/wolfhouse/accepted_quote.py'
    tree = ast.parse(path.read_text())
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef)
                    and n.name == 'shuttle_offer_context')
    replacements = 0
    if args.proposed_handoff:
        for node in ast.walk(function):
            if isinstance(node, ast.Constant) and isinstance(node.value, str) and OLD in node.value:
                node.value = node.value.replace(OLD, REPLACEMENT, 1)
                replacements += 1
        assert replacements == 1, 'Proposed handoff must replace exactly the known owner instruction'
    executable = compile(ast.Module(body=[function], type_ignores=[]), str(path), 'exec')
    observations = []
    failures = []
    for default_nights in (6, 5):
        plan = {'package_code': 'malibu', 'check_in': '2027-08-15', 'check_out': '2027-08-20',
                'guest_count': 2, 'room_preference': 'shared', 'nights': 5,
                'default_nights': default_nights,
                'package_includes': ([{'text': 'Free Santander airport shuttle', 'full_stay_only': True}]
                                     if 5 >= default_nights else [])}
        state = {'plan': plan, 'guest_language': 'en'}
        scope = {'deepcopy': deepcopy,
                 '_transaction': lambda callback, value=state: callback(deepcopy(value), None)}
        exec(executable, scope)
        actual = scope['shuttle_offer_context']()
        observations.append({'nights': 5, 'default_nights': default_nights, 'actual_hint': actual})
        context = (actual or {}).get('context', '')
        if (actual or {}).get('shuttle_offer_required') is False:
            # An excluded shuttle needs no explanatory offer instruction.
            if 5 >= default_nights:
                failures.append(f'5n/default-{default_nights}: qualifying shuttle must not be suppressed')
        elif OLD in context or REPLACEMENT not in context:
            failures.append(f'5n/default-{default_nights}: hint must defer to current stay-filtered Includes, not package presence')
        # Keep resolved-choice and accommodation-only protections intact.
        for extra in ({'shuttle_needed': False}, {'shuttle_choice': 'accepted'},
                      {'package_code': 'package_none'}):
            state['plan'] = dict(plan, **extra)
            assert scope['shuttle_offer_context']() is None, extra
    print(json.dumps({'mode': 'IN-MEMORY proposed handoff' if args.proposed_handoff else 'ACTUAL unchanged owner',
                      'boundary': 'advisory text only; no LLM/Staff/booking execution',
                      'observations': observations, 'failures': failures}, indent=2))
    if failures:
        raise SystemExit(1)
    print('PASS conditional owner wording and preserved resolved/accommodation-only suppression')


if __name__ == '__main__':
    main()
