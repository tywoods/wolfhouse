#!/usr/bin/env python3
"""Replay frozen R4/R5 evidence through current consumers. No network/model/owner admission.

All loaded case/body bytes stay unchanged. This is a historical consumer replay,
NOT current owner-admission proof. Legacy schema failures are retained, not waived.
"""
import argparse, collections, contextlib, copy, hashlib, importlib.util, io, json, os
from pathlib import Path
import subprocess, tarfile
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('replay_matrix',ROOT/'scripts/run-luna-v3-rendered-reply-matrix.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

def main_case(case,body,out):
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
    def request(url,token,trace,payload,**kwargs):
        if url.endswith('/preflight'):
            data={'ok':True,'effective_model':m.EXPECTED,'fallback_possible':False,
                  'pins':{k:head if k=='candidate_sha' else 'offline-only' for k in ('candidate_sha','image_digest','base_image_digest','instruction_sha256','plugin_sha256','contract_sha256')},
                  'staff_admission':{'capability_snapshot':{'revision':'offline-replay'}}}
        elif url.endswith('/state'):
            data={'ok':True,'schema':'luna-v3-test-state/v1','authenticated':True,'tenant':'wolfhouse-somo','thread':payload['thread'],**{k:0 for k in m.STATE_FIELDS}}
        else:data=copy.deepcopy(body)
        return {'status':200,'raw':json.dumps(data).encode(),'parsed':data,'headers':{},'elapsed_ms':0}
    env={'LUNA_MATRIX_CANDIDATE_SHA':head,'HERMES_MODEL_PROVIDER':m.EXPECTED['provider'],'HERMES_MODEL':m.EXPECTED['model'],
         'HERMES_REASONING_EFFORT':m.EXPECTED['reasoning'],'HERMES_TEMPERATURE':m.EXPECTED['temperature'],'HERMES_FALLBACK_MODEL':'',
         'LUNA_MATRIX_SIMULATOR_URL':'http://offline.invalid','LUNA_MATRIX_SIMULATOR_TOKEN':'offline-test','LUNA_V3_HARNESS_TRACE_TOKEN':'offline-test',
         'LUNA_MATRIX_FIXTURE_METADATA':'not-read','LUNA_MATRIX_FIXTURE_SHA256':'0'*64,'LUNA_MATRIX_OUTPUT':str(out)}
    with patch.dict(os.environ,env), patch.object(m,'request',request),patch.object(m,'load_owner_fixture',return_value=({'owner_provenance':{'evidence':'offline replay, admission mocked'}},'0'*64)),patch.object(m,'make_cases',return_value=[copy.deepcopy(case)]),patch.object(m,'REPS',1),contextlib.redirect_stdout(io.StringIO()):
        code=m.main()
    record=json.loads((out/'results.json').read_text())['records'][0]
    return {'exit':code,'verdict':record['verdict'],'checks':record['checks'],'semantic':record['semantic_score']}

def run(r5,out):
    out.mkdir(parents=True,exist_ok=False)
    rows=[]
    sources=[('frozen-r4',r5/'independent-scorer-r5/frozen-r4-receipts.tar.xz',None),
             ('frozen-r5',r5/'independent-scorer-r5/raw-main-receipts.tar.gz','r5-main/')]
    for suite,path,prefix in sources:
        with tarfile.open(path) as archive:
            for member in archive:
                if not member.isfile() or not member.name.endswith('/inputs.json') or (prefix and not member.name.startswith(prefix)):continue
                raw=archive.extractfile(member).read(); data=json.loads(raw)
                dest=out/suite/member.name;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw)
                body=data['body'];case=data['case'];trace=body.get('harness_trace',{})
                event={'event_id':trace.get('inbound_event_id'),'response':body}
                item={'suite':suite,'input':member.name,'sha256':hashlib.sha256(raw).hexdigest(),
                      'category':case['category'],'event_scores':m.score_events(case,[event]),
                      'main':main_case(case,body,dest.parent/'current-main')}
                assert dest.read_bytes()==raw,'frozen input changed'
                rows.append(item)
    consumers=json.loads((r5/'independent-faults-r5/consumer.json').read_text())
    for item in consumers:
        scores=m.score_events(item['case'],[item['event']])
        rows.append({'suite':'frozen-r5-consumers','label':item['label'],'expected':item['expected_fidelity'],'event_scores':scores})
    summary={'evidence_scope':'unchanged historical post-admission replay; no model/HTTP/DB proof',
             'counts':dict(collections.Counter(r['suite'] for r in rows)),
             'consumer_disagreements':[{'label':r['label'],'expected':r['expected'],'actual':r['event_scores'][0]['semantic']['fidelity']} for r in rows if 'expected' in r and r['expected']!=r['event_scores'][0]['semantic']['fidelity']]}
    (out/'receipts.json').write_text(json.dumps(rows,indent=2)+'\n');(out/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
    print(json.dumps(summary,indent=2))
    assert summary['counts']['frozen-r4']==230
    assert summary['counts']['frozen-r5']==257
    return 0

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--r5-evidence',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();raise SystemExit(run(a.r5_evidence.resolve(),a.output.resolve()))
