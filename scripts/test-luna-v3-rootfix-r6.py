#!/usr/bin/env python3
"""SAFE OFFLINE R6 cross-kind regressions for CAP findings #3, #4 and #6.

MATRIX_SOURCE may point at an exact-base copy for the mechanical red replay.
Every passing semantic control carries the same public/wire/authority/status/body
fields emitted by the installed producer; evidence-free scoring is never positive.
"""
import copy, importlib.util, json, os, pathlib, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
SOURCE=pathlib.Path(os.environ.get('MATRIX_SOURCE',ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py'))
spec=importlib.util.spec_from_file_location('matrix_r6_subject',SOURCE)
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
from luna_v3_grader_test_support import TEST_AUTHORITY, boundary_evidence, produce
KINDS=('accommodation','package','rental','lesson_a','lesson_b','mixed','multi_guest')

def specimen(kind):
 guests=[{'name':'Alex'},{'name':'Sam'}] if kind=='multi_guest' else [{'name':'Alex'}]
 package={'per_guest':[{'guest':1,'code':'malibu'},{'guest':2,'code':'package_none'}]} if kind=='multi_guest' else {'code':'malibu' if kind in ('package','mixed') else 'package_none'}
 fact_package={'per_guest':[{'guest':1,'guest_name':'Alex','code':'malibu'},{'guest':2,'guest_name':'Sam','code':'package_none'}]} if kind=='multi_guest' else copy.deepcopy(package)
 addons=[]
 if kind=='rental': addons=[{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']}]
 if kind=='lesson_a': addons=[{'code':'group_lesson','quantity':1,'dates':['2027-06-03'],'people':['Alex']}]
 if kind=='lesson_b': addons=[{'code':'private_lesson','quantity':1,'dates':['2027-06-04'],'people':['Alex']}]
 if kind=='mixed': addons=[{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']},{'code':'group_lesson','quantity':1,'dates':['2027-06-03'],'people':['Alex']}]
 if kind=='multi_guest': addons=[{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']},{'code':'private_lesson','quantity':1,'dates':['2027-06-04'],'people':['Sam']}]
 args={'action':'prepare','purpose':'quote','check_in':'2027-06-01','check_out':'2027-06-08','guests':guests,'room':{'kind':'shared'},'package':package,'add_ons':addons}
 facts={'currency':'EUR','total_cents':12345,'deposit_cents':3000,'remaining_cents':9345,'check_in':args['check_in'],'check_out':args['check_out'],'package':fact_package,'add_ons':copy.deepcopy(addons),'inclusions':[],'terms':[]}
 case={'expect':'mixed' if kind in ('mixed','multi_guest') else 'quote','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'intended_owner_outcome':{'expect':'mixed' if kind in ('mixed','multi_guest') else 'quote','facts':facts}}
 call={'id':'tc-'+kind,'function':{'name':'check_quote_book','arguments_parsed':copy.deepcopy(args)}}
 result={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,**copy.deepcopy(facts),'call_id':'owner-'+kind,'_tool_call_id':call['id']}
 product=[]
 if 'per_guest' in package:
  product=['Alex has the malibu package','Sam has the package_none package']
 else: product=[f"the {package['code']} package"]
 for a in addons: product.append(f"{', '.join(a['people'])} has {a['quantity']} {a['code']} {'lesson' if 'lesson' in a['code'] else 'rental'} on {', '.join(a['dates'])}")
 reply='; '.join([f"2027-06-01 to 2027-06-08: {product[0]}",*product[1:],"Total EUR 123.45, deposit EUR 30.00, remaining EUR 93.45","Availability is not guaranteed; I have not booked or held anything."])
 exchange=boundary_evidence(call,result,event_id='evt-'+kind)
 return args,facts,case,call,result,reply,exchange

class RootFixR6(unittest.TestCase):
 def test_cap3_all_kinds_typed_truth_and_mandatory_producer_boundary(self):
  for kind in KINDS:
   with self.subTest(kind=kind,control='producer-positive'):
    args,facts,case,call,result,good,ex=specimen(kind)
    self.assertTrue(m.semantic_score(case,good,[call],[result],ex,current_event_id=ex['event_id'],expected_authority=dict(TEST_AUTHORITY))['fidelity'])
    self.assertFalse(m.semantic_score(case,good,[call],[result],None,current_event_id=ex['event_id'],expected_authority=dict(TEST_AUTHORITY))['fidelity'])
   negated=good.replace(' has the ',' does not have the ',1) if kind=='multi_guest' else good.replace('the '+('malibu' if kind in ('package','mixed') else 'package_none')+' package','the '+('malibu' if kind in ('package','mixed') else 'package_none')+' package is not selected',1)
   bad=(good+' Your reservation is confirmed.',good+' Total JPY 9999.00.',negated,good+' Jamie has 9 board rentals.')
   for n,text in enumerate(bad):
    with self.subTest(kind=kind,counterexample=n):
     self.assertFalse(m.semantic_score(case,text,[call],[result],ex,current_event_id=ex['event_id'],expected_authority=dict(TEST_AUTHORITY))['fidelity'])
 def test_cap4_all_kinds_complete_operation_equivalence(self):
  choices=[{'code':'package_none','kind':'accommodation','active':True},{'code':'malibu','kind':'package','active':True},{'code':'board','kind':'rental','active':True},{'code':'group_lesson','kind':'service','active':True},{'code':'private_lesson','kind':'service','active':True}]
  for kind in KINDS:
   args,*_=specimen(kind); control={k:copy.deepcopy(v) for k,v in args.items() if k not in ('action','purpose')}
   with self.subTest(kind=kind,control='positive'): self.assertTrue(m.control_matches_prepare(control,args,choices))
   offer=copy.deepcopy(args); offer['purpose']='offer'; offer['payment']={'arrangement':'together'}
   beds=copy.deepcopy(args); beds['room']['beds']=['UNASKED']
   for label,value in (('purpose-payment',offer),('bed-intent',beds)):
    with self.subTest(kind=kind,counterexample=label): self.assertFalse(m.control_matches_prepare(control,value,choices))
 def test_cap6_all_kinds_non_json_fault_preserves_transport_semantics(self):
  for kind in KINDS:
   args,_,_,call,_,_,ex=specimen(kind)
   call,result,fault=produce(args,{'ok':False,'classification':'transport'},status=500,event_id=ex['event_id'],fault='non-json',call_id=call['id'])
   with self.subTest(kind=kind,control='producer-shaped-non-json'):
    self.assertTrue(m.semantic_score({'expect':'uncertain','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'fault':'non-json'},'I cannot verify this quote.',[call],[result],fault,current_event_id=ex['event_id'],expected_authority=dict(TEST_AUTHORITY))['fidelity'])
   corrupted={**fault,'raw_response_hex':json.dumps({'ok':True}).encode().hex()}
   with self.subTest(kind=kind,counterexample='unrelated-json-substitution'):
    self.assertFalse(m.semantic_score({'expect':'uncertain','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'fault':'non-json'},'I cannot verify this quote.',[call],[result],corrupted,current_event_id=ex['event_id'],expected_authority=dict(TEST_AUTHORITY))['fidelity'])

if __name__=='__main__': unittest.main(verbosity=2)
