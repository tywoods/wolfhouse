"""Offline execution of production batch owner and its function dependencies."""
import ast
import hashlib
import json
import re
import sys
import urllib.parse

path = sys.argv[1]
tree = ast.parse(open(path).read())
functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
selected = set()
def include(name):
    if name in selected or name not in functions:
        return
    selected.add(name)
    for n in ast.walk(functions[name]):
        if isinstance(n, ast.Name):
            include(n.id)
standalone = len(sys.argv) > 2 and sys.argv[2] == 'standalone'
include('create_guest_payment_link' if standalone else 'create_booking_from_plan')
# Only external transport/session context is replaced. Batch assembly and helpers are real.
from typing import Any
ns: dict[str, Any] = dict(json=json, hashlib=hashlib, re=re, urllib=urllib)
exec(compile(ast.Module(body=[functions[n] for n in selected], type_ignores=[]), path, 'exec'), ns)
responses = json.load(sys.stdin)
roster = [{**d, 'guest_name': 'STALE INPUT NAME'} for d in responses]
calls = []
def post(route, body):
    calls.append(route)
    if route == '/booking-create-from-plan':
        return dict(success=True, write_performed=True, uses_per_guest_model=True,
                    booking_code='WH-SYNTHETIC', booking_id='booking', booking_guests=roster)
    return next(d for d in responses if '/' + d['booking_guest_id'] + '/' in route)
ns.update(_post_bot=post, _session_guest_phone=lambda: '', _trusted_client_slug=lambda: 'wolfhouse-somo',
          _WOLFHOUSE_GUEST_LOCATION_LINE='offline location')
if standalone:
    print(json.dumps([json.loads(ns['create_guest_payment_link']({'booking_guest_id':d['booking_guest_id']})) for d in responses]))
    sys.exit(0)
import pathlib
sys.path.insert(0, str(pathlib.Path(path).parents[2]))
result = json.loads(ns['create_booking_from_plan'](dict(guest_name='Synthetic Owner', guest_phone='+123456789',
               selected_bed_codes=['synthetic'], package_code='package_none', room_preference='shared', group_gender='mixed', payment_choice='per_guest', client_slug='wolfhouse-somo')))
assert result['next_action'] == 'send_per_guest_payment_links'
assert len(calls) == len(responses) + 1
assert len(result['guest_payment_links']) == len(responses)
for link in result['guest_payment_links']:
    owner = next(d for d in responses if d['booking_guest_id'] == link['booking_guest_id'])
    for key in ('guest_number', 'guest_name', 'payment_id'):
        assert link.get(key) == owner[key], (key, link, owner)
    assert link['secure_payment_url'] == owner['guest_payment_url']
print(json.dumps(result))
