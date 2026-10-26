#!/usr/bin/env python3
"""Offline executable gates for the Cap runner (never substitutes a live run)."""
import ast, hashlib, importlib.util, json, os, pathlib, tempfile, unittest, subprocess
import copy, sys
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent/'lib'))
from luna_v3_grader_test_support import TEST_AUTHORITY, boundary_evidence, produce
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[1]
os.environ.setdefault('LUNA_OWNER_RECEIPT_VERIFIER_KEY','offline-owner-receipt-test-key-32-bytes-minimum')
RUNNER=ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py'
ROUTE=ROOT/'docker/hermes-luna-v3/runtime/simulator_route.py'
PLUGIN=ROOT/'docker/hermes-luna-v3/plugins/luna_v3_staff_api/__init__.py'

def owner_fixture():
 """Read authenticated TEST Staff/Postgres captures; never issue owner evidence."""
 return json.loads((owner_directory()/'matrix-fixture.json').read_text())

def owner_directory():
 path=pathlib.Path(os.environ.get('LUNA_GRADER_OWNER_EVIDENCE','fixtures/luna-v3-grader-owner'))
 return path if path.is_absolute() else ROOT/path

def owner_snapshot():
 return json.loads((owner_directory()/'capability-snapshot.raw.json').read_text())

def semantic_case(expect='quote'):
 facts={'currency':'EUR','total_cents':12345,'deposit_cents':3000,'remaining_cents':9345,'check_in':'2027-06-01','check_out':'2027-06-08','package':'malibu','add_ons':[],'inclusions':[],'terms':[]}
 return {'expect':expect,'prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'intended_owner_outcome':{'expect':expect,'facts':facts}}


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
  for x in ('manifest.json','results.json','SHA256SUMS','reply_equals_final_response','no_hold_or_booking_for_quote','one_prepare_per_turn','first_refusal_then_success','owner_fixture_custody_sha256','owner_fixture_provenance_unverified'): self.assertIn(x,s)
  self.assertNotIn('staff_fields_rendered_exactly',s)
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
  case={'prepare_required':False,'expect':'clarification'}
  score=self.runner.semantic_score(case,'Which check-in and check-out dates would you like?',[],[],None,expected_authority=dict(TEST_AUTHORITY))
  self.assertEqual({'clarification':True,'progress':True,'fidelity':None},score)
  for reply in ('Hello!', 'Ready?', 'Which check-in dates? Your reservation is confirmed.', 'Which check-in dates? Total EUR 9999.'):
   self.assertIs(False,self.runner.semantic_score(case,reply,[],[],None,expected_authority=dict(TEST_AUTHORITY))['fidelity'],reply)
 def test_live_verdict_uses_semantic_score_and_counts_prepare_per_event(self):
  events=[
   {'event_id':'evt-refusal','response':{'reply_text':'minimum stay; choose seven nights','harness_trace':{'messages':[
    {'role':'assistant','tool_calls':[{'function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}}]},
    {'role':'tool','content_parsed':{'ok':False,'reason':'minimum stay','next_step':'choose seven nights'}}]}}},
   {'event_id':'evt-corrected','response':{'reply_text':'verified total 7000','harness_trace':{'messages':[
    {'role':'assistant','tool_calls':[{'function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}}]},
    {'role':'tool','content_parsed':{'ok':True,'total_cents':7000}}]}}},
  ]
  scores=self.runner.score_events({'prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'expect':'quote','continuation':True},events)
  self.assertEqual([1,1],[row['prepare_count'] for row in scores])
  self.assertTrue(all(row['semantic']['progress'] for row in scores))
  events[1]['response']['harness_trace']['messages'][0]['tool_calls'].append({'function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}})
  self.assertFalse(self.runner.score_events({'prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'expect':'quote','continuation':True},events)[1]['semantic']['progress'])
  source=RUNNER.read_text(); self.assertIn('"semantic_score":event_scores',source); self.assertIn('all_semantic_scores_pass',source)
 def test_judge_allows_paraphrased_refusal_and_zero_tool_clarification(self):
  state={'booking_count':0,'hold_count':0}; common={'untruncated':True,'installed_plugin':{'sha256':'a'},'runtime_readback':{}}
  refusal={'ok':False,'classification':'availability','reason':'beds_unavailable','next_step':'choose_other_room','_tool_call_id':'c'}
  call={'id':'c','function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}}
  reply='That room is unavailable; please choose another room.'
  exchange=boundary_evidence(call,refusal)
  body={'reply_text':reply,'external_send_allowed':False,'staff_alert_allowed':False,'harness_trace':{**common,'staff_http_exchanges':[exchange],'messages':[{'role':'assistant','tool_calls':[call]},{'role':'tool','tool_call_id':'c','content_parsed':refusal}],'final_response':reply}}
  checks,_=self.runner.judge({'expect':'refusal','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'continuation':False},body,state,state)
  self.assertTrue(all(checks.values()),checks)
  empty=copy.deepcopy(body); empty['harness_trace']['staff_http_exchanges']=[{}]
  self.assertFalse(self.runner.judge({'expect':'refusal','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'continuation':False},empty,state,state)[0]['raw_staff_responses_present'])
  refusal_case={'expect':'refusal','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'intended_owner_outcome':{'expect':'refusal','classification':'availability','allowed_reasons':['beds_unavailable'],'next_step':'choose_other_room'}}
  self.assertTrue(self.runner.semantic_score(refusal_case,reply,[call],[refusal],exchange,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  question='Which check-in and check-out dates would you like?'
  clarification={'reply_text':question,'external_send_allowed':False,'staff_alert_allowed':False,'harness_trace':{**common,'staff_http_exchanges':[],'messages':[{'role':'assistant','content':question,'tool_calls':[]}],'final_response':question}}
  checks,_=self.runner.judge({'expect':'clarification','prepare_required':False,'continuation':False},clarification,state,state)
  self.assertTrue(all(checks.values()),checks)
  self.assertTrue(self.runner.semantic_score({'expect':'clarification','prepare_required':False},question,[],[],None,expected_authority=dict(TEST_AUTHORITY))['clarification'])
 def test_owner_fixture_bytes_are_digest_bound(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp)/'fixture.json'; raw=json.dumps(owner_fixture(),separators=(',',':')).encode(); path.write_bytes(raw)
   digest=hashlib.sha256(raw).hexdigest(); loaded,verified=self.runner.load_owner_fixture(path,digest)
   self.assertEqual(owner_fixture(),loaded); self.assertEqual(digest,verified)
   for invalid in ('','0'*64):
    with self.assertRaises(SystemExit): self.runner.load_owner_fixture(path,invalid)
 def test_owner_receipt_is_reusable_signed_and_proposition_bound(self):
  adapter=self.runner.OwnerExecutionAdapter(); self.addCleanup(adapter.close)
  fixture=owner_fixture(); snapshot=owner_snapshot(); case=fixture['cases'][0]
  choices=[{**c,'active':c['configuration']['active']} for c in snapshot['choices']]
  proposition={'revision':snapshot['revision'],'case_id':case['id'],'category':case['category'],'fault':case.get('fault'),'prompt':case['prompt'],'control':case['control'],'outcome':case['intended_owner_outcome'],'input':self.runner._public_prepare(case['control']),'choices':choices,'turn_id':'fixture-admission'}
  receipt=case['owner_execution_receipt']
  self.assertEqual('staff-owner-http/v5',receipt['schema'])
  self.assertFalse(adapter.call({'command':'verify','receipt':receipt,**{**proposition,'prompt':'Contradictory rehashed prompt'}})['ok'])
  self.assertTrue(adapter.call({'command':'verify','receipt':receipt,**proposition})['ok'])
  self.assertTrue(adapter.call({'command':'verify','receipt':receipt,**proposition})['ok'])
  for command in ('issue','generate'):
   self.assertEqual('adapter_error',adapter.call({'command':command,**proposition})['code'])
  tampered=copy.deepcopy(receipt); tampered['signature']='0'*64
  self.assertFalse(adapter.call({'command':'verify','receipt':tampered,**proposition})['ok'])
  for outcome in ({'expect':'refusal','classification':'availability'}, {'expect':'quote','facts':{'total_cents':1}}):
   normalized=adapter.call({'command':'normalize',**{**proposition,'outcome':outcome}})
   self.assertTrue(normalized['ok'])
   for key in ('outcome','facts','signature','receipt','owner_response'):
    self.assertNotIn(key,normalized)
 def test_frozen_receipts_reject_contradictory_prompt_control_and_outcome(self):
  snapshot=owner_snapshot()
  for category in ('rental','package','mixed','multi_guest','continuation'):
   bad=owner_fixture(); case=next(c for c in bad['cases'] if c['category']==category)
   field='correction_prompt' if category=='continuation' else 'prompt'; case[field]='Contradictory caller rewrite: select package_none and no add-ons.'
   with self.assertRaisesRegex(SystemExit,'receipt rejected'): self.runner.make_cases(snapshot,bad)
  for mutation in ('control','outcome','metadata'):
   bad=owner_fixture(); case=next(c for c in bad['cases'] if c['category']=='rental')
   if mutation=='control': case['control']['check_out']='2027-06-07'
   elif mutation=='outcome': case['intended_owner_outcome']['facts']['total_cents']+=1
   else: case['owner_execution_receipt']={'schema':'staff-owner-execution/v3','executed_at':'2026-10-26T00:00:00Z','proposition':{},'result':{},'signature':'0'*64}
   with self.assertRaises(SystemExit): self.runner.make_cases(snapshot,bad)
  with mock.patch.dict(os.environ,{},clear=True):
   with self.assertRaisesRegex(SystemExit,'VERIFIER_KEY'): self.runner.OwnerExecutionAdapter()
 def test_complete_kind_controls_and_continuation_source(self):
  fixture=owner_fixture()
  snapshot=owner_snapshot(); choices=[{**c,'active':c['configuration']['active']} for c in snapshot['choices']]
  cases=self.runner.make_cases(snapshot,fixture)
  self.assertFalse(any(c['expect']=='n/a' for c in cases)); self.assertTrue(all(c.get('control') for c in cases if c['prepare_required']))
  ids={c['id'] for c in cases}
  for expected in ('accommodation','package','rental','service-lesson_a','service-lesson_b','mixed','multi_guest'):
   self.assertIn('owner-'+expected,ids)
  mixed=next(c for c in cases if c['category']=='mixed')['control']; group=next(c for c in cases if c['category']=='multi_guest')['control']
  self.assertEqual(2,len(mixed['add_ons'])); self.assertEqual([{'name':'Alex'},{'name':'Sam'}],group['guests'])
  for case in cases:
   if case['prepare_required'] and not case['continuation']: self.assertTrue(self.runner.validate_control(case,choices),case['id'])
  continuation=next(c for c in cases if c['continuation'])
  self.assertEqual(['invalid_quantity'],continuation['intended_owner_outcome']['allowed_reasons'])
  self.assertIsNone(continuation['_owner_normalized_control'])
  self.assertFalse(self.runner.validate_control(continuation,choices))
  self.assertTrue(self.runner.validate_control({'control':continuation['corrected_control']},choices))
  evidence=continuation['owner_execution_receipt']
  before=json.loads(evidence['evidence']['prepare']['request_body']); after=json.loads(evidence['correction']['prepare']['request_body'])
  self.assertEqual(before['session_id'],after['session_id'])
  self.assertNotEqual(before['add_ons'][0]['quantity'],after['add_ons'][0]['quantity'])
  prepare=self.runner._public_prepare(mixed)
  self.assertTrue(self.runner.control_matches_prepare(mixed,prepare,choices))
  prepare['check_out']='2027-06-09'; self.assertFalse(self.runner.control_matches_prepare(mixed,prepare,choices))
  self.assertIn('control_matches_prepare',RUNNER.read_text())
  s=RUNNER.read_text(); self.assertNotIn('Quote Cap Week',s); self.assertIn('event_receipts',s); self.assertIn('refusal_correction',s)
 def test_missing_required_kinds_and_two_lessons_fail_closed(self):
  fixture=owner_fixture()
  for missing in ('accommodation','package','rental','service'):
   snapshot=owner_snapshot(); snapshot['choices']=[c for c in snapshot['choices'] if c['kind']!=missing]
   with self.subTest(missing=missing), self.assertRaisesRegex(SystemExit,'receipt rejected'):
    self.runner.make_cases(snapshot,fixture)
  snapshot=owner_snapshot(); snapshot['choices']=[c for c in snapshot['choices'] if c['code']!='private_lesson']
  with self.assertRaisesRegex(SystemExit,'receipt rejected'): self.runner.make_cases(snapshot,fixture)
 def test_owner_fixture_schema_fails_closed_and_is_deterministic(self):
  snapshot=owner_snapshot(); fixture=owner_fixture()
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
 def test_fixture_calendar_schema_and_complete_bindings_fail_closed(self):
  snapshot=owner_snapshot(); mutations=[]
  for mutate in (lambda c:c['control'].__setitem__('check_in','2027-02-30'),lambda c:c['control'].__setitem__('check_out',c['control']['check_in']),lambda c:c['control'].__setitem__('room',{'kind':'shared','unknown':True}),lambda c:c['control'].__setitem__('guests',[{}])):
   fixture=owner_fixture(); mutate(fixture['cases'][0]); mutations.append(fixture)
  fixture=owner_fixture(); next(c for c in fixture['cases'] if c['category']=='multi_guest')['control']['package']['per_guest'][1]['guest']=1; mutations.append(fixture)
  fixture=owner_fixture(); next(c for c in fixture['cases'] if c['category']=='rental')['control']['add_ons'][0]['dates']=['2027-02-30']; mutations.append(fixture)
  fixture=owner_fixture(); next(c for c in fixture['cases'] if c['category']=='continuation').pop('corrected_owner_outcome'); mutations.append(fixture)
  fixture=owner_fixture(); fixture['cases'][0]['intended_owner_outcome'].pop('facts'); mutations.append(fixture)
  for fixture in mutations:
   with self.assertRaises(SystemExit): self.runner.make_cases(snapshot,fixture)
 def test_actual_main_loop_accepts_non_fault_case_without_keyerror(self):
  import subprocess
  head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
  case={'id':'clarification','category':'clarification','prompt':'Which dates?','prepare_required':False,'continuation':False,'expect':'clarification','intended_owner_outcome':{'expect':'clarification'}}
  def fake_request(url,token,trace,payload,**kwargs):
   if url.endswith('/preflight'):
    parsed={'ok':True,'effective_model':self.runner.EXPECTED,'fallback_possible':False,'pins':{k:head if k=='candidate_sha' else 'pin' for k in ('candidate_sha','image_digest','base_image_digest','instruction_sha256','plugin_sha256','contract_sha256')},'staff_admission':{'capability_snapshot':{'ok':True,'revision':'r','choices':[]}}}
   elif url.endswith('/state'):
    parsed={'ok':True,'schema':'luna-v3-test-state/v1','authenticated':True,'tenant':'wolfhouse-somo','thread':payload['thread'],'booking_count':0,'hold_count':0,'payment_count':0,'external_send_count':0,'staff_alert_count':0}
   else:
    reply='Which check-in and check-out dates would you like?'; parsed={'reply_text':reply,'external_send_allowed':False,'staff_alert_allowed':False,'harness_trace':{'inbound_event_id':'evt','messages':[{'role':'user','content':'help'},{'role':'assistant','content':reply,'tool_calls':[]}],'staff_http_exchanges':[],'untruncated':True,'installed_plugin':{'sha256':'x'},'runtime_readback':{},'final_response':reply}}
   return {'status':200,'raw':json.dumps(parsed).encode(),'headers':{},'elapsed_ms':1,'parsed':parsed}
  with tempfile.TemporaryDirectory() as tmp:
   env={'LUNA_MATRIX_CANDIDATE_SHA':head,'HERMES_MODEL_PROVIDER':'openai','HERMES_MODEL':'gpt-6.1-sol','HERMES_REASONING_EFFORT':'low','LUNA_MATRIX_SIMULATOR_URL':'http://test','LUNA_MATRIX_SIMULATOR_TOKEN':'t','LUNA_V3_HARNESS_TRACE_TOKEN':'t','LUNA_MATRIX_FIXTURE_METADATA':'unused','LUNA_MATRIX_FIXTURE_SHA256':'0'*64,'LUNA_MATRIX_OUTPUT':str(pathlib.Path(tmp)/'result')}
   with mock.patch.dict(os.environ,env,clear=False), mock.patch.object(self.runner,'request',side_effect=fake_request), mock.patch.object(self.runner,'load_owner_fixture',return_value=({'owner_provenance':{}},'0'*64)), mock.patch.object(self.runner,'make_cases',return_value=[case]), mock.patch.object(self.runner,'REPS',1):
    self.assertEqual(0,self.runner.main())
 def test_fault_status_exception_and_real_timeout_are_verdict_inputs(self):
  source=RUNNER.read_text(); route=ROUTE.read_text(); plugin=PLUGIN.read_text()
  for fault in ('http-422','exception','timeout'):
   self.assertIn(fault,source); self.assertIn(fault,route); self.assertIn(fault,plugin)
  binding=(ROOT/'scripts/lib/luna_v3_receipt_binding.py').read_text()
  self.assertIn('luna_v3_receipt_binding',source)
  self.assertIn('exception_type',binding); self.assertIn('status',binding); self.assertIn('TimeoutError',plugin)
 def test_continuation_keeps_both_raw_and_event_receipts_with_linkage(self):
  source=RUNNER.read_text()
  for marker in ('raw_file','inbound_event_id','refusal_event_id','corrected_event_id','new_prepare_event_id'):
   self.assertIn(marker,source)
 def test_rootfix_counterexamples_fail_closed(self):
  case=semantic_case(); call={'id':'wanted'}
  quote={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,**case['intended_owner_outcome']['facts'],'_tool_call_id':'wanted'}
  good='For 2027-06-01 to 2027-06-08, the Malibu package has a total of EUR 123.45, a deposit of EUR 30.00, and a remaining balance of EUR 93.45.'
  evidence=boundary_evidence(call,quote)
  with self.subTest(positive=good): self.assertTrue(self.runner.semantic_score(case,good,[call],[quote],evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,'EUR 999.99, fully paid and confirmed',[call],[quote],evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  refusal_case={'expect':'refusal','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'intended_owner_outcome':{'expect':'refusal','classification':'availability','allowed_reasons':['minimum_stay'],'next_step':'choose_other_dates'}}
  infra={'ok':False,'reason':'db_error','classification':'availability','next_step':'choose_other_dates','_tool_call_id':'wanted'}
  self.assertFalse(self.runner.semantic_score(refusal_case,'Please choose other dates',[call],[infra],boundary_evidence(call,infra),current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  fault_case={'expect':'uncertain','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'fault':'timeout'}
  self.assertFalse(self.runner.semantic_score(fault_case,'I cannot verify this quote.',[{}],[{'ok':False}],{'fault':'timeout'},expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  capture=owner_fixture()['cases'][0]['owner_execution_receipt']['evidence']['prepare']
  fault_call,typed_fault,exchange=produce({'action':'prepare'},raw=capture['body'].encode(),status=capture['status'],event_id='e',fault='timeout',call_id='tc')
  self.assertTrue(self.runner.semantic_score(fault_case,'I cannot verify this quote.',[fault_call],[typed_fault],exchange,current_event_id='e',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  for mutation,bad_result,bad_exchange,bad_reply in (
   ('wrong_event',typed_fault,{**exchange,'event_id':'wrong'},'I cannot verify this quote.'),
   ('successful_fault_result',{**typed_fault,'ok':True},exchange,'I cannot verify this quote.'),
   ('missing_fault_source_capture',typed_fault,{k:v for k,v in exchange.items() if k not in ('original_response_hex','raw_response_hex')},'I cannot verify this quote.'),
   ('inconsistent_fault_source_bytes',typed_fault,{**exchange,'raw_response_hex':''},'I cannot verify this quote.'),
   ('false_facts',typed_fault,exchange,'I cannot verify. Your confirmed total is EUR 9999 and I booked it.'),
  ):
   with self.subTest(mutation=mutation): self.assertFalse(self.runner.semantic_score(fault_case,bad_reply,[fault_call],[bad_result],bad_exchange,current_event_id='e',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
 def test_complete_request_matching_rejects_material_mutations(self):
  control={'check_in':'2027-06-01','check_out':'2027-06-08','guests':[{'name':'Alex'}],'room':{'kind':'shared'},'package':'package_none','add_ons':[]}
  base={'action':'prepare','purpose':'quote','check_in':control['check_in'],'check_out':control['check_out'],'guests':[{'name':'Alex'}],'room':{'kind':'shared'},'package':{'code':'package_none'},'add_ons':[]}
  self.assertTrue(self.runner.control_matches_prepare(control,base))
  for mutation in ({'purpose':'offer'},{'payment':{'arrangement':'together'}},{'room':{'kind':'shared','beds':['invented']}},{'package':{'code':'package_none','unproven':'invented'}}):
   self.assertFalse(self.runner.control_matches_prepare(control,{**base,**mutation}))
  gendered={**control,'guests':[{'name':'Alex','explicit_gender':'female'}]}
  self.assertFalse(self.runner.control_matches_prepare(gendered,{**base,'guests':[{'name':'Alex','explicit_gender':'male'}]}))
  detailed={**control,'guests':[{'name':'Alex','age':27,'nationality':'ES'}]}
  self.assertFalse(self.runner.control_matches_prepare(detailed,{**base,'guests':[{'name':'Alex','age':28,'nationality':'ES'}]}))
  rental={**control,'add_ons':[{'code':'board','quantity':1,'days':1,'dates':['2027-06-01'],'people':['Alex']}]}
  self.assertFalse(self.runner.control_matches_prepare(rental,{**base,'add_ons':[{'code':'board','quantity':1,'days':99,'dates':['2027-06-01'],'people':['Alex']}]}))
  self.assertFalse(self.runner.control_matches_prepare(rental,{**base,'add_ons':[{'code':'board','quantity':1,'days':1,'dates':['2027-06-01'],'people':['Alex'],'duration_hours':99}]}))
 def test_verdict_is_bound_to_intended_tool_call_and_exact_tokens(self):
  case=semantic_case(); call={'id':'wanted'}; facts=case['intended_owner_outcome']['facts']
  quote={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,**facts,'_tool_call_id':'wanted'}
  unrelated={**quote,'_tool_call_id':'later'}
  good='Malibu package, 2027-06-01 to 2027-06-08: total EUR 123.45, deposit EUR 30.00, remaining EUR 93.45.'
  evidence=boundary_evidence(call,quote)
  self.assertTrue(self.runner.semantic_score(case,good,[call],[quote,unrelated],evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,good,[call],[unrelated],evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,good+' Booking confirmed.',[call],[quote],evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
 def test_semantic_oracle_adversarial_and_positive_controls(self):
  case=semantic_case(); call={'id':'wanted'}; facts=case['intended_owner_outcome']['facts']
  quote={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,**facts,'_tool_call_id':'wanted'}
  good='For the Malibu package from 2027-06-01 to 2027-06-08, total EUR 123.45; the deposit is EUR 30.00; the remaining balance is EUR 93.45.'
  paraphrase='Malibu package (2027-06-01 through 2027-06-08): EUR 123.45 total, EUR 30.00 deposit, and balance EUR 93.45.'
  evidence=boundary_evidence(call,quote)
  for reply in (good,paraphrase):
   with self.subTest(positive=reply): self.assertTrue(self.runner.semantic_score(case,reply,[call],[quote],evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  bad_replies=(
   good.replace('Malibu package','Malibu package plus Waimea package'),
   good.replace('total EUR 123.45; the deposit is EUR 30.00','total EUR 30.00; the deposit is EUR 123.45'),
   good+' It includes breakfast.',
   good+' Board rental included.',
   good.replace('2027-06-08','2027-06-09'),
  )
  for bad in bad_replies:
   with self.subTest(negative=bad): self.assertFalse(self.runner.semantic_score(case,bad,[call],[quote],evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'],bad)
  for bad in (good.replace('total EUR 123.45','total is NOT EUR 123.45'),good.replace('total EUR 123.45',"total isn't EUR 123.45"),good+' Your total is USD 9999.',good+' Your reservation is confirmed.'):
   with self.subTest(negative=bad): self.assertFalse(self.runner.semantic_score(case,bad,[call],[quote],evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'],bad)
  refusal_case={'expect':'refusal','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'intended_owner_outcome':{'expect':'refusal','classification':'availability','allowed_reasons':['minimum_stay'],'next_step':'choose_other_dates'}}
  refusal={'ok':False,'classification':'availability','reason':'minimum_stay','next_step':'choose_other_dates','_tool_call_id':'wanted'}
  refusal_evidence=boundary_evidence(call,refusal)
  self.assertTrue(self.runner.semantic_score(refusal_case,'That stay is too short; please select different dates.',[call],[refusal],refusal_evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  for bad in ('Hello!','Your reservation is confirmed. Total EUR 9999.'):
   self.assertFalse(self.runner.semantic_score(refusal_case,bad,[call],[refusal],refusal_evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'],bad)
  for infra in ({**refusal,'reason':'db_error'},{**refusal,'classification':'internal'},{**refusal,'code':'transport_error'}):
   self.assertFalse(self.runner.semantic_score(refusal_case,'Please select different dates.',[call],[infra],boundary_evidence(call,infra),current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  capture=owner_fixture()['cases'][0]['owner_execution_receipt']['evidence']['prepare']
  for fault in ('http-422','exception','timeout','non-json','malformed'):
   call,fault_result,exchange=produce({'action':'prepare'},raw=capture['body'].encode(),status=capture['status'],fault=fault,call_id='wanted')
   self.assertEqual(fault,exchange['fault_applied'])
   self.assertEqual(capture['body'].encode().hex(),exchange['original_response_hex'])
   fault_case={'expect':'uncertain','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'fault':fault}
   self.assertTrue(self.runner.semantic_score(fault_case,'I cannot verify this quote.',[call],[fault_result],exchange,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'],fault)
   exchange['event_id']='wrong-event'
   self.assertFalse(self.runner.semantic_score(fault_case,'I cannot verify this quote.',[call],[fault_result],exchange,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'],fault)
 def test_fixture_categories_are_bound_to_owner_products_and_canaries(self):
  snapshot=owner_snapshot()
  self.runner.make_cases(snapshot,owner_fixture())
  mutations=[]
  for category in ('package','rental','service:lesson_a','service:lesson_b','mixed'):
   bad=owner_fixture(); target=next(c for c in bad['cases'] if c['category']==category); target['control']['package']='package_none'; target['control']['add_ons']=[]; mutations.append(bad)

  for bad in mutations:
   with self.assertRaises(SystemExit): self.runner.make_cases(snapshot,bad)
 def test_structured_mixed_and_multi_guest_shape_aware_oracle(self):
  call={'id':'wanted'}
  package={'per_guest':[{'guest':1,'guest_name':'Alex','code':'malibu'},{'guest':2,'guest_name':'Sam','code':'package_none'}]}
  addons=[{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']},{'code':'group_lesson','quantity':2,'days':1,'dates':['2027-06-03'],'people':['Alex','Sam']}]
  facts={'currency':'EUR','total_cents':30000,'deposit_cents':10000,'remaining_cents':20000,'check_in':'2027-06-01','check_out':'2027-06-08','package':package,'add_ons':addons,'inclusions':[],'terms':[]}
  case={'expect':'mixed','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'intended_owner_outcome':{'expect':'mixed','facts':facts},'_catalog_claim_terms':[{'code':'malibu','terms':['malibu']},{'code':'package_none','terms':['package_none','accommodation only']},{'code':'board','terms':['board','board rental']},{'code':'group_lesson','terms':['group_lesson','group lesson']},{'code':'waimea','terms':['waimea','waimea surf bundle']},{'code':'yoga','terms':['yoga']}]}
  reply='2027-06-01 to 2027-06-08: Alex has the malibu package and 1 board rental on 2027-06-02; Sam has the package_none package. Alex and Sam have 2 group_lesson lessons on 2027-06-03. Total EUR 300.00, deposit EUR 100.00, remaining EUR 200.00.'
  snake={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,'quote':{'facts':copy.deepcopy(facts)},'_tool_call_id':'wanted'}
  camel={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,'data':{'quoteFacts':{'currency':'EUR','totalCents':30000,'depositCents':10000,'remainingCents':20000,'checkIn':'2027-06-01','checkOut':'2027-06-08','packageSelection':{'per_guest':[{'guestIndex':1,'guestName':'Alex','code':'malibu'},{'guestIndex':2,'guestName':'Sam','code':'package_none'}]},'addOns':[{'code':'group_lesson','quantity':2,'days':1,'dates':['2027-06-03'],'participants':['Sam','Alex']},{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']}],'inclusions':[],'terms':[]}},'_tool_call_id':'wanted'}
  evidence=boundary_evidence(call,snake)
  self.assertTrue(self.runner.semantic_score(case,reply,[call],[snake],evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  self.assertTrue(self.runner.semantic_score(case,reply,[call],[camel],boundary_evidence(call,camel),current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  for bad in (reply.replace(' and 1 board rental on 2027-06-02',''),reply.replace('Alex has the malibu package and 1 board rental on 2027-06-02; Sam has the package_none package','Alex has the package_none package and 1 board rental on 2027-06-02; Sam has the malibu package'),reply+' Waimea package.',reply+' Yoga add-on.',reply+' Yoga is part of this quote.',reply+' This also comes with the Waimea surf bundle.',reply+' Lessons are guaranteed.'):
   with self.subTest(negative=bad): self.assertFalse(self.runner.semantic_score(case,bad,[call],[snake],evidence,current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'],bad)
  swapped=copy.deepcopy(snake); swapped['quote']['facts']['package']['per_guest'][0]['code']='package_none'; swapped['quote']['facts']['package']['per_guest'][1]['code']='malibu'
  self.assertFalse(self.runner.semantic_score(case,reply,[call],[swapped],boundary_evidence(call,swapped),current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
  omitted=copy.deepcopy(snake); omitted['quote']['facts']['add_ons'].pop()
  self.assertFalse(self.runner.semantic_score(case,reply,[call],[omitted],boundary_evidence(call,omitted),current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'])
 def test_real_prepare_public_quote_feeds_semantic_score(self):
  import subprocess
  payload=json.loads(subprocess.check_output(['node','scripts/test-luna-v3-public-quote-owner.js'],cwd=ROOT,text=True))
  call={'id':'wanted'}
  cases={
   'single': ({'currency':'EUR','total_cents':12345,'deposit_cents':10000,'remaining_cents':2345,'check_in':'2027-06-01','check_out':'2027-06-08','package':'package_none','add_ons':[],'inclusions':[],'terms':[]},
    '2027-06-01 to 2027-06-08: package_none package. Total EUR 123.45, deposit EUR 100.00, remaining EUR 23.45.'),
   'multi': ({'currency':'EUR','total_cents':30000,'deposit_cents':10000,'remaining_cents':20000,'check_in':'2027-06-01','check_out':'2027-06-08',
     'package':{'per_guest':[{'guest':1,'guest_name':'Alex','code':'malibu'},{'guest':2,'guest_name':'Sam','code':'package_none'}]},
     'add_ons':[{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']},{'code':'group_lesson','quantity':2,'days':1,'dates':['2027-06-03'],'people':['Alex','Sam']}],
     'inclusions':['bed','breakfast'],'terms':['lessons subject to availability']},
    '2027-06-01 to 2027-06-08: Alex has the malibu package and 1 board rental on 2027-06-02; Sam has the package_none package. Alex and Sam have 2 group_lesson lessons on 2027-06-03. Total EUR 300.00, deposit EUR 100.00, remaining EUR 200.00.')}
  for name,(facts,reply) in cases.items():
   result=payload[name]['result']; result['_tool_call_id']='wanted'
   case={'expect':'mixed' if name=='multi' else 'quote','prepare_required':True,'_expected_authority':dict(TEST_AUTHORITY),'intended_owner_outcome':{'expect':'mixed' if name=='multi' else 'quote','facts':facts}}
   self.assertEqual(self.runner.canonical_facts(facts),self.runner.canonical_facts(result),name)
   self.assertTrue(self.runner.semantic_score(case,reply,[call],[result],boundary_evidence(call,result),current_event_id='evt',expected_authority=dict(TEST_AUTHORITY))['fidelity'],name)
  self.assertEqual('package_none',payload['single']['result']['guests'][0]['package'])
  self.assertEqual(payload['multi']['input']['add_ons'],[
   {'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-02']},
   {'code':'group_lesson','quantity':2,'days':1,'people':['Alex','Sam'],'requested_dates':['2027-06-03']}])
 def test_owner_outcome_must_match_control_and_cover_every_guest(self):
  snapshot=owner_snapshot()
  for mutate in (lambda c:c['intended_owner_outcome']['facts'].__setitem__('package','malibu'),lambda c:c['intended_owner_outcome']['facts']['package']['per_guest'][0].__setitem__('code','package_none'),lambda c:c['intended_owner_outcome']['facts']['add_ons'].pop(),lambda c:c['intended_owner_outcome']['facts'].__setitem__('check_out','2027-06-09')):
   fixture=owner_fixture(); case=next(x for x in fixture['cases'] if x['category']=='multi_guest'); mutate(case)
   with self.assertRaisesRegex(SystemExit,'invalid intended owner outcome'): self.runner.make_cases(snapshot,fixture)
 def test_state_query_executes_against_fake_pg_and_fails_closed(self):
  script="""
const assert=require('node:assert/strict');
const {readLunaV3DurableState}=require('./scripts/lib/model-led-luna/luna-v3-durable-state');
(async()=>{ const calls=[]; let unbound=false;
 const pg={query:async(sql,params)=>{calls.push({sql,params});return {rows:[{booking_count:unbound?2:1,hold_count:2,payment_count:unbound?4:3,external_send_count:4,staff_alert_count:5}]}}};
 const args={clientId:'cid',sessionId:'sid',principalId:'pid',clientSlug:'wolfhouse-somo'};
 const before=await readLunaV3DurableState(pg,args); unbound=true; const after=await readLunaV3DurableState(pg,args);
 assert.equal(after.booking_count,before.booking_count+1); assert.equal(after.payment_count,before.payment_count+1);
 assert.deepEqual(calls[0].params,['cid','sid','pid','wolfhouse-somo']);
 for(const owner of ['FROM bookings','FROM luna_v3_holds','FROM payments','FROM luna_v3_payment_links','FROM guest_message_sends','FROM client_notification_events']) assert.ok(calls[0].sql.includes(owner));
 for(const scope of ['b.phone=s.guest_phone','b.created_at>=s.created_at','pb.phone=s.guest_phone','pb.created_at>=s.created_at','p.booking_id=s.selected_booking_id','pl.session_id=s.id']) assert.ok(calls[0].sql.includes(scope),scope);
 await assert.rejects(()=>readLunaV3DurableState({query:async()=>({rows:[]})},{clientId:'c',sessionId:'s',principalId:'p',clientSlug:'x'}),e=>e.code==='luna_v3_staff_state_unavailable');
 await assert.rejects(()=>readLunaV3DurableState({query:async()=>({rows:[{...before,hold_count:'2'}]})},{clientId:'c',sessionId:'s',principalId:'p',clientSlug:'x'}),e=>e.code==='luna_v3_staff_state_unavailable');
})().catch(e=>{console.error(e);process.exit(1)});"""
  import subprocess
  subprocess.run(['node','-e',script],cwd=ROOT,check=True)
  self.assertIn('readLunaV3DurableState', (ROOT/'scripts/staff-query-api.js').read_text())
if __name__=='__main__': unittest.main(verbosity=2)
