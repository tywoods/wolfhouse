"""GUEST-SIM-AUDIT-FIX-001: deployed-config and ordinary guest-door regressions.

Offline only. Staff HTTP, the runner author and outbound transport are test doubles;
this proves boundary wiring, not a live booking or model conversation quality.
"""
from pathlib import Path
import io
import json
from urllib.parse import urlsplit
from types import SimpleNamespace
from unittest.mock import patch
import unittest
import yaml

from wolfhouse.crowsnest_guest_door import run_crowsnest_guest_turn

from wolfhouse.simulate_write_guards import evaluate_wolfhouse_staging_booking_capability

ROOT = Path(__file__).resolve().parents[3]


def tracked_wh_environment():
    compose = yaml.safe_load((ROOT / 'docker/hermes-staging/docker-compose.vm.yml').read_text())
    return {key: str(value) for key, value in compose['services']['hermes-luna']['environment'].items()}


class StagingConfigTests(unittest.TestCase):
    def test_tracked_wh_service_admits_existing_narrow_booking_capability(self):
        receipt = evaluate_wolfhouse_staging_booking_capability(
            scope_active=True, env=tracked_wh_environment())
        self.assertTrue(receipt['admitted'], receipt['reasons'])
        self.assertEqual(receipt['capability'], 'wolfhouse_staging_booking_test_link')

    def test_no_admission_for_prod_live_key_or_missing_scope(self):
        env = tracked_wh_environment()
        for override, reason in (
            ({'WOLFHOUSE_STAFF_API_BASE_URL': 'https://staff.lunafrontdesk.com'}, 'staff_destination_not_approved_staging'),
            ({'STRIPE_SECRET_KEY': 'sk_live_offline_test_only'}, 'live_stripe_key_blocked'),
            ({'WOLFHOUSE_STRIPE_MODE': 'live'}, 'live_stripe_key_blocked'),
        ):
            receipt = evaluate_wolfhouse_staging_booking_capability(scope_active=True, env={**env, **override})
            self.assertFalse(receipt['admitted'])
            self.assertIn(reason, receipt['reasons'])
        self.assertFalse(evaluate_wolfhouse_staging_booking_capability(scope_active=False, env=env)['admitted'])


class StaffBoundaryTests(unittest.TestCase):
    def setUp(self):
        import wolfhouse.crowsnest_guest_door as door
        self.door = door
        self.calls = []

        def post(path, payload, *, require_explicit_success=False):
            self.calls.append((path, payload, require_explicit_success))
            return {'success': True}

        async def send(*args, **kwargs):
            raise AssertionError('External sends forbidden')

        self.staff = SimpleNamespace(_post_bot=post)
        self.adapter = type('OfflineWhatsApp', (), {'send': send})
        door.install_request_owned_guards(self.staff, SimpleNamespace(WhatsAppCloudAdapter=self.adapter))
        self.env = patch.dict('os.environ', tracked_wh_environment(), clear=True)
        self.env.start()
        self.scope = door.CrowsnestGuestScope.create('+999000000000002')
        self.token = door._SCOPE.set(self.scope)

    def tearDown(self):
        self.door._SCOPE.reset(self.token)
        self.env.stop()
        self.door._INSTALLED_STAFF.discard(id(self.staff))
        self.door._INSTALLED_WHATSAPP.discard(id(self.adapter))

    def test_property_package_and_transfer_reads_work_when_booking_is_admitted(self):
        for path in ('/house-info', '/package-price-preview', '/transfers/prices'):
            with self.subTest(path=path):
                result = self.staff._post_bot(path, {})
                self.assertTrue(result['success'], result)
                self.assertEqual(self.calls[-1][0], '/staff/bot' + path)

    def test_explicit_success_contract_survives_guard(self):
        self.staff._post_bot('/transfers/prices', {}, require_explicit_success=True)
        self.assertTrue(self.calls[-1][2])
        # Outside simulator, preserve the same keyword contract, unmodified.
        token = self.door._SCOPE.set(None)
        try:
            self.staff._post_bot('/ordinary', {}, require_explicit_success=True)
        finally:
            self.door._SCOPE.reset(token)
        self.assertEqual(self.calls[-1], ('/ordinary', {}, True))

    def test_cancellation_handoff_is_bound_only_to_synthetic_inbox(self):
        result = self.staff._post_bot('/conversation/needs-human', {
            'conversation_id': '00000000-0000-4000-8000-000000000001',
            'phone': '+34000000000', 'reason': 'cancel_or_change_request',
        })
        self.assertTrue(result['success'], result)
        path, body, _ = self.calls[-1]
        self.assertEqual(path, '/staff/bot/conversation/needs-human')
        self.assertNotIn('conversation_id', body)
        self.assertEqual(body['phone'], self.scope.inbox_phone)
        self.assertEqual(body['guest_phone'], self.scope.inbox_phone)
        self.assertTrue(body['suppress_notifications'])
        self.assertTrue(body['suppress_approvals'])
        self.assertTrue(body['simulator_synthetic'])
        self.assertEqual(body['source_owner'], 'crowsnest-guest-door')
        self.assertEqual(body['wolfhouse_staging_capability'], 'wolfhouse_staging_booking_test_link')

    def test_handoff_rejects_malformed_non_request_owned_identity(self):
        for identity in ('+9991', '+9991234567890123', '+341234567890', ''):
            with self.subTest(identity=identity):
                self.scope.inbox_phone = identity
                result = self.staff._post_bot('/conversation/needs-human', {
                    'phone': '+999123456789012',
                    'simulator_synthetic': True,
                    'suppress_notifications': True,
                })
                self.assertFalse(result['success'])
        self.assertEqual(self.calls, [])

    def test_conflicting_live_stripe_mode_blocks_capability_and_transport(self):
        for wh_mode, mode in (('test', 'live'), ('live', 'test')):
            with self.subTest(wh_mode=wh_mode, mode=mode), patch.dict('os.environ', {
                'WOLFHOUSE_STRIPE_MODE': wh_mode, 'STRIPE_MODE': mode,
            }):
                capability = evaluate_wolfhouse_staging_booking_capability(scope_active=True)
                self.assertFalse(capability['admitted'])
                self.assertIn('live_stripe_key_blocked', capability['reasons'])
                self.assertEqual(capability['stripe_mode'], 'live')
                result = self.staff._post_bot('/conversation/needs-human', {'phone': self.scope.inbox_phone})
                self.assertFalse(result['success'])
        self.assertEqual(self.calls, [])

    def test_handoff_is_blocked_without_booking_capability_even_with_forged_metadata(self):
        with patch.dict('os.environ', {'BOT_BOOKING_ENABLED': 'false'}):
            result = self.staff._post_bot('/conversation/needs-human', {
                'phone': self.scope.inbox_phone,
                'simulator_synthetic': True,
                'source_owner': 'crowsnest-guest-door',
                'suppress_notifications': True,
                'wolfhouse_staging_capability': 'wolfhouse_staging_booking_test_link',
            })
        self.assertFalse(result['success'])
        self.assertEqual(self.calls, [])

    def test_unlisted_mutations_stay_blocked_and_revocation_still_wins(self):
        for path in ('/house-info/delete', '/transfers/prices/save', '/bookings/cancel',
                     '/bookings/update-contact', '/payments/create-balance-link',
                     '/sunset/booking-create'):
            self.assertFalse(self.staff._post_bot(path, {})['success'], path)
        self.assertEqual(self.calls, [])
        self.scope.revoked = True
        self.assertFalse(self.staff._post_bot('/house-info', {})['success'])
        self.assertEqual(self.calls, [])


class GuestDoorReceiptTests(unittest.IsolatedAsyncioTestCase):
    async def test_capability_receipt_exists_even_when_the_model_calls_no_tools(self):
        async def author(event):
            return 'Offline author placeholder'

        async def mirror(**kwargs):
            return {'ok': True}

        for override, admitted in (({}, True), ({'BOT_BOOKING_ENABLED': 'false'}, False)):
            with patch.dict('os.environ', {**tracked_wh_environment(), **override}, clear=True):
                result = await run_crowsnest_guest_turn(
                    runner=SimpleNamespace(_handle_message=author), phone='+999000000000001',
                    text='hello', mirror=mirror)
            cap = result['effective_capability']
            self.assertIsInstance(cap, dict, 'Every turn needs an honest capability receipt, not an absent-tool default')
            self.assertEqual(cap['admitted'], admitted)
            self.assertEqual(result['transport_calls'], 0)
            self.assertTrue(result['whatsapp_suppressed'])
            self.assertFalse(result['allow_writes'])
            if not admitted:
                self.assertIn('bot_booking_disabled', cap['reasons'])


class ConversationContractTests(unittest.TestCase):
    """Prompt contract only; deliberately not a model-quality claim."""
    def test_deposit_choice_and_duration_are_not_restarted_by_flow_steps(self):
        soul = (ROOT / 'docker/hermes-staging/SOUL.md').read_text()
        self.assertIn('5 nights or fewer', soul)
        self.assertIn('6 nights or more', soul)
        self.assertNotIn('ONE €100 deposit', soul)
        self.assertIn('payment_choice: "deposit"', soul)
        self.assertIn('Do not restart payment choice after a shuttle or information question', soul)

    def test_guest_bed_options_and_cancellation_have_explicit_paths(self):
        soul = (ROOT / 'docker/hermes-staging/SOUL.md').read_text()
        self.assertIn('room_options', soul)
        self.assertIn('A guest asking which dorm or bed options they can book', soul)
        self.assertIn('`available_beds`', soul)
        self.assertIn('`selected_room_code`', soul)
        self.assertIn('cancel_or_change_request', soul)
        self.assertIn('Do not say “set it up”', soul)
        self.assertNotIn('If it fails, ask the missing field.', soul)
        self.assertIn('only when the result identifies a genuinely missing field', soul)


class PluginGuestTurnTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_plugin_create_then_owned_test_link_and_inbox_share_identity(self):
        import importlib.util
        import sys
        plugin_path = ROOT / 'docker/hermes-staging/plugins/wolfhouse_staff_api/__init__.py'
        spec = importlib.util.spec_from_file_location('guest_sim_audit_staff', plugin_path)
        assert spec is not None and spec.loader is not None
        plugin = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = plugin
        spec.loader.exec_module(plugin)
        self.addCleanup(sys.modules.pop, spec.name, None)
        self.addCleanup(sys.modules.pop, spec.name + '.input_guard', None)
        self.assertEqual(plugin.guard_tool_input.__module__, spec.name + '.input_guard')
        import wolfhouse.crowsnest_guest_door as door
        import wolfhouse_whatsapp_mirror as mirror

        calls, mirrors, sends, results = [], [], [], []
        payment_id = '10000000-0000-4000-8000-000000000001'
        booking_id = '20000000-0000-4000-8000-000000000002'
        # Deliberate local HTTP fixture, never represented as a staging booking.
        responses = {
            '/booking-create-from-plan': {'success': True, 'write_performed': True,
                'booking_id': booking_id, 'booking_code': 'OFFLINE-AUDIT', 'payment_id': payment_id},
            f'/payments/{payment_id}/create-stripe-link': {'success': True,
                'checkout_url': 'https://staff-staging.lunafrontdesk.com/pay/OFFLINE-AUDIT',
                'amount_due_cents': 10000, 'currency': 'EUR', 'payment_status': 'pending'},
            '/house-info': {'success': True, 'notes': 'OFFLINE PROPERTY NOTES'},
            '/conversation/needs-human': {'success': True, 'needs_human': True, 'conversation_paused': False},
        }

        def http(request, timeout):
            self.assertEqual(urlsplit(request.full_url).netloc, 'staff-staging.lunafrontdesk.com')
            path = urlsplit(request.full_url).path.removeprefix('/staff/bot')
            self.assertIn(path, responses, 'Unexpected HTTP boundary')
            body = json.loads(request.data)
            calls.append((path, body))
            return io.BytesIO(json.dumps(responses[path]).encode())

        def persist(payload):
            mirrors.append(payload)
            return {'success': True, 'thread_message': {'persisted': True}}

        async def external_send(*args, **kwargs):
            sends.append(args)
            raise AssertionError('No outbound transport')

        adapter = type('OfflineWhatsApp', (), {'send': external_send})
        original_post, original_phone = plugin._post_bot, plugin._session_guest_phone
        door.install_request_owned_guards(plugin, SimpleNamespace(WhatsAppCloudAdapter=adapter))
        self.addCleanup(setattr, plugin, '_post_bot', original_post)
        self.addCleanup(setattr, plugin, '_session_guest_phone', original_phone)
        self.addCleanup(door._INSTALLED_STAFF.discard, id(plugin))
        self.addCleanup(door._INSTALLED_WHATSAPP.discard, id(adapter))

        async def author(event):
            # No LLM substituted as proof of conversation quality: exercise real
            # tool orchestration on the actual guest-door callback contract.
            result = json.loads(plugin.create_booking_from_plan({
                'check_in': '2026-10-01', 'check_out': '2026-10-04', 'guest_count': 1,
                'guest_name': 'Offline Guest', 'room_preference': 'mixed',
                'selected_bed_codes': ['OFFLINE-BED'], 'payment_choice': 'deposit',
            }))
            results.append(result)
            results.append(json.loads(plugin.get_house_info({})))
            results.append(json.loads(plugin.flag_needs_human({'reason': 'cancel_or_change_request'})))
            await adapter().send(event.source.chat_id, 'Offline fixture reply')
            return None

        env = {**tracked_wh_environment(), 'LUNA_BOT_INTERNAL_TOKEN': 'offline-not-a-credential'}
        with patch.dict('os.environ', env, clear=True), \
             patch('socket.socket.connect', side_effect=AssertionError('NETWORK FORBIDDEN')), \
             patch('socket.create_connection', side_effect=AssertionError('NETWORK FORBIDDEN')), \
             patch('urllib.request.urlopen', side_effect=http), \
             patch.object(mirror, '_post_mirror_sync', side_effect=persist):
            receipt = await run_crowsnest_guest_turn(
                runner=SimpleNamespace(_handle_message=author), phone='+999' + '000000000003', text='offline test')
        self.assertTrue(receipt['ok'])
        self.assertTrue(receipt['effective_capability']['admitted'])
        self.assertEqual(results[0]['booking_id'], booking_id)
        self.assertTrue(results[0]['write_performed'])
        self.assertEqual(results[0]['secure_payment_url'], responses[f'/payments/{payment_id}/create-stripe-link']['checkout_url'])
        self.assertTrue(results[2]['needs_human'])
        self.assertEqual([path for path, _ in calls], list(responses))
        self.assertEqual(calls[0][1]['payment_choice'], 'deposit')
        self.assertEqual(calls[0][1]['guest_phone'], mirrors[0]['guest_phone'])
        self.assertEqual(calls[-1][1]['phone'], mirrors[0]['guest_phone'])
        self.assertTrue(mirrors[0]['guest_phone'].startswith('+999'))
        self.assertEqual([row['direction'] for row in mirrors], ['inbound', 'outbound'])
        self.assertTrue(all(row['suppress_notifications'] for row in mirrors))
        self.assertEqual(receipt['transport_calls'], 0)
        self.assertEqual(receipt['transport_attempts'], 1)
        self.assertEqual(sends, [])


if __name__ == '__main__':
    unittest.main()
