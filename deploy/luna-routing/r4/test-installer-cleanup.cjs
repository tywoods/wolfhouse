'use strict';
const assert=require('node:assert/strict'); const cp=require('node:child_process'); const fs=require('node:fs'); const os=require('node:os'); const path=require('node:path');
const installer=fs.readFileSync(path.join(__dirname,'..','install-luna-routing.sh'),'utf8');
const start=installer.indexOf('rollback_failure=0; controller_stop_unconfirmed=0'); const end=installer.indexOf('trap cleanup EXIT;',start);
assert.ok(start>0&&end>start); const cleanup=installer.slice(start,end);
for(const scenario of ['stop-fail','inactive-unconfirmed']){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),`installer-${scenario}-`)), backup=path.join(d,'backup'), stage=path.join(d,'stage'); fs.mkdirSync(backup);fs.mkdirSync(stage);
 const caddy=path.join(d,'Caddyfile'), controller=path.join(d,'controller'); fs.writeFileSync(caddy,'new-caddy');fs.writeFileSync(controller,'new-controller');fs.writeFileSync(path.join(backup,'Caddyfile'),'old-caddy');fs.writeFileSync(path.join(backup,'controller'),'old-controller');
 const mock=path.join(d,'systemctl'); fs.writeFileSync(mock,`#!/bin/sh\necho "$*" >>${JSON.stringify(path.join(d,'calls'))}\nif [ "$1" = stop ]; then ${scenario==='stop-fail'?'exit 7':'exit 0'}; fi\nif [ "$1" = is-active ]; then echo failed; exit 3; fi\nexit 0\n`,{mode:0o755});
 let body=cleanup.replaceAll('/usr/bin/systemctl',mock);
 const vars=`stage=${JSON.stringify(stage)}; backup=${JSON.stringify(backup)}; committed=0; mutations_started=1; service_commands_started=1; unit_was_present=0; unit_was_enabled=0; unit_was_active=0;\ndest_Caddyfile=${JSON.stringify(caddy)}; backup_Caddyfile=${JSON.stringify(path.join(backup,'Caddyfile'))}; dest_controller=${JSON.stringify(controller)}; backup_controller=${JSON.stringify(path.join(backup,'controller'))};\nfor p in fragment env unit sudoers tmpfiles; do eval dest_$p=; eval backup_$p=; done\n`;
 const script=path.join(d,'case.sh'); fs.writeFileSync(script,`#!/bin/sh\n${vars}\n${body}\ntrap cleanup EXIT\nexit 17\n`,{mode:0o755});
 const out=cp.spawnSync(script,{encoding:'utf8'}); assert.equal(out.status,2,`${scenario}: ${out.stderr}`); assert.match(out.stderr,/ROLLBACK INCOMPLETE/); assert.match(out.stderr,/retaining controller artifacts/); assert.equal(fs.readFileSync(caddy,'utf8'),'old-caddy'); assert.equal(fs.readFileSync(controller,'utf8'),'new-controller'); assert.ok(fs.existsSync(backup)); const calls=fs.readFileSync(path.join(d,'calls'),'utf8'); assert.match(calls,/reload caddy/); assert.doesNotMatch(calls,/disable luna-routing/);
}
console.log('PASS real corrected installer cleanup fault injection retains controller artifacts and restores Caddy');
