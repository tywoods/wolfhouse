"""Offline downstream proof only: explicit complaint tool -> guarded mock send ->
actual Staff handoff handler + PGlite. Does NOT prove model intent selection,
real WhatsApp, live credentials, or an existing-booking commercial SQL record.
A synthetic retained receipt is stored in real Hermes SessionDB, not Staff SQL.
Reuses the repo's existing handoff SQL bridge. Synthetic identities only.
Usage: python scripts/prove-complaint-notice-sql.py [WORKTREE] [OUTPUT_JSON]
"""
import asyncio
import io
import json
import os
from pathlib import Path
import selectors
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
output = Path(sys.argv[2]) if len(sys.argv) > 2 else None
sys.path[:0] = [str(root / 'docker/hermes-staging'), str(root / 'docker/hermes-staging/plugins')]
import wolfhouse_staff_api as plugin
from wolfhouse import explicit_human_handoff as owner
from wolfhouse_staff_api import handoff_guest_note
from wolfhouse import accepted_quote
from hermes_state import SessionDB
from gateway.session_context import set_session_vars, clear_session_vars
phone = '+99900000001'
node_executable = shutil.which('node')
assert node_executable, 'Node and the existing PGlite dependencies are required'
node = subprocess.Popen([node_executable, '--max-old-space-size=1024',
    str(root / 'scripts/verify-luna-payment-failure-handoff-sql.js'), '--bridge'],
    cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, bufsize=1, env={'PATH': os.environ['PATH']})

def rpc(**data):
    node.stdin.write(json.dumps(data) + '\n'); node.stdin.flush()
    with selectors.DefaultSelector() as selector:
        selector.register(node.stdout, selectors.EVENT_READ)
        assert selector.select(timeout=30), 'SQL bridge timeout'
    reply = json.loads(node.stdout.readline())
    assert reply['ok'], reply
    return reply['result']

receipts, events = [], []
def transport(request, **kwargs):
    assert urlsplit(request.full_url).netloc == 'staff.invalid'
    assert urlsplit(request.full_url).path == '/staff/bot/conversation/needs-human'
    assert events and events[0]['kind'] == 'ack', 'SQL pause must follow notice'
    response = rpc(op='handoff', raw_body=request.data.decode(), trusted_client='wolfhouse-somo')
    assert response['status'] == 200, response
    receipts.append(response)
    events.append({'kind': 'persist', 'body': response['body']})
    return io.BytesIO(json.dumps(response['body']).encode())

class Adapter:
    async def send(self, chat_id, text, **kwargs):
        assert chat_id == phone
        state = rpc(op='snapshot')
        assert not state['handoffs'] and not state['pauses'], 'notice was too late'
        assert 'Camila' in text and 'shortly' in text
        assert '/pay' not in text and 'WH-' not in text
        events.append({'kind': 'ack', 'text': text})
        return SimpleNamespace(success=True, message_id='offline-notice-receipt', raw_response={})

async def main(reason):
    async def dispatch(event):
        return await asyncio.to_thread(lambda: json.loads(plugin.flag_needs_human({
            'reason': reason, 'language': 'en'})))
    event = SimpleNamespace(source=SimpleNamespace(chat_id=phone), text='I paid but got nothing')
    return await owner.dispatch_with_handoff_notice(event, SimpleNamespace(adapter=Adapter(), dispatch_fn=dispatch))

try:
    env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
           'LUNA_BOT_INTERNAL_TOKEN': 'offline-not-a-credential',
           'WOLFHOUSE_STAFF_API_BASE_URL': 'https://staff.invalid',
           'WOLFHOUSE_WHATSAPP_GUEST_PHONE': phone}
    cases = []
    reasons = (
        'complaint: guest reports paid but got nothing',
        'business_tool_error: payment_reported_unresolved',
        'business_tool_error: guest says money left their account',
        'payment help needed after charged card',
        'business_tool_error: create payment operation failed',
        'business_tool_error: retry payment operation failed',
    )
    with tempfile.TemporaryDirectory() as temp, patch.dict(os.environ, env, clear=True), \
         patch('socket.socket.connect', side_effect=AssertionError('network forbidden')), \
         patch('urllib.request.urlopen', side_effect=transport), \
         patch.object(handoff_guest_note, 'default_fetch_staff_info', return_value={'staff_member_name': 'Camila'}):
        db = SessionDB(Path(temp) / 'state.db')
        db.create_session('complaint-sql', source='whatsapp')
        tokens = set_session_vars(platform='whatsapp', source='whatsapp', chat_id=phone,
            user_id=phone, session_key='complaint-sql', session_id='complaint-sql', message_id='complaint')
        try:
            accepted_quote.observe_owner_turn(SimpleNamespace(_session_db=db, session_id='complaint-sql'),
                                              'I paid but got nothing')
            # Synthetic commercial receipt: enough to exercise the former saved-receipt veto.
            # No Staff booking write is claimed by this downstream SQL proof.
            retained = {'success': True, 'booking_id': 'offline-retained-booking',
                        'booking_code': 'OFFLINE-RETAINED', 'payment_link_created': True}
            accepted_quote._transaction(lambda state, _: state.update(completion=retained.copy()))
            assert plugin._successful_owner_booking_receipt() == retained
            for reason in reasons:
                rpc(op='reset')
                receipts.clear(); events.clear()
                result = asyncio.run(main(reason))
                state = rpc(op='snapshot')
                assert result.get('success') is True and result.get('needs_human') is True, result
                assert result.get('handoff_persisted') is True and result.get('ack_sent') is True, result
                assert result.get('conversation_paused') is True, result
                assert [event['kind'] for event in events] == ['ack', 'persist'], events
                assert len(state['handoffs']) == len(state['pauses']) == 1, state
                assert state['pauses'][0]['paused'] is True
                assert result['staff_review_id'] == state['handoffs'][0]['id']
                target = [c for c in state['conversations'] if c['slug'] == 'wolfhouse-somo' and c['phone'] == phone]
                assert len(target) == 1 and target[0]['needs_human'] is True
                assert state['handoffs'][0]['conversation_id'] == target[0]['id']
                assert all(not c['needs_human'] for c in state['conversations'] if c != target[0])
                assert not state['sql_errors'] and not state['network_attempts'], (state['sql_errors'], state['network_attempts'])
                assert plugin._successful_owner_booking_receipt() == retained, 'handoff must not alter saved booking'
                cases.append({'reason': reason, 'result': result, 'events': list(events), 'snapshot': state})
                print('PASS: Camila note before real SQL handoff + Needs human + pause:', reason)
        finally:
            accepted_quote.close_turn()
            clear_session_vars(tokens)
            db.close()
    if output:
        output.write_text(json.dumps({'boundary': __doc__, 'cases': cases}, indent=2) + '\n')

finally:
    node.stdin.close()
    node.wait(timeout=15)
    stderr = node.stderr.read()
    node.stdout.close(); node.stderr.close()
    assert node.returncode == 0 and not stderr, (node.returncode, stderr)
