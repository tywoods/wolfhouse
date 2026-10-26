#!/usr/bin/env python3
"""Parser/owner-graph invariants, independent of captured probe sentence lists."""
import copy
import itertools
import json
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/lib'))
from luna_v3_rendered_claims import diagnose_reply, parse_reply, reply_truth


def data(currency='CAD', a='Nia', b='Omar'):
    return {'currency': currency, 'total_cents': 57825, 'deposit_cents': 17000,
            'remaining_cents': 40825, 'check_in': '2031-04-03', 'check_out': '2031-04-09',
            'package': {'per_guest': [{'name': a, 'code': 'p_alpha'}, {'name': b, 'code': 'p_beta'}]},
            'add_ons': [{'code': 'a_delta', 'quantity': 3, 'people': [a], 'dates': ['2031-04-05']},
                        {'code': 'a_gamma', 'quantity': 4, 'people': [b], 'dates': ['2031-04-06']}],
            'inclusions': ['breakfast', 'bed linen'], 'terms': ['subject to availability']}


def text(f):
    a, b = (p['name'] for p in f['package']['per_guest'])
    c = f['currency']
    return (f"2031-04-03 to 2031-04-09. {a}: p_alpha; {b}: p_beta. "
            f"{a}: 3 a_delta on 2031-04-05. {b}: 4 a_gamma on 2031-04-06. "
            f"Total {c} 578.25; deposit {c} 170.00; remaining {c} 408.25.")


def grade(reply, facts):
    return reply_truth(reply, {'expect': 'quote'}, facts, {'ok': True, 'state': 'quote'})


class SemanticInvariants(unittest.TestCase):
    def test_coordinated_activity_descriptors_preserve_relations(self):
        f = data()
        for descriptor in ('rental/lesson', 'lessons / rentals', 'add-on/lesson/rental'):
            reply = text(f).replace('a_delta on', 'a_delta '+descriptor+' on')
            with self.subTest(descriptor=descriptor):
                self.assertTrue(grade(reply, f))
                self.assertFalse(grade(reply.replace('3 a_delta', '8 a_delta'), f))
                self.assertFalse(grade(reply.replace('2031-04-05', '2031-04-06'), f))
        self.assertFalse(grade(text(f).replace('a_delta on', 'a_delta rental/payment on'), f))

    def test_generated_entity_currency_and_order_substitutions(self):
        for currency, names in itertools.product(('CAD', 'BHD', 'ZAR'), (('Nia', 'Omar'), ('Inez', 'Tao'))):
            f = data(currency, *names)
            clauses = text(f).split('. ')
            for order in (clauses, clauses[::-1]):
                # No activity references here: independent clauses commute.
                reply = '. '.join(c.rstrip('.') for c in order) + '.'
                with self.subTest(currency=currency, names=names, order=order):
                    self.assertTrue(grade(reply, f))
            for old, new in (('578.25', '170.00'), ('p_alpha', 'p_beta'),
                             ('3 a_delta', '4 a_delta'), ('on 2031-04-05', 'on 2031-04-06')):
                with self.subTest(currency=currency, names=names, mutation=(old, new)):
                    self.assertFalse(grade(text(f).replace(old, new), f))

    def test_parse_spans_and_typed_roles_are_auditable(self):
        f = data()
        reply = text(f) + ' The total is not equal to CAD 800.00. Includes breakfast and bed linen.'
        parsed = parse_reply(reply, f)
        self.assertFalse(parsed.unparsed)
        covered = set()
        for start, end, rule in parsed.consumed:
            self.assertTrue(rule)
            self.assertGreater(end, start)
            self.assertLessEqual(end, len(reply))
            covered.update(range(start, end))
        self.assertTrue(all(index in covered for index, ch in enumerate(reply) if not ch.isspace()))
        negative = next(p for p in parsed.propositions if p.predicate == 'money:total' and not p.polarity)
        self.assertEqual(negative.subject, 'quote')
        self.assertEqual(negative.object, ('CAD', 80000))
        self.assertIn('not equal', reply[slice(*negative.span)])
        self.assertTrue(grade(reply, f))
        json.dumps(diagnose_reply(reply, {'expect': 'quote'}, f, {'ok': True}))

    def test_unknown_clause_is_exposed_not_invented_as_a_known_predicate(self):
        f = data()
        suffix = 'The lighthouse tour departs at noon'
        diagnostic = diagnose_reply(text(f) + ' ' + suffix + '.', {'expect': 'quote'}, f, {'ok': True})
        self.assertFalse(diagnostic['truth'])
        self.assertTrue(any(span[2] == suffix for span in diagnostic['unparsed']))

    def test_ambiguous_explicit_reference_does_not_guess_person(self):
        f = data()
        f['add_ons'][1]['code'] = 'a_delta'
        reply = text(f).replace('4 a_gamma', '4 a_delta')
        self.assertTrue(grade(reply, f))
        self.assertFalse(grade(reply + ' The a_delta quantity is three.', f))
        self.assertFalse(grade(reply + ' The a_delta quantity is not eight.', f))

    def test_negated_group_package_must_be_false_for_every_person(self):
        f = data()
        self.assertFalse(grade(text(f) + ' Nia and Omar do not have p_alpha.', f))
        self.assertTrue(grade(text(f) + ' Nia and Omar do not have p_other.', f))

    def test_partial_activity_negation_does_not_invent_missing_dates(self):
        f = data()
        for suffix in ('Nia does not get 3 a_delta.', 'Nia does not have a_delta.'):
            with self.subTest(suffix=suffix):
                self.assertFalse(grade(text(f) + ' ' + suffix, f))
        self.assertTrue(grade(text(f) + ' Nia does not get 9 a_delta.', f))
        self.assertTrue(grade(text(f) + ' Omar does not have a_delta.', f))
        self.assertTrue(grade(text(f) + ' Nia has a_delta.', f))


if __name__ == '__main__':
    unittest.main(verbosity=2)
