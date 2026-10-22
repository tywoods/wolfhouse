"""Offline registered-handler regression: guest choices and capacity facts.

Synthetic Staff receipts only; socket/HTTP tripwires prohibit live calls.
Run with the worktree docker/hermes-staging and plugins on PYTHONPATH.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import wolfhouse_staff_api as plugin


class Registry:
    def __init__(self):
        self.tools = {}

    def register_tool(self, **tool):
        self.tools[tool["name"]] = tool


class GuestSimQuoteAvailabilityTests(unittest.TestCase):
    def setUp(self):
        self.assertEqual(Path(plugin.__file__).resolve(), Path(__file__).with_name("__init__.py").resolve())
        for target in ("urllib.request.urlopen", "socket.socket.connect", "socket.socket.connect_ex",
                       "socket.create_connection", "socket.getaddrinfo"):
            tripwire = patch(target, side_effect=AssertionError("offline socket/HTTP tripwire"))
            mocked = tripwire.start()
            self.addCleanup(tripwire.stop)
            self.addCleanup(mocked.assert_not_called)
        env = patch.dict(os.environ, {"LUNA_CLIENT_SLUG": "wolfhouse-somo"})
        env.start()
        self.addCleanup(env.stop)
        registry = Registry()
        plugin.register(registry)
        self.tools = registry.tools
        self.params = {
            "check_in": "2027-07-05", "check_out": "2027-07-12", "guest_count": 2,
            "package_code": "malibu", "room_preference": "mixed",
        }
        self.quote = {
            "success": True, "quote_status": "ready",
            "quote": {"total_cents": 84000, "deposit_required_cents": 24000,
                      "balance_due_cents": 84000},
        }

    def invoke(self, name, params, receipt):
        original_params, original_receipt = copy.deepcopy(params), copy.deepcopy(receipt)
        with patch.object(plugin, "_post_bot", return_value=receipt) as transport:
            result = json.loads(self.tools[name]["handler"](params))
        transport.assert_called_once()
        self.assertEqual(transport.call_args.args[0],
                         "/booking-preview" if name == "quote_booking" else "/availability-check")
        self.assertEqual(params, original_params)
        self.assertEqual(receipt, original_receipt)
        return result, transport.call_args.args[1]

    def test_explicit_payment_choice_survives_quote_without_reasking(self):
        for choice in ("deposit", "full", "split", "per_guest", "full amount", "pay on arrival"):
            with self.subTest(choice=choice):
                result, sent = self.invoke("quote_booking", {**self.params, "payment_choice": choice}, self.quote)
                self.assertEqual(result.get("payment_choice"), choice)
                self.assertFalse(result["payment_choice_needed"])
                self.assertFalse(result["full_payment_only"], "known choice is not a full-payment-only tariff")
                self.assertEqual(result["total_cents"], 84000)
                self.assertEqual(result["deposit_required_cents"], 24000)
                self.assertEqual(result["remaining_after_deposit_cents"], 60000)
                self.assertEqual(result["balance_due_cents"], 84000, "quote balance is not money received")
                self.assertEqual(sent["payment_choice"], choice)
                self.assertNotIn("confirm", sent)


    def test_blank_unknown_and_nonstring_are_not_payment_consent(self):
        for choice in (None, '', '  ', 'surprise', False, 1, {}):
            with self.subTest(choice=choice):
                result, sent = self.invoke('quote_booking', {**self.params, 'payment_choice': choice}, self.quote)
                self.assertTrue(result['payment_choice_needed'])
                self.assertFalse(result['full_payment_only'])
                self.assertNotIn('payment_choice', result)
                self.assertNotIn('confirm', sent)

    def test_full_payment_only_is_money_based_not_choice_based(self):
        receipt = {'success': True, 'quote': {'total_cents': 10000, 'deposit_required_cents': 10000}}
        for choice in ('', 'deposit', 'full', 'split'):
            result, _ = self.invoke('quote_booking', {**self.params, 'payment_choice': choice}, receipt)
            self.assertTrue(result['full_payment_only'])
            self.assertFalse(result['payment_choice_needed'])
            if not choice:
                self.assertNotIn('payment_choice', result)

    def test_available_beds_are_safe_staff_facts_with_eligibility_preserved(self):
        receipt = {'success': True, 'has_enough_beds': True,
                   'selected_room_code': 'MIX', 'selected_bed_codes': ['M1'],
                   'girls_room_available': True,
                   'available_beds': [
                       {'bed_code': 'M1', 'room_code': 'MIX', 'room_type': 'mixed',
                        'bed_label': 'Bed 1', 'active': True, 'sellable': True,
                        'occupant': {'name': 'PRIVATE'}, 'guest_phone': 'PRIVATE', 'price': 777},
                       {'bed_code': 'F1', 'room_code': 'GIRLS', 'room_type': 'female_only'},
                   ]}
        result, _ = self.invoke('check_availability', {**self.params, 'group_gender': 'male'}, receipt)
        self.assertEqual(result.get('available_beds'), [
            {'bed_code': 'M1', 'room_code': 'MIX', 'room_type': 'mixed', 'bed_label': 'Bed 1'}])
        self.assertEqual(result.get('selected_room_code'), 'MIX')
        self.assertFalse(result['girls_room_available'])
        self.assertIn('female_only', result['room_decision']['excluded_room_preferences'])
        self.assertFalse(result['needs_human'])
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_named_room_real_service_and_owner_renderer_keep_free_room_available(self):
        repo = Path(__file__).resolve().parents[4]
        script = r"""
const pref = process.argv[1];
const {
  buildWolfhouseAvailabilityCommand,
  executeWolfhouseAvailabilityCheck,
  mapBotHttpAvailabilityResponse,
} = require('./scripts/lib/luna-front-desk-accommodation-availability-service');
const {getBedCalendarRoomsQuery, getBedCalendarBlocksQuery} = require('./scripts/lib/staff-bed-calendar-queries');
const beds = [
  {bed_code:'R1-B1', room_code:'R1', room_type:'mixed', bed_active:true, bed_sellable:true, fill_priority:9},
  {bed_code:'R3-B1', room_code:'R3', room_type:'matrimonial_or_mixed', bed_active:true, bed_sellable:true, fill_priority:5},
  {bed_code:'R9-B1', room_code:'R9', room_type:'mixed', bed_active:true, bed_sellable:true, fill_priority:1},
];
(async () => {
  const built = buildWolfhouseAvailabilityCommand({
    channel:'bot_http', trustedClientSlug:'wolfhouse-somo', assignmentMode:false,
    demoCalendarEnrichment:false, transportBody:{check_in:'2027-07-05', check_out:'2027-07-12',
      guest_count:1, room_type:'shared', room_preference:pref, guest_name:'Raj'},
  });
  const pg = {query: async sql => {
    if (sql === getBedCalendarRoomsQuery()) return {rows:beds};
    if (sql === getBedCalendarBlocksQuery() || sql.includes('FROM wh_pricing_items')) return {rows:[]};
    throw Error('Unexpected SQL ' + sql);
  }};
  const checked = await executeWolfhouseAvailabilityCheck(pg, built.command);
  process.stdout.write(JSON.stringify(mapBotHttpAvailabilityResponse(checked.body)));
})().catch(error => { console.error(error); process.exitCode = 1; });
"""
        expected = {
            'room 1': 'R1', 'R1': 'R1',
            'room 3': 'R3', 'R3': 'R3',
            'mixed': 'R9',
        }
        for preference, room_code in expected.items():
            with self.subTest(preference=preference):
                completed = subprocess.run(
                    ['node', '-e', script, preference], cwd=repo, check=True,
                    text=True, capture_output=True,
                )
                receipt = json.loads(completed.stdout)
                result, _ = self.invoke('check_availability', {
                    **self.params, 'guest_count': 1, 'room_preference': preference,
                    'guest_name': 'Raj',
                }, receipt)
                self.assertEqual(result['availability_status'], 'available', result)
                self.assertFalse(result['unavailable'], result)
                self.assertEqual(result['selected_room_code'], room_code, result)
                self.assertEqual(result['selected_bed_codes'], [f'{room_code}-B1'], result)
                self.assertNotIn('not available', str(result.get('reply_draft', '')).casefold())

    def test_unknown_women_room_eligibility_preserves_positive_inventory_fact(self):
        params = {
            **self.params,
            "check_in": "2026-11-18", "check_out": "2026-11-21",
            "guest_count": 1, "room_type": "shared",
            "room_preference": "female_only", "guests": [{"name": "Emma"}],
            "payment_choice": "full",
        }
        receipt = {
            "success": True, "has_enough_beds": True,
            "girls_room_available": True,
            "selected_bed_codes": ["F1"],
            "available_beds": [
                {"bed_code": "F1", "room_code": "F", "room_type": "female_only"},
            ],
        }
        result, sent = self.invoke("check_availability", params, receipt)
        self.assertEqual(sent["check_in"], "2026-11-18")
        self.assertEqual(sent["check_out"], "2026-11-21")
        self.assertEqual(sent["room_preference"], "female_only")
        self.assertEqual(sent["guests"], [{"name": "Emma"}])
        self.assertEqual(sent["payment_choice"], "full")
        self.assertEqual(result["availability_status"], "eligibility_required", result)
        self.assertEqual(result["next_action"], "ask_room_eligibility")
        self.assertIs(result["girls_room_available"], True)
        self.assertEqual(result["reply_draft"], "Can Emma stay in the women-only dorm?")
        self.assertNotIn("mixed", result["reply_draft"].casefold())

    def test_explicit_answer_resolves_requested_women_room_without_reasking(self):
        params = {
            **self.params,
            "check_in": "2026-11-17", "check_out": "2026-11-20",
            "guest_count": 1, "room_type": "shared",
            "room_preference": "female_only", "payment_choice": "full",
            "guests": [{"name": "Emma Clarke", "explicit_gender": "female"}],
        }
        receipt = {
            "success": True, "has_enough_beds": True,
            "girls_room_available": True,
            "selected_room_code": "R5", "selected_bed_codes": ["R5-B1"],
            "available_beds": [
                {"bed_code": "R5-B1", "room_code": "R5", "room_type": "female_only"},
            ],
        }
        result, sent = self.invoke("check_availability", params, receipt)
        self.assertEqual(sent["check_in"], "2026-11-17")
        self.assertEqual(sent["check_out"], "2026-11-20")
        self.assertEqual(sent["payment_choice"], "full")
        self.assertEqual(sent["guests"], params["guests"])
        self.assertEqual(result["availability_status"], "available", result)
        self.assertFalse(result["room_decision"]["clarification_needed"])
        self.assertNotEqual(result.get("next_action"), "ask_room_eligibility")

    def test_quote_legacy_gendered_pick_blocks_before_price_until_eligibility_answer(self):
        params = {
            **self.params,
            "check_in": "2026-11-17", "check_out": "2026-11-20",
            "guest_count": 1, "room_type": "shared",
            "room_preference": "female_only", "payment_choice": "full",
            "guests": [{"name": "Emma Clarke"}],
        }
        availability = {
            "success": True, "has_enough_beds": True,
            "girls_room_available": True,
            "selected_room_code": "R5", "selected_bed_codes": ["R5-B1"],
            "available_beds": [
                {"bed_code": "R5-B1", "room_code": "R5", "room_type": "female_only"},
            ],
        }
        with patch.object(plugin, "_post_bot", return_value=availability) as transport:
            result = json.loads(self.tools["quote_booking"]["handler"](params))
        transport.assert_called_once()
        self.assertEqual(transport.call_args.args[0], "/availability-check")
        self.assertEqual(transport.call_args.args[1]["check_in"], "2026-11-17")
        self.assertEqual(transport.call_args.args[1]["check_out"], "2026-11-20")
        self.assertEqual(result["quote_status"], "needs_guest_clarification")
        self.assertEqual(result["availability_status"], "eligibility_required")
        self.assertEqual(result["reply_draft"],
                         "Can Emma Clarke stay in the women-only dorm?")
        self.assertIsNone(result["offer_revision"])
        self.assertIsNone(result["total_cents"])
        self.assertFalse(result["write_performed"])

    def test_mixed_gendered_selection_is_never_relabelled_from_filtered_subset(self):
        receipt = {'success': True, 'has_enough_beds': True,
                   'selected_bed_codes': ['A1', 'B1'],
                   'available_beds': [
                       {'bed_code': 'A1', 'room_code': 'A', 'room_type': 'male_only'},
                       {'bed_code': 'B1', 'room_code': 'B', 'room_type': 'female_only'},
                   ]}
        result, _ = self.invoke('check_availability', {**self.params, 'group_gender': 'male'}, receipt)
        self.assertEqual(result['selected_room_types'], ['male_only', 'female_only'])
        self.assertIsNone(result['selected_room_description'])
        self.assertIsNone(result['guest_safe_room_label'])
        self.assertEqual(result['selected_bed_codes'], ['A1', 'B1'])

    def test_eligibility_conflict_is_neither_available_nor_sold_out(self):
        receipt = {'success': True, 'has_enough_beds': True,
                   'selected_room_code': None, 'selected_bed_codes': [],
                   'available_beds': [
                       {'bed_code': 'F1', 'room_code': 'F', 'room_type': 'female_only'},
                   ]}
        result, _ = self.invoke('check_availability', {
            **self.params, 'guest_count': 1, 'room_preference': 'female_only',
            'explicit_gender': 'male',
        }, receipt)
        self.assertFalse(result['available'])
        self.assertFalse(result['unavailable'])
        self.assertEqual(result['next_action'], 'ask_room_eligibility')

    def test_private_selected_room_survives_unmarked_free_sibling(self):
        receipt = {'success': True, 'has_enough_beds': True,
                   'selected_room_code': 'P', 'selected_bed_codes': ['P-B1'],
                   'available_beds': [
                       {'bed_code': 'P-B1', 'room_code': 'P', 'room_type': 'female_only',
                        'selected_selling_mode': 'private'},
                       {'bed_code': 'P-B2', 'room_code': 'P', 'room_type': 'female_only'},
                   ]}
        result, _ = self.invoke('check_availability', {
            **self.params, 'guest_count': 1, 'room_preference': 'private',
        }, receipt)
        self.assertEqual(result['selected_room_code'], 'P')
        self.assertEqual(result['selected_bed_codes'], ['P-B1'])
        self.assertEqual(result['selected_room_description'], 'private')
        self.assertEqual(result['guest_safe_room_label'], 'Private room.')

    def test_raw_booking_receipt_resumes_adapter_but_completed_receipt_short_circuits(self):
        import sys
        from wolfhouse import accepted_quote as ledger

        raw = {'success': True, 'write_performed': True,
               'booking_id': 'unit-booking', 'booking_code': 'UNIT-1'}
        completed = {**raw, 'post_booking_email': {
            'requested': True, 'saved': True, 'sent': False,
            'send_performed': False, 'outcome': 'saved'}}
        calls = []
        def adapter(params, **kwargs):
            calls.append(dict(params))
            return json.dumps(completed)
        guarded = plugin._quote_owner_handler('create_booking_from_plan', adapter)
        ticket = {'owner': 'ticket'}
        with patch.dict(sys.modules, {'agent.conversation_loop': object()}), \
                patch.object(ledger, 'prepare_create', return_value=ticket), \
                patch.object(ledger, 'record_create_completion') as record:
            with patch.object(ledger, 'dispatch_recovery', return_value={
                    'receipt': raw, 'adapter_completed': False}):
                result = json.loads(guarded({'email': 'alex@example.test'}))
            self.assertEqual(result['post_booking_email']['outcome'], 'saved')
            self.assertEqual(len(calls), 1, 'raw receipt must resume adapter work')
            record.assert_called_once_with(ticket, completed)

            calls.clear()
            record.reset_mock()
            with patch.object(ledger, 'dispatch_recovery', return_value={
                    'receipt': completed, 'adapter_completed': True}):
                replay = json.loads(guarded({'email': 'alex@example.test'}))
            self.assertEqual(replay['post_booking_email']['outcome'], 'saved')
            self.assertEqual(calls, [], 'completed adapter work must not run twice')
            record.assert_not_called()

    def test_post_booking_email_save_outcomes_replay_and_no_write_fences(self):
        payload = {'client_slug': 'wolfhouse-somo', 'email': 'alex@example.test'}
        created = {'success': True, 'write_performed': True}
        fields = {'booking_code': 'UNIT-EMAIL'}
        cases = (
            ({'success': True, 'write_performed': True, 'email_sent': True}, True, 'saved'),
            ({'success': False, 'write_performed': False, 'error': 'refused'}, False, 'refused'),
            ({'success': False, 'error': 'timeout'}, False, 'unknown'),
        )
        for adapter_result, saved, outcome in cases:
            with self.subTest(outcome=outcome), patch.object(plugin, '_post_bot', return_value=adapter_result) as post:
                result = plugin._save_post_booking_email(payload, created, fields)
                self.assertEqual(result['saved'], saved)
                self.assertEqual(result['outcome'], outcome)
                self.assertFalse(result['sent'])
                self.assertFalse(result['send_performed'])
                post.assert_called_once_with('/bookings/update-contact', {
                    'client_slug': 'wolfhouse-somo', 'booking_code': 'UNIT-EMAIL',
                    'email': 'alex@example.test',
                })

        prior = {'post_booking_email': {'requested': True, 'saved': True, 'sent': False,
                                        'send_performed': False, 'outcome': 'saved'}}
        with patch.object(plugin, '_post_bot') as post:
            self.assertEqual(plugin._save_post_booking_email(payload, created, fields, prior),
                             prior['post_booking_email'])
            self.assertIsNone(plugin._save_post_booking_email(payload,
                {'success': False, 'write_performed': False}, fields))
            self.assertIsNone(plugin._save_post_booking_email(payload,
                {'success': True, 'write_performed': False}, fields))
            self.assertIsNone(plugin._save_post_booking_email({}, created, fields))
            post.assert_not_called()

    def test_post_booking_contact_owner_status_controls_replay_transport(self):
        from wolfhouse import accepted_quote as ledger
        payload = {'client_slug': 'wolfhouse-somo', 'email': 'alex@example.test'}
        created = {'success': True, 'write_performed': True}
        fields = {'booking_code': 'UNIT-EMAIL'}
        ticket = {'owner': 'opaque'}

        with patch.object(ledger, 'post_booking_contact_status',
                          return_value={'status': 'unknown'}), \
                patch.object(ledger, 'begin_post_booking_contact') as begin, \
                patch.object(plugin, '_post_bot') as post:
            result = plugin._save_post_booking_email(
                payload, created, fields, prior_receipt=created, ticket=ticket)
        self.assertEqual(result['outcome'], 'unknown')
        self.assertTrue(result['uncertain'])
        self.assertFalse(result['sent'])
        begin.assert_not_called()
        post.assert_not_called()

        with patch.object(ledger, 'post_booking_contact_status',
                          return_value={'status': 'pending'}), \
                patch.object(ledger, 'begin_post_booking_contact',
                             return_value={'perform': True, 'contact': {'status': 'unknown'}}), \
                patch.object(ledger, 'complete_post_booking_contact') as complete, \
                patch.object(plugin, '_post_bot',
                             return_value={'success': True, 'write_performed': True}):
            result = plugin._save_post_booking_email(
                payload, created, fields, prior_receipt=created, ticket=ticket)
        self.assertEqual(result['outcome'], 'saved')
        complete.assert_called_once()
        self.assertFalse(complete.call_args.kwargs['outcome']['sent'])

    def test_failed_or_malformed_availability_cannot_project_beds(self):
        for receipt in (
            {'success': False, 'available_beds': [{'bed_code': 'M1'}], 'selected_room_code': 'MIX'},
            {'success': True, 'available_beds': {'occupant': 'PRIVATE'}, 'selected_room_code': {'guest': 'PRIVATE'}},
            {'success': True, 'available_beds': [None, 'PRIVATE', {'bed_code': {'name': 'PRIVATE'}}]},
        ):
            result, _ = self.invoke('check_availability', self.params, receipt)
            self.assertEqual(result.get('available_beds'), [])
            self.assertIsNone(result.get('selected_room_code'))
            self.assertNotIn('PRIVATE', json.dumps(result))


if __name__ == "__main__":
    unittest.main()
