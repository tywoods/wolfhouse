#!/usr/bin/env python3
"""Offline replay of copied Cap R3 probe intents against the R4 candidate.

The frozen R3 assumptions are exercised first and expected to be incompatible.
The separate adapter then owner-generates signed v3 receipts; no sealed packet file
is edited or represented as passing under its obsolete assumptions.
"""
import copy, importlib.util, json, os, pathlib, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
KEY='offline-owner-receipt-test-key-32-bytes-minimum'
os.environ['LUNA_OWNER_RECEIPT_VERIFIER_KEY']=KEY

def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path); mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod
candidate=load('candidate',ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py')
harness=load('candidate_harness',ROOT/'scripts/test-luna-v3-rendered-reply-harness.py')
fixture=harness.owner_fixture()
choices=[{'kind':'accommodation','code':'package_none','active':True},{'kind':'package','code':'malibu','active':True},{'kind':'rental','code':'board','active':True},{'kind':'service','code':'group_lesson','active':True},{'kind':'service','code':'private_lesson','active':True}]
snapshot={'ok':True,'revision':'r','choices':choices}
rows=[]

def probe(label,fn,expected):
 try: fn(); actual='zero'
 except (SystemExit,subprocess.CalledProcessError) as exc: actual='nonzero'; detail=str(exc)
 except Exception as exc: actual='nonzero'; detail=f'{type(exc).__name__}: {exc}'
 else: detail='completed'
 rows.append({'label':label,'expected_exit':expected,'actual_exit':actual,'pass':actual==expected,'detail':detail})

# Copy of the R3 control premise: unsigned/no-receipt fixture admission. R4 must reject it.
def original_controls():
 old=copy.deepcopy(fixture)
 for case in old['cases']: case.pop('owner_execution_receipt',None)
 candidate.make_cases(snapshot,old)
probe('ORIGINAL_R3_UNCHANGED_controls_unsigned_receipts',original_controls,'nonzero')

# Explicit R4 adapter: owner_fixture generated every receipt through `generate` using
# LUNA_OWNER_RECEIPT_ISSUER_KEY; candidate receives only verifier authority.
adapted=None
def adapted_controls():
 global adapted
 adapted=candidate.make_cases(snapshot,copy.deepcopy(fixture))
 assert {c['category'] for c in adapted} >= {'accommodation','package','rental','service:lesson_a','service:lesson_b','mixed','multi_guest','continuation'}
probe('ADAPTED_R4_controls_signed_v3',adapted_controls,'zero')

def owner_normalization():
 assert adapted
 for case in adapted:
  if case['expect']!='clarification': assert isinstance(case.get('_owner_normalized_control'),dict)
probe('ADAPTED_R4_owner_normalization',owner_normalization,'zero')

def followups():
 c=next(x for x in adapted if x['category']=='continuation')
 assert c['correction_prompt'] and c['corrected_control'] and c['corrected_owner_outcome']
probe('ADAPTED_R4_followups',followups,'zero')

def scorer_packet():
 subprocess.run([sys.executable,str(ROOT/'scripts/test-luna-v3-rootfix-r4.py')],cwd=ROOT,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
probe('ADAPTED_R4_scorer_packet_mechanical',scorer_packet,'zero')

def fault_packet():
 case={'expect':'uncertain','prepare_required':True,'fault':'timeout'}
 # The packet-compatible assertion is also executed by RootFixR4; ensure assembled
 # fault metadata remains accepted only with exact timeout evidence.
 result={'ok':False,'classification':'transport','call_id':'owner','_tool_call_id':'tc'}
 call={'id':'tc','function':{'name':'check_quote_book','arguments_parsed':{'action':'prepare'}}}
 raw=json.dumps({'ok':True}).encode().hex()
 ex={'tool':'check_quote_book','call_id':'owner','event_id':'evt','status':503,'original_status':200,'request':{'action':'prepare'},'fault_requested':'timeout','fault_applied':'timeout','fault_observed':'timeout_exception_raised','exception_type':'TimeoutError','original_response_hex':raw,'raw_response_hex':raw}
 assert candidate.semantic_score(case,'I cannot verify this quote right now.',[call],[result],ex,current_event_id='evt')['fidelity']
probe('ADAPTED_R4_fault_producer_packet_mechanical',fault_packet,'zero')
print(json.dumps({'schema':'cap-r3-to-r4-replay/v1','original_sealed_inputs_modified':False,'rows':rows,'pass':all(r['pass'] for r in rows)},indent=2))
raise SystemExit(0 if all(r['pass'] for r in rows) else 1)
