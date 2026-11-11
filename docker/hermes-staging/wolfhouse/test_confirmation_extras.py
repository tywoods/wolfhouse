"""Offline CONFIRM-WORDING facts/prompt regression; no model or guest sends."""
from copy import deepcopy
from pathlib import Path
import json
import subprocess
import unittest
from unittest.mock import patch

from wolfhouse import accepted_quote as owner


class ConfirmationExtrasTests(unittest.TestCase):
    def setUp(self):
        # Synthetic Staff fact fixture matching the reported shape, not a live receipt.
        self.extra = {'code': 'surfboard_rental', 'label': 'Hardboard rental',
                      'quantity': 1, 'days': 6, 'amount_cents': 12000}
        self.plan = {'check_in': '2027-04-01', 'check_out': '2027-04-07',
                     'guests': [{'name': 'Alex'}], 'language': 'en',
                     'package_code': 'package_none'}
        self.offer = {'total_cents': 42000, 'deposit_required_cents': 10000,
                      'remaining_after_deposit_cents': 32000,
                      'add_ons': [deepcopy(self.extra)]}
        self.receipt = {'booking_code': 'WH-CONFIRM-EXTRAS',
                        'amount_due_cents': 10000,
                        'secure_payment_url': 'https://pay.invalid/extra-fixture'}

    def facts(self, receipt=None, offer=None):
        with patch.object(owner, '_saved_property_location_url', return_value=None):
            return owner._saved_confirmation_facts(
                self.plan, self.offer if offer is None else offer,
                self.receipt if receipt is None else receipt)

    def test_booking_tool_extracts_saved_extras_and_priced_lines(self):
        from wolfhouse_staff_api import _extract_booking_write_fields
        raw = {'booking_code': 'WH-CONFIRM-EXTRAS',
               'quote': {'add_ons': [self.extra],
                         'line_items': [{'code': 'surfboard_rental',
                                         'label': 'Hardboard rental',
                                         'total_cents': 12000}]}}
        fields = _extract_booking_write_fields(raw)
        self.assertEqual(fields.get('add_ons'), [self.extra])
        self.assertEqual(fields.get('quote_line_items'), raw['quote']['line_items'])

    def test_staff_create_response_reaches_confirmation_author_with_priced_extras(self):
        # Execute the real successful HTTP response projection, with synthetic
        # committed rows. No API listener, DB, payment provider or model is used.
        script = r'''
const fs = require('node:fs'), vm = require('node:vm');
const sourceText = fs.readFileSync('scripts/staff-query-api.js', 'utf8');
const start = sourceText.indexOf('  // ── 8. Success', sourceText.indexOf('async function handleBotBookingCreate('));
const begin = sourceText.indexOf('return sendJSON(res, 201, {', start);
const end = sourceText.indexOf('});', begin) + 3;
if (start < 0 || begin < 0 || end < begin) throw Error('create response seam missing');
const extra = {code:'surfboard_hard', quantity:1, days:6};
const line = {code:'surfboard_hard', label:'Hardboard rental', quantity:6, unit_cents:2000, total_cents:12000};
const row = {booking_id:'fixture-b1', booking_code:'WH-CONFIRM-EXTRAS', guest_rooms:[], beds_inserted:1};
const cmd = {clientSlug:'wolfhouse-somo', pkgCtx:{isNoPackage:true}, effectivePackageCode:'package_none', addOns:[extra]};
const quote = {total_cents:42000, deposit_required_cents:10000, line_items:[line]};
const ctx = {row, cmd, quote, source:'fixture', resolvedAuthMode:'fixture', assignedBedCodes:[], elapsed:0, res:{},
 sendJSON:(_res,status,body)=>({status,body})};
const result = vm.runInNewContext('(function(){'+sourceText.slice(begin,end)+'})()', ctx);
if (result.status !== 201) throw Error('unexpected response status');
console.log(JSON.stringify(result.body));
'''
        raw = json.loads(subprocess.check_output(
            ['node', '-e', script], cwd=Path(__file__).resolve().parents[3], text=True))
        from wolfhouse_staff_api import _extract_booking_write_fields
        fields = _extract_booking_write_fields(raw)
        self.assertEqual(fields['add_ons'], [{'code': 'surfboard_hard', 'quantity': 1, 'days': 6}])
        self.assertEqual(fields['quote_line_items'][0]['total_cents'], 12000)
        facts = self.facts(receipt={**self.receipt, **fields})
        payload = owner._confirmation_rewrite_payload(facts, 'Old draft', [])
        self.assertEqual(payload['required_guest_facts']['extras'], fields['add_ons'])
        self.assertEqual(payload['required_guest_facts']['quote_line_items'], fields['quote_line_items'])

    def test_saved_confirmation_preserves_checked_extras_and_money(self):
        before = deepcopy((self.plan, self.offer, self.receipt))
        facts = self.facts()
        self.assertEqual(facts.get('extras'), [self.extra])
        self.assertEqual((facts['total_cents'], facts['amount_due_now_cents'],
                          facts['remains_owed_cents']), (42000, 10000, 32000))
        self.assertEqual(facts['payment_links'], [self.receipt['secure_payment_url']])
        facts['extras'][0]['days'] = 99
        self.assertEqual((self.plan, self.offer, self.receipt), before)

    def test_receipt_extras_override_checked_offer_including_explicit_empty(self):
        for extras in ([], [dict(self.extra, days=3, amount_cents=6000)]):
            with self.subTest(extras=extras):
                receipt = dict(self.receipt, add_ons=extras)
                self.assertEqual(self.facts(receipt=receipt).get('extras'), extras)

    def test_no_extras_are_inferred_from_stale_plan(self):
        self.plan['add_ons'] = [self.extra]
        self.assertEqual(self.facts(offer={**self.offer, 'add_ons': []}).get('extras'), [])
        self.assertNotIn('extras', self.facts(offer={'total_cents': 42000}))

    def test_rewrite_payload_and_soul_require_extras_without_template_copy(self):
        facts = self.facts()
        payload = owner._confirmation_rewrite_payload(facts, 'Old accommodation-only wording', [])
        self.assertEqual(payload['required_guest_facts'].get('extras'), [self.extra])
        self.assertEqual(payload['canonical_saved_booking'], facts)
        self.assertIn('extras', payload['booking_confirmation_guide'])
        self.assertIn('does not mean no extras', payload['booking_confirmation_guide'])
        guide = (Path(__file__).resolve().parents[1] / 'soul-guides' / '06-confirmation.md').read_text()
        self.assertIn('saved extras', guide)
        self.assertIn('does not mean no extras', guide)


if __name__ == '__main__':
    unittest.main()
