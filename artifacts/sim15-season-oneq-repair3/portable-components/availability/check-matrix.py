"""Assert requirement outcomes from real registered->JS receipts; nonzero = CHANGES."""
import json
from pathlib import Path
import sys

folder = Path(__file__).parent
base = {r['case']: r for r in map(json.loads, (folder/'matrix-base.jsonl').read_text().splitlines()) if 'adapted' in r}
head = {r['case']: r for r in map(json.loads, (folder/'matrix-head.jsonl').read_text().splitlines()) if 'adapted' in r}
checks = []
def check(name, ok, detail):
    checks.append(bool(ok))
    print(('PASS ' if ok else 'FAIL ') + name + ' ' + json.dumps(detail, ensure_ascii=False))

for name, row in head.items():
    result = row['adapted']
    count = row['payload']['guest_count']
    expected = 'available'
    if name in {'unknown requested female', 'male requested female conflict', 'partial female roster does not gender companion', 'mixed explicit roster rejects female dorm', 'no name inference explicit preference only'} or 'roster' in name and 'only female_only' in name:
        expected = 'eligibility_required'
    if name in {'optional private occupied sibling', 'female R6 one bed two occupants', 'unknown genuinely empty inventory', 'private unknown room fully occupied'} or name.endswith('explicit gendered genuinely full'):
        expected = 'unavailable'
    problems = []
    if result['availability_status'] != expected:
        problems.append(f'expected status {expected}')
    if expected == 'available':
        if len(result['selected_bed_codes']) != count:
            problems.append('expected complete selected beds')
        if not result['selected_room_code']:
            problems.append('expected authoritative selected room')
        if row['payload'].get('room_preference') == 'mixed' and name.startswith(('male ', 'female ')) and result['selected_room_types'] != ['mixed']:
            problems.append('explicit mixed must remain mixed')
    else:
        if result['selected_bed_codes']:
            problems.append('ineligible/full request must not select beds')
    if result['girls_room_available'] != result['room_options']['girls_room_available']:
        problems.append('root and nested girls flags differ')
    if result.get('needs_human') or result.get('staff_review_needed'):
        problems.append('room eligibility/capacity must not force handoff')
    before = base[name]['adapted']
    check(name, not problems, dict(problems=problems, head_status=result['availability_status'], head_beds=result['selected_bed_codes'], head_room=result['selected_room_code'], head_blockers=result['blockers'], base_status=before['availability_status'], base_beds=before['selected_bed_codes']))

for name in ['female R6 one bed two occupants', 'female R6 two beds two occupants']:
    expected = 'two beds' in name
    result = head[name]['adapted']
    check('R6 female shared actual bed capacity: '+name, result['girls_room_available'] is expected, dict(girls=result['girls_room_available'], nested=result['room_options'], baseline=base[name]['adapted']['room_options']))

print(json.dumps(dict(total=len(checks), passed=sum(checks), failed=len(checks)-sum(checks), verdict='PASS' if all(checks) else 'CHANGES')))
sys.exit(0 if all(checks) else 1)
