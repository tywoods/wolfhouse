#!/usr/bin/env python3
"""Offline inclusion/price regression: retained owner captures + explicit test controls.
Controls are synthetic owner HTTP inputs through the real plugin, not live receipts.
No fixture/expectation files are changed; transport is denied by produce().
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/lib'))
from luna_v3_grader_test_support import produce, TEST_AUTHORITY
from luna_v3_rendered_claims import diagnose_reply, parse_reply

spec = importlib.util.spec_from_file_location('price_matrix', ROOT / 'scripts/run-luna-v3-rendered-reply-matrix.py')
assert spec and spec.loader
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def reply(f):
    parts = [f"{f['check_in']} to {f['check_out']}",
             *[f"{role.title()} {f['currency']} {f[role + '_cents']/100:.2f}"
               for role in ('total', 'deposit', 'remaining')]]
    package = f['package']
    parts.extend([f"{p['name']}: {p['code']}" for p in package['per_guest']]
                 if 'per_guest' in package else [package['code']])
    parts.extend(f"{', '.join(a['people'])}: {a['quantity']} {a['code']} on {', '.join(a['dates'])}"
                 for a in f['add_ons'])
    return '. '.join(parts) + '.'


class InclusionPriceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.report = []
        fixture = json.loads((ROOT / 'fixtures/luna-v3-grader-owner/matrix-fixture.json').read_text())
        cls.sources = {c['category']: c for c in fixture['cases']
                       if c['category'] in ('package', 'rental', 'service:lesson_a', 'mixed', 'multi_guest')}

    @classmethod
    def tearDownClass(cls):
        if os.environ.get('LUNA_PRICE_REPORT'):
            Path(os.environ['LUNA_PRICE_REPORT']).write_text(json.dumps(cls.report, indent=2) + '\n')

    def context(self, kind, mutate=None):
        source = self.sources[kind]
        owner = json.loads(source['owner_execution_receipt']['evidence']['prepare']['body'])
        if mutate:
            mutate(owner)
        args = m._public_prepare(source['control'])
        # Test controls may vary selections, but the public request remains bound.
        args['add_ons'] = copy.deepcopy(owner['add_ons'])
        call, result, receipt = produce(args, owner, event_id='price-test')
        facts = m.canonical_facts(result)
        expected_facts = copy.deepcopy(facts)
        for p in expected_facts['package'].get('per_guest', []):
            p['guest_name'] = p.pop('name')  # intended-outcome wire schema
        outcome = {'expect': source['intended_owner_outcome']['expect'], 'facts': expected_facts}
        case = dict(expect=outcome['expect'], prepare_required=True, intended_owner_outcome=outcome)
        case['_price_kind'], case['_price_control'] = kind, mutate is not None
        return case, facts, call, result, receipt

    def check(self, ctx, suffix, expected):
        case, facts, call, result, receipt = ctx
        text = reply(facts) + ' ' + suffix
        d = diagnose_reply(text, case['intended_owner_outcome'], facts, result)
        score = m.semantic_score(case, text, [call], [result], receipt,
                                 current_event_id='price-test', expected_authority=TEST_AUTHORITY)
        self.report.append(dict(test=self.id(), kind=case['_price_kind'], synthetic_control=case['_price_control'],
                                reply=text, expected=expected, direct=d['truth'], composed=score['fidelity'],
                                diagnostic=d, lineItems=result['quote'].get('lineItems'),
                                package_details=result.get('package_details')))
        self.assertIs(d['truth'], expected, (suffix, d))
        self.assertIs(score['fidelity'], expected, (suffix, score))

    def test_paid_board_cannot_be_certified_free(self):
        ctx = self.context('rental')
        self.check(ctx, '', True)
        self.check(ctx, 'board is free.', False)
        self.check(ctx, 'board is not free.', True)

    def test_selection_quote_inclusion_and_scoped_inclusion_are_distinct(self):
        ctx = self.context('mixed')
        for suffix in ('board.', 'board is included.', 'Your quote includes board.',
                       'board is included in your quote.'):
            with self.subTest(suffix=suffix):
                self.check(ctx, suffix, True)
        for suffix in ('board is included with your package.', 'Your package includes board.',
                       'board comes with your stay.', 'Your stay includes board.'):
            with self.subTest(suffix=suffix):
                self.check(ctx, suffix, False)
        included = self.context('mixed', lambda o: o['package_details']['includes'].append('board'))
        for scope in ('package', 'stay'):
            self.check(included, f'board is included with your {scope}.', True)
            self.check(included, f'board is not included with your {scope}.', False)
            self.check(included, f'board is free with your {scope}.', False)
        facts = ctx[1]
        claims = parse_reply('board. board included. board included with your package. '
                             'board included with your stay. board free.', facts).propositions
        self.assertEqual(len({(p.subject, p.predicate) for p in claims}), 5)

    def test_zero_charge_does_not_establish_package_scope(self):
        def zero(o):
            row = o['quote']['lineItems'][-1]
            delta = row['total_cents']
            row['unit_cents'] = row['total_cents'] = 0
            o['quote']['totalCents'] -= delta
            o['quote']['remainingCents'] -= delta
        ctx = self.context('mixed', zero)
        self.check(ctx, 'board is free.', True)
        self.check(ctx, 'board is free with your package.', False)
        self.check(ctx, 'board is free with your stay.', False)

    def test_actual_fixture_kinds_price_evidence_not_selection(self):
        # These captures have NO lesson line items: both price signs are unknown.
        expected_paid = {
            'package': {'malibu': True},
            'rental': {'package_none': True, 'board': True},
            'service:lesson_a': {'package_none': True, 'group_lesson': False},
            'mixed': {'malibu': True, 'board': True, 'group_lesson': False},
            'multi_guest': {'malibu': True, 'package_none': True, 'board': True, 'private_lesson': False},
        }
        for kind, products in expected_paid.items():
            ctx = self.context(kind)
            for code, paid in products.items():
                with self.subTest(kind=kind, code=code):
                    self.check(ctx, f'{code} is included in your quote.', True)
                    self.check(ctx, f'{code} is free.', False)
                    self.check(ctx, f'{code} is not free.', paid)
                    for scope in ('package', 'stay'):
                        self.check(ctx, f'{code} is included with your {scope}.', False)

    def test_zero_price_controls_across_actual_fixture_kinds(self):
        for kind in self.sources:
            def zero(o):
                # Explicit zero rows even for services absent from the capture.
                codes = {row['code'] for row in o['quote']['lineItems']}
                for addon in o['add_ons']:
                    if addon['code'] not in codes:
                        o['quote']['lineItems'].append({'code': addon['code'], 'quantity': addon['quantity'],
                                                      'unit_cents': 0, 'total_cents': 0})
                for row in o['quote']['lineItems']:
                    row['unit_cents'] = row['total_cents'] = 0
                for key in ('totalCents', 'depositCents', 'remainingCents'):
                    o['quote'][key] = 0
            ctx = self.context(kind, zero)
            f = ctx[1]
            package = f['package']
            codes = [p['code'] for p in package['per_guest']] if 'per_guest' in package else [package['code']]
            codes += [a['code'] for a in f['add_ons']]
            for code in codes:
                with self.subTest(kind=kind, code=code):
                    self.check(ctx, f'{code} is free.', True)
                    self.check(ctx, f'{code} is not free.', False)

    def test_unknown_or_malformed_prices_fail_closed_for_both_signs(self):
        mutations = [lambda o: o['quote'].pop('lineItems'),
                     lambda o: o['quote'].update(lineItems=[]),
                     lambda o: o['quote']['lineItems'][-1].pop('unit_cents'),
                     lambda o: o['quote']['lineItems'][-1].pop('total_cents')]
        mutations += [lambda o, field=field, value=value: o['quote']['lineItems'][-1].update({field: value})
                      for field, value in [('unit_cents', False), ('total_cents', '0'),
                                           ('total_cents', -1), ('unit_cents', 0),
                                           ('quantity', 0), ('quantity', True)]]
        for index, mutate in enumerate(mutations):
            ctx = self.context('rental', mutate)
            for sign in ('', 'not '):
                with self.subTest(mutation=index, sign=sign):
                    self.check(ctx, f'board is {sign}free.', False)
        ctx = self.context('rental')
        for sign in ('', 'not '):
            self.check(ctx, f'helicopter is {sign}free.', False)

    def test_prices_follow_codes_quantities_and_all_matching_rows(self):
        for code in ('board', 'kayak', 'group_lesson', 'private_lesson'):
            for quantity in (1, 3):
                for unit in (0, 1700):
                    def control(o):
                        o['add_ons'][0].update(code=code, quantity=quantity)
                        row = o['quote']['lineItems'][-1]
                        delta = unit * quantity - row['total_cents']
                        row.update(code=code, quantity=quantity, unit_cents=unit, total_cents=unit * quantity)
                        o['quote']['totalCents'] += delta
                        o['quote']['remainingCents'] += delta
                    ctx = self.context('rental', control)
                    with self.subTest(code=code, quantity=quantity, unit=unit):
                        self.check(ctx, f'{code} is free.', unit == 0)
                        self.check(ctx, f'{code} is not free.', unit > 0)
                        self.check(ctx, f'{code} is included.', True)
                        self.check(ctx, f'{code} is included with your package.', False)
        def extra_zero(o):
            o['quote']['lineItems'].append({'code': 'board', 'quantity': 2, 'unit_cents': 0, 'total_cents': 0})
        ctx = self.context('rental', extra_zero)
        self.check(ctx, 'board is free.', False)
        self.check(ctx, 'board is not free.', True)
        def extra_unknown(o):
            extra_zero(o)
            o['quote']['lineItems'][-1].pop('total_cents')
        ctx = self.context('rental', extra_unknown)
        self.check(ctx, 'board is free.', False)
        self.check(ctx, 'board is not free.', False)

    def test_positive_scoped_free_needs_both_price_and_inclusion(self):
        def included_zero(o):
            row = o['quote']['lineItems'][-1]
            delta = row['total_cents']
            row['unit_cents'] = row['total_cents'] = 0
            o['quote']['totalCents'] -= delta
            o['quote']['remainingCents'] -= delta
            o['package_details']['includes'].append('board')
        ctx = self.context('mixed', included_zero)
        for scope in ('quote', 'stay', 'package'):
            self.check(ctx, f'board is free with your {scope}.', True)
            self.check(ctx, f'board is not free with your {scope}.', False)
            self.check(ctx, f'board is included with your {scope}.', True)
        # Paid and free conjuncts retain their own relation, polarity and scope.
        self.check(ctx, 'board is free and malibu is not free.', True)
        self.check(ctx, 'board and malibu are free.', False)
        self.check(ctx, 'board is included with your package and malibu is free.', False)

    def test_missing_service_prices_need_explicit_positive_charge(self):
        for kind, code in (('service:lesson_a', 'group_lesson'), ('mixed', 'group_lesson'),
                           ('multi_guest', 'private_lesson')):
            def charge(o):
                addon = next(a for a in o['add_ons'] if a['code'] == code)
                addon['quantity'] = 3
                o['quote']['lineItems'].append({'code': code, 'quantity': 3, 'unit_cents': 700, 'total_cents': 2100})
                o['quote']['totalCents'] += 2100
                o['quote']['remainingCents'] += 2100
            with self.subTest(kind=kind, code=code):
                ctx = self.context(kind, charge)
                self.check(ctx, f'{code} is free.', False)
                self.check(ctx, f'{code} is not free.', True)

    def test_projected_stay_and_unscoped_inclusions_preserve_unknown_evidence(self):
        for details, negative in (([], False), ({'code': 'malibu', 'includes': []}, True)):
            ctx = self.context('mixed', lambda o: o.update(package_details=copy.deepcopy(details)))
            for code in ('board', 'breakfast'):
                for suffix in (f'{code} is not included with your stay.',
                               f'Your stay does not include {code}.'):
                    with self.subTest(details=details, suffix=suffix):
                        self.check(ctx, suffix, negative)
            # Bare non-catalog inclusion clauses use the same stay evidence.
            self.check(ctx, 'breakfast is not included.', negative)
        ctx = self.context('multi_guest', lambda o: o.update(package_details=[{'code': 'package_none', 'includes': []}]))
        self.check(ctx, 'board is not included with your stay.', False)

    def test_package_absence_requires_complete_selected_scope_evidence(self):
        # Missing rows are unknown; explicit empty rows are exclusion evidence.
        for kind, rows, negative in (
            ('mixed', [], False),
            ('mixed', {'code': 'malibu', 'includes': []}, True),
            ('multi_guest', [{'code': 'package_none', 'includes': []}], False),
            ('multi_guest', [{'code': 'malibu', 'includes': []}], True),
        ):
            ctx = self.context(kind, lambda o: o.update(package_details=copy.deepcopy(rows)))
            for code in ('board', 'stay'):
                with self.subTest(kind=kind, rows=rows, code=code):
                    self.check(ctx, f'{code} is included with your package.', False)
                    self.check(ctx, f'{code} is not included with your package.', negative)

    def test_package_scope_duplicates_must_agree(self):
        for second, included, excluded in (
            (['board', 'stay'], True, False),
            (['stay', 'board'], True, False),
            ([], False, False),
            (['stay'], False, False),
            ([None], False, False),
        ):
            rows = [{'code': 'malibu', 'includes': ['stay', 'board']},
                    {'code': 'MALIBU', 'includes': second}]
            for ordered in (rows, rows[::-1]):
                ctx = self.context('mixed', lambda o: o.update(package_details=copy.deepcopy(ordered)))
                with self.subTest(rows=ordered):
                    self.check(ctx, 'board is included with your package.', included)
                    self.check(ctx, 'board is not included with your package.', excluded)
                    # Even an unrelated absence cannot be certified from conflicts.
                    self.check(ctx, 'helicopter is not included with your package.', included)
        ctx = self.context('mixed', lambda o: o.update(package_details=[
            {'code': 'malibu', 'includes': []}, {'code': 'malibu', 'includes': []}]))
        self.check(ctx, 'board is not included with your package.', True)

    def test_no_package_scope_is_explicit_and_aggregate_positives_survive(self):
        # package_none contributes no package inclusions and needs no detail row.
        for rows in ([], [{'code': 'package_none', 'includes': []}]):
            ctx = self.context('rental', lambda o: o.update(package_details=copy.deepcopy(rows)))
            self.check(ctx, 'board is included with your package.', False)
            self.check(ctx, 'board is not included with your package.', True)
        # Contradictory no-package metadata is not positive or negative evidence.
        ctx = self.context('rental', lambda o: o.update(package_details=[
            {'code': 'package_none', 'includes': ['board']}]))
        self.check(ctx, 'board is included with your package.', False)
        self.check(ctx, 'board is not included with your package.', False)
        full = [{'code': 'malibu', 'includes': ['stay', 'board']},
                {'code': 'package_none', 'includes': []}]
        for rows in (full, full[::-1], full[:1]):
            ctx = self.context('multi_guest', lambda o: o.update(package_details=copy.deepcopy(rows)))
            self.check(ctx, 'board is included with your package.', True)
            self.check(ctx, 'board is not included with your package.', False)
            self.check(ctx, 'helicopter is not included with your package.', True)

    def test_foreign_package_details_are_not_selected_package_inclusions(self):
        def foreign(o):
            o['package_details'] = {'code': 'foreign_package', 'includes': ['board'], 'terms': []}
        ctx = self.context('mixed', foreign)
        self.check(ctx, 'board is included with your package.', False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
