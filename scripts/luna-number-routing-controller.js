'use strict';
const crypto=require('crypto');
const fs=require('fs');
const https=require('https');
const {execFile}=require('child_process');
const {promisify}=require('util');
const exec=promisify(execFile);
const ROUTE_PATH='/v1/routes/meta-whatsapp-verified-webhook';
const EXACT_PATH='/whatsapp/webhook';
const NUMBER_E164=['+34','663','43','94','19'].join('');
const PHONE_NUMBER_ID='1152900101233109';
const TARGETS=Object.freeze({wolfhouse:'127.0.0.1:8090',sunset:'127.0.0.1:8094'});
const ACTION_TARGET=Object.freeze({flip_to_sunset:'sunset',rollback_to_wolfhouse:'wolfhouse'});
const seenNonces=new Map();
function digest(text){return crypto.createHash('sha256').update(text).digest('hex');}
function canonical(method,path,ts,nonce,body){return [method,path,ts,nonce,body].join('\n');}
function equalHex(a,b){if(!/^[a-f0-9]{64}$/i.test(a)||!/^[a-f0-9]{64}$/i.test(b))return false;return crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
function authenticate(req,raw,key,now=Date.now()){
 const ts=String(req.headers['x-routing-timestamp']||''),nonce=String(req.headers['x-routing-nonce']||'');
 const match=/^HMAC ([a-f0-9]{64})$/i.exec(String(req.headers.authorization||''));
 if(!key||key.length<32||!match||!/^\d{13}$/.test(ts)||!nonce)return false;
 if(Math.abs(now-Number(ts))>60000||seenNonces.has(nonce))return false;
 const expected=crypto.createHmac('sha256',key).update(canonical(req.method,ROUTE_PATH,ts,nonce,raw)).digest('hex');
 if(!equalHex(match[1],expected))return false;seenNonces.set(nonce,now);for(const[n,t]of seenNonces)if(now-t>60000)seenNonces.delete(n);return true;
}
function managedBlock(target){return [`# BEGIN luna-number-route`,`handle ${EXACT_PATH} {`,`  reverse_proxy ${TARGETS[target]}`,`}`,`# END luna-number-route`].join('\n');}
function parseRoute(text){
 const blocks=[...String(text).matchAll(/# BEGIN luna-number-route\s*\n([\s\S]*?)\n# END luna-number-route/g)];
 if(blocks.length!==1)return null;const body=blocks[0][1];
 if(!new RegExp(`handle\\s+${EXACT_PATH.replaceAll('/','\\/')}\\s*\\{`).test(body))return null;
 const m=/reverse_proxy\s+(127\.0\.0\.1:(?:8090|8094))\b/.exec(body);if(!m)return null;
 const target=Object.keys(TARGETS).find(k=>TARGETS[k]===m[1]);return {target_luna:target,upstream:m[1],revision:digest(text),exact_path:EXACT_PATH};
}
function buildCandidate(current,target){
 const block=managedBlock(target);if(/# BEGIN luna-number-route[\s\S]*?# END luna-number-route/.test(current))return current.replace(/# BEGIN luna-number-route[\s\S]*?# END luna-number-route/,block);
 const broad=/(^|\n)(\s*)(?:reverse_proxy\s+\/whatsapp\/\*|handle(?:_path)?\s+\/whatsapp\/\*)/m;const m=broad.exec(current);if(!m)throw Object.assign(new Error('broad route missing'),{code:'caddy_route_shape_unsupported'});
 return current.slice(0,m.index)+(m[1]||'')+(m[2]||'')+block+'\n'+current.slice(m.index+(m[1]||'').length);
}
function verifyIngressProof(proof,target,key,now=Date.now()){
 if(!proof||proof.number_e164!==NUMBER_E164||proof.phone_number_id!==PHONE_NUMBER_ID||proof.path!==EXACT_PATH||proof.environment!=='staging'||proof.upstream!==TARGETS[target])return false;
 if(!Number.isFinite(proof.observed_at_ms)||Math.abs(now-proof.observed_at_ms)>120000)return false;
 const payload=[proof.number_e164,proof.phone_number_id,proof.path,proof.environment,proof.upstream,String(proof.observed_at_ms)].join('\n');
 const expected=crypto.createHmac('sha256',key).update(payload).digest('hex');return equalHex(String(proof.signature||''),expected);
}
async function effectiveRoute(fetchImpl=fetch){
 try{const r=await fetchImpl('http://127.0.0.1:2019/config/');if(!r.ok)return null;const cfg=await r.json();const found=[];
  function walk(n,exact=false){if(!n||typeof n!=='object')return;const here=exact||(Array.isArray(n.path)&&n.path.length===1&&n.path[0]===EXACT_PATH);if(here&&Array.isArray(n.upstreams))for(const u of n.upstreams){const t=Object.keys(TARGETS).find(k=>TARGETS[k]===u.dial);if(t)found.push({target_luna:t,upstream:u.dial});}for(const v of Object.values(n))walk(v,here);}
  walk(cfg);return found.length===1?found[0]:null;
 }catch(_){return null;}
}
function createController(deps={}){
 const f=deps.fs||fs,run=deps.exec||exec,fetchImpl=deps.fetch||fetch,caddy=deps.caddyfile||'/etc/caddy/Caddyfile',key=deps.hmacKey||process.env.LUNA_ROUTING_CONTROLLER_HMAC_KEY,proofKey=deps.proofKey||process.env.LUNA_ROUTING_INGRESS_PROOF_KEY;
 async function state(){const text=f.readFileSync(caddy,'utf8'),route=parseRoute(text),effective=await effectiveRoute(fetchImpl);if(!route||!effective||route.target_luna!==effective.target_luna)throw Object.assign(new Error(),{code:'route_readback_failed'});return route;}
 async function mutate(body){
  if(!body||!ACTION_TARGET[body.action]||!/^[a-f0-9-]{36}$/i.test(String(body.operation_id||''))||!['earthling','monshies'].includes(body.actor_account_id))return {status:422,body:{ok:false,code:'invalid_request'}};
  const beforeText=f.readFileSync(caddy,'utf8'),before=parseRoute(beforeText);if(!before)return {status:503,body:{ok:false,code:'route_readback_failed'}};
  if(body.expected_revision!==before.revision)return {status:409,body:{ok:false,code:'stale_revision'}};
  const target=ACTION_TARGET[body.action];if(before.target_luna===target)return {status:200,body:{ok:true,idempotent:true,route:before,events:[{type:'precondition',details:{already_applied:true}},{type:'readback',details:{target}}]}};
  let proof;try{const r=await fetchImpl(process.env.LUNA_ROUTING_INGRESS_PROOF_URL,{headers:{accept:'application/json'}});proof=await r.json();}catch(_){return {status:422,body:{ok:false,code:'ingress_proof_unavailable',events:[{type:'precondition',details:{accepted:false}}]}};}
  if(!proofKey||!verifyIngressProof(proof,target,proofKey))return {status:422,body:{ok:false,code:'invalid_ingress_proof',events:[{type:'precondition',details:{accepted:false}}]}};
  let candidate;try{candidate=buildCandidate(beforeText,target);}catch(e){return {status:503,body:{ok:false,code:e.code}};}const tmp=`${caddy}.${process.pid}.tmp`,backup=`${caddy}.${body.operation_id}.bak`;f.copyFileSync(caddy,backup);f.writeFileSync(tmp,candidate,{mode:0o640});f.renameSync(tmp,caddy);
  const events=[{type:'precondition',details:{accepted:true}},{type:'applied',details:{target}}];
  try{await run('caddy',['validate','--config',caddy]);await run('systemctl',['reload','caddy']);const effective=await effectiveRoute(fetchImpl),route=parseRoute(f.readFileSync(caddy,'utf8'));if(!effective||!route||effective.target_luna!==target||route.target_luna!==target)throw new Error();events.push({type:'readback',details:{target}});return {status:200,body:{ok:true,route,events}};}
  catch(_){f.copyFileSync(backup,caddy);try{await run('caddy',['validate','--config',caddy]);await run('systemctl',['reload','caddy']);events.push({type:'rollback',details:{restored:true}});}catch(__){events.push({type:'rollback',details:{restored:false}});}return {status:503,body:{ok:false,code:'mutation_rolled_back',events}};}
 }
 return {state,mutate,key};
}
function send(res,status,body){const data=JSON.stringify(body);res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','content-length':Buffer.byteLength(data)});res.end(data);}
function makeHandler(controller=createController()){return async(req,res)=>{if((req.url||'').split('?')[0]!==ROUTE_PATH)return send(res,404,{ok:false,code:'not_found'});let raw='';for await(const c of req){raw+=c;if(Buffer.byteLength(raw)>8192)return send(res,413,{ok:false,code:'payload_too_large'});}if(!authenticate(req,raw,controller.key))return send(res,401,{ok:false,code:'unauthorized'});if(req.method==='GET'){try{return send(res,200,{ok:true,route:await controller.state()});}catch(e){return send(res,503,{ok:false,code:e.code||'readback_failed'});}}if(req.method!=='POST')return send(res,405,{ok:false,code:'method_not_allowed'});let body;try{body=JSON.parse(raw);}catch(_){return send(res,422,{ok:false,code:'invalid_json'});}const out=await controller.mutate(body);return send(res,out.status,out.body);};}
if(require.main===module){const cert=fs.readFileSync(process.env.LUNA_ROUTING_TLS_CERT),privateKey=fs.readFileSync(process.env.LUNA_ROUTING_TLS_KEY);https.createServer({cert,key:privateKey,requestCert:true,rejectUnauthorized:false},makeHandler()).listen(Number(process.env.LUNA_ROUTING_CONTROLLER_PORT||8096),'127.0.0.1');}
module.exports={ROUTE_PATH,EXACT_PATH,NUMBER_E164,PHONE_NUMBER_ID,TARGETS,ACTION_TARGET,digest,canonical,authenticate,managedBlock,parseRoute,buildCandidate,verifyIngressProof,effectiveRoute,createController,makeHandler};
