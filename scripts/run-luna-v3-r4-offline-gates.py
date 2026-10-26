#!/usr/bin/env python3
import json, pathlib, subprocess, sys
root=pathlib.Path(__file__).resolve().parents[1]
out=root/'artifacts/SKIP-V3-PR1426-ROOTFIX-R4-20261026T0352'
commands={
 'harness':([sys.executable,'scripts/test-luna-v3-rendered-reply-harness.py'],'harness.log'),
 'rootfix-r4':([sys.executable,'scripts/test-luna-v3-rootfix-r4.py'],'green.log'),
 'plugin':([sys.executable,'-m','unittest','-v','docker/hermes-luna-v3/plugins/luna_v3_staff_api/test_plugin.py'],'plugin.log'),
 'simulator-startup-discover':([sys.executable,'-m','unittest','discover','-v','-s','docker/hermes-luna-v3/tests'],'simulator-startup.log'),
 'lifecycle':(['node','scripts/lib/model-led-luna/test-prepare-lifecycle.js'],'lifecycle.log'),
 'routes':(['node','scripts/lib/model-led-luna/test-staff-routes.js'],'routes.log'),
 'fix1':(['node','scripts/verify-luna-v3-cap-fix1.js'],'fix1.log'),
 'public-quote-owner':(['node','scripts/test-luna-v3-public-quote-owner.js'],'public-quote-owner.log'),
 'staff-contract':(['node','scripts/lib/model-led-luna/test-contracts.js'],'staff-contract.log'),
 'cap-r3-replay-r4':([sys.executable,'scripts/replay-luna-v3-cap-r3-probes-r4.py'],'cap-r3-replay-r4.log'),
 'git-diff-check':(['git','diff','--check'],'diff-check.log')}
exits={}
for name,(command,logname) in commands.items():
 p=subprocess.run(command,cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 (out/logname).write_text('COMMAND: '+' '.join(command)+'\n'+p.stdout+'\nEXIT: '+str(p.returncode)+'\n')
 exits[name]=p.returncode
 print(name,p.returncode)
(out/'test-exits.json').write_text(json.dumps(exits,indent=2,sort_keys=True)+'\n')
(out/'offline-gate-exits.json').write_text(json.dumps({k:v for k,v in exits.items() if k not in ('harness','rootfix-r4','plugin','cap-r3-replay-r4')},indent=2,sort_keys=True)+'\n')
raise SystemExit(0 if all(v==0 for v in exits.values()) else 1)
