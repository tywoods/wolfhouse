"""R9: real Staff JS/SQL receipts must retain person-bound subgroup room scope.

Run: PYTHONPATH=docker/hermes-staging/plugins:docker/hermes-staging python3 -m
unittest wolfhouse_staff_api.test_subgroup_availability_authority -v
Only HTTP transport is replaced: Node executes Staff availability/preview against
PGlite seeded inventory, occupancy and Pricing seasons. No live calls or persistent writes.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import wolfhouse_staff_api as plugin

ROOT = Path(__file__).resolve().parents[4]
NODE_FIXTURE = r"""
'use strict';
const fs = require('node:fs');
const vm = require('node:vm');
const readline = require('node:readline');
const { PGlite } = require('@electric-sql/pglite');
const { seedOfflineBookingDb } = require('./scripts/verify-luna-create-booking-occupants');
const lib = name => require('./scripts/lib/' + name);
const offer = lib('luna-front-desk-accommodation-availability-service');
const service = lib('luna-front-desk-accommodation-booking-create-service');
const deny = () => { throw new Error('R9 fixture forbids network'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const name of ['node:http', 'node:https']) {
  require(name).request = deny; require(name).get = deny;
}
globalThis.fetch = deny;
process.env.LUNA_RULES_BASED_ROOMING = 'true';
(async () => {
  const db = new PGlite();
  const pg = { query: (sql, params = []) => db.query(sql, params) };
  try {
    await seedOfflineBookingDb(db, {phone: '+9990000001', guest_name: 'Alex'});
    // Local authoritative fixture: October is open; November is closed. Never
    // infer date permission from missing Pricing rows or historic season prose.
    await db.exec(`
      ALTER TABLE clients ADD COLUMN IF NOT EXISTS settings jsonb DEFAULT '{}'::jsonb;
      ALTER TABLE wh_pricing_rules ADD COLUMN IF NOT EXISTS per_night_cents int;
      DELETE FROM wh_pricing_season_ranges;
      DELETE FROM wh_pricing_seasons;
      INSERT INTO wh_pricing_seasons(client_slug,code,label,priority,bookable)
        VALUES ('wolfhouse-somo','all_year','October fixture',1,true),
               ('wolfhouse-somo','closed','November fixture',2,false);
      INSERT INTO wh_pricing_season_ranges(season_id,client_slug,start_month,start_day,end_month,end_day)
        SELECT id,client_slug,CASE WHEN bookable THEN 10 ELSE 11 END,1,
          CASE WHEN bookable THEN 10 ELSE 11 END,CASE WHEN bookable THEN 31 ELSE 30 END
        FROM wh_pricing_seasons;
      UPDATE rooms SET active=room_code IN ('R5','R7');
      UPDATE rooms SET room_type=CASE WHEN room_code='R5' THEN 'female_only' ELSE 'mixed' END,
        gender_strategy=CASE WHEN room_code='R5' THEN 'Female' ELSE 'Flexible' END,
        capacity=4, selling_mode='shared', can_be_matrimonial=false,
        often_used_by_operator=false WHERE active;
      UPDATE beds SET active=bed_number<=4 AND room_id IN (SELECT id FROM rooms WHERE active);
      UPDATE beds SET active=bed_number=1 WHERE room_id=(SELECT id FROM rooms WHERE room_code='R7');
    `);
    let requestBody;
    const context = {
      ...lib('booking-create-source-attribution'), ...lib('bot-booking-package-normalize'),
      ...lib('staff-manual-booking-payment'), ...lib('staff-manual-booking-create-sql'),
      ...lib('staff-booking-portal-policy'), ...lib('wolfhouse-room-options'),
      ...lib('wolfhouse-quote-calculator'), ...lib('guest-addon-pricing'),
      ...lib('bot-quote-included-items'), ...lib('wolfhouse-package-night-rules'),
      ...lib('booking-guests'), ...lib('staff-bed-calendar-queries'), ...offer, ...service,
      BOT_BOOKING_ENABLED: true, STAFF_AUTH_REQUIRED: true, DEFAULT_CLIENT: 'wolfhouse-somo',
      appendAuditLog() {}, readBody: async () => JSON.stringify(requestBody),
      resolveBotHandlerTrustedClientSlug: () => 'wolfhouse-somo',
      loadWolfhouseQuoteConfigWithOverlay: () => service.loadBookingQuoteConfigWithOverlay(pg),
      withPgClient: fn => fn(pg),
      sendJSON: (_res, status, body) => ({status, body}),
      send400: (_res, error) => ({status: 400, body: {error}}),
    };
    const source = fs.readFileSync('./scripts/staff-query-api.js', 'utf8');
    const start = source.indexOf('const BOT_BOOKING_REQUIRED_FIELDS = [');
    const preview = source.indexOf('async function handleBotBookingPreview(req, res, user, authMode) {');
    if (start < 0 || preview < start) throw new Error('Staff preview source anchors changed');
    vm.createContext(context);
    vm.runInContext(source.slice(start, source.indexOf('\n}\n', preview) + 2), context);
    console.log(JSON.stringify({ready: true}));
    for await (const line of readline.createInterface({input: process.stdin})) {
      const cmd = JSON.parse(line);
      try {
        // Occupancy is a real dated booking/bed assignment, not a false receipt.
        await db.exec('DELETE FROM booking_beds; DELETE FROM bookings;');
        if (cmd.occupied) {
          const booking = (await db.query(`INSERT INTO bookings(client_id,booking_code,status,check_in,check_out)
            SELECT id,'R9-OCCUPIED','confirmed','2027-10-06','2027-10-12'
            FROM clients WHERE slug='wolfhouse-somo' RETURNING id`)).rows[0];
          await db.query(`INSERT INTO booking_beds(client_id,booking_id,bed_id,bed_code,room_code,
            assignment_start_date,assignment_end_date,assignment_type)
            SELECT client_id,$1,id,bed_code,'R5','2027-10-06','2027-10-12','guest'
            FROM beds WHERE bed_code=$2`, [booking.id, cmd.occupied]);
        }
        requestBody = cmd.body;
        let result;
        if (cmd.path === '/availability-check') {
          const built = offer.buildWolfhouseAvailabilityCommand({channel: 'bot_http',
            trustedClientSlug: 'wolfhouse-somo', transportBody: requestBody,
            demoCalendarEnrichment: false,
            quoteConfig: await service.loadBookingQuoteConfigWithOverlay(pg)});
          if (!built.ok) throw new Error(JSON.stringify(built));
          result = await offer.executeWolfhouseAvailabilityCheck(pg, built.command);
          // Same transport projection as the bot HTTP route; early date refusals
          // already have their own HTTP body and must not be mapped as inventory.
          if (result.ok && result.body.domain_next_action) {
            result.body = offer.mapBotHttpAvailabilityResponse(result.body);
          }
        } else if (cmd.path === '/booking-preview') {
          result = await context.handleBotBookingPreview({headers: {}}, {}, null, 'bot_token');
        } else throw new Error('Read-only fixture endpoint required');
        console.log(JSON.stringify(result));
      } catch (error) { console.log(JSON.stringify({fixture_error: error.stack})); }
    }
  } finally { await db.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
"""


class SubgroupAvailabilityAuthority(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.node = subprocess.Popen(['node', '-e', NODE_FIXTURE], cwd=ROOT,
                                    stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, text=True)
        assert cls.node.stdout is not None and cls.node.stderr is not None
        ready = cls.node.stdout.readline()
        if not ready:
            raise AssertionError(cls.node.stderr.read())
        if json.loads(ready) != {'ready': True}:
            raise AssertionError(ready)

    @classmethod
    def tearDownClass(cls):
        assert cls.node.stdin is not None and cls.node.stdout is not None and cls.node.stderr is not None
        cls.node.stdin.close()
        cls.node.wait(timeout=20)
        error = cls.node.stderr.read()
        cls.node.stdout.close()
        cls.node.stderr.close()
        if cls.node.returncode or error:
            raise AssertionError(error)

    def setUp(self):
        for target in ('urllib.request.urlopen', 'socket.socket.connect',
                       'socket.socket.connect_ex', 'socket.create_connection'):
            guard = patch(target, side_effect=AssertionError('offline only'))
            guard.start()
            self.addCleanup(guard.stop)
        env = patch.dict(os.environ, {'LUNA_CLIENT_SLUG': 'wolfhouse-somo'})
        env.start()
        self.addCleanup(env.stop)
        self.params: dict = dict(client_slug='wolfhouse-somo', check_in='2027-10-06',
                           check_out='2027-10-12', guest_count=3, room_type='shared',
                           group_gender='mixed', package_code='package_none',
                           guests=[{'name': 'Alex', 'explicit_gender': 'female'},
                                   {'name': 'Alex', 'explicit_gender': 'female'},
                                   {'name': 'Sam', 'explicit_gender': 'male'}])
        self.calls = []
        self.occupied = None

    def transport(self, path, body):
        assert self.node.stdin is not None and self.node.stdout is not None
        self.node.stdin.write(json.dumps(dict(path=path, body=body, occupied=self.occupied)) + '\n')
        self.node.stdin.flush()
        reply = json.loads(self.node.stdout.readline())
        self.assertNotIn('fixture_error', reply, reply)
        self.assertEqual(reply.get('status'), 200, reply)
        self.calls.append((path, copy.deepcopy(body), reply['body']))
        return reply['body']

    def invoke(self, tool, params=None):
        params = copy.deepcopy(params or self.params)
        original = copy.deepcopy(params)
        # This unit exercises read-only Staff result projection, independent of
        # whether another suite imported the live owner loop. Registered owner
        # lifecycle + persistence is covered by test_serious_booking_persistence.
        from inspect import unwrap
        handler = unwrap(getattr(plugin, tool))
        with patch.object(plugin, '_post_bot', side_effect=self.transport):
            result = json.loads(handler(params))
        self.assertEqual(params, original)
        return result

    def assert_scoped_selection(self, result, expected):
        staff = self.calls[-1][2]
        self.assertEqual(staff['selected_bed_codes'], expected, staff)
        self.assertTrue(staff['has_enough_beds'])
        self.assertTrue(result['available'], result)
        self.assertEqual(result['selected_bed_codes'], expected)
        self.assertTrue(result['specific_range_verified_for_whole_party'])
        self.assertFalse(result.get('requires_guest_confirmation', False))
        self.assertFalse(result.get('write_performed', False))
        details = {bed['bed_code']: bed for bed in result['available_beds']}
        self.assertTrue(set(expected) <= details.keys())
        # The exception is for selected occupants, not every free female bed.
        self.assertNotIn('R5-B3', details)
        self.assertEqual(result['room_decision']['scope'], 'selected_guest_beds')
        self.assertEqual(result['room_decision']['selected_bed_codes'], expected)
        self.assertNotIn('female_only', result['room_decision']['excluded_room_preferences'])
        self.assertEqual(result['checked_request']['check_in'], '2027-10-06')
        self.assertEqual(result['checked_request']['check_out'], '2027-10-12')

    def test_allocator_generated_subgroup_selection_is_not_whole_party_exclusion(self):
        result = self.invoke('check_availability')
        self.assertEqual(self.calls[-1][2]['allocation_reason'], 'split_by_explicit_guest_eligibility')
        self.assert_scoped_selection(result, ['R5-B1', 'R5-B2', 'R7-B1'])

    def test_explicit_person_selection_is_retained_in_order(self):
        self.params['selected_bed_codes'] = ['R5-B2', 'R5-B1', 'R7-B1']
        result = self.invoke('check_availability')
        self.assertTrue(self.calls[-1][2]['exact_bed_eligibility']['eligible'])
        self.assert_scoped_selection(result, self.params['selected_bed_codes'])

    def test_roster_permutation_keeps_person_bed_bindings(self):
        self.params['guests'] = [self.params['guests'][2], *self.params['guests'][:2]]
        for explicit in (False, True):
            with self.subTest(explicit=explicit):
                expected = ['R7-B1', 'R5-B1', 'R5-B2']
                if explicit:
                    self.params['selected_bed_codes'] = expected
                self.assert_scoped_selection(self.invoke('check_availability'), expected)

    def test_quote_does_not_reintroduce_whole_party_exclusion(self):
        for explicit in (False, True):
            with self.subTest(explicit=explicit):
                if explicit:
                    self.params['selected_bed_codes'] = ['R5-B1', 'R5-B2', 'R7-B1']
                result = self.invoke('quote_booking')
                self.assertTrue(result['success'], result)
                self.assertTrue(result['offer_revision']['availability_checked'])
                self.assertEqual(result['availability']['selected_bed_codes'], ['R5-B1', 'R5-B2', 'R7-B1'])
                self.assertNotIn('female_only', result['room_decision']['excluded_room_preferences'])
                self.assertEqual(result['room_decision']['scope'], 'selected_guest_beds')

    def test_true_occupied_selection_is_refused_even_with_other_free_beds(self):
        self.params['selected_bed_codes'] = ['R5-B1', 'R5-B2', 'R7-B1']
        self.occupied = 'R5-B1'
        result = self.invoke('check_availability')
        staff = self.calls[-1][2]
        self.assertTrue(staff['has_enough_beds'])  # Free capacity is not this selection.
        self.assertFalse(staff['exact_bed_eligibility']['eligible'])
        self.assertIn('availability_changed', staff['blockers'])
        self.assertFalse(result['available'], result)
        self.assertTrue(result['unavailable'])
        self.assertEqual(result['selected_bed_codes'], [])
        self.assertEqual(result['next_action'], 'offer_accommodation_or_change_dates')

    def test_occupancy_outside_requested_dates_does_not_refuse_selection(self):
        self.params.update(check_in='2027-10-12', check_out='2027-10-18',
                           selected_bed_codes=['R5-B1', 'R5-B2', 'R7-B1'])
        self.occupied = 'R5-B1'
        result = self.invoke('check_availability')
        self.assertTrue(self.calls[-1][2]['exact_bed_eligibility']['eligible'])
        self.assertTrue(result['available'], result)
        self.assertEqual(result['selected_bed_codes'], self.params['selected_bed_codes'])
        self.assertEqual(result['checked_request']['check_in'], '2027-10-12')

    def test_checked_split_does_not_require_gender_for_mixed_bed_occupant(self):
        self.params['guests'][2].pop('explicit_gender')
        self.params['selected_bed_codes'] = ['R5-B1', 'R5-B2', 'R7-B1']
        # This fixture includes the real bot HTTP response mapper, complementing
        # the registered-owner persistence fixture's canonical availability edge.
        result = self.invoke('check_availability')
        self.assertTrue(self.calls[-1][2]['exact_bed_eligibility']['eligible'])
        self.assert_scoped_selection(result, self.params['selected_bed_codes'])
        quote = self.invoke('quote_booking')
        self.assertTrue(quote['success'], quote)
        self.assertEqual(quote['room_decision']['scope'], 'selected_guest_beds')
        self.assertFalse(quote['room_decision']['clarification_needed'])

    def test_unknown_or_wrong_occupant_does_not_inherit_subgroup_permission(self):
        for gender in (None, 'male'):
            with self.subTest(gender=gender):
                self.params['selected_bed_codes'] = ['R5-B1', 'R5-B2', 'R7-B1']
                self.params['guests'][0].pop('explicit_gender', None)
                if gender:
                    self.params['guests'][0]['explicit_gender'] = gender
                result = self.invoke('check_availability')
                self.assertFalse(self.calls[-1][2]['exact_bed_eligibility']['eligible'])
                self.assertEqual(result['selected_bed_codes'], [])
                self.assertFalse(result['available'], result)
                self.assertNotEqual((result.get('room_decision') or {}).get('scope'), 'selected_guest_beds')

    def test_whole_party_unknown_does_not_globally_allow_gendered_inventory(self):
        self.params['guests'] = [{'name': guest['name']} for guest in self.params['guests']]
        result = self.invoke('check_availability')
        self.assertTrue(all(bed['room_type'] == 'mixed' for bed in result['available_beds']))
        self.assertTrue(all(code.startswith('R7-') for code in result['selected_bed_codes']))

    def test_closed_season_remains_authoritative(self):
        self.params.update(check_in='2027-11-06', check_out='2027-11-12')
        result = self.invoke('check_availability')
        self.assertTrue(self.calls[-1][2]['closed_season'])
        self.assertEqual(result['availability_status'], 'closed_season')
        self.assertFalse(result['available'])
        self.assertEqual(result['selected_bed_codes'], [])


if __name__ == '__main__':
    unittest.main()
