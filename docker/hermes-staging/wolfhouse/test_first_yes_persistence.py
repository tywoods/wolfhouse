"""First-yes proof: patched original ingress -> registered owners -> real Staff SQL.

Only the LLM and HTTP/delivery edges are substituted. HTTP response bodies come
from the actual Staff preview/create handlers over a stdio PGlite adapter, not
handwritten success fixtures. Gateway session selection uses the existing bounded
harness; this is not a full gateway/delivery or deployed-environment claim.
Run with the Hermes venv and PYTHONPATH containing Hermes, staging and plugins.
"""
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
from threading import Lock
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

from hermes_state import SessionDB
from gateway.session_context import set_session_vars, clear_session_vars
from run_agent import AIAgent
from agent import conversation_loop
from wolfhouse import accepted_quote, booking_names
from wolfhouse.offline_ingress_harness import gateway_ingress
import wolfhouse_staff_api as plugin

ROOT = Path(__file__).resolve().parents[3]
PLAN = dict(check_in='2026-10-20', check_out='2026-10-22', guest_count=2,
            guest_name='Riley', guests=[{'name': 'Riley'}, {'name': 'Morgan'}],
            phone='+999****0001', package_code='package_none', room_type='shared',
            room_preference='shared', group_gender='mixed', payment_choice='full')


class OfflineAgentInterruption(BaseException):
    """HTTP-edge interruption that leaves the owner transaction uncommitted."""


class Registry:
    def __init__(self):
        self.tools, self.hooks = {}, {}

    def register_tool(self, **kwargs):
        self.tools[kwargs['name']] = kwargs

    def register_hook(self, name, handler):
        self.hooks.setdefault(name, []).append(handler)


class FirstYesPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {
            'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'LUNA_ALLOWED_LOCATION_IDS': '',
            'SUNSET_INGRESS_LOCATION_ID': '', 'LUNA_BOT_INTERNAL_TOKEN': 'offline-proof-not-a-credential',
            'HERMES_HOME': self.temp.name,
        })
        self.env.start()
        self.addCleanup(self.env.stop)
        self.node = subprocess.Popen(['node', str(ROOT / 'scripts/fixtures/first-yes-sql.js')],
            cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(self.close_node)
        ready = self.node.stdout.readline()
        self.assertEqual(json.loads(ready), {'ready': True})
        self.rpc_lock = Lock()
        self.db_path = Path(self.temp.name) / 'state.db'
        self.db = SessionDB(self.db_path)
        self.db.create_session('first-yes', source='whatsapp')
        self.addCleanup(lambda: self.db.close())
        self.agent = object.__new__(AIAgent)
        self.agent._session_db, self.agent.session_id = self.db, 'first-yes'
        self.registry = Registry()
        self.tokens = None
        self.messages = []
        self.model_calls = []
        self.quote_result = None
        self.fail_after_quote = False
        self.lose_commit_reply = False
        self.interrupt_after_commit = False
        self.original = conversation_loop.run_conversation
        self.addCleanup(lambda: setattr(conversation_loop, 'run_conversation', self.original))

        def offline_llm(agent, message, *args, **kwargs):
            self.model_calls.append(message)
            for hook in self.registry.hooks.get('pre_llm_call', []):
                hook(session_id=agent.session_id, user_message=message)
            if message == 'Please quote this booking':
                self.quote_result = json.loads(self.registry.tools['quote_booking']['handler'](dict(PLAN)))
                self.assertTrue(self.quote_result.get('success'), self.quote_result)
                if self.fail_after_quote:
                    raise RuntimeError('Offline LLM aborted before response presentation')
            return {'completed': True, 'final_response': 'Offline LLM edge; no booking claim.', 'messages': []}

        conversation_loop.run_conversation = offline_llm
        plugin.register(self.registry)
        self.http = patch.object(plugin.urllib.request, 'urlopen', side_effect=self.http_edge)
        self.http.start()
        self.addCleanup(self.http.stop)
        self.no_network = patch.object(socket.socket, 'connect', side_effect=AssertionError('Network forbidden'))
        self.no_network.start()
        self.addCleanup(self.no_network.stop)
        self.addCleanup(self.clear_context)

    def clear_context(self):
        if self.tokens:
            clear_session_vars(self.tokens)
            self.tokens = None
        accepted_quote._current.set(None)
        booking_names.end_turn()

    def close_node(self):
        if self.node.stdin and not self.node.stdin.closed:
            self.node.stdin.close()
        try:
            self.node.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.node.kill()
            self.node.wait(timeout=5)
        error = self.node.stderr.read()
        self.node.stdout.close()
        self.node.stderr.close()
        self.assertEqual(self.node.returncode, 0, error)

    def rpc(self, **command):
        with self.rpc_lock:
            self.node.stdin.write(json.dumps(command) + '\n')
            self.node.stdin.flush()
            line = self.node.stdout.readline()
        self.assertTrue(line, 'SQL adapter stopped')
        response = json.loads(line)
        self.assertNotIn('fixture_error', response, response)
        return response

    def http_edge(self, request, **kwargs):
        path = urlsplit(request.full_url).path
        self.assertTrue(path.startswith('/staff/bot/'), path)
        path = path[len('/staff/bot'):]
        result = self.rpc(path=path, body=json.loads(request.data))
        if path == '/booking-create-from-plan' and self.interrupt_after_commit:
            self.interrupt_after_commit = False
            self.assertTrue(result['body'].get('write_performed'), result)
            raise OfflineAgentInterruption('Interrupted after real SQL commit, before owner completion')
        if path == '/booking-create-from-plan' and self.lose_commit_reply:
            self.lose_commit_reply = False
            self.assertTrue(result['body'].get('write_performed'), result)
            raise URLError('offline simulated response loss AFTER real SQL commit')
        body = io.BytesIO(json.dumps(result['body']).encode())
        body.status = result['status']
        body.headers = {}
        if result['status'] >= 400:
            raise HTTPError(request.full_url, result['status'], 'Actual offline Staff refusal', {}, body)
        return body

    def turn(self, message, message_id=None, **kwargs):
        if self.tokens:
            clear_session_vars(self.tokens)
        message_id = message_id or 'message-' + str(len(self.messages) + 1)
        self.tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id='chat1',
            user_id='guest1', session_key='key1', session_id=self.agent.session_id, message_id=message_id)
        result = gateway_ingress(self.agent, message, message_id, self.agent.run_conversation, **kwargs)
        self.messages.append({'id': message_id, 'input': message, 'result': result})
        return result

    def offer(self):
        result = self.turn('Please quote this booking', 'offer')
        self.assertEqual(self.quote_result.get('availability', {}).get('status'), 'checked', self.quote_result)
        revision = self.quote_result.get('offer_revision')
        self.assertIsInstance(revision, dict, self.quote_result)
        self.assertTrue(revision.get('offer_fingerprint'))
        text = result.get('final_response', '')
        for fragment in ('riley', 'morgan', '2026-10-20', '2026-10-22', '160'):
            self.assertIn(fragment, text.lower(), text)
        self.assertEqual(text.count('?'), 1, text)
        self.assertEqual(self.rpc(snapshot=True)['tables']['bookings'], [], 'Checking is NOT holding or booking')
        return revision

    def assert_one_booking(self, revision):
        snapshot = self.rpc(snapshot=True)
        self.assertEqual(snapshot['errors'], [])
        self.assertEqual(len(snapshot['tables']['bookings']), 1, snapshot)
        guests = sorted(snapshot['tables']['booking_guests'], key=lambda row: row['guest_number'])
        expected = [(item['guest_name'], item['bed_code']) for item in revision['guest_bed_assignments']]
        self.assertEqual([(row['guest_name'].lower(), row['assigned_bed_code']) for row in guests], expected)
        self.assertEqual(len(snapshot['tables']['booking_beds']), 2)
        return snapshot

    def tearDown(self):
        evidence_dir = os.getenv('FIRST_YES_EVIDENCE_DIR')
        if evidence_dir and hasattr(self, 'rpc_lock'):
            evidence = {'case': self.id(), 'evidence_mode': 'offline real Staff handlers + SQL; bounded original-ingress harness; LLM and HTTP edges substituted',
                        'messages': self.messages, 'model_calls': self.model_calls, 'snapshot': self.rpc(snapshot=True)}
            target = Path(evidence_dir)
            target.mkdir(parents=True, exist_ok=True)
            (target / (self._testMethodName + '.json')).write_text(json.dumps(evidence, indent=2) + '\n')

    def test_one_short_yes_persists_exact_people_and_beds_without_model_create(self):
        revision = self.offer()
        result = self.turn('yes', 'accept')
        snapshot = self.assert_one_booking(revision)
        self.assertEqual(self.model_calls, ['Please quote this booking'], 'Acceptance must not depend on another model turn')
        calls = [call for call in snapshot['calls'] if call['path'] == '/booking-create-from-plan']
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]['body']['require_offer_identity'])
        self.assertEqual(calls[0]['body']['accepted_offer'], revision)
        self.assertIn(snapshot['tables']['bookings'][0]['booking_code'], result.get('final_response', ''))
        self.assertNotIn('?', result.get('final_response', ''), 'No reconfirm loop after successful create')

    def test_offer_uses_plain_guest_copy_not_internal_codes_or_json(self):
        result = self.turn('Please quote this booking', 'plain-offer')
        text = result['final_response']
        self.assertIn('Accommodation only', text)
        for internal in ('package_none', '[]', '{', 'payment_choice', 'female_only'):
            self.assertNotIn(internal, text)
        self.assertEqual(text.count('?'), 1)

    def test_interrupted_owner_reopens_and_recovers_original_yes_delivery(self):
        revision = self.offer()
        self.interrupt_after_commit = True
        with self.assertRaises(OfflineAgentInterruption):
            self.turn('yes', 'one-original-consent')
        committed = self.assert_one_booking(revision)
        # Real SQLite close rolls back the interrupted dispatch transaction;
        # reopen retains only state committed BEFORE the Staff transport.
        self.db.close()
        self.db = SessionDB(self.db_path)
        self.agent._session_db = self.db
        recovered = self.turn('yes', 'one-original-consent')
        after = self.assert_one_booking(revision)
        self.assertEqual(after['tables'], committed['tables'])
        calls = [c for c in after['calls'] if c['path'] == '/booking-create-from-plan']
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]['body']['idempotency_key'], calls[1]['body']['idempotency_key'])
        self.assertIn(after['tables']['bookings'][0]['booking_code'], recovered['final_response'])
        self.assertNotIn('?', recovered['final_response'])
        self.assertEqual(self.model_calls, ['Please quote this booking'])

    def test_catalog_extra_days_survive_checked_offer_and_first_yes(self):
        selection = {'service_code': 'wetsuit_rental', 'quantity': 1, 'days': 3}
        with patch.dict(PLAN, {'catalog_selections': [selection]}):
            self.turn('Please quote this booking', 'extra-offer')
        revision = self.quote_result['offer_revision']
        result = self.turn('yes', 'accept-extra')
        snapshot = self.assert_one_booking(revision)
        creates = [call for call in snapshot['calls'] if call['path'] == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1, result)
        self.assertEqual(creates[0]['body']['add_ons'], [{'code': 'wetsuit_rental', 'quantity': 1, 'days': 3}])
        self.assertEqual(self.model_calls, ['Please quote this booking'])

    def test_completed_retry_survives_session_db_reopen_without_another_booking(self):
        revision = self.offer()
        first = self.turn('yes', 'accept')
        before = self.assert_one_booking(revision)
        self.db.close()
        self.db = SessionDB(self.db_path)
        self.agent._session_db = self.db
        retry = self.turn('yes', 'retry-after-reopen')
        after = self.assert_one_booking(revision)
        self.assertEqual(after['tables'], before['tables'])
        self.assertEqual(retry.get('final_response'), first.get('final_response'))
        self.assertEqual(sum(call['path'] == '/booking-create-from-plan' for call in after['calls']), 1)

    def test_lost_commit_reply_recovers_same_sql_booking_and_idempotency_key(self):
        revision = self.offer()
        self.lose_commit_reply = True
        self.turn('yes', 'accept-with-response-loss')
        before = self.assert_one_booking(revision)
        self.db.close()
        self.db = SessionDB(self.db_path)
        self.agent._session_db = self.db
        recovered = self.turn('Please proceed', 'retry-lost-response')
        after = self.assert_one_booking(revision)
        calls = [call for call in after['calls'] if call['path'] == '/booking-create-from-plan']
        self.assertEqual(len(calls), 2, calls)
        self.assertEqual(calls[0]['body']['idempotency_key'], calls[1]['body']['idempotency_key'])
        self.assertTrue(calls[1]['response']['body'].get('idempotent'), calls[1])
        self.assertEqual(after['tables'], before['tables'])
        self.assertIn(before['tables']['bookings'][0]['booking_code'], recovered.get('final_response', ''))

    def test_checked_but_not_presented_offer_cannot_authorize_short_yes(self):
        self.fail_after_quote = True
        with self.assertRaisesRegex(RuntimeError, 'aborted before response'):
            self.turn('Please quote this booking', 'aborted-offer')
        self.fail_after_quote = False
        self.turn('yes', 'ambiguous-yes')
        self.assertEqual(self.rpc(snapshot=True)['tables']['bookings'], [])

    def test_unrelated_yes_without_offer_does_not_create(self):
        self.turn('yes', 'no-offer-yes')
        snapshot = self.rpc(snapshot=True)
        self.assertEqual(snapshot['tables']['bookings'], [])
        self.assertEqual(snapshot['calls'], [])

    def test_occupied_accepted_bed_does_not_silently_substitute_another(self):
        revision = self.offer()
        self.rpc(block_bed=revision['guest_bed_assignments'][0]['bed_code'])
        before = self.rpc(snapshot=True)['tables']
        self.turn('yes', 'accept-stale-inventory')
        after = self.rpc(snapshot=True)['tables']
        self.assertEqual(after, before, 'Competing booking remains; no replacement allocation/create')
        calls = self.rpc(snapshot=True)['calls']
        self.turn('yes', 'no-fresh-offer-after-bed-refusal')
        self.assertEqual(self.rpc(snapshot=True)['calls'], calls)
        self.assertEqual(self.model_calls[-1], 'yes', 'Definitive refusal revoked automatic authority')

    def test_enriched_yes_cannot_override_original_guest_refusal(self):
        self.offer()
        self.turn('No thanks', 'real-refusal', enriched='yes')
        self.turn('yes', 'late-yes')
        self.assertEqual(self.rpc(snapshot=True)['tables']['bookings'], [])

    def test_same_delivery_replay_cannot_create_another_booking(self):
        revision = self.offer()
        self.turn('yes', 'same-delivery')
        before = self.assert_one_booking(revision)
        self.turn('yes', 'same-delivery')
        after = self.assert_one_booking(revision)
        self.assertEqual(after['tables'], before['tables'])
        self.assertEqual(sum(call['path'] == '/booking-create-from-plan' for call in after['calls']), 1)

    def test_changed_shared_room_selling_rule_refuses_without_booking(self):
        revision = self.offer()
        self.rpc(make_room_private=revision['room_arrangement'][0]['room_code'])
        self.turn('yes', 'accept-changed-room-rule')
        snapshot = self.rpc(snapshot=True)
        self.assertEqual(snapshot['tables']['bookings'], [])
        self.assertEqual(snapshot['tables']['booking_guests'], [])
        self.assertEqual(snapshot['tables']['payments'], [])
        self.turn('yes', 'no-fresh-offer-after-staff-refusal')
        self.assertEqual(self.rpc(snapshot=True)['calls'], snapshot['calls'])
        self.assertEqual(self.model_calls[-1], 'yes', 'Typed Staff refusal revoked automatic authority')

    def test_unchanged_registered_revalidation_still_reaches_sql_without_reconfirm(self):
        revision = self.offer()
        original_before = accepted_quote._before_create
        def revalidate(**kwargs):
            if original_before:
                original_before(**kwargs)
            # Targeted scheduler instrumentation: repeat the REAL registered quote
            # after consent and before create. Neither authority nor business facts
            # are injected, and the ordinary uninstrumented positive is separate.
            quoted = json.loads(self.registry.tools['quote_booking']['handler'](dict(PLAN)))
            self.assertEqual(quoted['offer_revision'], revision)
        with patch.object(accepted_quote, '_before_create', side_effect=revalidate):
            result = self.turn('yes', 'accept-with-unchanged-revalidation')
        snapshot = self.assert_one_booking(revision)
        self.assertNotIn('?', result.get('final_response', ''))
        self.assertEqual(sum(call['path'] == '/booking-preview' for call in snapshot['calls']), 2)
        self.assertEqual(sum(call['path'] == '/booking-create-from-plan' for call in snapshot['calls']), 1)

    def test_new_session_cannot_inherit_an_old_presented_offer(self):
        self.offer()
        self.db.create_session('reset-session', source='whatsapp')
        self.agent.session_id = 'reset-session'
        self.turn('yes', 'new-session-yes')
        self.assertEqual(self.rpc(snapshot=True)['tables']['bookings'], [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
