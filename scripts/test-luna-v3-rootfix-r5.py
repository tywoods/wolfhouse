#!/usr/bin/env python3
"""R5 regressions distilled from CAP-PR1426-R4-HOLD counterexamples."""
import copy, importlib.util, json, pathlib, sys, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/lib'))
from luna_v3_grader_test_support import TEST_AUTHORITY, boundary_evidence
spec=importlib.util.spec_from_file_location('matrix',ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py')
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class RootFixR5(unittest.TestCase):
 def setUp(self):
  self.args={'action':'prepare','purpose':'quote','check_in':'2027-06-01','check_out':'2027-06-08','guests':[{'name':'Alex'},{'name':'Sam'}],'room':{'kind':'shared'},'package':{'per_guest':[{'guest':1,'code':'malibu'},{'guest':2,'code':'package_none'}]},'add_ons':[{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']}]}
  self.facts={'currency':'EUR','total_cents':12345,'deposit_cents':3000,'remaining_cents':9345,'check_in':'2027-06-01','check_out':'2027-06-08','package':{'per_guest':[{'guest':1,'guest_name':'Alex','code':'malibu'},{'guest':2,'guest_name':'Sam','code':'package_none'}]},'add_ons':self.args['add_ons'],'inclusions':[],'terms':[]}
  self.case={'expect':'mixed','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'intended_owner_outcome':{'expect':'mixed','facts':self.facts}}
  self.call={'id':'tc','function':{'name':'check_quote_book','arguments_parsed':self.args}}
  self.result={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,**self.facts,'call_id':'owner','_tool_call_id':'tc'}
  # Explicit offline owner body; the installed plugin creates all boundary fields.
  self.ex=boundary_evidence(self.call,self.result)
  self.good='2027-06-01 to 2027-06-08: Alex has the malibu package and 1 board rental on 2027-06-02; Sam has the package_none package. Total 123.45 EUR, deposit 30.00 EUR, remaining 93.45 EUR. Availability is not guaranteed; I have not booked or held anything.'
 def score(self,text,ex=None): return m.semantic_score(self.case,text,[self.call],[self.result],self.ex if ex is None else ex,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity']
 def test_authority_projection_and_complete_response_reconciliation(self):
  self.assertTrue(self.score(self.good))
  for mutation in ('missing_projection','authority_changed','missing_fact','call_disagreement','original_disagreement'):
   ex=copy.deepcopy(self.ex)
   if mutation=='missing_projection': ex.pop('public_request')
   elif mutation=='authority_changed': ex['request']['tenant_id']='other'
   elif mutation=='missing_fact': ex['raw_response_hex']=json.dumps({'ok':True}).encode().hex()
   elif mutation=='call_disagreement': ex['raw_response_hex']=json.dumps({**self.result,'call_id':'wrong'}).encode().hex()
   else: ex['original_response_hex']=json.dumps({'ok':False,'code':'old'}).encode().hex()
   self.assertFalse(self.score(self.good,ex),mutation)
 def test_typed_roles_reject_cap_counterexamples(self):
  self.assertTrue(self.score(self.good))
  bad=[self.good+' Your reservation is confirmed.',self.good.replace('Alex has the malibu package','Alex does not have the malibu package'),self.good.replace('Alex has the malibu package','Alex has the package_none package').replace('Sam has the package_none package','Sam has the malibu package'),self.good+' Jamie has 1 board rental.',self.good+' Alex has 9 board rentals.',self.good+' Total 9999 JPY.']
  for text in bad: self.assertFalse(self.score(text),text)
 def test_evidence_is_mandatory_even_for_unit_calls(self):
  self.assertFalse(m.semantic_score(self.case,self.good,[self.call],[self.result],None,expected_authority=dict(TEST_AUTHORITY))['fidelity'])
 def test_operation_equivalence_preserves_purpose_payment_and_beds(self):
  control={k:copy.deepcopy(v) for k,v in self.args.items() if k not in ('action','purpose')}
  self.assertTrue(m.control_matches_prepare(control,self.args))
  self.assertFalse(m.control_matches_prepare(control,{**self.args,'purpose':'offer','payment':{'arrangement':'together'}}))
  changed=copy.deepcopy(self.args); changed['room']['beds']=['UNASKED']; self.assertFalse(m.control_matches_prepare(control,changed))
 def test_lesson_coverage_excludes_wellness(self):
  choices=[{'code':'yoga','kind':'service','active':True,'metadata':{'service_type':'yoga'}},{'code':'surf','kind':'service','active':True,'metadata':{'service_type':'lesson'}}]
  self.assertFalse(m._is_lesson_code('yoga',choices)); self.assertTrue(m._is_lesson_code('surf',choices))

if __name__=='__main__': unittest.main(verbosity=2)
