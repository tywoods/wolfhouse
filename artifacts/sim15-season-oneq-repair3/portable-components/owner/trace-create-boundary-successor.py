# Successor-head driver: baseline success expectations updated; line-number tracing removed.
# Captured receipts unchanged. Compare with original distributed script.
"""Offline existing create-wrapper replay. NO Staff/network/business create.
Initial and later completed quote receipts come verbatim from the export.
The later receipt is explicitly a SUBSTITUTE for the unexported internal
refresh response; this does NOT reconstruct the live historical ledger.
Counterfactual removes only redundant request gender_preference, not roster
facts, room preference, or group_gender. Product source remains unchanged.
"""
from pathlib import Path
import json,sys
from copy import deepcopy
from unittest.mock import patch
from wolfhouse.test_first_yes_owner import FirstYesOwnerTests
from wolfhouse import accepted_quote as owner
import wolfhouse_staff_api as api
B=Path(__file__).resolve().parent
cases=json.loads((B/'trace-extracted.json').read_text())
TRACE_LINE=next(i for i,line in enumerate(Path(owner.__file__).read_text().splitlines(),1) if line.strip()=='if terms_unchanged:')
class OfflineDispatchReached(Exception):pass
def run(key,normalized,mutation=None):
 f=FirstYesOwnerTests();f.setUp();rows=[];events=cases[key]['events'];diagnostics=[]
 def request(e):
  p=deepcopy(e['data'])
  if normalized and p.get('gender_preference')=='male':
   assert p['guests'] and all(g.get('explicit_gender')=='male' for g in p['guests'])
   p.pop('gender_preference')
  return p
 def response(e):
  return next(x['data'] for x in events if x['line']>e['line'] and x['header'].startswith('RESULT `quote_booking`'))
 def snap():return owner._transaction(lambda s,i:deepcopy(s))
 def trace(frame,event,arg):
  if frame.f_code.co_filename==owner.__file__ and frame.f_code.co_name=='record' and event=='line' and frame.f_lineno==TRACE_LINE and not diagnostics:
   l=frame.f_locals;a={k:l['expected_plan'].get(k) for k in owner._FIELDS if k in l['expected_plan']};b={k:l['plan'].get(k) for k in a}
   diagnostics.append({'terms_unchanged':l['terms_unchanged'],'comparison_diff':{k:[a.get(k),b.get(k)] for k in a.keys()|b.keys() if a.get(k)!=b.get(k)}})
  return trace
 try:
  quotes=[e for e in events if 'REQUEST `quote_booking`' in e['header']]
  creation=next(e for e in events if 'REQUEST `create_booking_from_plan`' in e['header'])
  f.turn('export-quote','Quote accommodation only for those dates')
  for e in quotes:
   if e['line']>creation['line']:break
   p=owner.prepare_quote(request(e));owner.record_quote(p,response(e))
  rendered=owner.finalize_offer_response({'completed':True,'final_response':'offline render draft'})
  before=snap()
  f.turn('export-accept','Book it, my full name is supplied and I choose deposit')
  later=next(e for e in quotes if e['line']>creation['line'])
  receipt=deepcopy(response(later))
  # Deliberately changed synthetic authority: safety controls, not live receipts.
  if mutation=='price':
   receipt['total_cents']+=100
   receipt['offer_revision']['total_cents']+=100
  elif mutation=='bed':
   def swap(value):
    if isinstance(value,dict):return {k:swap(v) for k,v in value.items()}
    if isinstance(value,list):return [swap(v) for v in value]
    return 'R4-B6' if value=='R4-B5' else value
   receipt=swap(receipt)
  elif mutation=='person':
   receipt['offer_revision']['guest_bed_assignments'][0]['guest_name']='different person'
  elif mutation=='tenant':
   receipt['offer_revision']['client_slug']='other-tenant'

  refresh=api._quote_owner_handler('quote_booking',lambda p,**kw:json.dumps(receipt))
  def forbidden_create(*a,**kw):raise OfflineDispatchReached()
  wrapped=api._quote_owner_handler('create_booking_from_plan',forbidden_create)
  sys.settrace(trace)
  try:
   with patch.object(api,'quote_booking',refresh):
    outcome=json.loads(wrapped(request(creation)))
  except OfflineDispatchReached:
   outcome={'offline_dispatch_reached':True,'business_create_executed':False}
  finally:sys.settrace(None)
  result={'case':key,'mutation':mutation,'normalized_request_alias':normalized,'internal_receipt_provenance':'later exported quote, NOT captured internal reply','outcome':outcome,'diagnostics':diagnostics,'before':before,'after':snap(),'initial_quote':request(quotes[1]),'create_args':request(creation)}
  (B/f'trace-create-{key}-{normalized}-{mutation or "original"}.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
  print(json.dumps({k:result[k] for k in ['case','mutation','normalized_request_alias','outcome','diagnostics']},ensure_ascii=False))
  if mutation:
   assert outcome.get('offline_dispatch_reached') is not True
   assert outcome.get('success') is False
  elif normalized:
   assert outcome.get('offline_dispatch_reached') is True
  else:
   assert outcome.get('offline_dispatch_reached') is True, outcome
  return result
 finally:f.tearDown()
for key in ('B1','B4'):
 run(key,False);run(key,True)
for mutation in ('price','bed','person','tenant'):
 run('B1',True,mutation)
print('PASS eight source-wrapper controls; no business writes')
