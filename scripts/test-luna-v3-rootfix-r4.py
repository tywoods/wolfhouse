#!/usr/bin/env python3
"""Offline regressions for SKIP-V3-PR1426-ROOTFIX-R4-20261026T0352."""
import copy, hashlib, importlib.util, json, pathlib, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
P=ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py'
spec=importlib.util.spec_from_file_location('r4matrix',P); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
from luna_v3_grader_test_support import TEST_AUTHORITY, boundary_evidence, produce

class RootFixR4(unittest.TestCase):
 def setUp(self):
  self.call={'id':'tc','function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}}
  self.facts={'currency':'EUR','total_cents':12345,'deposit_cents':3000,'remaining_cents':9345,'check_in':'2027-06-01','check_out':'2027-06-08','package':'malibu','add_ons':[],'inclusions':[],'terms':[]}
  self.case={'expect':'quote','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'intended_owner_outcome':{'expect':'quote','facts':self.facts}}
  self.result={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,**self.facts,'call_id':'owner','_tool_call_id':'tc'}
  self.exchange=boundary_evidence(self.call,self.result,event_id='evt')
  self.good='2027-06-01 to 2027-06-08: Malibu package. Total EUR 123.45, deposit EUR 30.00, remaining EUR 93.45. I have not booked or held anything.'
 def score(self,text,exchange=True,event='evt'):
  return m.semantic_score(self.case,text,[self.call],[self.result],self.exchange if exchange else None,current_event_id=event,expected_authority=dict(TEST_AUTHORITY))['fidelity']
 def test_truthful_no_booking_passes_and_claim_contradictions_fail(self):
  self.assertTrue(self.score(self.good))
  bad=(self.good+' No changes are needed, your reservation is confirmed.',
       self.good+' Your stay is secured and the charge went through.',
       self.good.replace('Total EUR 123.45','Total EUR 30.00'),
       self.good.replace('Total EUR 123.45','Total EUR 123.45 is incorrect'),
       self.good+' Total CAD 9999.')
  for text in bad: self.assertFalse(self.score(text),text)
 def test_boundary_is_unique_current_coherent_and_bytes_agree(self):
  self.assertTrue(self.score(self.good))
  for ex,event in ((None,'evt'),(self.exchange,None),({**self.exchange,'tool':'get_booking'},'evt'),({**self.exchange,'status':503},'evt'),({**self.exchange,'request':{'action':'book'}},'evt'),({**self.exchange,'raw_response_hex':'00'},'evt')):
   old=self.exchange; self.exchange=ex
   try: self.assertFalse(self.score(self.good,exchange=ex is not None,event=event))
   finally: self.exchange=old
 def test_person_allocations_are_exact_and_polarity_aware(self):
  facts=copy.deepcopy(self.facts); facts['package']={'per_guest':[{'guest':1,'name':'Alex','code':'malibu'},{'guest':2,'name':'Sam','code':'package_none'}]}; facts['add_ons']=[{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']}]
  case={'expect':'mixed','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'intended_owner_outcome':{'expect':'mixed','facts':facts}}
  result={**self.result,**facts}; good='2027-06-01 to 2027-06-08: Alex has the malibu package and 1 board rental on 2027-06-02; Sam has the package_none package. Total EUR 123.45, deposit EUR 30.00, remaining EUR 93.45.'
  for bad in (good.replace('Alex has the malibu package','Alex has the package_none package').replace('Sam has the package_none package','Sam has the malibu package'),good+' Sam also gets 1 board rental on 2027-06-02.',good.replace('Alex has the malibu','Alex does not have the malibu')):
   self.assertFalse(m.semantic_score(case,bad,[self.call],[result],None,expected_authority=dict(TEST_AUTHORITY))['fidelity'],bad)
 def test_fault_rejects_affirmations_and_inconsistent_boundary(self):
  case={'expect':'uncertain','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'fault':'timeout'}; result={'ok':False,'classification':'transport','call_id':'owner','_tool_call_id':'tc'}
  self.call,result,ex=produce(self.call['function']['arguments_parsed'],{'ok':True},event_id='evt',fault='timeout',call_id='tc')
  self.assertTrue(m.semantic_score(case,'I am unable to confirm the quote right now. Please try again later.',[self.call],[result],ex,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  for bad in ('I cannot verify this quote, but your reservation is confirmed.','I cannot verify this quote, but your payment was received.','I can verify your reservation is secured.','I cannot verify because of an internal database error.'):
   self.assertFalse(m.semantic_score(case,bad,[self.call],[result],ex,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'],bad)

 def _assembled(self,category,package,addons=(),guests=('Alex',),reply=None):
  """Build the complete event shape consumed by score_events, not a direct seam."""
  event_id='evt-'+category; call_id='tool-'+category; owner_id='owner-'+category
  request={'action':'prepare','purpose':'quote','check_in':'2027-06-01','check_out':'2027-06-08','guests':[{'name':name} for name in guests],'room':{'kind':'shared'},'package':package,'add_ons':list(addons)}
  facts=copy.deepcopy(self.facts); facts['package']=package; facts['add_ons']=list(addons)
  result={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,**facts,'call_id':owner_id}
  raw=json.dumps(result,separators=(',',':')).encode().hex()
  call={'id':call_id,'function':{'name':'check_quote_book','arguments_parsed':copy.deepcopy(request)}}
  thread='r4-assembled-'+category
  session='luna-v3:'+hashlib.sha256(thread.encode()).hexdigest()[:24]
  exchange=boundary_evidence(call,result,event_id=event_id,session=session)
  package_text=(f"{package['code']} package" if 'code' in package else '; '.join(f"{x.get('name',x.get('guest_name'))} has the {x['code']} package" for x in package['per_guest']))
  addon_text=''.join(f"; {', '.join(a.get('people',[]))+' has ' if a.get('people') else ''}{a['quantity']} {a['code']} rental/lesson on {', '.join(a['dates'])}" for a in addons)
  good=reply or f"2027-06-01 to 2027-06-08: {package_text}{addon_text}. Total EUR 123.45, deposit EUR 30.00, remaining EUR 93.45. I have not booked or held anything."
  expected='mixed' if addons or len(guests)>1 else 'quote'
  case={'id':category,'expect':expected,'prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'control':copy.deepcopy(request),'intended_owner_outcome':{'expect':expected,'facts':facts}}
  messages=[{'role':'user','content':'assembled '+category},{'role':'assistant','tool_calls':[call]},{'role':'tool','tool_call_id':call_id,'content_parsed':result}]
  event={'event_id':event_id,'request':{'thread':thread},'response':{'reply_text':good,'harness_trace':{'messages':messages,'staff_http_exchanges':[exchange]}}}
  return case,event,good

 def test_score_events_assembled_all_seven_categories_and_cap_contradictions(self):
  fixtures=[
   self._assembled('accommodation',{'code':'package_none'}),
   self._assembled('package',{'code':'malibu'}),
   self._assembled('rental',{'code':'package_none'},[{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']}]),
   self._assembled('lesson-a',{'code':'package_none'},[{'code':'group_lesson','quantity':1,'dates':['2027-06-02'],'people':['Alex']}]),
   self._assembled('lesson-b',{'code':'package_none'},[{'code':'private_lesson','quantity':1,'dates':['2027-06-03'],'people':['Alex']}]),
   self._assembled('mixed',{'code':'malibu'},[{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']},{'code':'group_lesson','quantity':1,'dates':['2027-06-03'],'people':['Alex']}]),
   self._assembled('multi-guest',{'per_guest':[{'guest':1,'guest_name':'Alex','code':'malibu'},{'guest':2,'guest_name':'Sam','code':'package_none'}]},[{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']}],('Alex','Sam'))]
  for case,event,good in fixtures:
   with self.subTest(category=case['id'],control='positive'):
    row=m.score_events(case,[event])[0]; self.assertTrue(row['semantic']['fidelity']); self.assertTrue(row['owner_control_matches'])
   contradictions=[good+' Your reservation is confirmed.',good.replace('Total EUR 123.45','Total EUR 30.00')]
   if case['id']=='multi-guest': contradictions.append(good.replace('Alex has the malibu package','Alex has the package_none package').replace('Sam has the package_none package','Sam has the malibu package'))
   for bad in contradictions:
    broken=copy.deepcopy(event); broken['response']['reply_text']=bad
    with self.subTest(category=case['id'],control='claim'): self.assertFalse(m.score_events(case,[broken])[0]['semantic']['fidelity'])
   for kind in ('missing-event','request-mismatch','http-503','error-bytes','duplicate-exchange'):
    broken=copy.deepcopy(event); trace=broken['response']['harness_trace']; ex=trace['staff_http_exchanges'][0]
    if kind=='missing-event': broken['event_id']=''
    elif kind=='request-mismatch': ex['request']['action']='book'
    elif kind=='http-503': ex['status']=503
    elif kind=='error-bytes': ex['raw_response_hex']=json.dumps({'ok':False,'error':'HTTP 503'}).encode().hex()
    else: trace['staff_http_exchanges'].append(copy.deepcopy(ex))
    with self.subTest(category=case['id'],control=kind): self.assertFalse(m.score_events(case,[broken])[0]['semantic']['fidelity'])

if __name__=='__main__': unittest.main(verbosity=2)
