#!/usr/bin/env python3
"""Composed TEST proof: real owner receipt admission -> actual plugin -> actual matrix.

Transport and rendered replies are explicit offline test doubles. The input Staff
bodies/owner signatures must come from run-luna-v3-r7-real-owner.js. No model proof.
"""
import copy, hashlib, importlib.util, json, os
from pathlib import Path
import subprocess, sys, tempfile, unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/lib'))
from luna_v3_grader_test_support import produce
spec=importlib.util.spec_from_file_location('pipeline_matrix',ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py')
assert spec and spec.loader
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
OWNER=Path(os.environ.get('LUNA_GRADER_OWNER_EVIDENCE',str(ROOT/'fixtures/luna-v3-grader-owner')))
OUT=Path(os.environ.get('LUNA_GRADER_PIPELINE_OUTPUT',str(ROOT/'artifacts/cap-grader-pipeline')))


def quote_reply(facts):
    parts=[f"{facts['check_in']} to {facts['check_out']}"]
    p=facts['package']
    if 'per_guest' in p:parts.extend(f"{r['name']}: {r['code']}" for r in p['per_guest'])
    else:parts.append(p['code'])
    for a in facts['add_ons']:parts.append(f"{', '.join(a['people'])}: {a['quantity']} {a['code']} on {', '.join(a['dates'])}")
    parts.append('Total EUR %.2f, deposit EUR %.2f, remaining EUR %.2f'%(facts['total_cents']/100,facts['deposit_cents']/100,facts['remaining_cents']/100))
    parts.extend('Includes: '+x for x in facts['inclusions'])
    parts.extend('Terms: '+x for x in facts['terms'])
    return '. '.join(parts)+'.'

class Pipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture=json.loads((OWNER/'matrix-fixture.json').read_text())
        cls.snapshot=json.loads((OWNER/'capability-snapshot.raw.json').read_text())
        cls.cases=m.make_cases(cls.snapshot,cls.fixture)
        cls.evidence=[]
    @classmethod
    def tearDownClass(cls):
        OUT.mkdir(parents=True,exist_ok=True)
        (OUT/'pipeline-receipts.json').write_text(json.dumps(cls.evidence,indent=2)+'\n')
    def test_actual_owner_admits_all_categories_without_normalizer_issuance(self):
        self.assertEqual(len(self.cases),14)
        for c in self.cases:
            self.assertEqual(c['_owner_http_provenance']['source'],'test-staff-http')
            if c['category'] in ('rental','service:lesson_a','service:lesson_b'):
                self.assertEqual(c['control']['package'],'package_none')
        c=next(c for c in self.cases if c['continuation'])
        self.assertIsNone(c['_owner_normalized_control'])
        self.assertNotEqual(c['_owner_http_provenance']['event_id'],c['_owner_http_provenance']['corrected_event_id'])
        control=m._public_prepare(c['control'])
        self.assertTrue(m.control_matches_prepare(c['control'],control,c['_owner_choices']))
        control['add_ons'][0]['quantity']+=1
        self.assertFalse(m.control_matches_prepare(c['control'],control,c['_owner_choices']))
    def test_real_receipts_reject_fictional_claims_and_category_or_session_changes(self):
        for category in ('accommodation','package','rental','service:lesson_a','service:lesson_b','mixed','multi_guest'):
            for key,value in [('currency','XYZ'),('total_cents',999999),('inclusions',['invented breakfast']),('terms',['invented cancellation'])]:
                f=copy.deepcopy(self.fixture);c=next(c for c in f['cases'] if c['category']==category);c['intended_owner_outcome']['facts'][key]=value
                with self.subTest(category=category,field=key),self.assertRaises(SystemExit):m.make_cases(self.snapshot,f)
        for mutate in (lambda c:c.update(category='rental'),lambda c:c['owner_execution_receipt']['correction']['prepare'].update(body='{}')):
            f=copy.deepcopy(self.fixture);c=next(c for c in f['cases'] if c['category']=='continuation');mutate(c)
            with self.assertRaises(SystemExit):m.make_cases(self.snapshot,f)
    def execute_main(self,mutation=None,selected=None):
        # This uses genuine signed owner fixture admission, NOT a make_cases mock.
        fixture=copy.deepcopy(self.fixture);head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
        cases=self.cases;calls={};pending={};evidence=[]
        def wire(url,token,trace,payload,**kw):
            if url.endswith('/preflight'):
                body={'ok':True,'effective_model':m.EXPECTED,'fallback_possible':False,'staff_admission':{'capability_snapshot':self.snapshot},
                      'pins':{k:head if k=='candidate_sha' else 'offline-component-proof' for k in ('candidate_sha','image_digest','base_image_digest','instruction_sha256','plugin_sha256','contract_sha256')}}
            elif url.endswith('/state'):
                body={'ok':True,'schema':'luna-v3-test-state/v1','authenticated':True,'tenant':'wolfhouse-somo','thread':payload['thread'],**{k:0 for k in m.STATE_FIELDS}}
            else:
                phone=payload['thread'];corrected=bool(payload.get('refusal_correction'));case=pending[phone] if corrected else cases[(int(phone[-5:])-1)//m.REPS]
                pending[phone]=case
                event='offline-'+hashlib.sha256((phone+payload['text']).encode()).hexdigest()[:24]
                session='luna-v3:'+hashlib.sha256(phone.encode()).hexdigest()[:24]
                messages=[{'role':'user','content':payload['text']}];exchanges=[]
                if case['category']=='clarification':reply='Would you prefer a private or shared room?'
                else:
                    control=case['corrected_control'] if corrected else case['control']
                    capture=case['owner_execution_receipt']['correction' if corrected else 'evidence']['prepare']
                    call,result,exchange=produce(m._public_prepare(control),raw=capture['body'].encode(),status=capture['status'],event_id=event,session=session,fault=kw.get('fault') or '')
                    messages.extend([{'role':'assistant','tool_calls':[call]},{'role':'tool','tool_call_id':call['id'],'content_parsed':{k:v for k,v in result.items() if k!='_tool_call_id'}}]);exchanges=[exchange]
                    if case.get('fault') and not corrected:reply='I am unable to verify the quote.'
                    elif result.get('ok') is False:reply='That quantity is invalid. Please correct your request.'
                    else:reply=quote_reply(m.canonical_facts(result))
                if mutation and case['category'] in (selected or {c['category'] for c in cases}):reply=mutation(reply,case,exchanges,messages)
                messages.append({'role':'assistant','content':reply})
                body={'reply_text':reply,'thread':phone,'session_id':session.replace(':','-',1),'external_send_allowed':False,'staff_alert_allowed':False,
                      'harness_trace':{'messages':messages,'staff_http_exchanges':exchanges,'untruncated':True,'final_response':reply,'inbound_event_id':event,
                      'installed_plugin':{'sha256':'offline-actual-plugin'},'runtime_readback':m.EXPECTED,'continuation_consumed':corrected}}
                if case['continuation'] and not corrected:body['continuation_ref']='offline-one-use-'+phone
                evidence.append({'case':case['id'],'corrected':corrected,'response':body})
            return {'status':200,'elapsed_ms':0,'headers':{},'parsed':body,'raw':json.dumps(body).encode()}
        with tempfile.TemporaryDirectory() as temp:
            env={'LUNA_MATRIX_CANDIDATE_SHA':head,'HERMES_MODEL_PROVIDER':m.EXPECTED['provider'],'HERMES_MODEL':m.EXPECTED['model'],'HERMES_REASONING_EFFORT':m.EXPECTED['reasoning'],'HERMES_TEMPERATURE':m.EXPECTED['temperature'],'HERMES_FALLBACK_MODEL':'',
                 'LUNA_MATRIX_SIMULATOR_URL':'http://offline.invalid','LUNA_MATRIX_SIMULATOR_TOKEN':'offline-test','LUNA_V3_HARNESS_TRACE_TOKEN':'offline-test','LUNA_MATRIX_FIXTURE_METADATA':str(OWNER/'matrix-fixture.json'),
                 'LUNA_MATRIX_FIXTURE_SHA256':hashlib.sha256((OWNER/'matrix-fixture.json').read_bytes()).hexdigest(),'LUNA_MATRIX_OUTPUT':temp+'/matrix'}
            with patch.dict(os.environ,env),patch.object(m,'request',wire):code=m.main()
            result=json.loads(Path(temp+'/matrix/results.json').read_text())
        self.evidence.append({'evidence_scope':'real signed owner fixture; actual plugin; offline transport/state/replies, no model', 'exit':code,'results':result,'calls':evidence})
        return code,result
    def test_full_matrix_genuine_owner_bodies_and_honest_replies(self):
        code,result=self.execute_main()
        bad=[{'case':r['case']['id'],'rep':r['repetition'],'failed':[k for k,v in r['checks'].items() if not v],'scores':r['semantic_score']} for r in result['records'] if r['verdict']!='PASS']
        self.assertEqual(code,0,json.dumps(bad,indent=2))
        self.assertEqual(len(result['records']),42)
    def test_booking_payment_currency_claims_fail_across_every_kind(self):
        for suffix in (' Your reservation is confirmed.',' We received your payment.',' Your total is NZD 9999.'):
            code,result=self.execute_main(lambda reply,*_:reply+suffix)
            self.assertEqual(code,1)
            self.assertTrue(all(r['verdict']=='FAIL' for r in result['records']))
    def test_coherent_foreign_session_receipt_fails_in_main(self):
        def mutate(reply,case,exchanges,messages):
            for e in exchanges:e['trusted_authority']['session_id']='luna-v3:foreign';e['request']['session_id']='luna-v3:foreign'
            return reply
        code,result=self.execute_main(mutate)
        self.assertEqual(code,1)
        self.assertTrue(all(r['verdict']=='FAIL' for r in result['records'] if r['case']['prepare_required']))

if __name__=='__main__':unittest.main(verbosity=2)
