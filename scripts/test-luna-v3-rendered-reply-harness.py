#!/usr/bin/env python3
"""Offline executable gates for the Cap runner (never substitutes a live run)."""
import ast, hashlib, importlib.util, json, os, pathlib, tempfile, unittest, subprocess
import copy
from unittest import mock
ROOT=pathlib.Path(__file__).resolve().parents[1]
os.environ.setdefault('LUNA_OWNER_RECEIPT_VERIFIER_KEY','offline-owner-receipt-test-key-32-bytes-minimum')
RUNNER=ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py'
ROUTE=ROOT/'docker/hermes-luna-v3/runtime/simulator_route.py'
PLUGIN=ROOT/'docker/hermes-luna-v3/plugins/luna_v3_staff_api/__init__.py'

def owner_fixture():
 base={'check_in':'2027-06-01','check_out':'2027-06-08','guests':[{'name':'Alex'}],'room':{'kind':'shared'},'package':'package_none','add_ons':[]}
 def success(control,expect='quote'):
  package=control['package']
  if isinstance(package,dict): package={'per_guest':[{'guest':p['guest'],'guest_name':control['guests'][p['guest']-1]['name'],'code':p.get('code') or p['name']} for p in package['per_guest']]}
  addons=[{'code':a.get('code') or a['name'],'quantity':a['quantity'],'dates':a.get('dates',a.get('requested_dates',[])),'people':a.get('people',[]),**({'days':a['days']} if 'days' in a else {})} for a in control['add_ons']]
  return {'expect':expect,'facts':{'currency':'EUR','total_cents':12345,'deposit_cents':3000,'remaining_cents':9345,'check_in':control['check_in'],'check_out':control['check_out'],'package':package,'add_ons':addons,'inclusions':[],'terms':[]}}
 def case(category,control=None,expect='quote',**extra):
  actual=copy.deepcopy(control if control is not None else base)
  outcome=success(actual,expect) if expect in ('quote','mixed') else {'expect':expect}
  if expect=='refusal': outcome={'expect':'refusal','classification':'availability','allowed_reasons':['minimum_stay'],'next_step':'choose_other_dates'}
  return {'id':category.replace(':','-'),'category':category,'prompt':'Owner authored prompt for '+category,
   'control':actual,'intended_owner_outcome':outcome,**extra}
 cases=[case('accommodation'),case('package',{**base,'package':'malibu'}),
  case('rental',{**base,'add_ons':[{'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-01']}]}) ,
  case('service:lesson_a',{**base,'add_ons':[{'code':'group_lesson','quantity':1,'people':['Alex'],'dates':['2027-06-01']}]}) ,
  case('service:lesson_b',{**base,'add_ons':[{'code':'private_lesson','quantity':1,'people':['Alex'],'dates':['2027-06-01']}]})]
 mixed={**base,'package':'malibu','add_ons':[{'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-01']},{'code':'group_lesson','quantity':1,'people':['Alex'],'dates':['2027-06-01']}]}
 cases.append(case('mixed',mixed,expect='mixed')); cases[-1]['intended_owner_outcome']['compatibility_proven']=True
 group={**base,'guests':[{'name':'Alex'},{'name':'Sam'}],'package':{'per_guest':[{'guest':1,'name':'malibu'},{'guest':2,'name':'package_none'}]},'add_ons':[{'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-01']},{'code':'group_lesson','quantity':1,'people':['Sam'],'dates':['2027-06-02']}]}
 continuation=case('continuation',{**base,'check_out':'2027-06-02'},expect='refusal',corrected_control=base,correction_prompt='Use the owner-proven dates 2027-06-01 to 2027-06-08.')
 continuation['corrected_owner_outcome']=success(base)
 cases += [case('multi_guest',group),continuation,case('clarification',None,expect='clarification')]
 cases[-1].pop('control')
 for fault in ('non-json','malformed','http-422','exception','timeout'):
  row=case('fault',base,expect='uncertain',fault=fault); row['id']='fault-'+fault; cases.append(row)
 for c in cases:
  c['owner_canary']={'receipt_id':'canary-'+c['id'],'executed_at':'2026-10-26T00:00:00Z','capability_revision':'r',
   'prompt_sha256':hashlib.sha256(c['prompt'].encode()).hexdigest(),
   'correction_prompt_sha256':hashlib.sha256(str(c.get('correction_prompt') or '').encode()).hexdigest(),
   'control_sha256':hashlib.sha256(json.dumps(c.get('control'),sort_keys=True,separators=(',',':')).encode()).hexdigest(),
   'outcome_sha256':hashlib.sha256(json.dumps(c['intended_owner_outcome'],sort_keys=True,separators=(',',':')).encode()).hexdigest(),
   'corrected_control_sha256':hashlib.sha256(json.dumps(c.get('corrected_control'),sort_keys=True,separators=(',',':')).encode()).hexdigest(),
   'corrected_outcome_sha256':hashlib.sha256(json.dumps(c.get('corrected_owner_outcome'),sort_keys=True,separators=(',',':')).encode()).hexdigest()}
 choices=[{'kind':'accommodation','code':'package_none','active':True},{'kind':'package','code':'malibu','active':True},{'kind':'rental','code':'board','active':True},{'kind':'service','code':'group_lesson','active':True},{'kind':'service','code':'private_lesson','active':True}]
 key='offline-owner-receipt-test-key-32-bytes-minimum'; cli=ROOT/'scripts/lib/model-led-luna/staff-request-normalize-cli.js'
 for c in cases:
  if c['category']=='clarification': continue
  request={'action':'prepare','purpose':'quote',**copy.deepcopy(c['control'])}
  if isinstance(request.get('package'),str): request['package']={'code':request['package']}
  payload={'command':'generate','executed_at':'2026-10-26T00:00:00Z','revision':'r','case_id':c['id'],'prompt':c['prompt'],'control':c['control'],'outcome':c['intended_owner_outcome'],'correction_prompt':c.get('correction_prompt'),'corrected_control':c.get('corrected_control'),'corrected_outcome':c.get('corrected_owner_outcome'),'input':request,'choices':choices,'turn_id':'fixture-admission'}
  c['owner_execution_receipt']=json.loads(subprocess.check_output(['node',str(cli)],input=json.dumps(payload),text=True,env={**os.environ,'LUNA_OWNER_RECEIPT_ISSUER_KEY':key}))
 return {'schema':'luna-matrix-fixture/v2','tenant':'wolfhouse-somo','unsupported_declaration':{'standalone':True,'policy':'Products absent from the admitted active catalog are unsupported and must be refused.'},'owner_provenance':{'authority':'staff-owner','fixture_id':'fixture-1','approved_by':'owner@example.test','approved_at':'2026-10-26T00:00:00Z','owner_revision_or_receipt_id':'receipt-42'},'capability_revision':'r','cases':cases}

def semantic_case(expect='quote'):
 facts={'currency':'EUR','total_cents':12345,'deposit_cents':3000,'remaining_cents':9345,'check_in':'2027-06-01','check_out':'2027-06-08','package':'malibu','add_ons':[],'inclusions':[],'terms':[]}
 return {'expect':expect,'prepare_required':True,'intended_owner_outcome':{'expect':expect,'facts':facts}}

def boundary_evidence(call,result,event_id='evt',status=None):
 """Construct mandatory trust-boundary evidence for positive scorer controls."""
 if not isinstance(call.get('function'),dict): call['function']={'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}
 elif not call['function'].get('arguments_parsed'): call['function']['arguments_parsed']={'action':'prepare'}
 args=copy.deepcopy((call.get('function') or {}).get('arguments_parsed') or call.get('arguments_parsed') or {})
 result.setdefault('call_id','owner-call')
 clean={k:v for k,v in result.items() if not k.startswith('_')}
 raw=json.dumps(clean,separators=(',',':')).encode().hex()
 authority={'tenant_id':'wolfhouse-somo','session_id':'test-session','external_send_allowed':False,'staff_alert_allowed':False}
 actual_status=status if status is not None else (200 if clean.get('ok') is True else 422)
 return {'tool':'check_quote_book','call_id':clean.get('call_id','owner-call'),'event_id':event_id,
  'status':actual_status,'original_status':actual_status,'request':{**args,**authority},'public_request':args,
  'trusted_authority':authority,'original_response_hex':raw,'raw_response_hex':raw}

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
 def test_judge_allows_paraphrased_refusal_and_zero_tool_clarification(self):
  state={'booking_count':0,'hold_count':0}; common={'untruncated':True,'installed_plugin':{'sha256':'a'},'runtime_readback':{}}
  refusal={'ok':False,'classification':'availability','reason':'literal owner reason','next_step':'literal_owner_step','_tool_call_id':'c'}
  call={'id':'c','function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}}
  reply='That option is unavailable; please choose another.'
  exchange={'tool':'check_quote_book','call_id':'owner-call','event_id':'evt','status':422,'original_status':422,'original_response_hex':'7b7d','raw_response_hex':'7b7d'}
  body={'reply_text':reply,'external_send_allowed':False,'staff_alert_allowed':False,'harness_trace':{**common,'staff_http_exchanges':[exchange],'messages':[{'role':'assistant','tool_calls':[call]},{'role':'tool','tool_call_id':'c','content_parsed':refusal}],'final_response':reply}}
  checks,_=self.runner.judge({'expect':'refusal','prepare_required':True,'continuation':False},body,state,state)
  self.assertTrue(all(checks.values()),checks)
  empty=copy.deepcopy(body); empty['harness_trace']['staff_http_exchanges']=[{}]
  self.assertFalse(self.runner.judge({'expect':'refusal','prepare_required':True,'continuation':False},empty,state,state)[0]['raw_staff_responses_present'])
  refusal_case={'expect':'refusal','prepare_required':True,'intended_owner_outcome':{'expect':'refusal','classification':'availability','allowed_reasons':['literal owner reason'],'next_step':'literal_owner_step'}}
  self.assertTrue(self.runner.semantic_score(refusal_case,reply,[call],[refusal],boundary_evidence(call,refusal),current_event_id='evt')['fidelity'])
  question='Which check-in and check-out dates would you like?'
  clarification={'reply_text':question,'external_send_allowed':False,'staff_alert_allowed':False,'harness_trace':{**common,'staff_http_exchanges':[],'messages':[{'role':'assistant','content':question,'tool_calls':[]}],'final_response':question}}
  checks,_=self.runner.judge({'expect':'clarification','prepare_required':False,'continuation':False},clarification,state,state)
  self.assertTrue(all(checks.values()),checks)
  self.assertTrue(self.runner.semantic_score({'expect':'clarification','prepare_required':False},question,[],[],None)['clarification'])
 def test_owner_fixture_bytes_are_digest_bound(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=pathlib.Path(tmp)/'fixture.json'; raw=json.dumps(owner_fixture(),separators=(',',':')).encode(); path.write_bytes(raw)
   digest=hashlib.sha256(raw).hexdigest(); loaded,verified=self.runner.load_owner_fixture(path,digest)
   self.assertEqual(owner_fixture(),loaded); self.assertEqual(digest,verified)
   for invalid in ('','0'*64):
    with self.assertRaises(SystemExit): self.runner.load_owner_fixture(path,invalid)
 def test_owner_receipt_is_reusable_signed_and_proposition_bound(self):
  key='offline-owner-receipt-test-key-32-bytes-minimum'; adapter=self.runner.OwnerExecutionAdapter(key); choices=[{'kind':'accommodation','code':'package_none','active':True}]
  request={'action':'prepare','purpose':'quote','check_in':'2027-06-01','check_out':'2027-06-08','guests':[{'name':'Alex'}],'room':{'kind':'shared'},'package':{'code':'package_none'},'add_ons':[]}
  facts={'currency':'EUR','total_cents':1,'deposit_cents':0,'remaining_cents':1,'check_in':'2027-06-01','check_out':'2027-06-08','package':'package_none','add_ons':[],'inclusions':[],'terms':[]}
  proposition={'revision':'r','case_id':'bound','prompt':'Quote this exact stay','control':{'check_in':'2027-06-01'},'outcome':{'expect':'quote','facts':facts},'input':request,'choices':choices,'turn_id':'fixture-admission'}
  cli=ROOT/'scripts/lib/model-led-luna/staff-request-normalize-cli.js'
  receipt=json.loads(subprocess.check_output(['node',str(cli)],input=json.dumps({'command':'generate',**proposition}),text=True,env={**os.environ,'LUNA_OWNER_RECEIPT_ISSUER_KEY':key}))
  self.assertFalse(adapter.call({'command':'verify','receipt':receipt,**{**proposition,'prompt':'Contradictory rehashed prompt'}})['ok'])
  self.assertTrue(adapter.call({'command':'verify','receipt':receipt,**proposition})['ok'])
  self.assertTrue(adapter.call({'command':'verify','receipt':receipt,**proposition})['ok'])
  self.assertEqual('adapter_error',adapter.call({'command':'issue',**proposition})['code'])
  adapter.close()
 def test_frozen_receipts_reject_contradictory_prompt_control_and_outcome(self):
  choices=[{'kind':'accommodation','code':'package_none','active':True},{'kind':'package','code':'malibu','active':True},{'kind':'rental','code':'board','active':True},{'kind':'service','code':'group_lesson','active':True},{'kind':'service','code':'private_lesson','active':True}]
  snapshot={'ok':True,'revision':'r','choices':choices}
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
  self.assertEqual(2,len(mixed['add_ons'])); self.assertEqual([{'name':'Alex'},{'name':'Sam'}],group['guests'])
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
 def test_fixture_calendar_schema_and_complete_bindings_fail_closed(self):
  choices=[{'kind':'accommodation','code':'package_none','active':True,'requirements':{}},{'kind':'package','code':'malibu','active':True,'requirements':{}},{'kind':'rental','code':'board','active':True,'requirements':{'dates':True,'participants':True}},{'kind':'service','code':'group_lesson','active':True,'requirements':{'dates':True,'participants':True}},{'kind':'service','code':'private_lesson','active':True,'requirements':{'dates':True,'participants':True}}]
  snapshot={'ok':True,'revision':'r','choices':choices}; mutations=[]
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
    reply='Which dates would you like?'; parsed={'reply_text':reply,'external_send_allowed':False,'staff_alert_allowed':False,'harness_trace':{'inbound_event_id':'evt','messages':[{'role':'user','content':'help'},{'role':'assistant','content':reply,'tool_calls':[]}],'staff_http_exchanges':[],'untruncated':True,'installed_plugin':{'sha256':'x'},'runtime_readback':{},'final_response':reply}}
   return {'status':200,'raw':json.dumps(parsed).encode(),'headers':{},'elapsed_ms':1,'parsed':parsed}
  with tempfile.TemporaryDirectory() as tmp:
   env={'LUNA_MATRIX_CANDIDATE_SHA':head,'HERMES_MODEL_PROVIDER':'openai-codex','HERMES_MODEL':'gpt-6.1-sol','HERMES_REASONING_EFFORT':'low','LUNA_MATRIX_SIMULATOR_URL':'http://test','LUNA_MATRIX_SIMULATOR_TOKEN':'t','LUNA_V3_HARNESS_TRACE_TOKEN':'t','LUNA_MATRIX_FIXTURE_METADATA':'unused','LUNA_MATRIX_FIXTURE_SHA256':'0'*64,'LUNA_MATRIX_OUTPUT':str(pathlib.Path(tmp)/'result')}
   with mock.patch.dict(os.environ,env,clear=False), mock.patch.object(self.runner,'request',side_effect=fake_request), mock.patch.object(self.runner,'load_owner_fixture',return_value=({'owner_provenance':{}},'0'*64)), mock.patch.object(self.runner,'make_cases',return_value=[case]), mock.patch.object(self.runner,'REPS',1):
    self.assertEqual(0,self.runner.main())
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
  case=semantic_case(); call={'id':'wanted'}
  quote={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,**case['intended_owner_outcome']['facts'],'_tool_call_id':'wanted'}
  good='For 2027-06-01 to 2027-06-08, the Malibu package has a total of EUR 123.45, a deposit of EUR 30.00, and a remaining balance of EUR 93.45.'
  self.assertTrue(self.runner.semantic_score(case,good,[call],[quote],boundary_evidence(call,quote),current_event_id='evt')['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,'EUR 999.99, fully paid and confirmed',[call],[quote],None)['fidelity'])
  refusal_case={'expect':'refusal','prepare_required':True,'intended_owner_outcome':{'expect':'refusal','classification':'availability','allowed_reasons':['minimum_stay'],'next_step':'choose_other_dates'}}
  self.assertFalse(self.runner.semantic_score(refusal_case,'Please choose other dates',[call],[{'ok':False,'reason':'db_error','classification':'availability','next_step':'choose_other_dates','_tool_call_id':'wanted'}],None)['fidelity'])
  fault_case={'expect':'uncertain','prepare_required':True,'fault':'timeout'}
  self.assertFalse(self.runner.semantic_score(fault_case,'I cannot verify',[{}],[{'ok':False}],{'fault':'timeout'})['fidelity'])
  typed_fault={'ok':False,'classification':'transport','call_id':'c','_tool_call_id':'tc'}
  fault_call={'id':'tc'}
  exchange={**boundary_evidence(fault_call,typed_fault,event_id='e',status=503),'fault_requested':'timeout','fault_applied':'timeout','fault_observed':'timeout_exception_raised','original_response_hex':'7b7d','raw_response_hex':'7b7d','exception_type':'TimeoutError'}
  self.assertTrue(self.runner.semantic_score(fault_case,'I cannot verify',[fault_call],[typed_fault],exchange,current_event_id='e')['fidelity'])
  for bad_result,bad_exchange,bad_reply in (
   (typed_fault,{**exchange,'event_id':'wrong'},'I cannot verify'),
   ({**typed_fault,'ok':True},exchange,'I cannot verify'),
   (typed_fault,{**exchange,'original_response_hex':'','raw_response_hex':''},'I cannot verify'),
   (typed_fault,exchange,'I cannot verify. Your confirmed total is EUR 9999 and I booked it.'),
  ):
   self.assertFalse(self.runner.semantic_score(fault_case,bad_reply,[{'id':'tc'}],[bad_result],bad_exchange,current_event_id='e')['fidelity'])
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
  self.assertTrue(self.runner.semantic_score(case,good,[call],[quote,unrelated],boundary_evidence(call,quote),current_event_id='evt')['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,good,[call],[unrelated],None)['fidelity'])
  self.assertFalse(self.runner.semantic_score(case,good+' Booking confirmed.',[call],[quote],None)['fidelity'])
 def test_semantic_oracle_adversarial_and_positive_controls(self):
  case=semantic_case(); call={'id':'wanted'}; facts=case['intended_owner_outcome']['facts']
  quote={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,**facts,'_tool_call_id':'wanted'}
  good='For the Malibu package from 2027-06-01 to 2027-06-08, total EUR 123.45; the deposit is EUR 30.00; the remaining balance is EUR 93.45.'
  paraphrase='Malibu package (2027-06-01 through 2027-06-08): EUR 123.45 total, EUR 30.00 deposit, and balance EUR 93.45.'
  self.assertTrue(self.runner.semantic_score(case,good,[call],[quote],boundary_evidence(call,quote),current_event_id='evt')['fidelity'])
  self.assertTrue(self.runner.semantic_score(case,paraphrase,[call],[quote],boundary_evidence(call,quote),current_event_id='evt')['fidelity'])
  bad_replies=(
   good.replace('Malibu package','Malibu package plus Waimea package'),
   good.replace('total EUR 123.45; the deposit is EUR 30.00','total EUR 30.00; the deposit is EUR 123.45'),
   good+' It includes breakfast.',
   good+' Board rental included.',
   good.replace('2027-06-08','2027-06-09'),
  )
  for bad in bad_replies: self.assertFalse(self.runner.semantic_score(case,bad,[call],[quote],None)['fidelity'],bad)
  for bad in (good.replace('total EUR 123.45','total is NOT EUR 123.45'),good.replace('total EUR 123.45',"total isn't EUR 123.45"),good+' Your total is USD 9999.',good+' Your reservation is confirmed.'):
   self.assertFalse(self.runner.semantic_score(case,bad,[call],[quote],None)['fidelity'],bad)
  refusal_case={'expect':'refusal','prepare_required':True,'intended_owner_outcome':{'expect':'refusal','classification':'availability','allowed_reasons':['minimum_stay'],'next_step':'choose_other_dates'}}
  refusal={'ok':False,'classification':'availability','reason':'minimum_stay','next_step':'choose_other_dates','_tool_call_id':'wanted'}
  self.assertTrue(self.runner.semantic_score(refusal_case,'That stay is too short; please select different dates.',[call],[refusal],boundary_evidence(call,refusal),current_event_id='evt')['fidelity'])
  for bad in ('Hello!','Your reservation is confirmed. Total EUR 9999.'):
   self.assertFalse(self.runner.semantic_score(refusal_case,bad,[call],[refusal],None)['fidelity'],bad)
  for infra in ({**refusal,'reason':'db_error'},{**refusal,'classification':'internal'},{**refusal,'code':'transport_error'}):
   self.assertFalse(self.runner.semantic_score(refusal_case,'Please select different dates.',[call],[infra],None)['fidelity'])
  for fault,classification,observed,status,etype in [('http-422','validation','http_error_read',422,None),('exception','internal','runtime_exception_raised',500,'RuntimeError'),('timeout','transport','timeout_exception_raised',503,'TimeoutError'),('non-json','transport','http_error_json_parse_error',500,None),('malformed','transport','http_error_malformed_shape',500,None)]:
   fault_result={'ok':False,'classification':classification,'call_id':'owner-call','_tool_call_id':'wanted'}
   exchange={**boundary_evidence(call,fault_result,status=status),'original_status':500,'original_response_hex':'7b7d','raw_response_hex':('4341502d4841524e4553532d4e4f4e2d4a534f4e' if fault=='non-json' else '5b5d' if fault=='malformed' else '7b7d'),'fault_requested':fault,'fault_applied':fault,'fault_observed':observed}
   if etype: exchange['exception_type']=etype
   self.assertTrue(self.runner.semantic_score({'prepare_required':True,'fault':fault},'I cannot verify this quote.',[call],[fault_result],exchange,current_event_id='evt')['fidelity'],fault)
   exchange['event_id']='wrong-event'
   self.assertFalse(self.runner.semantic_score({'prepare_required':True,'fault':fault},'I cannot verify this quote.',[call],[fault_result],exchange,current_event_id='evt')['fidelity'],fault)
 def test_fixture_categories_are_bound_to_owner_products_and_canaries(self):
  choices=[{'kind':'accommodation','code':'package_none','active':True,'requirements':{}},{'kind':'package','code':'malibu','active':True,'requirements':{}},{'kind':'rental','code':'board','active':True,'requirements':{'dates':True,'participants':True}},{'kind':'service','code':'group_lesson','product':'group_lesson','active':True,'requirements':{'dates':True,'participants':True}},{'kind':'service','code':'private_lesson','product':'private_lesson','active':True,'requirements':{'dates':True,'participants':True}}]
  snapshot={'ok':True,'revision':'r','choices':choices}
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
  case={'expect':'mixed','prepare_required':True,'intended_owner_outcome':{'expect':'mixed','facts':facts},'_catalog_claim_terms':[{'code':'malibu','terms':['malibu']},{'code':'package_none','terms':['package_none','accommodation only']},{'code':'board','terms':['board','board rental']},{'code':'group_lesson','terms':['group_lesson','group lesson']},{'code':'waimea','terms':['waimea','waimea surf bundle']},{'code':'yoga','terms':['yoga']}]}
  reply='2027-06-01 to 2027-06-08: Alex has the malibu package and 1 board rental on 2027-06-02; Sam has the package_none package. Alex and Sam have 2 group_lesson lessons on 2027-06-03. Total EUR 300.00, deposit EUR 100.00, remaining EUR 200.00.'
  snake={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,'quote':{'facts':copy.deepcopy(facts)},'_tool_call_id':'wanted'}
  camel={'ok':True,'state':'quote','held':False,'booked':False,'paid':False,'data':{'quoteFacts':{'currency':'EUR','totalCents':30000,'depositCents':10000,'remainingCents':20000,'checkIn':'2027-06-01','checkOut':'2027-06-08','packageSelection':{'per_guest':[{'guestIndex':1,'guestName':'Alex','code':'malibu'},{'guestIndex':2,'guestName':'Sam','code':'package_none'}]},'addOns':[{'code':'group_lesson','quantity':2,'days':1,'dates':['2027-06-03'],'participants':['Sam','Alex']},{'code':'board','quantity':1,'dates':['2027-06-02'],'people':['Alex']}],'inclusions':[],'terms':[]}},'_tool_call_id':'wanted'}
  self.assertTrue(self.runner.semantic_score(case,reply,[call],[snake],boundary_evidence(call,snake),current_event_id='evt')['fidelity'])
  self.assertTrue(self.runner.semantic_score(case,reply,[call],[camel],boundary_evidence(call,camel),current_event_id='evt')['fidelity'])
  for bad in (reply.replace(' and 1 board rental on 2027-06-02',''),reply.replace('Alex has the malibu package and 1 board rental on 2027-06-02; Sam has the package_none package','Alex has the package_none package and 1 board rental on 2027-06-02; Sam has the malibu package'),reply+' Waimea package.',reply+' Yoga add-on.',reply+' Yoga is part of this quote.',reply+' This also comes with the Waimea surf bundle.',reply+' Lessons are guaranteed.'):
   self.assertFalse(self.runner.semantic_score(case,bad,[call],[snake],None)['fidelity'],bad)
  swapped=copy.deepcopy(snake); swapped['quote']['facts']['package']['per_guest'][0]['code']='package_none'; swapped['quote']['facts']['package']['per_guest'][1]['code']='malibu'
  self.assertFalse(self.runner.semantic_score(case,reply,[call],[swapped],None)['fidelity'])
  omitted=copy.deepcopy(snake); omitted['quote']['facts']['add_ons'].pop()
  self.assertFalse(self.runner.semantic_score(case,reply,[call],[omitted],None)['fidelity'])
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
   case={'expect':'mixed' if name=='multi' else 'quote','prepare_required':True,'intended_owner_outcome':{'expect':'mixed' if name=='multi' else 'quote','facts':facts}}
   self.assertEqual(self.runner.canonical_facts(facts),self.runner.canonical_facts(result),name)
   self.assertTrue(self.runner.semantic_score(case,reply,[call],[result],boundary_evidence(call,result),current_event_id='evt')['fidelity'],name)
  self.assertEqual('package_none',payload['single']['result']['guests'][0]['package'])
  self.assertEqual(payload['multi']['input']['add_ons'],[
   {'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-02']},
   {'code':'group_lesson','quantity':2,'days':1,'people':['Alex','Sam'],'requested_dates':['2027-06-03']}])
 def test_owner_outcome_must_match_control_and_cover_every_guest(self):
  choices=[{'kind':'accommodation','code':'package_none','active':True,'requirements':{}},{'kind':'package','code':'malibu','active':True,'requirements':{}},{'kind':'rental','code':'board','active':True,'requirements':{'dates':True,'participants':True}},{'kind':'service','code':'group_lesson','active':True,'requirements':{'dates':True,'participants':True}},{'kind':'service','code':'private_lesson','active':True,'requirements':{'dates':True,'participants':True}}]
  snapshot={'ok':True,'revision':'r','choices':choices}
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
