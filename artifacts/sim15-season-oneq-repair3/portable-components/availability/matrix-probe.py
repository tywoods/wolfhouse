"""Offline registered-tool -> actual JS service -> adapter. Synthetic rows, no DB/network."""
import json
import os
from pathlib import Path
import subprocess
from copy import deepcopy
from unittest.mock import patch
import socket
socket.socket.connect = lambda *a, **k: (_ for _ in ()).throw(AssertionError('network forbidden'))
import wolfhouse_staff_api as plugin
from wolfhouse import accepted_quote

class Registry:
    def __init__(self): self.tools = {}
    def register_tool(self, **tool): self.tools[tool['name']] = tool
    def register_hook(self, *args): pass

registry=Registry()
with patch.object(accepted_quote, 'install_owner_hook'):
    plugin.register(registry)

def bed(room, category, n=1, mode='shared'):
    return dict(bed_code=f'{room}-B{n}',room_code=room,room_type=category,selling_mode=mode,
                capacity=3,bed_active=True,bed_sellable=True)

base=dict(check_in='2027-01-01',check_out='2027-01-02',guest_count=1,room_type='shared')
cases=[
 ('female canonical requested female',dict(room_preference='female_only',guests=[dict(name='Nora',explicit_gender='female')]),[bed('F','female_only')],[]),
 ('male canonical requested male',dict(room_preference='male_only',guests=[dict(name='Alex',explicit_gender='male')]),[bed('M','male_only')],[]),
 ('unknown requested female',dict(room_preference='female_only',guests=[dict(name='Nora')]),[bed('F','female_only')],[]),
 ('male requested female conflict',dict(room_preference='female_only',guests=[dict(name='Alex',explicit_gender='male')]),[bed('F','female_only')],[]),
 ('private female category unknown guest',dict(room_preference='private',room_type='private',guests=[dict(name='Alex')]),[bed('P','female_only',mode='private')],[]),
 ('private male category unknown guest',dict(room_preference='private',room_type='private',guests=[dict(name='Alex')]),[bed('P','male_only',mode='private')],[]),
 ('private mixed category unknown guest',dict(room_preference='private',room_type='private',guests=[dict(name='Alex')]),[bed('P','mixed',mode='private')],[]),
 ('optional private occupied sibling',dict(room_preference='private',room_type='private',guests=[dict(name='Alex')]),[bed('P','female_only',mode='private_optional'),bed('P','female_only',2,mode='private_optional')],[dict(room_code='P',bed_code='P-B2')]),
 ('female canonical generic shared male ranks first',dict(room_preference='shared',guests=[dict(name='Nora',explicit_gender='female')]),[bed('R4','male_only'),bed('R5','female_only')],[]),
 ('three explicit girls generic shared',dict(guest_count=3,room_preference='shared',guests=[dict(name=n,explicit_gender='female') for n in ['A','B','C']]),[bed(r,c,n) for r,c in [('R4','male_only'),('R5','female_only')] for n in (1,2,3)],[]),
 ('partial female roster does not gender companion',dict(guest_count=2,room_preference='female_only',guests=[dict(name='A',explicit_gender='female'),dict(name='B')]),[bed('F','female_only',n) for n in (1,2)],[]),
 ('mixed explicit roster rejects female dorm',dict(guest_count=2,room_preference='female_only',guests=[dict(name='A',explicit_gender='female'),dict(name='B',explicit_gender='male')]),[bed('F','female_only',n) for n in (1,2)],[]),
 ('no name inference explicit preference only',dict(room_preference='female_only',guests=[dict(name='Nora')]),[bed('F','female_only')],[]),
 ('stale hints do not override canonical female',dict(room_preference='female_only',guests=[dict(name='Nora',explicit_gender='female')],room_name_hints=[dict(name='Nora',explicit_gender='male')]),[bed('F','female_only')],[]),
]
# Extra cases are synthetic; original prior probe remains byte-identical.
for gender in ('female', 'male'):
    guest = dict(name='Person', explicit_gender=gender)
    matching = gender + '_only'
    for pref in ('mixed', 'shared'):
        cases.append((f'{gender} {pref} only mixed beds', dict(room_preference=pref, guests=[guest]), [bed('X','mixed')], []))
        cases.append((f'{gender} {pref} gendered plus mixed beds', dict(room_preference=pref, guests=[guest]), [bed('R4','male_only'),bed('R5','female_only'),bed('X','mixed')], []))
        cases.append((f'{gender} {pref} occupied gendered plus free mixed', dict(room_preference=pref, guests=[guest]), [bed('G',matching),bed('X','mixed')], [dict(bed_code='G-B1',room_code='G')]))
    cases.append((f'{gender} omitted preference only mixed beds',dict(guests=[guest]),[bed('X','mixed')],[]))
    for mode in ('private','private_optional'):
        cases.append((f'private {gender} {mode} unused sibling',dict(room_preference='private',room_type='private',guests=[dict(name='Person')]),[bed('P',matching,1,mode),bed('P',matching,2,mode)],[]))
    cases.append((f'{gender} explicit gendered genuinely full', dict(room_preference=matching,guests=[guest]), [bed('G',matching)], [dict(bed_code='G-B1',room_code='G')]))
for roster_name, guests in (
    ('unknown', [dict(name='A'),dict(name='B')]),
    ('partial', [dict(name='A',explicit_gender='female'),dict(name='B')]),
    ('mixed', [dict(name='A',explicit_gender='female'),dict(name='B',explicit_gender='male')]),
):
    for pref in ('shared','mixed'):
        for category in ('mixed','female_only'):
            cases.append((f'{roster_name} roster {pref} only {category}', dict(guest_count=2,room_preference=pref,guests=guests),[bed('X',category,n) for n in (1,2)],[]))
cases += [
    ('male ordinary shared female ranks first',dict(room_preference='shared',guests=[dict(name='A',explicit_gender='male')]),[bed('A','female_only'),bed('Z','male_only')],[]),
    ('female R6 one bed two occupants',dict(guest_count=2,room_preference='female_only',guests=[dict(name=n,explicit_gender='female') for n in ('A','B')]),[bed('R6','female_only')],[]),
    ('female R6 two beds two occupants',dict(guest_count=2,room_preference='female_only',guests=[dict(name=n,explicit_gender='female') for n in ('A','B')]),[bed('R6','female_only',n) for n in (1,2)],[]),
    ('unknown genuinely empty inventory',dict(guests=[dict(name='A')]),[],[]),
    ('private unknown room fully occupied',dict(room_preference='private',room_type='private',guests=[dict(name='A')]),[bed('P','female_only',mode='private')],[dict(bed_code='P-B1',room_code='P')]),
]
for name, extra, rows, blocks in cases:
    calls=[]
    def post(path,payload):
        assert path == '/availability-check'
        completed=subprocess.run(['node',str(Path(__file__).with_name('staff-probe.js')),'bridge'],input=json.dumps(dict(payload=payload,rows=rows,blocks=blocks)),text=True,capture_output=True,check=True)
        receipt=json.loads(completed.stdout)
        calls.append(dict(payload=deepcopy(payload),staff=receipt))
        return receipt
    with patch.object(plugin,'_post_bot',side_effect=post):
        result=json.loads(registry.tools['check_availability']['handler']({**base,**extra}))
    print(json.dumps(dict(case=name,**calls[0],adapted=result),ensure_ascii=False))

item=registry.tools['capture_booking_names']['schema']['parameters']['properties']['guests']['items']
assert 'gender_evidence' not in item['properties']
assert item['additionalProperties'] is False
for gender in ('male','female',None):
    guest={'name':'Alex',**({'explicit_gender':gender} if gender else {})}
    result=json.loads(registry.tools['capture_booking_names']['handler']({'guest_count':1,'guests':[guest]}))
    assert result['status'] != 'invalid_input', result
    print(json.dumps(dict(case='capture schema accepted',guest=guest,result=result)))
print(json.dumps(dict(case='capture schema',item=item)))
