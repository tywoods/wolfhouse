#!/usr/bin/env python3
"""Portable replay of all 262 frozen independent expectations. No model/network."""
import copy,importlib.util,json,pathlib,sys,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts/lib'))
from luna_v3_grader_test_support import produce,TEST_AUTHORITY
from luna_v3_rendered_claims import reply_truth
spec=importlib.util.spec_from_file_location('independent_claim_matrix',ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class FrozenIndependentClaims(unittest.TestCase):
 def test_all_262_frozen_expectations_direct_and_composed(self):
  data=json.loads((ROOT/'fixtures/luna-v3-grader-owner/independent-claims.json').read_text())
  self.assertEqual(len(data['rows']),262)
  contexts={}
  for kind,ctx in data['contexts'].items():
   call,result,exchange=produce(ctx['arguments'],ctx['owner'],status=ctx['status'],event_id='frozen-independent-event',session=TEST_AUTHORITY['session_id'])
   case={'expect':ctx['outcome']['expect'],'prepare_required':True,'intended_owner_outcome':ctx['outcome'],'_expected_authority':dict(TEST_AUTHORITY)}
   facts=m.canonical_facts(ctx['owner']) if ctx['owner'].get('facts') else None
   contexts[kind]=(case,facts,call,result,exchange)
  contexts['clarification']=({'expect':'clarification','prepare_required':False,'intended_owner_outcome':{'expect':'clarification'}},None,None,None,None)
  for row in data['rows']:
   with self.subTest(category=row['category'],label=row['label']):
    case,facts,call,result,exchange=contexts[row['category']]
    actual=reply_truth(row['reply'],case['intended_owner_outcome'],facts,result)
    self.assertIs(actual,row['expected'],'direct: '+row['reply'])
    score=m.semantic_score(case,row['reply'],[call] if call else [],[result] if result else [],exchange,current_event_id='frozen-independent-event',expected_authority=dict(TEST_AUTHORITY))
    self.assertIs(score['clarification'] if row['category']=='clarification' else score['fidelity'],row['expected'],'composed: '+row['reply'])
if __name__=='__main__':unittest.main(verbosity=2)
