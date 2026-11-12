"""Accepted create is not vetoed by quote diagnostics; all transports offline."""
from copy import deepcopy
from email.message import Message
import io
import json
import urllib.error
import urllib.parse
import unittest
from unittest.mock import patch

from wolfhouse import test_no_final_ask as fixture
from wolfhouse import accepted_quote as owner
import wolfhouse_staff_api as plugin


class AlwaysSaveTests(unittest.TestCase):
    setUp = fixture.NoFinalAskTests.setUp
    tearDown = fixture.NoFinalAskTests.tearDown
    call = fixture.NoFinalAskTests.call
    staff = fixture.NoFinalAskTests.staff

    def test_missing_presentation_and_failed_verification_save_with_links(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.assertTrue(self.call('quote_booking', self.case['quote_args'])['success'])
            owner._transaction(lambda state, _: state.update(presentation=None,
                initial_create_request=None,
                create_attempt_budget={'booking': [state['plan'].get(k) for k in
                    ('check_in', 'check_out', 'guest_count')], 'failures': 2}))
            result = self.call('create_booking_from_plan', self.case['create_args'])
        self.assertTrue(result['success'], result)
        self.assertTrue(result['payment_link_created'], result)
        self.assertEqual(result['secure_payment_url'], 'https://example.invalid/pay/offline')
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        self.assertTrue(creates[0]['always_save_accepted_booking'])
        self.assertEqual(creates[0]['accepted_offer']['total_cents'], 59800)
        self.assertEqual(creates[0]['accepted_quote']['total_cents'], 59800)
        self.assertIn('quote_owner', json.dumps(creates[0]['booking_check_warnings']))
        self.assertIn('booking_create_failure_limit', creates[0]['booking_check_warnings'])
        self.assertFalse(any(p == '/conversation/needs-human' for p, _ in self.calls))

    def test_http_overlap_sends_warm_note_before_needs_human(self):
        self._assert_http_taken_bed_handoff({'success': False,
            'block_reason': 'overlap_conflict', '_blocked': True})

    def test_http_occupied_preflight_sends_warm_note_before_needs_human(self):
        self._assert_http_taken_bed_handoff({'success': False,
            'reason_code': 'availability_changed', 'conflict_beds': ['R1-B1'],
            '_blocked': True})

    def _assert_http_taken_bed_handoff(self, conflict):
        import asyncio
        from types import SimpleNamespace
        from wolfhouse import explicit_human_handoff as handoff
        from wolfhouse_staff_api import handoff_guest_note
        self.case = deepcopy(fixture.FIXTURES['klein'])
        self.case['quote_args']['language'] = 'de'
        self.case['create_args']['language'] = 'de'
        timeline = []
        test = self
        class Adapter:
            async def send(self, chat_id, content, **kwargs):
                test.assertEqual(content, handoff_guest_note.WARM_NOTES['de'])
                test.assertNotIn('duplicate', content)
                timeline.append('warm_note')
                return SimpleNamespace(success=True, message_id='offline-warm', raw_response={})
        def urlopen(request, **kwargs):
            path = urllib.parse.urlsplit(request.full_url).path.removeprefix('/staff/bot')
            body = json.loads(request.data)
            if path == '/booking-create-from-plan':
                self.calls.append((path, deepcopy(body)))
                raise urllib.error.HTTPError(request.full_url, 409, 'Conflict', Message(),
                    io.BytesIO(json.dumps(conflict).encode()))
            elif path == '/conversation/needs-human':
                self.calls.append((path, deepcopy(body)))
                timeline.append('needs_human')
                self.assertEqual(body['reason'], 'business_tool_error: bed_already_taken')
                response = {'success': True, 'needs_human': True, 'conversation_paused': True,
                        'staff_handoff': {'id': 'offline-bed-conflict'}}
            else:
                response = self.staff(path, body)
            return io.BytesIO(json.dumps(response).encode())
        async def dispatch(_):
            result = json.loads(await asyncio.to_thread(plugin.create_booking_from_plan,
                self.case['create_args']))
            self.assertFalse(result['success'])
            self.assertEqual(result.get('error'), 'bed_already_taken', result)
            self.assertTrue(result['handoff']['handoff_persisted'])
        async def run():
            await handoff.dispatch_with_handoff_notice(
                SimpleNamespace(source=SimpleNamespace(chat_id='+999111000222'), text='Please book it'),
                SimpleNamespace(adapter=Adapter(), dispatch_fn=dispatch))
        with patch.dict('os.environ', {'HERMES_ROLE': 'luna',
                 'LUNA_BOT_INTERNAL_TOKEN': 'offline-token',
                 'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}), \
             patch.object(plugin.urllib.request, 'urlopen', side_effect=urlopen), \
             patch.object(plugin, '_session_guest_phone', return_value='+999111000222'), \
             patch.object(handoff_guest_note, 'default_fetch_staff_info', return_value={}):
            self.call('quote_booking', self.case['quote_args'])
            owner._transaction(lambda state, _: state.update(guest_language='de'))
            asyncio.run(run())
        self.assertEqual(timeline, ['warm_note', 'needs_human'])
        self.assertEqual(sum(p == '/booking-create-from-plan' for p, _ in self.calls), 1)
        self.assertFalse(any('/create-stripe-link' in p for p, _ in self.calls))

    def _assert_diagnostic_advisory(self, code):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff), \
             patch.object(owner, '_prepare_create_checked', side_effect=owner.QuoteBoundaryError(code)):
            self.call('quote_booking', self.case['quote_args'])
            result = self.call('create_booking_from_plan', self.case['create_args'])
        self.assertTrue(result.get('success'), result)
        self.assertTrue(result['payment_link_created'], result)
        creates = [body for path, body in self.calls if path == '/booking-create-from-plan']
        self.assertEqual(len(creates), 1)
        wire = creates[0]
        self.assertIn(code, wire['booking_check_warnings'])
        self.assertFalse(any(p == '/conversation/needs-human' for p, _ in self.calls))
        self.assertEqual(result['secure_payment_url'], 'https://example.invalid/pay/offline')

    def test_current_quote_drift_keeps_the_presented_staff_price(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            original = deepcopy(self.case['quote_result'])
            def drift(state, _):
                state['presentation'] = {'quote_revision': original['offer_revision'],
                    'authoritative_quote': original}
                state['quote']['total_cents'] += 10000
            owner._transaction(drift)
            result = self.call('create_booking_from_plan', self.case['create_args'])
        self.assertTrue(result.get('success'), result)
        wire = [body for path, body in self.calls if path == '/booking-create-from-plan'][0]
        self.assertEqual(wire['accepted_quote']['total_cents'], original['total_cents'])
        self.assertEqual(wire['accepted_quote']['deposit_required_cents'], original['deposit_required_cents'])

    def test_no_price_display_gate(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            result = self.call('create_booking_from_plan', self.case['create_args'])
        self.assertTrue(result['success'], result)
        self.assertTrue(result['payment_link_created'], result)

    def test_retry_returns_same_booking_without_second_create(self):
        self.case = deepcopy(fixture.FIXTURES['klein'])
        with patch.object(plugin, '_post_bot', side_effect=self.staff):
            self.call('quote_booking', self.case['quote_args'])
            first = self.call('create_booking_from_plan', self.case['create_args'])
            second = self.call('create_booking_from_plan', self.case['create_args'])
        self.assertTrue(first['success'], first)
        self.assertTrue(second['success'], second)
        self.assertEqual(first['booking_id'], second['booking_id'])
        self.assertEqual(sum(p == '/booking-create-from-plan' for p, _ in self.calls), 1)


def _diagnostic_case(code):
    def test(self):
        self._assert_diagnostic_advisory(code)
    return test


for _code in ('quote_owner_save_outcome_unknown', 'quote_owner_acceptance_required',
              'quote_owner_sent_offer_required', 'quote_owner_material_change_requires_requote',
              'quote_owner_readiness_failed', 'booking_create_failure_limit',
              'quote_owner_presented_offer_required', 'accepted_quote_changed',
              'quote_payment_options_unsupported', 'quote_owner_turn_missing',
              'quote_ledger_invalid', 'quote_completion_identity_changed', 'quote_owner_ended'):
    setattr(AlwaysSaveTests, 'test_advisory_' + _code, _diagnostic_case(_code))


class BookingConflictHTTPBoundaryTests(unittest.TestCase):
    def post_error(self, body, *, path='/booking-create-from-plan', status=409):
        error = urllib.error.HTTPError('https://offline.invalid', status, 'Conflict', Message(),
            io.BytesIO(json.dumps(body).encode()))
        with patch.dict('os.environ', {'LUNA_CLIENT_SLUG': 'wolfhouse-somo',
                 'LUNA_BOT_INTERNAL_TOKEN': 'offline-token',
                 'WOLFHOUSE_STAFF_API_BASE_URL': 'https://offline.invalid'}), \
             patch.object(plugin.urllib.request, 'urlopen', side_effect=error) as transport:
            result = plugin._post_bot(path, {})
        transport.assert_called_once()
        self.assertIs(result['success'], False)
        self.assertEqual(result['staff_api_status'], 'http_error')
        self.assertEqual(result['status'], status)
        return result

    def test_definitive_conflicts_promote_only_restrictive_facts(self):
        for conflict in ({'block_reason': 'overlap_conflict'},
                         {'reason_code': 'availability_changed', 'conflict_beds': ['R1-B1']}):
            with self.subTest(conflict=conflict):
                result = self.post_error({'success': False, **conflict,
                    'booking_id': 'untrusted', 'payment_id': 'untrusted',
                    'booking_code': 'untrusted', 'secure_payment_url': 'https://untrusted.invalid',
                    'guest_payment_links': [{'url': 'https://untrusted.invalid'}],
                    'write_performed': True, 'payment_link_created': True})
                self.assertIs(result.get('bed_already_taken'), True, result)
                self.assertIs(result.get('booking_create_refused'), True, result)
                self.assertIs(result.get('write_performed'), False, result)
                if conflict.get('block_reason') == 'overlap_conflict':
                    self.assertEqual(result.get('block_reason'), 'overlap_conflict')
                else:
                    self.assertNotIn('block_reason', result)
                for key in ('booking_id', 'payment_id', 'booking_code', 'secure_payment_url',
                            'guest_payment_links', 'payment_link_created', 'conflict_beds'):
                    self.assertNotIn(key, result)

    def test_wrong_route_status_and_nonliteral_failure_do_not_promote_conflicts(self):
        for conflict in ({'block_reason': 'overlap_conflict'},
                         {'reason_code': 'availability_changed', 'conflict_beds': ['R1-B1']}):
            cases = [('/availability-check', 409, False),
                     ('/booking-create-from-plan', 422, False),
                     ('/booking-create-from-plan', 500, False),
                     ('/booking-create-from-plan', 409, True),
                     ('/booking-create-from-plan', 409, 0),
                     ('/booking-create-from-plan', 409, 'false'),
                     ('/booking-create-from-plan', 409, None)]
            for path, status, success in cases:
                with self.subTest(conflict=conflict, path=path, status=status, success=success):
                    result = self.post_error({'success': success, **conflict}, path=path, status=status)
                    self.assertNotIn('bed_already_taken', result)
                    self.assertNotIn('block_reason', result)

    def test_generic_refusal_and_unproven_preflight_do_not_become_occupied_beds(self):
        cases = [{'reason_code': 'booking_verification_failed', 'conflict_beds': ['R1-B1']},
                 {'reason_code': 'incompatible_preselected_beds', 'conflict_beds': ['R1-B1']},
                 {'block_reason': 'verification_failed'}, {'bed_already_taken': True},
                 {'reason_code': 'staleavailability', 'conflict_beds': ['R1-B1']},
                 {'reason_code': 'offer_identity_required', 'conflict_beds': ['R1-B1']},
                 {'reason_code': 'quote_completion_identity_changed', 'conflict_beds': ['R1-B1']},
                 {'reason_code': 'availability_changed'}]
        cases += [{'reason_code': 'availability_changed', 'conflict_beds': beds}
                  for beds in ([], None, 'R1-B1', {}, [None], [1], [''], [' '], ['R1-B1', None])]
        for body in cases:
            with self.subTest(body=body):
                result = self.post_error({'success': False, 'write_performed': False, **body})
                self.assertNotIn('bed_already_taken', result)
                self.assertNotIn('block_reason', result)
                self.assertNotIn('reason_code', result)


if __name__ == '__main__':
    unittest.main()
