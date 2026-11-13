"""Offline downstream proof only: explicit complaint tool -> guarded mock send ->
actual Staff handoff handler + PGlite. Does NOT prove model intent selection,
real WhatsApp, live credentials, or an existing-booking commercial SQL record.
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
from types import SimpleNamespace
from unittest.mock import patch
from urllib.parse import urlsplit

root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parents[1]
output = Path(sys.argv[2]) if len(sys.argv) > 2 else None
sys.path[:0] = [str(root / 'docker/hermes-staging'), str(root / 'docker/hermes-staging/plugins')]
import wolfhouse_staff_api as plugin
from wolfhouse import explicit_human_handoff as owner
from wolfhouse_staff_api import handoff_guest_note
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

async def main():
    async def dispatch(event):
        return await asyncio.to_thread(lambda: json.loads(plugin.flag_needs_human({
            'reason': 'complaint: guest reports paid but got nothing', 'language': 'en'})))
    event = SimpleNamespace(source=SimpleNamespace(chat_id=phone), text='I paid but got nothing')
    return await owner.dispatch_with_handoff_notice(event, SimpleNamespace(adapter=Adapter(), dispatch_fn=dispatch))

try:
    before = rpc(op='reset')
    env = {'LUNA_CLIENT_SLUG': 'wolfhouse-somo', 'HERMES_ROLE': 'luna',
           'LUNA_BOT_INTERNAL_TOKEN': 'offline-not-a-credential',
           'WOLFHOUSE_STAFF_API_BASE_URL': 'https://staff.invalid',
           'WOLFHOUSE_WHATSAPP_GUEST_PHONE': phone}
    with patch.dict(os.environ, env, clear=True), \
         patch('socket.socket.connect', side_effect=AssertionError('network forbidden')), \
         patch('urllib.request.urlopen', side_effect=transport), \
         patch.object(handoff_guest_note, 'default_fetch_staff_info', return_value={'staff_member_name': 'Camila'}):
        result = asyncio.run(main())
    state = rpc(op='snapshot')
    assert result.get('success') is True and result.get('needs_human') is True, result
    assert len(state['handoffs']) == len(state['pauses']) == 1, state
    assert state['pauses'][0]['paused'] is True
    target = [c for c in state['conversations'] if c['slug'] == 'wolfhouse-somo' and c['phone'] == phone]
    assert len(target) == 1 and target[0]['needs_human'] is True
    assert all(not c['needs_human'] for c in state['conversations'] if c != target[0])
    assert not state['sql_errors'] and not state['network_attempts'], (state['sql_errors'], state['network_attempts'])
    if output:
        output.write_text(json.dumps({'boundary': __doc__, 'result': result, 'events': events, 'snapshot': state}, indent=2) + '\n')
    print('PASS: configured warm note before real SQL Needs human + one pause; other conversations unchanged')
finally:
    node.stdin.close()
    node.wait(timeout=15)
    stderr = node.stderr.read()
    node.stdout.close(); node.stderr.close()
    assert node.returncode == 0 and not stderr, (node.returncode, stderr)
