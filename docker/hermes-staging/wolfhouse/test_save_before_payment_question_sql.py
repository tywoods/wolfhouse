"""Fix A: committed SQL row precedes the amount question, solo and two guests.

Run with the existing Hermes venv, PYTHONPATH including Hermes, staging and plugins:
  python docker/hermes-staging/wolfhouse/test_save_before_payment_question_sql.py -v

Actual registered tools, owner, Staff body reader/tenant dispatcher/create-from-plan
wrapper, create service and PostgreSQL (PGlite) INSERT/COMMIT/SELECT. No saved rows
or create receipts are mocked. Reuses first-yes ingress/SQL fixtures unchanged.
The model is SCRIPTED and delivery is offline: this proves save-path ordering,
not that a live LLM follows the prompt. No Stripe or guest sends are permitted.

Negative controls (each must fail the same assertions for both party sizes):
  FIX_A_SQL_MUTANT=early-question ...python ...test_save_before_payment_question_sql.py
  FIX_A_SQL_MUTANT=rollback ...python ...test_save_before_payment_question_sql.py
  FIX_A_SQL_MUTANT=early-link ...python ...test_save_before_payment_question_sql.py
These inject faults only into this test; never change production files or guards.
"""
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

STAGING = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(STAGING), str(STAGING / 'plugins')]
from wolfhouse import test_first_yes_persistence as harness

# Observe the exact production atomic SQL and await the actual database result.
# The extra read is observational: never substitute query rows or receipts.
SQL_OBSERVER = r"""
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const normalize = s => String(s).replace(/\s+/g, ' ').trim().replace(/;$/, '');
const atomic = normalize(require('./scripts/lib/staff-manual-booking-create-sql').buildManualBookingCreateSql());
const append = event => fs.appendFileSync(process.env.FIX_A_SQL_TRACE, JSON.stringify(event) + '\n');
const query = PGlite.prototype.query;
let bookingId;
PGlite.prototype.query = async function(sql, ...args) {
  const text = normalize(sql);
  if (text === 'COMMIT' && process.env.FIX_A_SQL_MUTANT === 'rollback') {
    const result = await query.call(this, 'ROLLBACK');
    append({event: 'ROLLBACK_MUTANT'});
    return result;
  }
  const result = await query.call(this, sql, ...args);
  if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') append({event: text});
  if (text === atomic) {
    bookingId = result.rows[0] && result.rows[0].booking_id;
    append({event: 'INSERT', booking_id: bookingId});
  }
  if (text === 'COMMIT' && bookingId) {
    const read = await query.call(this, 'SELECT * FROM bookings WHERE id=$1::uuid', [bookingId]);
    append({event: 'SELECT_AFTER_COMMIT', rows: read.rows});
  }
  return result;
};
require('./scripts/fixtures/first-yes-sql.js');
// Override the fixture's network tripwires with counted failures, including any
// attempt swallowed by application error handling. There are no socket servers.
const deny = () => { append({event: 'NETWORK_ATTEMPT'}); throw Error('Offline SQL proof: network forbidden'); };
require('node:net').Socket.prototype.connect = deny;
require('node:tls').connect = deny;
for (const name of ['node:http', 'node:https']) {
  require(name).request = deny; require(name).get = deny;
}
globalThis.fetch = deny;
"""


class SaveBeforePaymentQuestionSQLTests(unittest.TestCase):
    rpc = harness.FirstYesPersistenceTests.rpc
    turn = harness.FirstYesPersistenceTests.turn
    clear_context = harness.FirstYesPersistenceTests.clear_context
    close_node = harness.FirstYesPersistenceTests.close_node

    def setUp(self):
        self.proof_temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.proof_temp.cleanup)
        self.trace_path = Path(self.proof_temp.name) / 'trace.jsonl'
        self.trace_path.touch()
        self.snapshots = []
        self.link_attempts = []
        self.network_attempts = []
        self.mutant = os.environ.get('FIX_A_SQL_MUTANT', '')
        self.assertIn(self.mutant, ('', 'early-question', 'rollback', 'early-link'))
        env = patch.dict(os.environ, {
            'FIX_A_SQL_TRACE': str(self.trace_path),
            'PYTHONDONTWRITEBYTECODE': '1',
            'NODE_OPTIONS': '--max-old-space-size=1024',
        })
        env.start()
        self.addCleanup(env.stop)
        original_popen = subprocess.Popen

        def instrument_fixture(command, *args, **kwargs):
            self.assertEqual(Path(command[1]).name, 'first-yes-sql.js')
            return original_popen(['node', '-e', SQL_OBSERVER], *args, **kwargs)

        # Only change the fixture launch; its handlers and SQL remain untouched.
        with patch.object(harness.subprocess, 'Popen', side_effect=instrument_fixture):
            harness.FirstYesPersistenceTests.setUp(self)
        for target in ('socket.socket.connect', 'socket.create_connection'):
            guard = patch(target, side_effect=self.deny_network)
            guard.start()
            self.addCleanup(guard.stop)

    def deny_network(self, *args, **kwargs):
        self.network_attempts.append('forbidden socket')
        raise AssertionError('Offline SQL proof: network forbidden')

    def event(self, name, **details):
        with self.trace_path.open('a') as stream:
            stream.write(json.dumps(dict(event=name, **details)) + '\n')

    def observe(self, name, receipt=None, text=None):
        snapshot = self.rpc(snapshot=True)
        self.snapshots.append(snapshot)
        self.event(name, tables=snapshot['tables'], errors=snapshot['errors'],
                   receipt=receipt, text=text)

    def http_edge(self, request, **kwargs):
        path = urlsplit(request.full_url).path
        self.assertTrue(path.startswith('/staff/bot/'), path)
        path = path[len('/staff/bot'):]
        if 'link' in path:
            self.link_attempts.append(path)
            self.event('LINK_ATTEMPT', path=path)
            raise URLError('Offline SQL proof: payment link forbidden before tier answer')
        self.assertIn(path, ('/contact-identity', '/booking-preview',
                             '/availability-check', '/booking-create-from-plan'))
        command = dict(path=path, body=json.loads(request.data),
                       guest_phone=request.get_header('X-luna-guest-phone'))
        if path == '/booking-create-from-plan':
            # Unlike the fixture's legacy direct-handler shortcut, exercise the
            # actual reader, principal binding, route wrapper and create handler.
            command.update(staff_body_stream=True, raw_body=request.data.decode())
        result = self.rpc(**command)
        if path == '/booking-create-from-plan':
            self.observe('STAFF_RESPONSE', receipt=result['body'])
        body = io.BytesIO(json.dumps(result['body']).encode())
        body.status, body.headers = result['status'], {}
        if body.status >= 400:
            raise HTTPError(request.full_url, body.status, 'Actual Staff refusal', {}, body)
        return body

    def run_party(self, count):
        plan = copy.deepcopy(harness.PLAN)
        plan.pop('payment_choice', None)
        plan.update(guest_count=count, guests=[{'name': n} for n in ('Riley', 'Morgan')[:count]],
                    check_in='2027-10-20', check_out='2027-10-24',
                    payment_link_distribution='together', per_guest_payment_links=False)
        # No ask_payment_amount/pending flag is pre-seeded: real owner/Staff must
        # discover the missing amount choice, without using it to prevent saving.
        with patch.dict(harness.PLAN, plan, clear=True):
            self.turn('Please quote this booking', 'checked-offer')
            self.assertTrue(self.quote_result['success'], self.quote_result)
            self.assertEqual(self.rpc(snapshot=True)['tables']['bookings'], [])

            def scripted_model(agent, message, *args, **kwargs):
                for hook in self.registry.hooks.get('pre_llm_call', []):
                    hook(session_id=agent.session_id, user_message=message)
                if self.mutant == 'early-question':
                    self.observe('MODEL_QUESTION', text='Deposit or full?')
                if self.mutant == 'early-link':
                    # Attempt through the real transport boundary, not a canned
                    # link success. The observer must fail even if it is caught.
                    harness.plugin._post_bot('/payments/not-saved/create-stripe-link', {})
                created = json.loads(self.registry.tools['create_booking_from_plan']['handler']({}))
                self.last_receipt = created
                self.observe('TOOL_RECEIPT', receipt=created)
                reply = (f"Your booking is saved. Reference: {created.get('booking_code')}. "
                         "Would you like to pay the deposit or the full amount?")
                self.observe('MODEL_QUESTION', receipt=created, text=reply)
                return {'completed': True, 'final_response': reply, 'booking_result': created,
                        'messages': [{'role': 'assistant', 'content': reply}]}

            def scripted_confirmation(_agent, facts, invalid_draft, **kwargs):
                # The finalizer's authoring LLM edge also uses real saved facts.
                # In particular, there is deliberately no amount_due_now while
                # the tier is unresolved (the generic old fixture assumes one).
                self.event('AUTHORING_INPUT', facts=facts)
                display = harness.accepted_quote._confirmation_rewrite_payload(
                    facts, invalid_draft, [])['required_guest_facts']
                self.assertTrue(self.last_receipt.get('ask_payment_amount'), self.last_receipt)
                self.assertIs(facts.get('ask_payment_amount'), True)
                self.assertFalse(display['payment_links'])
                self.assertNotIn('amount_due_now', display)
                text = (f"Your booking is saved. Reference: {display['booking_reference']}. "
                        f"Total: {display['total']}.")
                if display.get('saved_room_type'):
                    text += f" Room type: {display['saved_room_type']}."
                if display.get('saved_room_numbers'):
                    text += ' Room: ' + ', '.join(display['saved_room_numbers']) + '.'
                if display.get('remaining_balance'):
                    text += f" Remaining balance: {display['remaining_balance']}, due at arrival/check-in."
                if display.get('location_url'):
                    text += '\n' + display['location_url']
                text += '\nWould you like to pay the deposit or the full amount?'
                self.observe('AUTHORING_QUESTION', receipt=self.last_receipt, text=text)
                return text

            with patch.object(harness.conversation_loop, 'run_conversation', scripted_model), \
                    patch.object(harness.accepted_quote, '_rewrite_saved_confirmation',
                                 side_effect=scripted_confirmation):
                # Reinstall the real wrapper around this scripted model edge;
                # replacing run_conversation alone would bypass owner ingress.
                harness.accepted_quote.install_owner_hook()
                result = self.turn('yes', 'accepted-stay-without-payment-tier')
            self.observe('FINAL_REPLY', receipt=result.get('booking_result'),
                         text=result.get('final_response', ''))

        events = [json.loads(line) for line in self.trace_path.read_text().splitlines()]
        evidence = os.environ.get('FIX_A_SQL_EVIDENCE_DIR')
        if evidence:
            directory = Path(evidence)
            directory.mkdir(parents=True, exist_ok=True)
            (directory / f'party-{count}.json').write_text(json.dumps(events, indent=2) + '\n')
        kinds = [e['event'] for e in events]
        self.assertEqual(self.network_attempts, [])
        self.assertNotIn('NETWORK_ATTEMPT', kinds)
        self.assertEqual(self.link_attempts, [], 'No link attempt before the amount answer')
        self.assertNotIn('LINK_ATTEMPT', kinds)
        self.assertEqual(kinds.count('INSERT'), 1, 'One exact production atomic INSERT')
        self.assertEqual(kinds.count('COMMIT'), 1, 'Real COMMIT required before amount question')
        self.assertNotIn('ROLLBACK', kinds)
        self.assertNotIn('ROLLBACK_MUTANT', kinds)
        required = ['BEGIN', 'INSERT', 'COMMIT', 'SELECT_AFTER_COMMIT', 'STAFF_RESPONSE',
                    'TOOL_RECEIPT', 'MODEL_QUESTION', 'FINAL_REPLY']
        positions = [kinds.index(kind) for kind in required]
        self.assertEqual(positions, sorted(positions), 'Save/readback must precede first amount question')
        selected = events[kinds.index('SELECT_AFTER_COMMIT')]['rows']
        self.assertEqual(len(selected), 1, 'SELECT must find the committed booking')
        saved = selected[0]
        self.assertEqual(saved['id'], events[kinds.index('INSERT')]['booking_id'])
        self.assertEqual(saved['guest_count'], count)
        self.assertEqual(saved['status'], 'confirmed')
        self.assertEqual(saved['metadata']['payment_choice_pending'], True)
        self.assertEqual(saved['metadata']['ask_payment_amount'], True)
        self.assertIsNone(saved['metadata'].get('payment_choice'))
        for event in events:
            if event['event'] not in ('STAFF_RESPONSE', 'TOOL_RECEIPT', 'MODEL_QUESTION', 'FINAL_REPLY'):
                continue
            self.assertEqual(event['errors'], [])
            tables = event['tables']
            self.assertEqual(len(tables['bookings']), 1, f"Booking must already exist at {event['event']}")
            self.assertEqual(tables['bookings'][0]['id'], saved['id'])
            self.assertEqual(len(tables['booking_guests']), count)
            self.assertEqual(len(tables['booking_beds']), count)
            self.assertTrue(all(p['status'] == 'draft' for p in tables['payments']))
            # No checkout or short payment URL in SQL rows, receipts or replies.
            serialized = json.dumps(event)
            self.assertNotRegex(serialized, r'https?://[^\s"\\]*(?:checkout|/pay/|/g[0-9]+)')
            self.assertNotRegex(serialized, r'cs_(?:test|live)_')
            receipt = event.get('receipt') or {}
            self.assertTrue(receipt.get('success'), receipt)
            self.assertEqual(receipt.get('booking_id'), saved['id'])
            self.assertTrue(receipt.get('ask_payment_amount'), receipt)
            self.assertFalse(receipt.get('secure_payment_url'))
            self.assertFalse(receipt.get('guest_payment_links'))
        self.assertIsInstance(result.get('final_response'), str,
                              'Real finalizer withheld the post-save deposit/full question')
        self.assertIn(saved['booking_code'], result['final_response'])
        self.assertRegex(result['final_response'].lower(), r'deposit.*full.*\?')
        creates = [c for c in self.snapshots[-1]['calls'] if c['path'] == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertTrue(creates[0]['transport']['handler_called'])
        self.assertEqual(creates[0]['transport']['bound_client_slug'], 'wolfhouse-somo')
        print(f"SQL PASS party={count}: {' -> '.join(required)}; booking_id={saved['id']}; "
              f"guests={count}, beds={count}, link_attempts=0; model scripted, delivery offline")

    def test_solo_commits_before_amount_question_or_link(self):
        self.run_party(1)

    def test_two_guests_commit_before_amount_question_or_link(self):
        self.run_party(2)


class PendingAmountConfirmationTests(unittest.TestCase):
    """The post-save exception must not change known payment facts."""

    def facts(self, **receipt_changes):
        receipt = dict(booking_code='WH-20271020-12345678', total_cents=40000,
                       ask_payment_amount=True, payment_choice_pending=True)
        receipt.update(receipt_changes)
        return harness.accepted_quote._saved_confirmation_facts(
            {'guests': [{'name': 'Riley'}]}, {}, receipt)

    def test_pending_receipt_survives_empty_checked_offer(self):
        facts = self.facts()
        self.assertIs(facts.get('ask_payment_amount'), True)
        self.assertIsNone(harness.accepted_quote._amount_due_now_cents(facts))
        self.assertIsNotNone(harness.accepted_quote._sendable_saved_confirmation(
            'Saved WH-20271020-12345678. Total €400. Deposit or full?', facts))

    def test_pending_choice_does_not_invent_quote_deposit_due_now(self):
        facts = harness.accepted_quote._saved_confirmation_facts(
            {'guests': [{'name': 'Riley'}]},
            {'total_cents': 40000, 'deposit_required_cents': 10000},
            {'booking_code': 'WH-20271020-12345678', 'total_cents': 40000,
             'payment_choice_pending': True})
        self.assertIs(facts.get('ask_payment_amount'), True)
        self.assertIsNone(harness.accepted_quote._amount_due_now_cents(facts))
        display = harness.accepted_quote._confirmation_rewrite_payload(
            facts, '', [])['required_guest_facts']
        self.assertNotIn('amount_due_now', display)

    def test_known_deposit_and_full_still_require_saved_amount_and_link(self):
        for due in (10000, 40000):
            with self.subTest(due=due):
                url = 'https://example.invalid/pay/saved-booking'
                facts = self.facts(amount_due_cents=due, secure_payment_url=url)
                self.assertNotIn('ask_payment_amount', facts)
                self.assertEqual(harness.accepted_quote._amount_due_now_cents(facts), due)
                self.assertEqual(facts['payment_links'], [url])
                reply = f'Saved WH-20271020-12345678. Total €400. Due now €{due // 100}. {url}'
                if facts.get('remains_owed_cents'):
                    reply += f" Remaining €{facts['remains_owed_cents'] // 100} at arrival."
                self.assertIsNotNone(harness.accepted_quote._sendable_saved_confirmation(reply, facts))
                self.assertIsNone(harness.accepted_quote._sendable_saved_confirmation(
                    reply.replace(url, ''), facts))
                self.assertIsNone(harness.accepted_quote._sendable_saved_confirmation(
                    reply.replace(f'€{due // 100}', '€12'), facts))

    def test_unknown_due_without_pending_fact_is_not_silently_accepted(self):
        facts = self.facts(ask_payment_amount=False, payment_choice_pending=False)
        self.assertIsNone(harness.accepted_quote._sendable_saved_confirmation(
            'Saved WH-20271020-12345678. Total €400.', facts))

    def test_pending_still_requires_saved_total_reference_and_no_untrusted_url(self):
        facts = self.facts()
        valid = 'Saved WH-20271020-12345678. Total €400. Deposit or full?'
        for text in (valid.replace('€400', '€12'),
                     valid.replace('12345678', '87654321'),
                     valid + ' https://example.invalid/pay/not-authorized'):
            with self.subTest(text=text):
                self.assertIsNone(harness.accepted_quote._sendable_saved_confirmation(text, facts))


if __name__ == '__main__':
    unittest.main(verbosity=2)
