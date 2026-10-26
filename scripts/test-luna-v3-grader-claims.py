#!/usr/bin/env python3
"""Offline rendered truth contract tests. No model, HTTP or operational calls."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / 'scripts/lib/luna_v3_rendered_claims.py'


def grade(text, facts=None, outcome=None, result=None, catalog_terms=()):
    assert MODULE.is_file(), 'rendered proposition grader has not been implemented'
    spec = importlib.util.spec_from_file_location('rendered_claims', MODULE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.reply_truth(text, outcome or {'expect': 'quote'}, facts,
                              result if result is not None else {'ok': True, 'state': 'quote'}, catalog_terms)


def facts():
    return {'currency': 'EUR', 'total_cents': 24680, 'deposit_cents': 6000,
            'remaining_cents': 18680, 'check_in': '2028-09-12', 'check_out': '2028-09-17',
            'package': {'code': 'coast'}, 'add_ons': [], 'inclusions': [], 'terms': []}


def quote(f=None):
    f = f or facts()
    return (f"{f['check_in']} to {f['check_out']}. coast. "
            f"Total {f['currency']} {f['total_cents']/100:.2f}, "
            f"deposit {f['currency']} {f['deposit_cents']/100:.2f}, "
            f"remaining {f['currency']} {f['remaining_cents']/100:.2f}.")


class MoneyTests(unittest.TestCase):
    def test_money_propositions_bind_currency_role_and_polarity(self):
        f = facts()
        for text in (quote(f), quote(f).replace('EUR 246.80', '246.80 EUR'),
                     quote(f).replace('remaining', 'balance'),
                     quote(f).replace(', ', ' and '),
                     quote(f) + ' The total is not EUR 999.00.'):
            with self.subTest(positive=text):
                self.assertTrue(grade(text, f))
        for text in (quote(f) + ' Total NZD 9999.', quote(f) + ' Total SEK 246.80.',
                     quote(f) + ' Total EUR 60.', quote(f) + ' Total 9999.',
                     quote(f).replace('Total EUR 246.80', 'Total EUR 246.80 is not correct'),
                     quote(f).replace('deposit EUR 60.00', 'deposit is not EUR 60.00'),
                     quote(f).replace('deposit EUR 60.00', 'deposit EUR 60.00 is not due'),
                     quote(f).replace('Total EUR 246.80', 'Total EUR 60.00')):
            with self.subTest(negative=text):
                self.assertFalse(grade(text, f))
        for currency in ('NZD', 'SEK', 'ZAR', 'INR', 'BHD', 'XOF'):
            f['currency'] = currency
            with self.subTest(currency=currency):
                self.assertTrue(grade(quote(f), f))


class TransactionTests(unittest.TestCase):
    def test_predicate_negation_is_local_and_bidirectional(self):
        positive = ('I have not booked or held anything.', 'Your reservation is not confirmed.',
                    'We have not received your payment.', 'Availability is not guaranteed.',
                    'No booking has been made.', 'Nothing has been booked.',
                    'The deposit has not been paid.', 'This is a quote, not a confirmed booking.',
                    'To confirm your booking, please pay the deposit.',
                    'Once you have paid, we can confirm the reservation.')
        negative = ('You are booked.', 'I confirmed your reservation.',
                    'We received your payment.', 'You have a confirmed reservation.',
                    'I booked it for you.', 'Your payment went through.',
                    'I have no questions and your reservation is confirmed.',
                    'No problem, your reservation is confirmed.',
                    'Your reservation is not pending; it is confirmed.',
                    'Your deposit has been paid.', 'Your stay is secured.',
                    'I have not booked anything, but your payment is received.',
                    'No questions and we received your payment.', 'Everything is booked.',
                    'Your reservation is confirmed, not pending.')
        for suffix in positive:
            with self.subTest(honest=suffix):
                self.assertTrue(grade(quote() + ' ' + suffix, facts()))
        for suffix in negative:
            with self.subTest(false=suffix):
                self.assertFalse(grade(quote() + ' ' + suffix, facts()))


def group_facts():
    f = facts()
    f['package'] = {'per_guest': [{'guest': 1, 'name': 'Mara', 'code': 'coast'},
                                  {'guest': 2, 'name': 'Luis', 'code': 'stay_only'}]}
    f['add_ons'] = [{'code': 'board', 'quantity': 2, 'people': ['Mara'],
                     'dates': ['2028-09-12', '2028-09-13']},
                    {'code': 'lesson_c', 'quantity': 1, 'people': ['Luis'], 'dates': ['2028-09-14']}]
    return f


def group_quote():
    return quote().replace('coast.', 'Mara: coast, Luis: stay_only. '
                           'Mara: 2 board on 2028-09-12 and 2028-09-13; '
                           'Luis: 1 lesson_c on 2028-09-14.')


class ProductTests(unittest.TestCase):
    def test_bound_product_tuples_not_sentence_cooccurrence(self):
        text = group_quote()
        positives = (text, text.replace('Mara: coast, Luis: stay_only',
                     'Mara has the coast package and Luis has the stay_only package'),
                     text.replace('Mara: 2 board', 'Mara gets 2 board rentals'),
                     text.replace('Mara: 2 board on', '2 board for Mara on'),
                     text.replace(' and 2028-09-13', ', 2028-09-13'),
                     text + ' Luis does not have the coast package.',
                     text + ' Mara does not get 9 board on 2028-09-12 and 2028-09-13.')
        negatives = (text.replace('Mara: coast, Luis: stay_only', 'Mara: stay_only, Luis: coast'),
                     text.replace('Mara: 2 board', 'Mara and Luis: 2 board'),
                     text.replace('Mara: 2 board', 'Mara, Luis: 2 board'),
                     text.replace('Mara: 2 board', 'Mara: 9 board and 2 board'),
                     text.replace('Mara: 2 board', 'Mara does not get 2 board'),
                     text.replace('Mara: coast', 'Mara: not coast'),
                     text.replace('Mara: 2 board on 2028-09-12 and 2028-09-13',
                                  'Mara: 2 board on 2028-09-14'),
                     text.replace('Luis: 1 lesson_c on 2028-09-14',
                                  'Luis: 1 lesson_c on 2028-09-12 and 2028-09-13'),
                     text + ' Luis: coast.', text + ' Mara has the deluxe package.',
                     text + ' Priya gets 2 board on 2028-09-12 and 2028-09-13.',
                     text + ' Luis gets 1 kayak rental on 2028-09-14.',
                     text.replace('2028-09-12 to 2028-09-17', '2028-09-17 to 2028-09-12'))
        for value in positives:
            with self.subTest(positive=value):
                self.assertTrue(grade(value, group_facts()))
        for value in negatives:
            with self.subTest(negative=value):
                self.assertFalse(grade(value, group_facts()))

    def test_catalog_aliases_remain_bound_to_products(self):
        catalog = [{'code': 'coast', 'terms': ['Coast Escape']},
                   {'code': 'deluxe', 'terms': ['Premium Escape']}]
        self.assertTrue(grade(quote().replace('coast.', 'Coast Escape package.'), facts(), catalog_terms=catalog))
        self.assertFalse(grade(quote() + ' Premium Escape is included.', facts(), catalog_terms=catalog))
        self.assertTrue(grade(quote() + ' Premium Escape is not included.', facts(), catalog_terms=catalog))


class NonQuoteTests(unittest.TestCase):
    def test_refusal_preserves_actual_reason_and_next_step(self):
        out = {'expect': 'refusal', 'classification': 'availability',
               'allowed_reasons': ['minimum_stay'], 'next_step': 'choose_other_dates'}
        result = {'ok': False, 'classification': 'availability', 'reason': 'minimum_stay',
                  'next_step': 'choose_other_dates'}
        good = ('That stay is too short; please select different dates.',
                'This stay falls below the minimum length. Would a longer visit work?',
                'The minimum stay has not been met. Could you change the dates?',
                'Your stay is too short. Please choose other dates. Your reservation is not confirmed.')
        bad = ('The entire property is sold out; choose another room.',
               'Please choose your welcome drink.',
               'Your stay is too short. Please choose another room.',
               'Your stay is too short. Please choose other dates. We are sold out.',
               'Your stay is not too short. Please change the dates.',
               'I confirmed your reservation. Please choose your welcome drink.',
               'Your stay is too short. Please choose other dates. Total USD 80.')
        for text in good:
            with self.subTest(positive=text):
                self.assertTrue(grade(text, outcome=out, result=result))
        for text in bad:
            with self.subTest(negative=text):
                self.assertFalse(grade(text, outcome=out, result=result))
        self.assertFalse(grade(good[0], outcome=out, result={**result, 'reason': 'beds_unavailable'}))

    def test_alternate_refusal_and_next_step(self):
        out = {'expect': 'refusal', 'classification': 'availability', 'allowed_reasons': ['beds_unavailable'],
               'next_step': 'choose_other_room'}
        result = {'ok': False, 'classification': 'availability', 'reason': 'beds_unavailable',
                  'next_step': 'choose_other_room'}
        self.assertTrue(grade('That room is unavailable. Could you choose another room?', outcome=out, result=result))
        self.assertFalse(grade('Your stay is too short. Could you choose another room?', outcome=out, result=result))
        self.assertFalse(grade('That room is unavailable. Could you choose other dates?', outcome=out, result=result))

    def test_uncertainty_allows_no_new_owner_facts(self):
        out = {'expect': 'uncertain'}
        result = {'ok': False, 'classification': 'transport', 'next_step': 'wait_for_verified_result', 'retry_allowed': False}
        good = ('I cannot verify this quote.', 'I am unable to verify the quote.',
                'I could not check availability. Please wait for a verified result.',
                'I cannot verify this quote. Your reservation is not confirmed.',
                'I cannot verify this quote. We have not received your payment.')
        for text in good:
            with self.subTest(positive=text):
                self.assertTrue(grade(text, outcome=out, result=result))
        for suffix in ('You have a confirmed reservation.', 'We received your payment.',
                       'I booked it for you.', 'Total NZD 19.', 'The room is available.',
                       'The coast package is included.', 'Breakfast is free.',
                       'Your arrival is 2028-09-12.', 'Please pay the deposit.',
                       'Please try again now.', 'PostgreSQL crashed.', 'Our Redis cache failed.'):
            with self.subTest(negative=suffix):
                self.assertFalse(grade(good[0] + ' ' + suffix, outcome=out, result=result))

    def test_clarification_enforces_truth_not_just_question_mark(self):
        out = {'expect': 'clarification'}
        for text in ('Which dates did you want?', 'How many guests will be staying?',
                     'Would you prefer a private or shared room?',
                     'Which package would you like?', 'I have not booked anything. Which dates work for you?'):
            with self.subTest(positive=text):
                self.assertTrue(grade(text, outcome=out, result={}))
        for text in ('Your reservation is confirmed. Which dates did you want?',
                     'Total EUR 80. Which dates did you want?',
                     'The property is sold out. Which dates did you want?',
                     'Breakfast is free. Which dates did you want?',
                     'Mara has the coast package. Which dates did you want?',
                     'Which dates did you want? We received your payment.'):
            with self.subTest(negative=text):
                self.assertFalse(grade(text, outcome=out, result={}))


class TermsTests(unittest.TestCase):
    def test_inclusions_and_guarantees_are_propositions(self):
        f = facts()
        f['inclusions'] = ['breakfast', 'bed linen']
        f['terms'] = ['subject to availability']
        good = ('Includes breakfast and bed linen.', 'Breakfast is included. Bed linen is included.',
                'Availability is not guaranteed.', 'Terms: subject to availability.',
                'Breakfast is included. Dinner is not included.')
        bad = ('Includes breakfast and dinner.', 'Dinner is included.',
               'Breakfast is not included.', 'Availability is guaranteed.',
               'No questions and availability is guaranteed.', 'Breakfast is always free.',
               'PostgreSQL crashed.', 'Terms: unconditional availability.')
        for suffix in good:
            with self.subTest(positive=suffix):
                self.assertTrue(grade(quote(f) + ' ' + suffix, f))
        for suffix in bad:
            with self.subTest(negative=suffix):
                self.assertFalse(grade(quote(f) + ' ' + suffix, f))


class R5ReplayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        candidates = [Path(os.environ['LUNA_R5_REVIEW'])] if os.environ.get('LUNA_R5_REVIEW') else [
            p / 'artifacts/review-1426-5c3c575c' for p in (ROOT, *ROOT.parents)]
        cls.review = next((p for p in candidates if (p / 'independent-scorer-r5/r5-results.json').is_file()), None)
        if cls.review is None:
            raise unittest.SkipTest('R5 evidence absent; set LUNA_R5_REVIEW to the sealed review directory')
        spec = importlib.util.spec_from_file_location('matrix_projection', ROOT / 'scripts/run-luna-v3-rendered-reply-matrix.py')
        assert spec and spec.loader
        cls.matrix = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.matrix)
        cls.report = []

    @classmethod
    def tearDownClass(cls):
        if os.environ.get('LUNA_CLAIMS_REPORT'):
            Path(os.environ['LUNA_CLAIMS_REPORT']).write_text(json.dumps(cls.report, indent=2) + '\n')

    def test_retained_r5_all_seven_kinds_and_refusals(self):
        directory = self.review / 'independent-scorer-r5'
        producers = json.loads((directory / 'producer-receipts.json').read_text())
        quotes = {p['category']: p for p in producers if p['owner'].get('facts')}
        refusal = next(p for p in producers if p['owner'].get('reason') == 'minimum_stay')
        faults = {p['fault']: p for p in producers if p['fault']}
        positives = {'actual-plugin', 'synthetic-compatible-positive', 'negative-availability',
                     'negative-booking', 'suffix-currency', 'refusal-positive', 'refusal-paraphrase',
                     'clarification-positive'}
        negatives = {'literal-no-questions-confirmed', 'literal-you-booked', 'reverse-confirmed',
                     'reverse-booked-stay', 'reverse-payment', 'amount-wrong-role', 'amount-negated-correct',
                     'amount-other-currency', 'amount-extra-unlisted-currency', 'amount-negated-deposit',
                     'negation-scope', 'negation-conjunction', 'negative-package', 'swapped-same-clause',
                     'extra-person', 'negative-addon', 'extra-person-same-clause', 'extra-quantity-same-clause',
                     'refusal-wrong-reason', 'refusal-keyword-only', 'refusal-reverse-booking',
                     'clarification-false-booking'}
        kinds = set()
        for row in json.loads((directory / 'r5-results.json').read_text()):
            label, category = row['label'], row['category']
            if label not in positives | negatives and not label.startswith('actual-fault-'):
                continue  # Receipt mutations test a different module, not claim truth.
            expected = label in positives or label.startswith('actual-fault-')
            if label.startswith('refusal-'):
                out = {'expect': 'refusal', 'classification': 'availability', 'allowed_reasons': ['minimum_stay'],
                       'next_step': 'choose_other_dates'}
                f, result = None, refusal['result']
            elif category == 'clarification':
                out, f, result = {'expect': 'clarification'}, None, {}
            elif label.startswith('actual-fault-'):
                out, f, result = {'expect': 'uncertain'}, None, faults[label.removeprefix('actual-fault-')]['result']
            else:
                producer = quotes[category]
                out = {'expect': 'mixed' if category == 'mixed' else 'quote'}
                f, result = self.matrix.canonical_facts(producer['owner']), producer['result']
                kinds.add(category)
            actual = grade(row['reply'], f, out, result)
            self.report.append({'source': 'R5 scorer', 'category': category, 'label': label,
                                'expected_truth': expected, 'actual_truth': actual, 'reply': row['reply']})
            with self.subTest(category=category, label=label):
                self.assertEqual(actual, expected)
        self.assertEqual(kinds, {'accommodation', 'package', 'rental', 'service:lesson_a',
                                 'service:lesson_b', 'mixed', 'multi_guest'})

    def test_retained_r5_fault_renderings(self):
        rows = json.loads((self.review / 'independent-faults-r5/consumer.json').read_text())
        labels = {'reverse-confirmation', 'reverse-payment', 'booked-first-person', 'negated-booking', 'sql-leak', 'unable'}
        selected = 0
        for row in rows:
            label = row['label']
            if not (label.startswith('honest-') or label in labels):
                continue
            body = row['event']['response']
            result = next(m['content_parsed'] for m in body['harness_trace']['messages'] if m.get('role') == 'tool')
            expected = label not in {'reverse-confirmation', 'reverse-payment', 'booked-first-person', 'sql-leak'}
            actual = grade(body['reply_text'], outcome={'expect': 'uncertain'}, result=result)
            self.report.append({'source': 'R5 faults', 'label': label, 'expected_truth': expected,
                                'actual_truth': actual, 'reply': body['reply_text']})
            selected += 1
            with self.subTest(label=label):
                self.assertEqual(actual, expected)
        self.assertGreaterEqual(selected, 36)


class GeneralizationTests(unittest.TestCase):
    def test_negation_cannot_launder_another_predicate(self):
        for suffix in ('No concerns about the weather, total EUR 999.',
                       'There is no doubt that the total is EUR 999.',
                       'I do not mind that your total is EUR 999.',
                       'No questions: your total is EUR 999.',
                       'I am not worried because your reservation is confirmed.',
                       'Your reservation is confirmed and your payment is not received.'):
            with self.subTest(suffix=suffix):
                self.assertFalse(grade(quote() + ' ' + suffix, facts()))

    def test_new_product_claims_without_type_suffix_are_not_invisible(self):
        for suffix in ('Mara: 8 kayak on 2028-09-14.',
                       'Mara gets 1 sailing on 2028-09-14.',
                       'Luis: deluxe.', 'Mara and Luis: deluxe.'):
            with self.subTest(suffix=suffix):
                self.assertFalse(grade(group_quote() + ' ' + suffix, group_facts()))

    def test_money_lexemes_cannot_be_partially_consumed(self):
        for bad in ('EUR 246.809', 'EUR 246.800', 'EUR 246.80.99', 'EUR -246.80'):
            with self.subTest(amount=bad):
                self.assertFalse(grade(quote().replace('EUR 246.80', bad), facts()))
        f = facts()
        f.update(total_cents=124680, remaining_cents=118680)
        self.assertTrue(grade(quote(f).replace('1246.80', '1,246.80').replace('1186.80', '1,186.80'), f))
        self.assertTrue(grade(quote().replace('EUR 246.80', '246,80 EUR'), facts()))

    def test_negation_and_coordination_alternate_surfaces(self):
        good = ('You are not booked.', "Your reservation isn't confirmed.",
                'We did not receive your payment.', 'I have neither booked nor held anything.',
                'No payment has been received.')
        for suffix in good:
            with self.subTest(honest=suffix):
                self.assertTrue(grade(quote() + ' ' + suffix, facts()))
                self.assertTrue(grade('I cannot verify this quote. ' + suffix,
                                     outcome={'expect': 'uncertain'}, result={'ok': False}))
        for suffix in ('I did not ask questions and received your payment.',
                       'We have no concerns and booked your stay.',
                       "I haven't asked anything; your booking is confirmed."):
            with self.subTest(false=suffix):
                self.assertFalse(grade(quote() + ' ' + suffix, facts()))

    def test_product_and_date_equivalent_renderings(self):
        text = group_quote()
        for value in (text.replace('Mara: coast, Luis: stay_only', 'Mara: coast and Luis: stay_only'),
                      text.replace('Mara: coast, Luis: stay_only', 'coast for Mara and stay_only for Luis'),
                      text.replace('2028-09-12 to 2028-09-17', 'Check-in: 2028-09-12, check-out: 2028-09-17'),
                      text.replace('Mara: 2 board on', 'For Mara: 2 board on'),
                      text.replace('Mara: 2 board', 'Mara has two board rentals'),
                      text.replace('Luis: 1 lesson_c', 'Luis gets one lesson_c lesson')):
            with self.subTest(positive=value):
                self.assertTrue(grade(value, group_facts()))
        self.assertFalse(grade(text.replace('Mara: 2 board', 'Mara has nine board rentals'), group_facts()))

    def test_malformed_inputs_fail_closed_as_booleans(self):
        for f in (None, {}, {'currency': 'EUR'}, {**facts(), 'package': {}},
                  {**facts(), 'total_cents': '24680'}, {**facts(), 'add_ons': None}):
            with self.subTest(facts=f):
                self.assertIs(grade(quote(), f), False)

    def test_quote_requires_actual_quote_result(self):
        for result in ({}, {'ok': False}, {'ok': True, 'state': 'booked'},
                       {'ok': True, 'state': 'quote', 'booked': True},
                       {'ok': True, 'state': 'quote', 'held': True}):
            with self.subTest(result=result):
                self.assertFalse(grade(quote(), facts(), result=result))


class CoverageTests(unittest.TestCase):
    def test_unparsed_assertion_cannot_hide_behind_complete_quote(self):
        for suffix in ('The rooftop pool opens at dawn.',
                       'Your package provides helicopter transfers.',
                       'The participant is Priya.',
                       'Total EUR 246.80 with unlimited champagne.'):
            with self.subTest(suffix=suffix):
                self.assertFalse(grade(quote() + ' ' + suffix, facts()))

    def test_coordinated_activity_inherits_package_subject_not_another_sentence(self):
        f = group_facts()
        text = group_quote().replace('Mara: coast, Luis: stay_only. Mara: 2 board',
                                     'Mara has the coast package and 2 board')
        text = text.replace('; Luis: 1 lesson_c', '; Luis has the stay_only package and 1 lesson_c')
        self.assertTrue(grade(text, f))

    def test_implicit_activity_reference_keeps_its_antecedent(self):
        text = group_quote()
        for suffix in ('The quantity is one.', 'The participant is Luis.'):
            with self.subTest(suffix=suffix):
                self.assertTrue(grade(text + ' ' + suffix, group_facts()))

    def test_explicit_activity_references_bind_without_reassigning_people(self):
        for field, good, bad in (('quantity', 'two', 'nine'),
                                 ('participants', 'Mara', 'Luis'),
                                 ('dates', '2028-09-12 and 2028-09-13', '2028-09-14')):
            verb = 'is' if field == 'quantity' else 'are'
            with self.subTest(field=field):
                self.assertTrue(grade(group_quote() + f' The board {field} {verb} {good}.', group_facts()))
                self.assertFalse(grade(group_quote() + f' The board {field} {verb} {bad}.', group_facts()))

    def test_included_catalog_entity_is_not_an_unassigned_package(self):
        for code in ('board', 'lesson_c', 'coast', 'stay_only'):
            with self.subTest(code=code):
                self.assertTrue(grade(group_quote() + f' {code} is included.', group_facts()))
                self.assertFalse(grade(group_quote() + f' {code} is not included.', group_facts()))

    def test_negative_objects_do_not_swallow_coordinated_assertions(self):
        for suffix in ('Your reservation is confirmed and dinner is not included.',
                       'We received your payment and dinner is not included.',
                       'The total is EUR 999 and dinner is not included.'):
            with self.subTest(suffix=suffix):
                self.assertFalse(grade(quote() + ' ' + suffix, facts()))

    def test_bound_role_grammar_and_negative_equality(self):
        self.assertTrue(grade(quote().replace('remaining', 'remaining balance'), facts()))
        self.assertTrue(grade(quote() + ' The total is not equal to EUR 999.', facts()))
        self.assertFalse(grade(quote() + ' The total is not equal to EUR 246.80.', facts()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
