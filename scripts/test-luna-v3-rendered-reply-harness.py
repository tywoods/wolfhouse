#!/usr/bin/env python3
"""Offline executable gates for the Cap runner (never substitutes a live run)."""
import ast, importlib.util, pathlib, unittest
import copy
ROOT=pathlib.Path(__file__).resolve().parents[1]
RUNNER=ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py'
ROUTE=ROOT/'docker/hermes-luna-v3/runtime/simulator_route.py'
PLUGIN=ROOT/'docker/hermes-luna-v3/plugins/luna_v3_staff_api/__init__.py'

def owner_fixture():
 base={'check_in':'2027-06-01','check_out':'2027-06-08','guests':['Alex'],'room':{'kind':'shared'},'package':'package_none','add_ons':[]}
 def case(category,control=None,expect='quote',**extra):
  return {'id':category.replace(':','-'),'category':category,'prompt':'Owner authored prompt for '+category,
   'control':copy.deepcopy(control if control is not None else base),'intended_owner_outcome':{'expect':expect},**extra}
 cases=[case('accommodation'),case('package',{**base,'package':'malibu'}),
  case('rental',{**base,'add_ons':[{'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-01']}]}) ,
  case('service:lesson_a',{**base,'add_ons':[{'code':'group_lesson','quantity':1,'people':['Alex'],'dates':['2027-06-01']}]}) ,
  case('service:lesson_b',{**base,'add_ons':[{'code':'private_lesson','quantity':1,'people':['Alex'],'dates':['2027-06-01']}]})]
 mixed={**base,'package':'malibu','add_ons':[{'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-01']},{'code':'group_lesson','quantity':1,'people':['Alex'],'dates':['2027-06-01']}]}
 cases.append(case('mixed',mixed,expect='mixed')); cases[-1]['intended_owner_outcome']['compatibility_proven']=True
 group={**base,'guests':['Alex','Sam'],'package':{'per_guest':[{'guest':1,'name':'malibu'},{'guest':2,'name':'package_none'}]},'add_ons':[{'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-01']},{'code':'group_lesson','quantity':1,'people':['Sam'],'dates':['2027-06-02']}]}
 cases += [case('multi_guest',group),case('continuation',{**base,'check_out':'2027-06-02'},expect='refusal',corrected_control=base,correction_prompt='Use the owner-proven dates 2027-06-01 to 2027-06-08.'),case('clarification',None,expect='clarification'),case('fault',base,expect='uncertain',fault='timeout')]
 cases[-2].pop('control')
 return {'schema':'luna-matrix-fixture/v1','tenant':'wolfhouse-somo','owner_provenance':{'authority':'staff-owner','fixture_id':'fixture-1','approved_by':'owner@example.test','approved_at':'2026-10-26T00:00:00Z'},'capability_revision':'r','cases':cases}
class Gates(unittest.TestCase):
 @classmethod
 def setUpClass(cls):
  spec=importlib.util.spec_from_file_location('matrix_runner',RUNNER); cls.runner=importlib.util.module_from_spec(spec); spec.loader.exec_module(cls.runner)
 def test_sources_parse(self):
  for p in (RUNNER,ROUTE,PLUGIN): ast.parse(p.read_text())
 def test_no_caller_inventory_or_retry(self):
  s=RUNNER.read_text(); self.assertNotIn('LUNA_MATRIX_INVENTORY',s); self.assertIn('"no_retries":True',s); self.assertIn('REPS=3',s)
 def test_artifact_and_verdict_contract(self):
  s=RUNNER.read_text()
  for x in ('manifest.json','results.json','SHA256SUMS','reply_equals_final_response','staff_fields_rendered_exactly','no_hold_or_booking_for_quote','one_prepare_per_turn','first_refusal_then_success'): self.assertIn(x,s)
 def test_harness_gates_and_fault_isolation(self):
  route=ROUTE.read_text(); plugin=PLUGIN.read_text()
  self.assertIn('_harness_trace_allowed(request)',route); self.assertIn('trace_allowed else ""',route)
  self.assertIn('A genuine authenticated Staff response has crossed the boundary',plugin)
  for x in ('non-json','malformed','timeout'): self.assertIn(x,route); self.assertIn(x,plugin)
 def test_continuation_is_opaque_bound_and_one_use(self):
  s=ROUTE.read_text(); self.assertIn('token_urlsafe(32)',s); self.assertIn('_CONTINUATIONS.pop',s); self.assertIn('captured["phone"] != phone',s)
 def test_pins_and_preflight(self):
  s=ROUTE.read_text()
  for x in ('image_digest','base_image_digest','instruction_sha256','plugin_sha256','contract_sha256','fallback_possible'): self.assertIn(x,s)
 def test_state_receipts_and_semantic_scoring_fail_closed(self):
  good={'ok':True,'schema':'luna-v3-test-state/v1','authenticated':True,'tenant':'wolfhouse-somo','thread':'+346****0001','booking_count':0,'hold_count':0,'payment_count':0,'external_send_count':0,'staff_alert_count':0}
  self.assertTrue(self.runner.valid_state_receipt(good,'+346****0001'))
  for key in tuple(good):
   bad=dict(good); bad.pop(key); self.assertFalse(self.runner.valid_state_receipt(bad,'+346****0001'),key)
  score=self.runner.semantic_score({'prepare_required':False,'expect':'clarification'},'Which dates?',[],[],None)
  self.assertEqual({'clarification':True,'progress':True,'fidelity':None},score)
 def test_live_verdict_uses_semantic_score_and_counts_prepare_per_event(self):
  events=[
   {'event_id':'evt-refusal','response':{'reply_text':'minimum stay; choose seven nights','harness_trace':{'messages':[
    {'role':'assistant','tool_calls':[{'function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}}]},
    {'role':'tool','content_parsed':{'ok':False,'reason':'minimum stay','next_step':'choose seven nights'}}]}}},
   {'event_id':'evt-corrected','response':{'reply_text':'verified total 7000','harness_trace':{'messages':[
    {'role':'assistant','tool_calls':[{'function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}}]},
    {'role':'tool','content_parsed':{'ok':True,'total_cents':7000}}]}}},
  ]
  scores=self.runner.score_events({'prepare_required':True,'expect':'quote','continuation':True},events)
  self.assertEqual([1,1],[row['prepare_count'] for row in scores])
  self.assertTrue(all(row['semantic']['progress'] for row in scores))
  events[1]['response']['harness_trace']['messages'][0]['tool_calls'].append({'function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}})
  self.assertFalse(self.runner.score_events({'prepare_required':True,'expect':'quote','continuation':True},events)[1]['semantic']['progress'])
  source=RUNNER.read_text(); self.assertIn('"semantic_score":event_scores',source); self.assertIn('all_semantic_scores_pass',source)
 def test_complete_kind_controls_and_continuation_source(self):
  fixture=owner_fixture()
  choices=[
   {'kind':'accommodation','code':'package_none','label':'Stay','active':True,'requirements':{}},
   {'kind':'package','code':'malibu','label':'Malibu','active':True,'requirements':{}},
   {'kind':'rental','code':'board','label':'Board','active':True,'requirements':{'dates':True,'quantity':True}},
   {'kind':'service','code':'yoga','label':'Yoga','active':True,'requirements':{'dates':True,'participants':True}},
   {'kind':'service','code':'group_lesson','label':'Group lesson','product':'group_lesson','active':True,'requirements':{'dates':True,'participants':True}},
   {'kind':'service','code':'private_lesson','label':'Private lesson','product':'private_lesson','active':True,'requirements':{'dates':True,'participants':True}},
  ]
  cases=self.runner.make_cases({'ok':True,'revision':'r','choices':choices},fixture)
  self.assertFalse(any(c['expect']=='n/a' for c in cases)); self.assertTrue(all(c.get('control') for c in cases if c['prepare_required']))
  ids={c['id'] for c in cases}
  for expected in ('accommodation','package','rental','service-lesson_a','service-lesson_b','mixed','multi_guest'):
   self.assertIn(expected,ids)
  mixed=next(c for c in cases if c['id']=='mixed')['control']; group=next(c for c in cases if c['id']=='multi_guest')['control']
  self.assertEqual(2,len(mixed['add_ons'])); self.assertEqual(['Alex','Sam'],group['guests'])
  for case in cases:
   if case['prepare_required']: self.assertTrue(self.runner.validate_control(case,choices),case['id'])
  prepare={'action':'prepare','purpose':'quote','check_in':'2027-06-01','check_out':'2027-06-08','guests':[{'name':'Alex'}],'room':{'kind':'shared'},'package':{'name':'malibu'},'add_ons':[{'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-01']},{'code':'group_lesson','quantity':1,'people':['Alex'],'dates':['2027-06-01']}]}
  self.assertTrue(self.runner.control_matches_prepare(mixed,prepare))
  prepare['check_out']='2027-06-09'; self.assertFalse(self.runner.control_matches_prepare(mixed,prepare))
  self.assertIn('control_matches_prepare',RUNNER.read_text())
  s=RUNNER.read_text(); self.assertNotIn('Quote Cap Week',s); self.assertIn('event_receipts',s); self.assertIn('refusal_correction',s)
 def test_missing_required_kinds_and_two_lessons_fail_closed(self):
  fixture=owner_fixture()
  base=[{'kind':k,'code':k,'label':k,'active':True,'requirements':{}} for k in ('accommodation','package','rental','service')]
  with self.assertRaisesRegex(SystemExit,'owner-invalid complete control'):
   self.runner.make_cases({'ok':True,'revision':'r','choices':base},fixture)
 def test_owner_fixture_schema_fails_closed_and_is_deterministic(self):
  choices=[{'kind':'accommodation','code':'package_none','active':True,'requirements':{}},{'kind':'package','code':'malibu','active':True,'requirements':{}},{'kind':'rental','code':'board','active':True,'requirements':{'dates':True,'participants':True}},{'kind':'service','code':'group_lesson','active':True,'requirements':{'dates':True,'participants':True}},{'kind':'service','code':'private_lesson','active':True,'requirements':{'dates':True,'participants':True}}]
  snapshot={'ok':True,'revision':'r','choices':choices}; fixture=owner_fixture()
  self.assertEqual(self.runner.make_cases(snapshot,fixture),self.runner.make_cases(snapshot,copy.deepcopy(fixture)))
  mutations=[]
  for key in ('schema','owner_provenance','capability_revision','cases'):
   bad=copy.deepcopy(fixture); bad.pop(key); mutations.append(bad)
  bad=copy.deepcopy(fixture); bad['capability_revision']='other'; mutations.append(bad)
  bad=copy.deepcopy(fixture); bad['cases'][0]['control'].pop('check_out'); mutations.append(bad)
  bad=copy.deepcopy(fixture); bad['cases'][1]['control']['package']='inactive'; mutations.append(bad)
  bad=copy.deepcopy(fixture); bad['cases']=bad['cases'][:-1]; mutations.append(bad)
  bad=copy.deepcopy(fixture); next(c for c in bad['cases'] if c['category']=='mixed')['intended_owner_outcome'].pop('compatibility_proven'); mutations.append(bad)
  bad=copy.deepcopy(fixture); next(c for c in bad['cases'] if c['category']=='continuation').pop('corrected_control'); mutations.append(bad)
  for bad in mutations:
   with self.assertRaises(SystemExit): self.runner.make_cases(snapshot,bad)
 def test_fault_status_exception_and_real_timeout_are_verdict_inputs(self):
  source=RUNNER.read_text(); route=ROUTE.read_text(); plugin=PLUGIN.read_text()
  for fault in ('http-422','exception','timeout'):
   self.assertIn(fault,source); self.assertIn(fault,route); self.assertIn(fault,plugin)
  self.assertIn('exception_type',source); self.assertIn('status',source); self.assertIn('TimeoutError',plugin)
 def test_continuation_keeps_both_raw_and_event_receipts_with_linkage(self):
  source=RUNNER.read_text()
  for marker in ('raw_file','inbound_event_id','refusal_event_id','corrected_event_id','new_prepare_event_id'):
   self.assertIn(marker,source)
 def test_rootfix_counterexamples_fail_closed(self):
  quote={'ok':True,'state':'quote','held':False,'booked':False,'quote':{'totalCents':12345,'currency':'EUR'},'reason':'authoritative_quote_ready'}
  case={'expect':'quote','prepare_required':True}
  self.assertFalse(self.runner.semantic_score(case,'EUR 999.99, fully paid and confirmed',[{}],[quote],None)['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,'db_error; wait_for_verified_result',[{}],[{'ok':False,'reason':'db_error','classification':'internal'}],None)['fidelity'])
  good='authoritative_quote_ready EUR 123.45 EUR'
  self.assertTrue(self.runner.semantic_score(case,good,[{}],[quote],None)['fidelity'])
  fault_case={'expect':'uncertain','prepare_required':True,'fault':'timeout'}
  self.assertFalse(self.runner.semantic_score(fault_case,'I cannot verify',[{}],[{'ok':False}],{'fault':'timeout'})['fidelity'])
  exchange={'tool':'check_quote_book','fault_requested':'timeout','fault_applied':'timeout','fault_observed':'timeout_exception_raised','call_id':'c','event_id':'e','original_response_hex':'7b7d','raw_response_hex':'7b7d','exception_type':'TimeoutError'}
  self.assertTrue(self.runner.semantic_score(fault_case,'I cannot verify',[{'id':'tc'}],[{'ok':False,'call_id':'c','_tool_call_id':'tc'}],exchange)['fidelity'])
 def test_complete_request_matching_rejects_material_mutations(self):
  control={'check_in':'2027-06-01','check_out':'2027-06-08','guests':['Alex'],'room':{'kind':'shared'},'package':'package_none','add_ons':[]}
  base={'action':'prepare','purpose':'quote','check_in':control['check_in'],'check_out':control['check_out'],'guests':[{'name':'Alex'}],'room':{'kind':'shared'},'package':{'code':'package_none'},'add_ons':[]}
  self.assertTrue(self.runner.control_matches_prepare(control,base))
  for mutation in ({'purpose':'offer'},{'payment':{'arrangement':'together'}},{'room':{'kind':'shared','beds':['invented']}}):
   self.assertFalse(self.runner.control_matches_prepare(control,{**base,**mutation}))
 def test_verdict_is_bound_to_intended_tool_call_and_exact_tokens(self):
  case={'expect':'quote','prepare_required':True}; call={'id':'wanted'}
  quote={'ok':True,'total_cents':12345,'currency':'EUR','_tool_call_id':'wanted'}
  unrelated={'ok':True,'total_cents':12345,'currency':'EUR','_tool_call_id':'later'}
  self.assertTrue(self.runner.semantic_score(case,'EUR 123.45',[call],[quote,unrelated],None)['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,'EUR 123.456',[call],[quote],None)['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,'EUR 123.45, booking confirmed',[call],[quote],None)['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,'EUR 123.45',[call],[unrelated],None)['fidelity'])
 def test_semantic_oracle_rejects_every_unsupported_claim(self):
  case={'expect':'quote','prepare_required':True}; call={'id':'wanted'}
  quote={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,'total_cents':12345,'deposit_cents':3000,'remaining_cents':9345,'currency':'EUR','check_in':'2027-06-01','check_out':'2027-06-08','package':'malibu','_tool_call_id':'wanted'}
  good='Malibu, 2027-06-01 to 2027-06-08: EUR 123.45 total, EUR 30.00 deposit and EUR 93.45 remaining.'
  self.assertTrue(self.runner.semantic_score(case,good,[call],[quote],None)['fidelity'])
  for bad in (good+' EUR 99.99 extra.',good.replace('EUR 30.00','EUR 31.00'),good.replace('2027-06-08','2027-06-09'),good.replace('Malibu','Waimea'),good+' It is held.',good+' Payment received.'):
   self.assertFalse(self.runner.semantic_score(case,bad,[call],[quote],None)['fidelity'],bad)
  refusal={'ok':False,'classification':'availability','reason':'minimum stay violated','next_step':'choose other dates','_tool_call_id':'wanted'}
  self.assertTrue(self.runner.semantic_score({'expect':'refusal','prepare_required':True},'Those dates are unavailable; please pick different dates.',[call],[refusal],None)['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,good,[call],[{**quote,'_tool_call_id':'later'}],None)['fidelity'])
 def test_state_query_uses_durable_owners_not_operation_heuristics(self):
  source=(ROOT/'scripts/staff-query-api.js').read_text()
  start=source.index('// Read each durable domain owner directly.')
  block=source[start:source.index('if (!state ||',start)]
  for owner in ('FROM bookings','FROM luna_v3_holds','FROM payments','FROM luna_v3_payment_links','FROM guest_message_sends','FROM client_notification_events'):
   self.assertIn(owner,block)
  self.assertNotIn('luna_v3_operations',block)
  self.assertNotIn('get_payment_status',block)
if __name__=='__main__': unittest.main(verbosity=2)
