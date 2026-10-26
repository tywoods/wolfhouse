#!/usr/bin/env python3
"""Offline regressions for SKIP-V3-PR1426-ROOTFIX-R4-20261026T0352."""
import copy, importlib.util, json, pathlib, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
P=ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py'
spec=importlib.util.spec_from_file_location('r4matrix',P); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class RootFixR4(unittest.TestCase):
 def setUp(self):
  self.call={'id':'tc','function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}}
  self.facts={'currency':'EUR','total_cents':12345,'deposit_cents':3000,'remaining_cents':9345,'check_in':'2027-06-01','check_out':'2027-06-08','package':'malibu','add_ons':[],'inclusions':[],'terms':[]}
  self.case={'expect':'quote','prepare_required':True,'intended_owner_outcome':{'expect':'quote','facts':self.facts}}
  self.result={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,**self.facts,'call_id':'owner','_tool_call_id':'tc'}
  self.exchange={'tool':'check_quote_book','call_id':'owner','event_id':'evt','status':200,'original_status':200,'request':{'action':'prepare'},'original_response_hex':json.dumps(self.result,separators=(',',':')).encode().hex(),'raw_response_hex':json.dumps(self.result,separators=(',',':')).encode().hex()}
  self.good='2027-06-01 to 2027-06-08: Malibu package. Total EUR 123.45, deposit EUR 30.00, remaining EUR 93.45. I have not booked or held anything.'
 def score(self,text,exchange=True,event='evt'):
  return m.semantic_score(self.case,text,[self.call],[self.result],self.exchange if exchange else None,current_event_id=event)['fidelity']
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
  case={'expect':'mixed','prepare_required':True,'intended_owner_outcome':{'expect':'mixed','facts':facts}}
  result={**self.result,**facts}; good='2027-06-01 to 2027-06-08: Alex has the malibu package and 1 board rental on 2027-06-02; Sam has the package_none package. Total EUR 123.45, deposit EUR 30.00, remaining EUR 93.45.'
  for bad in (good.replace('Alex has the malibu package','Alex has the package_none package').replace('Sam has the package_none package','Sam has the malibu package'),good+' Sam also gets 1 board rental on 2027-06-02.',good.replace('Alex has the malibu','Alex does not have the malibu')):
   self.assertFalse(m.semantic_score(case,bad,[self.call],[result],None)['fidelity'],bad)
 def test_fault_rejects_affirmations_and_inconsistent_boundary(self):
  case={'expect':'uncertain','prepare_required':True,'fault':'timeout'}; result={'ok':False,'classification':'transport','call_id':'owner','_tool_call_id':'tc'}
  ex={**self.exchange,'status':503,'original_status':200,'fault_requested':'timeout','fault_applied':'timeout','fault_observed':'timeout_exception_raised','exception_type':'TimeoutError','raw_response_hex':self.exchange['original_response_hex']}
  self.assertTrue(m.semantic_score(case,'I am unable to confirm the quote right now. Please try again later.',[self.call],[result],ex,current_event_id='evt')['fidelity'])
  for bad in ('I cannot verify this quote, but your reservation is confirmed.','I cannot verify this quote, but your payment was received.','I can verify your reservation is secured.','I cannot verify because of an internal database error.'):
   self.assertFalse(m.semantic_score(case,bad,[self.call],[result],ex,current_event_id='evt')['fidelity'],bad)

if __name__=='__main__': unittest.main(verbosity=2)
