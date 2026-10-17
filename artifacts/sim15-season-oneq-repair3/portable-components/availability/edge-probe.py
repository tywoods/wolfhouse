"""Additional bounded offline cases. Does not modify/reinterpret the immutable matrix."""
import json
from pathlib import Path
import socket
import subprocess
from copy import deepcopy
from unittest.mock import patch
socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(AssertionError('network forbidden'))
import wolfhouse_staff_api as plugin
from wolfhouse import accepted_quote

class Registry:
    def __init__(self): self.tools = {}
    def register_tool(self, **tool): self.tools[tool['name']] = tool
    def register_hook(self, *args): pass
registry = Registry()
with patch.object(accepted_quote, 'install_owner_hook'):
    plugin.register(registry)

def bed(room, category, n=1, mode='shared'):
    return dict(bed_code=f'{room}-B{n}', room_code=room, room_type=category,
                selling_mode=mode, capacity=3, bed_active=True, bed_sellable=True)

base = dict(check_in='2027-01-01', check_out='2027-01-02', guest_count=1, room_type='shared')
cases = []
for gender in ('female', 'male'):
    matching = gender + '_only'
    guests = [dict(name='Person', explicit_gender=gender)]
    for pref in ('mixed', 'shared'):
        for inventory in ('matching-only', 'mixed-occupied', 'mixed-insufficient'):
            count = 2 if inventory == 'mixed-insufficient' else 1
            rows = [bed('G', matching, n) for n in range(1, count + 1)]
            blocks = []
            if inventory != 'matching-only': rows += [bed('X', 'mixed')]
            if inventory == 'mixed-occupied': blocks = [dict(bed_code='X-B1', room_code='X')]
            people = [dict(name=f'Person{n}', explicit_gender=gender) for n in range(count)]
            cases.append((f'{gender} {pref} {inventory}', dict(room_preference=pref, guest_count=count, guests=people), rows, blocks,
                          dict(availability_status='unavailable' if pref == 'mixed' else 'available',
                               selected_room_code=None if pref == 'mixed' else 'G')))
    for explicit_type in (True, False):
        params = dict(guests=guests)
        if not explicit_type: params['room_type'] = None
        cases.append((f'{gender} omitted preference mixed-only room_type_{explicit_type}', params, [bed('X','mixed')], [],
                      dict(availability_status='available', selected_room_code='X')))
    for mode in ('private', 'private_optional'):
        for occupied in (False, True):
            rows = [bed('P',matching,n,mode) for n in (1,2)]
            blocks = [dict(bed_code='P-B2',room_code='P')] if occupied else []
            expected = dict(availability_status='unavailable' if occupied else 'available', selected_room_code=None if occupied else 'P',
                            selected_room_description=None if occupied else 'private', guest_safe_room_label=None if occupied else 'Private room.')
            cases.append((f'private {gender} {mode} sibling_occupied_{occupied}', dict(room_type='private',room_preference='private',guests=[dict(name='Alex')]),rows,blocks,expected))
    opposite = 'male' if gender == 'female' else 'female'
    cases.append((f'{gender} explicitly requests opposite category',dict(room_preference=opposite+'_only',guests=guests),[bed('G',opposite+'_only')],[],dict(availability_status='eligibility_required',selected_room_code=None)))
    cases.append((f'{gender} mixed roster requests gendered',dict(room_preference=matching,guest_count=2,guests=[*guests,dict(name='Other',explicit_gender=opposite)]),[bed('G',matching,n) for n in (1,2)],[],dict(availability_status='eligibility_required',selected_room_code=None)))

for name, extra, rows, blocks, expected in cases:
    calls = []
    def post(path, payload):
        assert path == '/availability-check'
        done = subprocess.run(['node', str(Path(__file__).with_name('staff-probe.js')), 'bridge'],
                              input=json.dumps(dict(payload=payload,rows=rows,blocks=blocks)),
                              text=True,capture_output=True,check=True)
        staff = json.loads(done.stdout)
        calls.append(dict(payload=deepcopy(payload),staff=staff))
        return staff
    with patch.object(plugin, '_post_bot', side_effect=post):
        adapted = json.loads(registry.tools['check_availability']['handler']({**base,**extra}))
    assert len(calls) == 1
    problems = [f'{key}: expected {value!r}, got {adapted.get(key)!r}' for key,value in expected.items() if adapted.get(key) != value]
    available = expected['availability_status'] == 'available'
    if len(adapted['selected_bed_codes']) != (calls[0]['payload']['guest_count'] if available else 0):
        problems.append('wrong selection count')
    if adapted.get('available') != (expected['availability_status'] == 'available') or adapted.get('unavailable') != (expected['availability_status'] == 'unavailable'):
        problems.append('wrong available/unavailable boolean')
    if adapted.get('needs_human') or adapted.get('staff_review_needed'):
        problems.append('unexpected escalation')
    if adapted['girls_room_available'] != adapted['room_options']['girls_room_available']:
        problems.append('nested flag disagreement')
    print(json.dumps(dict(case=name,input={**base,**extra},inventory=rows,occupancy=blocks,expected=expected,
                          **calls[0],adapted=adapted,problems=problems,verdict='CHANGES' if problems else 'PASS')))
