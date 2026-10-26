#!/usr/bin/env python3
"""R6 SAFE OFFLINE gates, including an exact e0e9c38 source replay."""
import hashlib, json, os, pathlib, shutil, subprocess, sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
OUT=ROOT/'artifacts/SKIP-V3-PR1426-ROOTFIX-R6-20261026T051433Z'
BASE='e0e9c38ce59b33e965263a666a47861a6a177e66'
OUT.mkdir(parents=True,exist_ok=True)
base_root=OUT/'base-e0e9c38-source'; shutil.rmtree(base_root,ignore_errors=True)
base_matrix=base_root/'scripts/run-luna-v3-rendered-reply-matrix.py'
base_cli=base_root/'scripts/lib/model-led-luna/staff-request-normalize-cli.js'
for rel,dest in (('scripts/run-luna-v3-rendered-reply-matrix.py',base_matrix),('scripts/lib/model-led-luna/staff-request-normalize-cli.js',base_cli),('scripts/lib/model-led-luna/staff-request-contract.js',base_root/'scripts/lib/model-led-luna/staff-request-contract.js'),('docker/hermes-luna-v3/contracts/check_quote_book.schema.json',base_root/'docker/hermes-luna-v3/contracts/check_quote_book.schema.json')):
 dest.parent.mkdir(parents=True,exist_ok=True)
 got=subprocess.run(['git','show',f'{BASE}:{rel}'],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if got.returncode: raise SystemExit(f'cannot extract exact base {rel}: {got.stderr.decode()}')
 dest.write_bytes(got.stdout)

def run(name,cmd,log,env=None):
 p=subprocess.run(cmd,cwd=ROOT,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=env)
 (OUT/log).write_text('COMMAND: '+' '.join(map(str,cmd))+'\n'+p.stdout+'\nEXIT: '+str(p.returncode)+'\n')
 print(name,p.returncode); return p.returncode,p.stdout
base_env={**os.environ,'MATRIX_SOURCE':str(base_matrix)}
base_code,base_text=run('base-e0e9c38-red',[sys.executable,'-B','scripts/test-luna-v3-rootfix-r6.py'],'base-e0e9c38-red.log',base_env)
commands={
 'rootfix-r6':([sys.executable,'-B','scripts/test-luna-v3-rootfix-r6.py'],'candidate-r6.log'),
 'rendered-harness':([sys.executable,'-B','scripts/test-luna-v3-rendered-reply-harness.py'],'rendered-harness.log'),
 'plugin':([sys.executable,'-B','-m','unittest','-v','docker/hermes-luna-v3/plugins/luna_v3_staff_api/test_plugin.py'],'plugin.log'),
 'simulator-startup':([sys.executable,'-B','-m','unittest','discover','-v','-s','docker/hermes-luna-v3/tests'],'simulator-startup.log'),
 'lifecycle':(['node','scripts/lib/model-led-luna/test-prepare-lifecycle.js'],'lifecycle.log'),
 'routes':(['node','scripts/lib/model-led-luna/test-staff-routes.js'],'routes.log'),
 'fix1':(['node','scripts/verify-luna-v3-cap-fix1.js'],'fix1.log'),
 'public-quote-owner':(['node','scripts/test-luna-v3-public-quote-owner.js'],'public-quote-owner.log'),
 'staff-contract':(['node','scripts/lib/model-led-luna/test-contracts.js'],'staff-contract.log')}
exits={};
for name,(cmd,log) in commands.items(): exits[name]=run(name,cmd,log)[0]
base_failures=base_text.count('\nFAIL:'); base_errors=base_text.count('\nERROR:')
summary={'schema':'luna-v3-r6-safe-offline/v1','base_sha':BASE,'base_replay_exit':base_code,'base_failure_blocks':base_failures,'base_error_blocks':base_errors,'candidate_gates':exits,'assertion_instances':77,'request_kinds':7,'offline_only':True,'real_owner_proof':False,'live_model_proof':False}
(OUT/'offline-gate-exits.json').write_text(json.dumps(summary,indent=2,sort_keys=True)+'\n')
files=sorted(p for p in OUT.rglob('*') if p.is_file() and p.name!='SHA256SUMS')
(OUT/'SHA256SUMS').write_text(''.join(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.relative_to(ROOT)}\n" for p in files))
raise SystemExit(0 if base_code!=0 and base_failures==28 and base_errors==0 and all(v==0 for v in exits.values()) else 1)
