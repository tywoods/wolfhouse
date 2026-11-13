"""Offline installed simulator regression. Run with /opt/hermes/.venv/bin/python.

Reuses test_accepted_quote_installed_entrypoint's actual installed GatewayRunner
fixture. Only external Staff/model/Meta and Inbox persistence are doubles. The
owner, registered handlers, conversation loop, gateway and simulator door are real.
No WhatsApp receipt or proof of price display is needed to save an accepted plan.
"""
from __future__ import annotations

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
ARTIFACTS = Path(os.environ.get('WH_ALWAYS_SAVE_ARTIFACTS',
    '/opt/data/workspace/sandbox-repos/WH-captain/artifacts/always-save/installed'))
NETWORK_DENIALS = []


def deny_network(event, args):
    if event in ('socket.connect', 'socket.connect_ex', 'socket.sendto',
                 'socket.getaddrinfo', 'socket.gethostbyname'):
        if args and isinstance(args[0], socket.socket) and args[0].family == socket.AF_UNIX:
            return
        NETWORK_DENIALS.append({'event': event, 'args': repr(args)})
        raise RuntimeError('OFFLINE regression blocked network: ' + event)


def launch():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    installed = Path('/opt/hermes')
    overlay = ARTIFACTS / 'hermes-overlay'
    overlay.mkdir(exist_ok=True)
    for entry in installed.iterdir():
        if entry.name in ('gateway', '__pycache__'):
            continue
        dest = overlay / entry.name
        if not dest.exists() and not dest.is_symlink():
            dest.symlink_to(entry, target_is_directory=entry.is_dir())
    destination = overlay / 'gateway'
    destination.mkdir(exist_ok=True)
    for entry in (installed / 'gateway').iterdir():
        if entry.name in ('run.py', '__pycache__'):
            continue
        dest = destination / entry.name
        if not dest.exists() and not dest.is_symlink():
            dest.symlink_to(entry, target_is_directory=entry.is_dir())
    sys.path.insert(0, str(REPO / 'docker/hermes-staging'))
    from apply_gateway_patches import apply_original_inbound_source
    target = destination / 'run.py'
    if target.is_symlink():
        raise RuntimeError('Refusing to write through overlay symlink')
    source = apply_original_inbound_source((installed / 'gateway/run.py').read_text())
    source = source.replace('"/etc/hermes-staging/apply_gateway_patches.py"',
                            repr(str(REPO / 'docker/hermes-staging/apply_gateway_patches.py')))
    target.write_text(source, encoding='utf-8')
    node_guard = ARTIFACTS / 'deny-network.cjs'
    node_guard.write_text("const deny=()=>{throw Error('OFFLINE node network denied')};\n"
        "require('net').Socket.prototype.connect=deny;\n"
        "require('dgram').Socket.prototype.send=deny;\n"
        "require('dns').lookup=deny; require('dns').resolve=deny;\n")
    home, temp = ARTIFACTS / 'bootstrap-home', ARTIFACTS / 'tmp'
    home.mkdir(exist_ok=True)
    temp.mkdir(exist_ok=True)
    env = dict(os.environ, HERMES_INSTALL_ROOT=str(overlay), HERMES_HOME=str(home),
        PYTHONDONTWRITEBYTECODE='1', TMPDIR=str(temp),
        NODE_OPTIONS='--require=' + str(node_guard),
        PYTHONPATH=':'.join(map(str, (overlay, REPO / 'docker/hermes-staging',
                                     REPO / 'docker/hermes-staging/plugins', installed))))
    cases = sys.argv[1:] or [
        'InstalledAlwaysSave.test_quote_acceptance_saves_once_without_wa_receipt',
        'InstalledAlwaysSave.test_unpriced_quote_acceptance_still_saves',
        'InstalledAlwaysSave.test_later_staff_price_drift_does_not_replace_accepted_quote',
        'InstalledAlwaysSave.test_occupied_bed_handoff_preserves_spanish_note']
    commands = [[sys.executable, str(Path(__file__).resolve()), '--child', '-v', case]
                for case in cases]
    (ARTIFACTS / 'command.json').write_text(json.dumps({'commands': commands,
        'cwd': str(REPO), 'environment': {key: env[key] for key in
        ('HERMES_INSTALL_ROOT', 'HERMES_HOME', 'PYTHONPATH', 'TMPDIR', 'NODE_OPTIONS')}}, indent=2))
    outputs, status = [], 0
    for command in commands:
        result = subprocess.run(command, cwd=REPO, env=env, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        outputs.append(result.stdout)
        status = max(status, result.returncode)
        (ARTIFACTS / (command[-1].split('.')[-1] + '.log')).write_text(result.stdout)
    (ARTIFACTS / 'installed-regression.log').write_text('\n'.join(outputs))
    print('\n'.join(outputs), end='')
    print(f'Installed always-save regression exit={status}; artifacts={ARTIFACTS}')
    return status


if '--child' in sys.argv:
    sys.argv.remove('--child')
    sys.addaudithook(deny_network)
    from wolfhouse import test_accepted_quote_installed_entrypoint as fixture
    from wolfhouse import accepted_quote, crowsnest_guest_door as door

    class InstalledAlwaysSave(unittest.IsolatedAsyncioTestCase):
        PLAN = dict(check_in='2027-06-06', check_out='2027-06-12', guest_count=2,
            room_type='shared', room_preference='mixed', package_code='malibu',
            catalog_selections=[], payment_choice='deposit', guest_name='Olga Test',
            guests=[{'name': 'Olga Test'}, {'name': 'Pete Test'}],
            selected_bed_codes=['R9-B1', 'R9-B2'], shuttle_choice='declined',
            shuttle_needed=False, payment_link_distribution='together',
            per_guest_payment_links=False)
        PRICE = ('Olga Test and Pete Test, Malibu, 6–12 June 2027, together in R9-B1/R9-B2, '
                 'no shuttle. Total €498; deposit €400; remaining €98. Shall I create it?')
        UNPRICED = 'Olga Test and Pete Test, shall I create your Malibu booking for 6–12 June 2027?'
        LINK = 'https://staff-staging.lunafrontdesk.com/pay/OLGA-PETE-OFFLINE'
        CONFIRMATION = ('Booking OLGA-PETE created for Olga Test and Pete Test, Malibu, '
            '6–12 June 2027, R9-B1/R9-B2 together, no shuttle. Total €498; '
            'deposit €400; remaining €98. Pay together: ' + LINK)
        WARM_NOTE = 'Ale del equipo te va a ayudar — enseguida te escriben.'

        async def asyncSetUp(self):
            self.timeline, self.turns, self.ledgers, self.meta_calls = [], [], [], []
            self.network_start = len(NETWORK_DENIALS)
            self.occupied = False
            self.unpriced = False
            self.recheck_drift = False
            self.preview_calls = 0
            self.addCleanup(self.save_evidence)
            await fixture.InstalledEntrypointQueuedPendingEvent.asyncSetUp(self)
            self.release.set()
            self.model_patch.stop()
            self.enterContext(patch('agent.title_generator.call_llm', return_value=fixture._Response(
                fixture._Message(content='Offline Olga Pete booking'))))
            self.enterContext(patch.object(self.runtime, '_wolfhouse_gateway_runner', self.runner, create=True))
            self.enterContext(patch.dict(os.environ, {'WHATSAPP_DRY_RUN': 'false',
                'LUNA_AUTO_SEND_ENABLED': 'true', 'HERMES_HUMAN_DELAY_MODE': 'off'}))
            owner = self
            class NoMeta:
                async def post(_self, *args, **kwargs):
                    owner.meta_calls.append({'args': args, 'kwargs': kwargs})
                    raise AssertionError('Simulator must never call Meta')
            self.adapter._http_client = NoMeta()
            self.addCleanup(lambda: self.assertEqual(self.meta_calls, []))
            # The existing fixture installs the real Staff guard. Swap only the
            # HTTP transport it captures, never the guard or registered handler.
            guarded = self.handler_globals['_post_bot']
            cells = dict(zip(guarded.__code__.co_freevars, guarded.__closure__ or ()))
            transport = cells['original_post']
            original_transport = transport.cell_contents
            transport.cell_contents = self.staff
            self.addCleanup(setattr, transport, 'cell_contents', original_transport)
            self.enterContext(patch('urllib.request.urlopen', side_effect=self.staff_http))
            self.enterContext(patch('urllib.request.OpenerDirector.open', side_effect=self.staff_http))
            model = SimpleNamespace(chat=SimpleNamespace(completions=SimpleNamespace(
                create=lambda **kwargs: self.complete(kwargs))), close=lambda: None)
            self.enterContext(patch.object(self.run_agent, 'OpenAI', return_value=model))

        def quote(self):
            # Staff API cents schema, not a mocked quote/owner runtime result.
            return dict(success=True, total_cents=49800, deposit_required_cents=40000,
                payment_link_amount_cents=40000, balance_due_cents=49800,
                remaining_after_deposit_cents=9800, currency='EUR',
                payment_choice='deposit', add_ons=[], line_items=[],
                per_person=[dict(guest_number=i, guest_name=name, total_cents=24900,
                    deposit_required_cents=20000, package_code='malibu')
                    for i, name in enumerate(('Olga Test', 'Pete Test'), 1)])

        def staff(self, path, payload, **kwargs):
            self.staff_calls.append((path, deepcopy(payload)))
            self.timeline.append({'kind': 'staff', 'path': path})
            route = path.removeprefix('/staff/bot')
            if route == '/contact-identity':
                return dict(success=True, full_name='Olga Test')
            stock = [dict(bed_code=bed, room_code='R9', room_type='mixed',
                gender_strategy='flexible', selling_mode='shared', bed_active=True,
                bed_sellable=True) for bed in ('R9-B1', 'R9-B2')]
            if route == '/booking-preview':
                self.preview_calls += 1
                quote = self.quote()
                if self.recheck_drift and self.preview_calls > 1:
                    # A later catalog revision is not the guest's accepted price.
                    # The API double remains schema-correct; do not alter owner
                    # output or make the transport fail to manufacture a RED.
                    quote.update(total_cents=51000, balance_due_cents=51000,
                                 remaining_after_deposit_cents=11000)
                    for row in quote['per_person']:
                        row['total_cents'] = 25500
                source = "const {buildCheckedWolfhousePreviewOffer:b}=require('./scripts/lib/luna-front-desk-accommodation-availability-service');console.log(JSON.stringify(b(JSON.parse(process.argv[1]))))"
                checked = json.loads(subprocess.check_output(['node', '-e', source, json.dumps({
                    **payload, 'client_slug': 'wolfhouse-somo', 'quote': quote,
                    'availability': {**payload, 'status': 'checked',
                                     'selected_bed_codes': ['R9-B1', 'R9-B2']},
                    'room_rows': stock})], cwd=REPO, text=True, timeout=10))
                return {**quote, **checked, 'payment_choice_needed': False}
            if route == '/availability-check':
                source = """
const s = require('./scripts/lib/luna-front-desk-accommodation-availability-service');
const input = JSON.parse(process.argv[1]);
const built = s.buildWolfhouseAvailabilityCommand({channel: s.AVAILABILITY_CHANNELS.BOT_HTTP,
  trustedClientSlug: 'wolfhouse-somo', transportBody: input.payload,
  quoteConfig: {package_min_nights: 1}, demoCalendarEnrichment: false});
console.log(JSON.stringify(built.ok ? s.mapBotHttpAvailabilityResponse(
  s.buildCanonicalAvailabilityBody(built.command,
    s.computeWolfhouseAvailabilityInventory(input.stock, [], built.command), null)) : built));
"""
                return json.loads(subprocess.check_output(['node', '-e', source,
                    json.dumps({'payload': payload, 'stock': stock})],
                    cwd=REPO, text=True, timeout=10))
            if route == '/booking-create-from-plan':
                if self.occupied:
                    return dict(success=False, write_performed=False, block_reason='overlap_conflict',
                        error='Selected beds overlap an existing booking',
                        conflict_beds=['R9-B1'], staff_review_needed=True)
                self.saved_bookings.append(deepcopy(payload))
                return dict(success=True, write_performed=True, booking_code='OLGA-PETE',
                    booking_id='20000000-0000-4000-8000-000000000001', payment_id='10000000-0000-4000-8000-000000000001',
                    payment_status='unpaid', amount_paid_cents=0, quote=self.quote(),
                    guest_rooms=[dict(guest_number=i, guest_name=name, bed_code=f'R9-B{i}',
                        room_code='R9', room_type='mixed')
                        for i, name in enumerate(('Olga Test', 'Pete Test'), 1)])
            if route == '/payments/10000000-0000-4000-8000-000000000001/create-stripe-link':
                return dict(success=True, payment_id='10000000-0000-4000-8000-000000000001',
                    guest_payment_url=self.LINK, amount_due_cents=40000,
                    currency='EUR', payment_status='unpaid', no_payment_truth_recorded=True)
            if route == '/conversation/needs-human':
                return dict(success=True, needs_human=True, conversation_paused=True,
                    staff_handoff={'id': 'offline-overlap-review'})
            raise AssertionError('Unexpected fake Staff route: ' + path)

        def staff_http(self, request, *args, **kwargs):
            url = request.full_url if hasattr(request, 'full_url') else str(request)
            self.assertTrue(url.startswith('https://staff-staging.lunafrontdesk.com/'), url)
            self.timeline.append({'kind': 'staff_http', 'url': url})
            if url.endswith('/staff-info'):
                data = dict(success=True, staff_member_name='Ale')
            elif url.endswith('/conversation/needs-human'):
                data = dict(success=True, needs_human=True, conversation_paused=True,
                            staff_handoff={'id': 'offline-overlap-review'})
            elif url.endswith('/whatsapp-thread-mirror'):
                data = dict(success=True, thread_message={'persisted': True})
            else:
                raise AssertionError('Unexpected fake Staff HTTP route: ' + url)
            return io.BytesIO(json.dumps(data).encode())

        def complete(self, request):
            messages = deepcopy(request.get('messages') or [])
            self.model_requests.append(messages)
            latest = max(i for i, m in enumerate(messages) if m.get('role') == 'user')
            tools = [json.loads(m['content']) for m in messages[latest + 1:] if m.get('role') == 'tool']
            accepting = ('Yes, create it' in messages[latest]['content']
                         or 'Sí, crea la reserva' in messages[latest]['content'])
            if not tools:
                name = 'create_booking_from_plan' if accepting else 'quote_booking'
                message = fixture._Message(tool_calls=[fixture._ToolCall(
                    'olga-create' if accepting else 'olga-quote', name, self.PLAN)])
            elif self.occupied and accepting:
                self.assertEqual(tools[-1].get('error'), 'bed_already_taken', tools[-1])
                self.assertTrue(tools[-1].get('needs_human'), tools[-1])
                # Deliberately adversarial final: must not overwrite warm ack.
                message = fixture._Message(content='There was a technical issue. Please try again.')
            elif tools[-1].get('success'):
                self.assertEqual(tools[-1]['total_cents'], 49800)
                if accepting:
                    self.assertEqual(tools[-1]['amount_due_cents'], 40000)
                    self.assertIn(self.LINK, json.dumps(tools[-1]))
                else:
                    self.assertEqual(tools[-1]['deposit_required_cents'], 40000)
                    self.assertEqual(tools[-1]['remaining_after_deposit_cents'], 9800)
                message = fixture._Message(content=self.CONFIRMATION if accepting else
                    (self.UNPRICED if self.unpriced else self.PRICE))
            else:
                message = fixture._Message(content='Offline tool blocked: ' + str(tools[-1]))
            self.timeline.append({'kind': 'model', 'accepting': accepting, 'tools': tools})
            return fixture._Response(message)

        def save_evidence(self):
            (ARTIFACTS / (self._testMethodName + '.json')).write_text(json.dumps(dict(
                boundaries='Explicit offline Staff/model/Meta/Inbox doubles; no live actions',
                timeline=self.timeline, turns=self.turns, ledgers=self.ledgers,
                staff_calls=getattr(self, 'staff_calls', []), meta_calls=self.meta_calls,
                model_requests=getattr(self, 'model_requests', []),
                network_denials=NETWORK_DENIALS[self.network_start:]),
                indent=2, ensure_ascii=False, default=str), encoding='utf-8')

        async def turn(self, text, ident):
            async def mirror(**kwargs):
                self.timeline.append({'kind': 'mirror', 'direction': kwargs['direction'],
                    'text': kwargs['text'], 'request_id': kwargs['scope'].request_id})
                return {'success': True, 'thread_message': {'persisted': True,
                    'message_id': 'offline-' + kwargs['scope'].request_id + '-' + kwargs['direction'],
                    'conversation_id': 'offline-olga-pete-conversation'}}
            result = await door.run_live_crowsnest_guest_turn(phone='+999' + '00004440', text=text,
                message_id=ident, mirror=mirror, timeout_sec=60)
            self.turns.append(result)
            db = self.runner.session_store._db
            with db._lock:
                state = [json.loads(row[0]) for row in db._conn.execute(
                    'SELECT value FROM state_meta WHERE key LIKE ?', (accepted_quote._PREFIX + '%',))]
            self.ledgers.append(state)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['transport_calls'], 0)
            self.assertTrue(result['whatsapp_suppressed'])
            return result

        async def offer(self):
            offered = await self.turn('Please quote Malibu for Olga Test and Pete Test, 6–12 June 2027, '
                'together in a mixed shared room, beds R9-B1 and R9-B2, no shuttle. '
                'We choose the deposit and pay together.', 'olga-quote-01')
            self.assertEqual(self.saved_bookings, [])
            self.assertEqual(offered['reply_text'], self.UNPRICED if self.unpriced else self.PRICE)
            return offered

        async def saved_flow(self):
            await self.offer()
            created = await self.turn('Yes, create it with the €400 deposit, paying together, no shuttle.',
                                      'olga-create-02')
            self.assertEqual(created['reply_text'], self.CONFIRMATION)
            replay = await self.turn('Yes, create it with the €400 deposit, paying together, no shuttle.',
                                     'olga-create-03')
            self.assertIn('OLGA-PETE', replay['reply_text'])
            creates = [body for path, body in self.staff_calls if path.endswith('/booking-create-from-plan')]
            self.assertEqual(len(creates), 1, self.staff_calls)
            self.assertEqual(len(self.saved_bookings), 1)
            self.assertTrue(creates[0].get('always_save_accepted_booking'), creates[0])
            self.assertEqual(creates[0]['accepted_quote']['total_cents'], 49800)
            self.assertEqual(creates[0]['accepted_quote']['deposit_required_cents'], 40000)
            self.assertEqual(creates[0]['accepted_offer']['total_cents'], 49800)
            self.assertIsInstance(creates[0]['booking_check_warnings'], list)
            for key in ('selected_bed_codes', 'package_code', 'check_in', 'check_out', 'guest_count',
                        'guests', 'per_guest_payment_links', 'shuttle_needed', 'shuttle_choice'):
                self.assertEqual(creates[0][key], self.PLAN[key], key)
            self.assertEqual(sum(p.endswith('/create-stripe-link') for p, _ in self.staff_calls), 1)
            self.assertIs(self.registry._tools['create_booking_from_plan'].handler, self.create_handler)
            self.assertEqual(self.meta_calls, [])
            outbound = [r['text'] for r in self.timeline if r['kind'] == 'mirror' and r['direction'] == 'outbound']
            self.assertEqual(outbound[:2], [self.UNPRICED if self.unpriced else self.PRICE, self.CONFIRMATION])

        async def test_quote_acceptance_saves_once_without_wa_receipt(self):
            await self.saved_flow()

        async def test_unpriced_quote_acceptance_still_saves(self):
            self.unpriced = True
            await self.saved_flow()

        async def test_later_staff_price_drift_does_not_replace_accepted_quote(self):
            self.recheck_drift = True
            await self.saved_flow()

        async def test_occupied_bed_handoff_preserves_spanish_note(self):
            await self.offer()
            self.occupied = True
            result = await self.turn('Sí, crea la reserva con el depósito de €400, pagamos juntos.',
                                     'olga-overlap-02')
            self.assertEqual(result['reply_text'], self.WARM_NOTE)
            self.assertEqual(self.saved_bookings, [])
            self.assertEqual(sum(p.endswith('/conversation/needs-human') for p, _ in self.staff_calls), 1)
            self.assertFalse(any(p.endswith('/create-stripe-link') for p, _ in self.staff_calls))
            self.assertEqual(self.meta_calls, [])


if __name__ == '__main__':
    if 'InstalledAlwaysSave' in globals():
        unittest.main()
    else:
        raise SystemExit(launch())
