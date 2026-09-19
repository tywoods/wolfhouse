'use strict';
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const ctl = require('./luna-number-routing-controller');
let passed = 0;
async function test(name, fn) { try { await fn(); passed++; console.log(`PASS ${name}`); } catch (e) { console.error(`FAIL ${name}`, e); process.exitCode = 1; } }
function effective(target) {
  const route = { match: [{ path: [ctl.EXACT_PATH] }], handle: [{ handler: 'subroute', routes: [{ handle: [{ handler: 'reverse_proxy', upstreams: [{ dial: ctl.TARGETS[target] }] }] }] }] };
  return { ok: true, json: async () => ({ apps: { http: { servers: { staging: { routes: [route] } } } } }) };
}
function fixture(target = 'wolfhouse') { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'route-')); const fragment=path.join(dir,'luna-number-route.caddy'); fs.writeFileSync(fragment,ctl.managedBlock(target),{mode:0o640}); const root=path.join(dir,'Caddyfile'); fs.writeFileSync(root,`staging.example {\n  import ${fragment}\n  reverse_proxy /whatsapp/* 127.0.0.1:8090\n}\n`); return {dir,fragment,root,hash:ctl.digest(fs.readFileSync(root,'utf8'))}; }
function controller(x, extra={}) { return ctl.createController({fragmentFile:x.fragment,rootCaddyfile:x.root,rootCaddyHash:x.hash,ledgerFile:path.join(x.dir,'ledger'),journalFile:path.join(x.dir,'journal'),lockDir:path.join(x.dir,'lock'),...extra}); }
function proof(target) { const p={number_e164:ctl.NUMBER_E164,phone_number_id:ctl.PHONE_NUMBER_ID,path:ctl.EXACT_PATH,environment:'staging',upstream:ctl.TARGETS[target],observed_at_ms:Date.now()}; p.signature=crypto.createHmac('sha256','p'.repeat(32)).update(Object.values(p).join('\n')).digest('hex'); return p; }
(async()=>{
 await test('fragment parser permits only canonical exact webhook content',()=>{ assert.equal(ctl.parseRoute(ctl.managedBlock('wolfhouse')).target_luna,'wolfhouse'); assert.equal(ctl.parseRoute(`${ctl.managedBlock('wolfhouse')}# extra\n`),null); assert.equal(ctl.parseRoute('reverse_proxy /whatsapp/* 127.0.0.1:8090\n'),null); });
 await test('root hash/import/order contract fails closed',async()=>{ const x=fixture(); fs.appendFileSync(x.root,'# drift\n'); await assert.rejects(controller(x).state(),e=>e.code==='root_caddy_contract_failed'); });
 await test('candidate validates temporary full root with absolute binary and mutates fragment only',async()=>{ const x=fixture(); const rootBefore=fs.readFileSync(x.root,'utf8'); let target='wolfhouse'; const calls=[]; process.env.LUNA_ROUTING_INGRESS_PROOF_URL='https://proof'; const c=controller(x,{proofKey:'p'.repeat(32),fetch:async u=>u==='https://proof'?{json:async()=>proof('sunset')}:effective(target),exec:async(cmd,args)=>{calls.push([cmd,args]); if(cmd==='/usr/bin/sudo') target='sunset';}}); const out=await c.mutate({action:'flip_to_sunset',operation_id:crypto.randomUUID(),expected_revision:ctl.parseRoute(fs.readFileSync(x.fragment,'utf8')).revision,actor_account_id:'earthling'}); assert.equal(out.body.ok,true,JSON.stringify(out)); assert.equal(calls[0][0],'/usr/bin/caddy'); assert.equal(calls[0][1][0],'validate'); assert.deepEqual(calls.at(-1),['/usr/bin/sudo',['-n','/usr/bin/systemctl','reload','caddy']]); assert.equal(fs.readFileSync(x.root,'utf8'),rootBefore); assert.equal(fs.statSync(x.fragment).mode&0o777,0o640); });
 await test('controller is loopback plain HTTP while HMAC remains mandatory',async()=>{ const server=http.createServer(ctl.makeHandler({key:'h'.repeat(32),state:async()=>({})})); await new Promise(r=>server.listen(0,'127.0.0.1',r)); try { const res=await fetch(`http://127.0.0.1:${server.address().port}${ctl.ROUTE_PATH}`); assert.equal(res.status,401); assert.equal(server.address().address,'127.0.0.1'); } finally { await new Promise(r=>server.close(r)); } });
 await test('migration uses pre-provisioned roles and SET LOCAL ROLE',()=>{ const sql=fs.readFileSync(path.join(__dirname,'../database/migrations/103_crowsnest_comms_number_route_audit.sql'),'utf8'); assert.match(sql,/SET LOCAL ROLE crowsnest_comms_owner/); assert.doesNotMatch(sql,/CREATE ROLE/); const boot=fs.readFileSync(path.join(__dirname,'bootstrap-crowsnest-comms-roles.sh'),'utf8'); assert.match(boot,/WITH ADMIN OPTION/); const grant=fs.readFileSync(path.join(__dirname,'provision-crowsnest-comms-runtime-role.sh'),'utf8'); assert.match(grant,/rolcanlogin/); assert.match(grant,/GRANT crowsnest_api TO/); });
 console.log(`\n${passed} tests passed`); if(process.exitCode) process.exit(process.exitCode);
})().catch(e=>{console.error(e);process.exit(1)});
