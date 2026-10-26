#!/usr/bin/env python3
"""Offline-only R5 gates; deliberately contains no network or model execution."""
import json, pathlib, subprocess, sys
root=pathlib.Path(__file__).resolve().parents[1]
out=root/'artifacts/SKIP-V3-PR1426-ROOTFIX-R5-20261026T0534'; out.mkdir(parents=True,exist_ok=True)
commands={
 'rootfix-r5':([sys.executable,'-B','scripts/test-luna-v3-rootfix-r5.py'],'green.log'),
 'rendered-harness':([sys.executable,'-B','scripts/test-luna-v3-rendered-reply-harness.py'],'rendered-harness.log'),
 'plugin':([sys.executable,'-B','-m','unittest','-v','docker/hermes-luna-v3/plugins/luna_v3_staff_api/test_plugin.py'],'plugin.log'),
 'simulator-startup':([sys.executable,'-B','-m','unittest','discover','-v','-s','docker/hermes-luna-v3/tests'],'simulator-startup.log'),
 'lifecycle':(['node','scripts/lib/model-led-luna/test-prepare-lifecycle.js'],'lifecycle.log'),
 'routes':(['node','scripts/lib/model-led-luna/test-staff-routes.js'],'routes.log'),
 'fix1':(['node','scripts/verify-luna-v3-cap-fix1.js'],'fix1.log'),
 'public-quote-owner':(['node','scripts/test-luna-v3-public-quote-owner.js'],'public-quote-owner.log'),
 'staff-contract':(['node','scripts/lib/model-led-luna/test-contracts.js'],'staff-contract.log')}
exits={}
for name,(cmd,log) in commands.items():
 p=subprocess.run(cmd,cwd=root,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 (out/log).write_text('COMMAND: '+' '.join(cmd)+'\n'+p.stdout+'\nEXIT: '+str(p.returncode)+'\n')
 exits[name]=p.returncode; print(name,p.returncode)
(out/'offline-gate-exits.json').write_text(json.dumps(exits,indent=2,sort_keys=True)+'\n')
raise SystemExit(0 if all(v==0 for v in exits.values()) else 1)
