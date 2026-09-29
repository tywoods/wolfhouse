"""L1 offline tool -> production quote/create -> embedded SQL regression.

Run: python3 docker/hermes-staging/plugins/wolfhouse_staff_api/test_yoga_quote_retention.py
No model, live HTTP, WABA, Stripe or external database. The _post_bot boundary is
adapted to production JS functions and the existing PGlite create CLI. This proves
payload/result retention, not that an LLM will always remember to supply add_ons.
Create stops after real SQL readback, before checkout/guest-confirmation handling.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import unittest
from unittest.mock import patch

PLUGIN = Path(__file__).resolve().parent
ROOT = PLUGIN.parents[3]
spec = importlib.util.spec_from_file_location(
    "yoga_staff_api", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)]
)
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

# Real application owners; adapter adds the same included-items mapper as bot preview.
QUOTE_JS = r"""
const fs = require('node:fs');
const deny = () => { throw new Error('Offline yoga quote forbids network'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const m of ['node:http', 'node:https']) {
  require(m).request = deny; require(m).get = deny;
}
globalThis.fetch = deny;
const { executeWolfhouseAccommodationQuote } = require('./scripts/lib/wolfhouse-accommodation-application');
const { buildBotQuoteIncludedItems } = require('./scripts/lib/bot-quote-included-items');
const result = executeWolfhouseAccommodationQuote(JSON.parse(fs.readFileSync(0, 'utf8')));
if (!result.ok) { console.log(JSON.stringify(result)); process.exit(1); }
const body = result.body;
body.included_items = buildBotQuoteIncludedItems(body.quote);
console.log(JSON.stringify(body));
"""


def node_json(args, payload):
    env = {k: v for k, v in os.environ.items() if not any(
        term in k.upper() for term in ('TOKEN', 'SECRET', 'PASSWORD', 'API_KEY', 'DATABASE_URL', 'STAFF_API', 'STRIPE', 'WABA', 'WHATSAPP', 'NODE_OPTIONS')
    )}
    run = subprocess.run(['node', *args], input=json.dumps(payload), text=True,
                         cwd=ROOT, env=env, capture_output=True, timeout=90)
    if run.returncode:
        raise AssertionError(f'local node failed ({run.returncode}): {run.stdout}\n{run.stderr}')
    return json.loads(run.stdout)


class CreateCaptured(Exception):
    """Expected offline stop after SQL create, before payment-link handling."""


class YogaQuoteRetention(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.sql_results = []
        self.patches = [
            patch.object(mod, '_post_bot', side_effect=self.local_post),
            patch.object(mod, '_session_guest_phone', return_value='+999000000002'),
            patch.object(socket.socket, 'connect', side_effect=AssertionError('network forbidden')),
            patch.dict(os.environ, {'WOLFHOUSE_CLIENT_SLUG': 'wolfhouse-somo'}),
        ]
        for guard in self.patches:
            guard.start()
            self.addCleanup(guard.stop)

    def local_post(self, route, payload):
        self.calls.append((route, copy.deepcopy(payload)))
        if route == '/booking-preview':
            return node_json(['-e', QUOTE_JS], payload)
        if route == '/booking-create-from-plan':
            result = node_json(['scripts/verify-luna-create-booking-occupants.js', '--payload'], payload)
            self.assertTrue(result['ok'])
            self.assertEqual(result['network_attempts'], [])
            self.sql_results.append(result)
            # Do not fake a bot-route response or allow automatic checkout handling.
            raise CreateCaptured('SQL create complete; checkout is outside this offline proof')
        raise AssertionError(f'Unexpected external route: {route}')

    def create(self, fields):
        with self.assertRaises(CreateCaptured):
            mod.create_booking_from_plan(fields)

    def fields(self, package='malibu', payment='full'):
        return {
            'client_slug': 'wolfhouse-somo', 'check_in': '2026-07-06',
            'check_out': '2026-07-09' if package == 'package_none' else '2026-07-13',
            'guest_count': 2, 'guest_name': 'Tom', 'guests': [{'name': 'Tom'}, {'name': 'Sam'}],
            'phone': '+999000000002', 'guest_phone': '+999000000002',
            'package_code': package, 'payment_choice': payment,
            'room_type': 'shared', 'group_gender': 'mixed',
            'selected_bed_codes': ['R3-B1', 'R3-B2'],
            'add_ons': [{'code': 'yoga_class', 'quantity': 2, 'board_type': 'soft'}],
        }

    def quote(self, payload, expected_quantity=2):
        result = json.loads(mod.quote_booking(payload))
        self.assertTrue(result['success'], result)
        yoga = [i for i in result['included_items'] if i['code'] == 'yoga_class']
        self.assertEqual(len(yoga), 1 if expected_quantity else 0, result)
        if expected_quantity:
            self.assertEqual(yoga[0]['quantity'], expected_quantity)
            self.assertEqual(yoga[0]['total_cents'], 1500 * expected_quantity)
        return result

    def test_short_weekly_and_payment_paths_keep_one_yoga_service(self):
        for package in ['package_none', 'malibu', 'waimea']:
            for payment in ['deposit', 'full']:
                with self.subTest(package=package, payment=payment):
                    fields = self.fields(package, payment)
                    before = copy.deepcopy(fields)
                    quoted = self.quote(fields)
                    self.create(fields)
                    self.assertEqual(fields, before, 'caller payload stays unchanged')
                    created_payload = [p for r, p in self.calls if r == '/booking-create-from-plan'][-1]
                    self.assertEqual(created_payload['add_ons'], fields['add_ons'])
                    result = self.sql_results[-1]
                    self.assertEqual(result['money']['total_cents'], quoted['total_cents'])
                    self.assertEqual(len(result['services']), 1, result['services'])
                    yoga = result['services'][0]
                    self.assertEqual(yoga['service_type'], 'yoga')
                    self.assertEqual(yoga['quantity'], 2)
                    self.assertEqual(yoga['amount_paid_cents'], 0)
                    self.assertEqual(yoga['metadata']['source_quote_line_code'], 'yoga_class')
                    self.assertFalse(any('add-service' in r or 'payment' in r for r, _ in self.calls))
                    print(json.dumps({'case': package + '/' + payment,
                        'quote_total_cents': quoted['total_cents'],
                        'create_total_cents': result['money']['total_cents'],
                        'services_sql_readback': result['services'],
                        'network_attempts': result['network_attempts']}, sort_keys=True))

    def test_requote_room_dates_package_payment_and_explicit_removal(self):
        fields = self.fields()
        self.quote(fields)
        for changes in [
            {'room_type': 'double', 'room_preference': 'couple_private'},
            {'check_in': '2026-08-15', 'check_out': '2026-08-22'},
            {'package_code': 'waimea'}, {'payment_choice': 'deposit'},
        ]:
            fields.update(changes)
            self.quote(fields)
        fields['add_ons'] = [{'code': 'yoga', 'quantity': 1, 'boardType': 'hard'}]
        self.quote(fields, 1)
        fields['add_ons'] = []  # explicit guest removal, not an omission fallback
        removed = self.quote(fields, 0)
        self.create(fields)
        self.assertEqual(self.sql_results[-1]['services'], [])
        self.assertEqual(self.sql_results[-1]['money']['total_cents'], removed['total_cents'])
        fields = self.fields()
        del fields['add_ons']  # a new request without yoga never inherits another guest's extras
        self.quote(fields, 0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
