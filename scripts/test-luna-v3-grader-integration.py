#!/usr/bin/env python3
"""Grader composition regressions; offline boundary doubles are labelled, not live proof."""
import copy
import importlib.util
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('grader_integration_matrix', ROOT / 'scripts/run-luna-v3-rendered-reply-matrix.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class Composition(unittest.TestCase):
    def run_clarification(self, reply):
        case = {'id':'clarification','category':'clarification','prompt':'Hello','prepare_required':False,
                'continuation':False,'expect':'clarification','intended_owner_outcome':{'expect':'clarification'}}
        head = subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
        def wire(url,token,trace,payload,**kwargs):
            if url.endswith('/preflight'):
                body={'ok':True,'effective_model':m.EXPECTED,'fallback_possible':False,
                      'pins':{k:(head if k=='candidate_sha' else 'offline-test-pin') for k in ('candidate_sha','image_digest','base_image_digest','instruction_sha256','plugin_sha256','contract_sha256')},
                      'staff_admission':{'capability_snapshot':{'revision':'offline'}}}
            elif url.endswith('/state'):
                body={'ok':True,'schema':'luna-v3-test-state/v1','authenticated':True,'tenant':'wolfhouse-somo','thread':payload['thread'],**{k:0 for k in m.STATE_FIELDS}}
            else:
                body={'reply_text':reply,'external_send_allowed':False,'staff_alert_allowed':False,
                      'harness_trace':{'final_response':reply,'untruncated':True,'inbound_event_id':'offline-event',
                      'messages':[{'role':'user','content':'Hello'},{'role':'assistant','content':reply}],
                      'staff_http_exchanges':[],'installed_plugin':{'sha256':'offline-plugin'},'runtime_readback':{}}}
            raw=json.dumps(body).encode()
            return {'status':200,'raw':raw,'headers':{},'elapsed_ms':0,'parsed':body}
        with tempfile.TemporaryDirectory() as temp:
            env={'LUNA_MATRIX_CANDIDATE_SHA':head,'HERMES_MODEL_PROVIDER':m.EXPECTED['provider'],
                 'HERMES_MODEL':m.EXPECTED['model'],'HERMES_REASONING_EFFORT':m.EXPECTED['reasoning'],
                 'HERMES_TEMPERATURE':m.EXPECTED['temperature'],'HERMES_FALLBACK_MODEL':'',
                 'LUNA_MATRIX_SIMULATOR_URL':'http://offline.invalid','LUNA_MATRIX_SIMULATOR_TOKEN':'offline-test',
                 'LUNA_V3_HARNESS_TRACE_TOKEN':'offline-test','LUNA_MATRIX_OUTPUT':temp+'/out',
                 'LUNA_MATRIX_FIXTURE_METADATA':temp+'/not-read','LUNA_MATRIX_FIXTURE_SHA256':'0'*64}
            with mock.patch.dict(os.environ,env), mock.patch.object(m,'request',wire), mock.patch.object(m,'make_cases',return_value=[case]), mock.patch.object(m,'load_owner_fixture',return_value=({'owner_provenance':{}},'0'*64)):
                exit_code=m.main()
            return exit_code,json.loads(pathlib.Path(temp+'/out/results.json').read_text())
    def test_honest_clarification_main_passes(self):
        code,result=self.run_clarification('Which dates would you like?')
        self.assertEqual(code,0)
        self.assertTrue(result['pass'])
    def test_clarification_main_enforces_truth_not_just_question_mark(self):
        for reply in ('Your reservation is confirmed. Which dates would you like?',
                      'We received your payment. Which dates would you like?',
                      'Your total is NZD 9999. Which dates would you like?'):
            with self.subTest(reply=reply):
                code,result=self.run_clarification(reply)
                self.assertEqual(code,1)
                self.assertTrue(all(not r['checks']['all_semantic_scores_pass'] for r in result['records']))
    def test_addon_order_is_semantically_equivalent_after_owner_normalization(self):
        choices=[{'kind':'package','code':'malibu','active':True}, {'kind':'rental','code':'board','active':True}, {'kind':'service','code':'group_lesson','active':True}]
        control={'check_in':'2027-06-01','check_out':'2027-06-08','guests':[{'name':'Alex'}],'room':{'kind':'shared'},'package':'malibu','add_ons':[{'code':'board','quantity':1,'people':['Alex'],'dates':['2027-06-02']},{'code':'group_lesson','quantity':1,'people':['Alex'],'dates':['2027-06-03']}]}
        request=m._public_prepare(control)
        self.assertTrue(m.control_matches_prepare(control,request,choices))
        request['add_ons'].reverse()
        self.assertTrue(m.control_matches_prepare(control,request,choices))
        request['purpose']='offer'
        self.assertFalse(m.control_matches_prepare(control,request,choices))

if __name__=='__main__': unittest.main(verbosity=2)
