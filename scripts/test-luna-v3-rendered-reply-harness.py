#!/usr/bin/env python3
"""Offline executable gates for the Cap runner (never substitutes a live run)."""
import ast, importlib.util, pathlib, unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
RUNNER=ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py'
ROUTE=ROOT/'docker/hermes-luna-v3/runtime/simulator_route.py'
PLUGIN=ROOT/'docker/hermes-luna-v3/plugins/luna_v3_staff_api/__init__.py'
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
  fixture={'valid_dates':{'check_in':'2027-06-01','check_out':'2027-06-08'},'invalid_dates':{'check_in':'2027-06-01','check_out':'2027-06-02'}}
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
  for expected in ('stay-only-success-control','package-malibu-success','rental-board-success','service-yoga-success','service-group_lesson-success','service-private_lesson-success','mixed','multi-guest'):
   self.assertIn(expected,ids)
  mixed=next(c for c in cases if c['id']=='mixed')['control']; group=next(c for c in cases if c['id']=='multi-guest')['control']
  self.assertEqual(4,len(mixed['add_ons'])); self.assertEqual(['Alex','Sam','Jo'],group['guests'])
  for case in cases:
   if case['prepare_required']: self.assertTrue(self.runner.validate_control(case,choices),case['id'])
  prepare={'action':'prepare','purpose':'quote','check_in':'2027-06-01','check_out':'2027-06-08','guests':[{'name':'Alex'}],'room':{'kind':'shared'},'package':{'name':'malibu'},'add_ons':[{'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-01']},{'code':'yoga','quantity':1,'people':['Alex'],'dates':['2027-06-01']},{'code':'group_lesson','quantity':1,'people':['Alex'],'dates':['2027-06-01']},{'code':'private_lesson','quantity':1,'people':['Alex'],'dates':['2027-06-01']}]}
  self.assertTrue(self.runner.control_matches_prepare(mixed,prepare))
  prepare['check_out']='2027-06-09'; self.assertFalse(self.runner.control_matches_prepare(mixed,prepare))
  self.assertIn('control_matches_prepare',RUNNER.read_text())
  s=RUNNER.read_text(); self.assertNotIn('Quote Cap Week',s); self.assertIn('event_receipts',s); self.assertIn('refusal_correction',s)
 def test_missing_required_kinds_and_two_lessons_fail_closed(self):
  fixture={'valid_dates':{'check_in':'2027-06-01','check_out':'2027-06-08'},'invalid_dates':{'check_in':'2027-06-01','check_out':'2027-06-02'}}
  base=[{'kind':k,'code':k,'label':k,'active':True,'requirements':{}} for k in ('accommodation','package','rental','service')]
  with self.assertRaisesRegex(SystemExit,'missing required active capability kinds'):
   self.runner.make_cases({'ok':True,'revision':'r','choices':base},fixture)
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
  exchange={'tool':'check_quote_book','fault_requested':'timeout','fault_applied':'timeout','fault_observed':True,'call_id':'c','event_id':'e','original_response_hex':'7b7d','raw_response_hex':'7b7d','exception_type':'TimeoutError'}
  self.assertTrue(self.runner.semantic_score(fault_case,'I cannot verify',[{}],[{'ok':False}],exchange)['fidelity'])
 def test_complete_request_matching_rejects_material_mutations(self):
  control={'check_in':'2027-06-01','check_out':'2027-06-08','guests':['Alex'],'room':{'kind':'shared'},'package':'package_none','add_ons':[]}
  base={'action':'prepare','purpose':'quote','check_in':control['check_in'],'check_out':control['check_out'],'guests':[{'name':'Alex'}],'room':{'kind':'shared'},'package':{'code':'package_none'},'add_ons':[]}
  self.assertTrue(self.runner.control_matches_prepare(control,base))
  for mutation in ({'purpose':'offer'},{'payment':{'arrangement':'together'}},{'room':{'kind':'shared','beds':['invented']}}):
   self.assertFalse(self.runner.control_matches_prepare(control,{**base,**mutation}))
if __name__=='__main__': unittest.main(verbosity=2)
