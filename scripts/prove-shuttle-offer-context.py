#!/usr/bin/env python3
"""Deferred owner-hint regression: default is RED until Lookout's handoff lands.

Run --proposed-handoff to apply ONLY the proposed string replacement in memory.
Executes the real owner's function AST with fixture state, not a substitute
implementation. No runtime imports, network, model calls, or guest-state writes.
This checks advisory text, NOT whether the LLM follows it or a booking succeeds.

Eligibility is boolean in BOTH directions against the package's CURRENT
default_nights (never a hard-coded stay length): short stay → required False,
qualifying stay → required True. Wording is checked only on the qualifying
offer. A negative control mutates the short stay to True and MUST fail.
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

# Current package defaults under test — stay lengths are derived from these,
# never a hard-coded 5-night stay.
CURRENT_DEFAULT_NIGHTS = (8, 6, 4)


def eligibility_errors(nights, default_nights, actual):
    """Short stay (< current default) must be False; qualifying (>=) must be True."""
    required = (actual or {}).get('shuttle_offer_required')
    label = f'{nights}n/default-{default_nights}'
    if nights < default_nights:
        if required is not False:
            return [f'{label}: short stay must be shuttle_offer_required=False, got {required!r}']
        return []
    if required is not True:
        return [f'{label}: qualifying stay must be shuttle_offer_required=True, got {required!r}']
    return []


def fixture_state(nights, default_nights, extra_plan=None):
    plan = {
        'package_code': 'malibu',
        'check_in': '2027-08-15',
        'check_out': '2027-08-20',
        'guest_count': 2,
        'room_preference': 'shared',
        'nights': nights,
        'default_nights': default_nights,
        'package_includes': (
            [{'text': 'Free Santander airport shuttle', 'full_stay_only': True}]
            if nights >= default_nights else []
        ),
    }
    if extra_plan:
        plan.update(extra_plan)
    checked_offer = {
        'nights': nights,
        'default_nights': default_nights,
        'package_includes': plan['package_includes'],
    }
    return {'plan': plan, 'checked_offer': checked_offer, 'guest_language': 'en'}


def run_owner(scope, nights, default_nights, extra_plan=None):
    state = fixture_state(nights, default_nights, extra_plan)
    scope['_transaction'] = lambda callback, value=state: callback(deepcopy(value), None)
    return scope['shuttle_offer_context']()


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
    scope = {'deepcopy': deepcopy, '_transaction': None}
    exec(executable, scope)

    negative_control_ok = False
    for default_nights in CURRENT_DEFAULT_NIGHTS:
        assert default_nights > 1, 'default_nights must allow a shorter stay'
        short_nights = default_nights - 1
        qualifying_nights = default_nights

        short_actual = run_owner(scope, short_nights, default_nights)
        observations.append({
            'nights': short_nights, 'default_nights': default_nights,
            'kind': 'short', 'actual_hint': short_actual,
        })
        failures.extend(eligibility_errors(short_nights, default_nights, short_actual))

        mutated = dict(short_actual or {}, shuttle_offer_required=True)
        mutated_errors = eligibility_errors(short_nights, default_nights, mutated)
        if not mutated_errors:
            failures.append(
                f'{short_nights}n/default-{default_nights}: negative control failed — '
                'True on a short stay must not PASS'
            )
        else:
            negative_control_ok = True

        qual_actual = run_owner(scope, qualifying_nights, default_nights)
        observations.append({
            'nights': qualifying_nights, 'default_nights': default_nights,
            'kind': 'qualifying', 'actual_hint': qual_actual,
        })
        failures.extend(eligibility_errors(qualifying_nights, default_nights, qual_actual))
        context = (qual_actual or {}).get('context', '')
        if OLD in context or REPLACEMENT not in context:
            failures.append(
                f'{qualifying_nights}n/default-{default_nights}: qualifying-offer wording must '
                'defer to current stay-filtered Includes, not package presence'
            )

        # Keep resolved-choice and accommodation-only protections intact.
        for extra in ({'shuttle_needed': False}, {'shuttle_choice': 'accepted'},
                      {'package_code': 'package_none'}):
            suppressed = run_owner(scope, qualifying_nights, default_nights, extra)
            assert suppressed is None, extra

    print(json.dumps({
        'mode': 'IN-MEMORY proposed handoff' if args.proposed_handoff else 'ACTUAL unchanged owner',
        'boundary': 'advisory text only; no LLM/Staff/booking execution',
        'negative_control_rejects_true_on_short_stay': negative_control_ok,
        'observations': observations,
        'failures': failures,
    }, indent=2, default=str))
    if not negative_control_ok:
        raise SystemExit(1)
    if failures:
        raise SystemExit(1)
    print('PASS eligibility both directions, qualifying wording, preserved resolved/accommodation-only suppression')


if __name__ == '__main__':
    main()
