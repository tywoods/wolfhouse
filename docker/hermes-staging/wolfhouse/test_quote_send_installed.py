"""Offline, real installed gateway: priced send -> same-turn create -> receipt send.

Run with /opt/hermes/.venv/bin/python <this-file>. The launcher creates an
artifact-only install overlay and runs the tests in a fresh, network-denied child.
Only model and external Staff/Meta transports are fixtures; neither owner,
registered tool, sender, retry loop, conversation loop nor SessionDB is mocked.
"""
from __future__ import annotations

import asyncio
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True

REPO = Path(__file__).resolve().parents[3]
ARTIFACTS = Path('/opt/data/workspace/sandbox-repos/WH-captain/artifacts/price-before-save/send-continuation')
INBOUND = ("Please book accommodation only for Casey, one adult, 10–12 June 2027, "
           "a mixed shared room, no extras. I choose the €100 deposit. Create the booking now.")
PRICE = ("Casey, your accommodation-only mixed shared stay for one adult, 10–12 June 2027, "
         "is €650 total. Your selected deposit is €100; the remaining balance is €550.")
LINK = 'https://staff-staging.lunafrontdesk.com/pay/CASEY-100-OFFLINE'
CONFIRMATION = ('Your booking CASEY-100 is created for Casey, one adult, 10–12 June 2027, '
                'accommodation only in a mixed shared room. Total €650; deposit €100, '
                'remaining balance €550. Pay your deposit here: ' + LINK)
REFRESH_BLOCKED = ('I have not created your booking. A teammate will help with the next step.')
PLAN = dict(check_in='2027-06-10', check_out='2027-06-12', guest_count=1,
            room_type='shared', room_preference='mixed', package_code='package_none',
            catalog_selections=[], payment_choice='deposit', guest_name='Casey',
            guests=[{'name': 'Casey'}])
NETWORK_DENIALS = []


def deny_network(event, args):
    if event in ('socket.connect', 'socket.connect_ex', 'socket.sendto',
                 'socket.getaddrinfo', 'socket.gethostbyname'):
        # asyncio's local self-pipe is not Internet traffic.
        if args and isinstance(args[0], socket.socket) and args[0].family == socket.AF_UNIX:
            return
        NETWORK_DENIALS.append({'event': event, 'args': repr(args)})
        raise RuntimeError('OFFLINE regression blocked network: ' + event)


def launch():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    overlay = ARTIFACTS / 'hermes-overlay'
    overlay.mkdir(exist_ok=True)
    installed = Path('/opt/hermes')
    for entry in installed.iterdir():
        if entry.name in ('gateway', 'agent', '__pycache__'):
            continue
        dest = overlay / entry.name
        if not dest.exists() and not dest.is_symlink():
            dest.symlink_to(entry, target_is_directory=entry.is_dir())
    for package, copied in (('gateway', 'run.py'), ('agent', 'turn_context.py')):
        destination = overlay / package
        destination.mkdir(exist_ok=True)
        for entry in (installed / package).iterdir():
            if entry.name in (copied, '__pycache__'):
                continue
            dest = destination / entry.name
            if not dest.exists() and not dest.is_symlink():
                dest.symlink_to(entry, target_is_directory=entry.is_dir())
    sys.path.insert(0, str(REPO / 'docker/hermes-staging'))
    from apply_gateway_patches import apply_original_inbound_source, apply_quote_continuation_source
    for relative, transform in (('gateway/run.py', apply_original_inbound_source),
                                ('agent/turn_context.py', apply_quote_continuation_source)):
        target = overlay / relative
        if target.is_symlink():
            raise RuntimeError('Refusing to write through overlay symlink: ' + str(target))
        source = transform((installed / relative).read_text())
        if relative == 'gateway/run.py':
            # Installed hook loads a deployment path by spec, not PYTHONPATH.
            # Bind only this overlay hook to the candidate production module.
            source = source.replace('"/etc/hermes-staging/apply_gateway_patches.py"',
                                    repr(str(REPO / 'docker/hermes-staging/apply_gateway_patches.py')))
        target.write_text(source, encoding='utf-8')
    node_guard = ARTIFACTS / 'deny-network.cjs'
    node_guard.write_text("const deny=()=>{throw Error('OFFLINE node network denied')};\n"
                          "require('net').Socket.prototype.connect=deny;\n"
                          "require('dgram').Socket.prototype.send=deny;\n"
                          "require('dns').lookup=deny; require('dns').resolve=deny;\n")
    home = ARTIFACTS / 'bootstrap-home'
    home.mkdir(exist_ok=True)
    temp = ARTIFACTS / 'tmp'
    temp.mkdir(exist_ok=True)
    env = dict(os.environ, HERMES_INSTALL_ROOT=str(overlay), HERMES_HOME=str(home),
               PYTHONDONTWRITEBYTECODE='1', TMPDIR=str(temp),
               NODE_OPTIONS='--require=' + str(node_guard),
               PYTHONPATH=':'.join(map(str, (overlay, REPO / 'docker/hermes-staging',
                                            REPO / 'docker/hermes-staging/plugins', installed))))
    cases = sys.argv[1:] or [
        'InstalledQuoteSendContinuation.test_success_sends_price_then_creates_then_sends_receipt',
        'InstalledQuoteSendContinuation.test_provider_failure_never_creates',
        'InstalledQuoteSendContinuation.test_kill_switch_suppression_never_creates',
        'InstalledQuoteSendContinuation.test_provider_success_without_id_never_creates',
        'InstalledQuoteSendContinuation.test_changed_price_revalidation_never_creates']
    commands = [[sys.executable, str(Path(__file__).resolve()), '--child', '-v', case] for case in cases]
    (ARTIFACTS / 'command.json').write_text(json.dumps({'commands': commands,
        'cwd': str(REPO), 'environment': {k: env[k] for k in (
            'HERMES_INSTALL_ROOT', 'HERMES_HOME', 'PYTHONPATH', 'TMPDIR', 'NODE_OPTIONS')}}, indent=2))
    outputs, exit_code = [], 0
    # Separate processes avoid the installed global logging/plugin singletons
    # retaining a prior fixture's already-cleaned temporary HERMES_HOME.
    for command in commands:
        result = subprocess.run(command, cwd=REPO, env=env, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        outputs.append(result.stdout)
        exit_code = max(exit_code, result.returncode)
        (ARTIFACTS / (command[-1].split('.')[-1] + '.log')).write_text(result.stdout, encoding='utf-8')
    log = ARTIFACTS / 'installed-regression.log'
    log.write_text('\n'.join(outputs), encoding='utf-8')
    print('\n'.join(outputs), end='')
    print(f'Installed regression exit={exit_code}; log={log}')
    return exit_code


if '--child' in sys.argv:
    sys.argv.remove('--child')
    sys.addaudithook(deny_network)
    from wolfhouse import test_accepted_quote_installed_entrypoint as fixture
    from wolfhouse import accepted_quote, original_inbound, quote_delivery
    from gateway.config import Platform
    from gateway.platforms.base import MessageEvent, MessageType
    from gateway.session import SessionSource, build_session_key
    import logging
    logging.getLogger('wolfhouse.original_inbound').addHandler(logging.StreamHandler())

    class InstalledQuoteSendContinuation(unittest.IsolatedAsyncioTestCase):
        """Reuse fixture setup, not its unrelated inherited test methods."""
        async def asyncSetUp(self):
            self.timeline = []
            self.mode = 'success'
            self.owner_ids = []
            self.user_turn_counts = []
            self.provider_calls = []
            self.staff_http = []
            self.model_steps = []
            self.db_rows = []
            self.ledger = []
            self.network_start = len(NETWORK_DENIALS)
            self.addCleanup(self.save_evidence)
            await fixture.InstalledEntrypointQueuedPendingEvent.asyncSetUp(self)
            self.release.set()
            self.model_patch.stop()
            self.env_send = patch.dict(os.environ, {
                'WHATSAPP_DRY_RUN': 'false', 'LUNA_AUTO_SEND_ENABLED': 'true',
                'HERMES_HUMAN_DELAY_MODE': 'off', 'HERMES_GATEWAY_BUSY_ACK_ENABLED': 'false'})
            self.env_send.start(); self.addCleanup(self.env_send.stop)
            os.environ[self.runtime._home_target_env_var('whatsapp_cloud')] = '999000012222'

            # Extend only the fixture's captured fake Staff transport, under the
            # existing request guard; keep the real registered handler intact.
            guarded = self.handler_globals['_post_bot']
            cells = dict(zip(guarded.__code__.co_freevars, guarded.__closure__ or ()))
            self.assertIn('original_post', cells)
            transport_cell = cells['original_post']
            base_staff = transport_cell.cell_contents
            def staff(path, payload, **kwargs):
                self.timeline.append({'kind': 'staff', 'path': path})
                if path.endswith(('/booking-preview', '/booking-create-from-plan')):
                    self.assertIsNotNone(accepted_quote._current.get())
                    self.owner_ids.append(id(accepted_quote._current.get()))
                    self.user_turn_counts.append(accepted_quote._current.get().binding[0]._user_turn_count)
                result = base_staff(path, payload, **kwargs)
                if path.endswith('/booking-preview'):
                    if self.mode == 'changed-price' and self.provider_calls:
                        # Seal refreshed commercial facts with the same real
                        # checked-offer builder used by the shared fixture.
                        quote = {'success': True, 'total_cents': 70000,
                                 'deposit_required_cents': 10000,
                                 'payment_link_amount_cents': 10000, 'currency': 'EUR'}
                        source = "const {buildCheckedWolfhousePreviewOffer:b}=require('./scripts/lib/luna-front-desk-accommodation-availability-service');console.log(JSON.stringify(b(JSON.parse(process.argv[1]))))"
                        checked = json.loads(subprocess.check_output(
                            ['node', '-e', source, json.dumps({
                                **payload, 'client_slug': 'wolfhouse-somo', 'quote': quote,
                                'availability': {**payload, 'status': 'checked',
                                                 'selected_bed_codes': ['R3-B1']},
                                'room_rows': [{'bed_code': 'R3-B1', 'room_code': 'R3',
                                               'gender_strategy': 'flexible'}],
                            })], cwd=REPO, text=True, timeout=10))
                        result = {**quote, **checked, 'payment_choice_needed': False}
                    self.timeline.append({'kind': 'staff_preview', 'response': deepcopy(result)})
                if path.endswith('/availability-check'):
                    # The older shared fixture omits exact_bed_eligibility.
                    # Derive the full transport contract from Staff's real pure
                    # pipeline, not a hand-written eligible=True bypass. Stock
                    # is declared independently of the requested/accepted codes.
                    source = """
const service = require('./scripts/lib/luna-front-desk-accommodation-availability-service');
const built = service.buildWolfhouseAvailabilityCommand({
  channel: service.AVAILABILITY_CHANNELS.BOT_HTTP,
  trustedClientSlug: 'wolfhouse-somo', transportBody: JSON.parse(process.argv[1]),
  quoteConfig: {package_min_nights: 1}, demoCalendarEnrichment: false,
});
const stock = [{bed_code: 'R3-B1', room_code: 'R3', room_type: 'mixed',
  gender_strategy: 'Flexible', selling_mode: 'shared', bed_active: true, bed_sellable: true}];
const response = built.ok ? service.mapBotHttpAvailabilityResponse(
  service.buildCanonicalAvailabilityBody(built.command,
    service.computeWolfhouseAvailabilityInventory(stock, [], built.command), null)) : built;
console.log(JSON.stringify(response));
"""
                    result = json.loads(subprocess.check_output(
                        ['node', '-e', source, json.dumps(payload)], cwd=REPO,
                        text=True, timeout=10))
                    self.timeline.append({'kind': 'staff_availability',
                                          'request': deepcopy(payload), 'response': deepcopy(result)})
                if path.endswith('/booking-create-from-plan'):
                    self.owner_ids.append(id(accepted_quote._current.get()))
                    result = dict(result, payment_id='casey-deposit-offline',
                                  quote={'total_cents': 65000, 'deposit_required_cents': 10000,
                                         'payment_link_amount_cents': 10000, 'currency': 'EUR'})
                if path.endswith('/payments/casey-deposit-offline/create-stripe-link'):
                    # The registered handler obtains the URL in a separate Staff
                    # payment operation; a URL on the create response is ignored.
                    result = {'success': True, 'payment_id': 'casey-deposit-offline',
                              'guest_payment_url': LINK, 'amount_due_cents': 10000,
                              'currency': 'EUR', 'payment_status': 'unpaid',
                              'no_payment_truth_recorded': True}
                return result
            transport_cell.cell_contents = staff
            self.addCleanup(setattr, transport_cell, 'cell_contents', base_staff)

            # The real pause gate still parses Staff HTTP data and makes decisions.
            def staff_http(request, *args, **kwargs):
                url = request.full_url if hasattr(request, 'full_url') else str(request)
                self.staff_http.append(url)
                if not url.startswith('https://staff-staging.lunafrontdesk.com/'):
                    raise AssertionError('Unexpected external HTTP: ' + url)
                if url.endswith('/check-guest-automation-gate'):
                    data = {'success': True, 'whatsapp_channel_mode': 'auto',
                            'can_continue_guest_automation': True, 'bot_paused': False}
                else:
                    # Inbox mirror/guest profile reads are also fake Staff I/O.
                    data = {'success': True}
                return io.BytesIO(json.dumps(data).encode())
            http_patch = patch('urllib.request.urlopen', side_effect=staff_http)
            http_patch.start(); self.addCleanup(http_patch.stop)

            owner = self
            class Provider:
                async def post(_self, url, *, headers, json):
                    payload = deepcopy(json)
                    owner.provider_calls.append({'url': url, 'payload': payload})
                    if payload.get('type') != 'text':
                        return SimpleNamespace(status_code=200, json=lambda: {'success': True})
                    body = payload['text']['body']
                    ident = f'wamid.OFFLINE.{len(owner.provider_calls)}'
                    owner.timeline.append({'kind': 'provider', 'body': body,
                                           'message_id': ident if owner.mode in ('success', 'changed-price') else None})
                    if owner.mode == 'failure':
                        data = {'error': {'code': 100, 'message': 'offline fixture rejected'}}
                        return SimpleNamespace(status_code=400, json=lambda: data, text=json_module(data))
                    data = {'messages': [{'id': ident}]} if owner.mode in ('success', 'changed-price') else {'messages': []}
                    return SimpleNamespace(status_code=200, json=lambda: data)
            self.adapter._http_client = Provider()

            def complete(request):
                messages = deepcopy(request.get('messages') or [])
                self.model_requests.append(messages)
                step = len(self.model_steps)
                self.model_steps.append(step)
                internal = any(m.get('role') == 'system' and 'Internal transport continuation' in str(m.get('content')) for m in messages)
                self.timeline.append({'kind': 'model', 'step': step,
                                      'internal': internal})
                tools = [json.loads(m['content']) for m in messages if m.get('role') == 'tool']
                if step == 0:
                    message = fixture._Message(tool_calls=[fixture._ToolCall('quote-casey', 'quote_booking', PLAN)])
                elif step == 1:
                    self.assertTrue(tools[-1]['success'], tools[-1])
                    message = fixture._Message(tool_calls=[fixture._ToolCall('premature-create', 'create_booking_from_plan', PLAN)])
                elif step == 2:
                    self.assertFalse(tools[-1]['success'], tools[-1])
                    self.assertEqual(tools[-1]['error'], 'quote_owner_presented_offer_required')
                    self.assertFalse(any(p.endswith('/booking-create-from-plan') for p, _ in self.staff_calls))
                    message = fixture._Message(content=PRICE)
                elif step == 3:
                    self.assertTrue(internal, messages)
                    self.assertEqual(len([m for m in messages if m.get('role') == 'user']), 1, messages)
                    self.assertTrue(any(m.get('role') == 'system' and 'Internal transport continuation' in str(m.get('content')) for m in messages))
                    message = fixture._Message(tool_calls=[fixture._ToolCall('resumed-create', 'create_booking_from_plan', PLAN)])
                elif step == 4:
                    if self.mode == 'changed-price':
                        self.assertFalse(tools[-1]['success'], tools[-1])
                        self.assertEqual(tools[-1]['error'], 'quote_owner_presented_offer_required')
                        self.assertFalse(any(p.endswith('/booking-create-from-plan') for p, _ in self.staff_calls))
                        self.assertEqual(tools[-1]['next_action'], 'staff_handoff')
                        message = fixture._Message(content=REFRESH_BLOCKED)
                    else:
                        self.assertTrue(tools[-1]['success'], tools[-1])
                        self.assertEqual(tools[-1]['total_cents'], 65000)
                        self.assertEqual(tools[-1]['amount_due_cents'], 10000)
                        self.assertIn(LINK, json.dumps(tools[-1]))
                        message = fixture._Message(content=CONFIRMATION)
                elif step == 5 and self.mode == 'changed-price':
                    # The real quote owner asks its authoring-only model to
                    # include refreshed terms omitted by the handoff draft.
                    facts = json.loads(messages[-1]['content'])['authoritative_staff_quote']
                    self.assertEqual(facts['total_cents'], 70000)
                    self.assertEqual(facts['deposit_cents'], 10000)
                    self.assertFalse(internal)
                    message = fixture._Message(content=(
                        'The refreshed quote is €700 total, with a €100 deposit and €600 remaining. '
                        'I have not created your booking.'))
                else:
                    raise AssertionError('Unexpected extra model call: ' + json.dumps(messages))
                return fixture._Response(message)
            model = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kwargs: complete(kwargs))),
                                    close=lambda: None)
            model_patch = patch.object(self.run_agent, 'OpenAI', return_value=model)
            model_patch.start(); self.addCleanup(model_patch.stop)

            patches = self.runtime._wh_patch_mod
            self.assertEqual(Path(patches.__file__).resolve(),
                             REPO / 'docker/hermes-staging/apply_gateway_patches.py')
            self.assertIsNotNone(getattr(patches, '_orig_whatsapp_cloud_send', None))
            self.assertEqual(patches._patched_whatsapp_cloud_send.__name__, '_patched_whatsapp_cloud_send')
            self.assertNotIn('crowsnest-sim:', INBOUND)

        def save_evidence(self):
            evidence = dict(mode=self.mode, timeline=self.timeline,
                            model_requests=getattr(self, 'model_requests', []),
                            staff_calls=getattr(self, 'staff_calls', []),
                            provider_calls=self.provider_calls, staff_http=self.staff_http,
                            owner_ids=self.owner_ids, db_rows=self.db_rows, ledger=self.ledger,
                            user_turn_counts=self.user_turn_counts,
                            network_denials=NETWORK_DENIALS[self.network_start:])
            (ARTIFACTS / (self._testMethodName + '.json')).write_text(
                json.dumps(evidence, indent=2, ensure_ascii=False, default=str), encoding='utf-8')

        async def run_booking(self, mode):
            self.mode = mode
            if mode == 'suppression':
                os.environ['WHATSAPP_DRY_RUN'] = 'true'
            source = SessionSource(platform=Platform.WHATSAPP_CLOUD,
                                   chat_id='999000012222', user_id='999000012222',
                                   chat_type='dm', user_name='Casey')
            event = MessageEvent(text=INBOUND, message_type=MessageType.TEXT, source=source,
                                 message_id='wamid.OFFLINE.inbound.' + mode)
            key = build_session_key(source, group_sessions_per_user=True, thread_sessions_per_user=False)
            # Real adapter ingress owns background task, normal final send and cleanup.
            await self.adapter.handle_message(event)
            tasks = list(self.adapter._session_tasks.values())
            self.assertTrue(tasks, 'real adapter did not launch ingress task')
            await asyncio.wait_for(asyncio.gather(*tasks), timeout=70)
            entry = self.runner.session_store._entries.get(key)
            self.assertIsNotNone(entry)
            db = self.runner.session_store._db
            self.assertEqual(type(db).__name__, 'SessionDB')
            self.db_rows = db.get_messages(entry.session_id)
            with db._lock:
                self.ledger = [json.loads(row[0]) for row in db._conn.execute(
                    'SELECT value FROM state_meta WHERE key LIKE ?', (accepted_quote._PREFIX + '%',)).fetchall()]
            self.assertEqual(len([r for r in self.db_rows if r['role'] == 'user']), 1, self.db_rows)
            user = next(r for r in self.db_rows if r['role'] == 'user')
            self.assertIn(INBOUND, user['content'])
            self.assertEqual(len(set(self.owner_ids)), 1, self.owner_ids)
            self.assertEqual(set(self.user_turn_counts), {1})
            self.assertIs(self.registry._tools['create_booking_from_plan'].handler, self.create_handler)
            bodies = [row['body'] for row in self.timeline if row['kind'] == 'provider']
            self.assertTrue(all('shall i book' not in body.lower() and '?' not in body for body in bodies))
            # Optional installed model-catalog/version lookups can try DNS. The
            # process audit hook denies them before any socket connects.
            self.assertTrue(all(row['event'] == 'socket.getaddrinfo'
                                for row in NETWORK_DENIALS[self.network_start:]))
            return [p for p, _ in self.staff_calls if p.endswith('/booking-create-from-plan')], bodies

        async def test_success_sends_price_then_creates_then_sends_receipt(self):
            creates, bodies = await self.run_booking('success')
            self.assertEqual(len(creates), 1, self.timeline)
            self.assertEqual(self.model_steps, [0, 1, 2, 3, 4])
            self.assertEqual(bodies, [PRICE, CONFIRMATION])
            price_index = next(i for i, row in enumerate(self.timeline) if row.get('body') == PRICE)
            create_index = next(i for i, row in enumerate(self.timeline) if row.get('path', '').endswith('/booking-create-from-plan'))
            confirmation_index = next(i for i, row in enumerate(self.timeline) if row.get('body') == CONFIRMATION)
            self.assertLess(price_index, create_index)
            self.assertLess(create_index, confirmation_index)
            self.assertEqual(sum(r.get('internal') is True for r in self.timeline), 2)
            self.assertIn(LINK, bodies[-1])
            presentation = self.ledger[0]['accepted_presentation']
            self.assertTrue(quote_delivery.has_send_ack(presentation))
            self.assertEqual(presentation['send_ack']['message_id'], 'wamid.OFFLINE.1')
            self.assertTrue(presentation['send_ack']['continuation_claimed'])
            exact_checks = [row for row in self.timeline if row['kind'] == 'staff_availability'
                            and row['request'].get('selected_bed_codes')]
            self.assertEqual(len(exact_checks), 1)
            exact = exact_checks[0]['response']['exact_bed_eligibility']
            self.assertTrue(exact['eligible'])
            self.assertEqual(exact['selected_bed_codes'], ['R3-B1'])
            self.assertEqual(exact['guest_bed_assignments'], [
                {'guest_index': 0, 'guest_name': 'Casey', 'bed_code': 'R3-B1'}])
            self.assertEqual(sum(p.endswith('/create-stripe-link') for p, _ in self.staff_calls), 1)

        async def test_changed_price_revalidation_never_creates(self):
            creates, bodies = await self.run_booking('changed-price')
            self.assertEqual(creates, [])
            self.assertEqual(self.saved_bookings, [])
            self.assertEqual(self.model_steps, [0, 1, 2, 3, 4, 5])
            # Current production failure-budget handling escalates this second
            # refusal, then suppresses the final reply as handoff_duplicate.
            # This test proves zero create, NOT successful revised-offer delivery.
            self.assertEqual(bodies, [PRICE])
            previews = [row['response'] for row in self.timeline if row['kind'] == 'staff_preview']
            self.assertEqual([row['total_cents'] for row in previews], [65000, 70000])
            self.assertNotEqual(previews[0]['offer_revision']['offer_fingerprint'],
                                previews[1]['offer_revision']['offer_fingerprint'])
            self.assertEqual(sum(r.get('internal') is True for r in self.timeline), 2)
            self.assertFalse(any(p.endswith('/create-stripe-link') for p, _ in self.staff_calls))
            self.assertFalse(self.ledger[0].get('receipt'))
            self.assertEqual(self.ledger[0]['status'], 'offered')
            self.assertEqual(self.ledger[0]['quote']['total_cents'], 70000)
            self.assertFalse(quote_delivery.has_send_ack(self.ledger[0].get('presentation')))

        async def test_provider_failure_never_creates(self):
            creates, bodies = await self.run_booking('failure')
            self.assertEqual(creates, [])
            self.assertTrue(bodies)
            self.assertEqual(self.model_steps, [0, 1, 2])
            self.assertFalse(quote_delivery.has_send_ack(self.ledger[0].get('presentation')))

        async def test_kill_switch_suppression_never_creates(self):
            creates, bodies = await self.run_booking('suppression')
            self.assertEqual(creates, [])
            self.assertEqual(bodies, [])
            self.assertEqual(self.model_steps, [0, 1, 2])
            self.assertFalse(quote_delivery.has_send_ack(self.ledger[0].get('presentation')))

        async def test_provider_success_without_id_never_creates(self):
            creates, bodies = await self.run_booking('no-id')
            self.assertEqual(creates, [])
            self.assertTrue(bodies)
            self.assertEqual(self.model_steps, [0, 1, 2])
            self.assertFalse(quote_delivery.has_send_ack(self.ledger[0].get('presentation')))

    def json_module(data):
        return json.dumps(data)


if __name__ == '__main__':
    if 'InstalledQuoteSendContinuation' in globals():
        unittest.main()
    else:
        raise SystemExit(launch())
