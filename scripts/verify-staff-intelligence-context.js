'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const src=fs.readFileSync(path.join(__dirname,'staff-query-api.js'),'utf8');
const code=src.slice(src.indexOf('function lunaIntelligencePaint(){'),src.indexOf('function wireLunaStaffTabCards(){'));
function setup(){
 const attrs={'aria-checked':'false'}, btn={disabled:false,textContent:'Off',classList:{toggle(){}},getAttribute:k=>attrs[k],setAttribute:(k,v)=>attrs[k]=v,querySelector:()=>true,addEventListener(){}},status={textContent:''},pending=[];
 const listeners={};
 const context={console,window:{__staffDisclosureContext:{client:'wolfhouse-somo',key:'1:wolfhouse-somo'},addEventListener:(name,fn)=>{(listeners[name] ||= []).push(fn);}},el:id=>id.endsWith('-toggle')?btn:status,fetch:()=>new Promise(resolve=>pending.push(resolve))};
 vm.createContext(context);vm.runInContext(code,context);
 const finish=(i,client,enabled)=>pending[i]({ok:true,json:async()=>({success:true,enabled,client_slug:client})});
 const transition=(client,key)=>{const detail={client,key};context.window.__staffDisclosureContext=detail;(listeners['staff-disclosure-context']||[]).forEach(fn=>fn({detail}));};
 return {context,btn,status,pending,finish,attrs,transition};
}
(async()=>{
 {const s=setup();const p=s.context.lunaIntelligenceRequest();s.context.window.__staffDisclosureContext={client:'sunset',key:'2:sunset'};s.finish(0,'wolfhouse-somo',true);await p;assert.equal(s.attrs['aria-checked'],'false','late old tenant response must not enable new tenant switch');}
 {const s=setup();const p=s.context.lunaIntelligenceRequest();s.finish(0,'sunset',true);await p;assert.equal(s.attrs['aria-checked'],'false','mismatched server scope fails closed');}
 {const s=setup();const old=s.context.lunaIntelligenceRequest();s.context.window.__staffDisclosureContext={client:'sunset',key:'2:sunset'};const fresh=s.context.lunaIntelligenceRequest();assert.equal(s.pending.length,2,'new scope load cannot be blocked by old pending request');s.finish(1,'sunset',false);await fresh;s.finish(0,'wolfhouse-somo',true);await old;assert.equal(s.attrs['aria-checked'],'false');assert.equal(s.btn.disabled,false);}
 console.log('PASS Intelligence late response, mismatch and independent new context load');
 for(const settleAway of [true,false]){
  const name=settleAway?'away -> settle -> return to SAME key':'away -> return to SAME key before settle';
  try{
   const s=setup();const old=s.context.lunaIntelligenceRequest();
   s.transition('wolfhouse-somo','1:wolfhouse-somo');
   s.context.lunaIntelligenceRequest();assert.equal(s.pending.length,1,'same-context notification must not duplicate pending request');
   s.transition('sunset','2:sunset');
   if(settleAway){s.finish(0,'wolfhouse-somo',true);await old;}
   s.transition('wolfhouse-somo','1:wolfhouse-somo');
   if(!settleAway){s.finish(0,'wolfhouse-somo',true);await old;}
   assert.equal(s.attrs['aria-checked'],'false','completion from prior context lifetime must not paint on return');
   const fresh=s.context.lunaIntelligenceRequest();
   assert.equal(s.pending.length,2,'return must issue a fresh request, not inherit stale pending ownership');
   s.finish(1,'wolfhouse-somo',false);await fresh;
   assert.equal(s.btn.disabled,false);assert.equal(s.btn._lunaIntelligencePending,false);assert.equal(s.status.textContent,'');
   console.log('PASS Intelligence '+name);
  }catch(error){console.error('FAIL Intelligence '+name,error);process.exitCode=1;}
 }
 {
  const s=setup();const old=s.context.lunaIntelligenceRequest();
  s.transition('sunset','2:sunset');s.transition('wolfhouse-somo','1:wolfhouse-somo');
  const fresh=s.context.lunaIntelligenceRequest();
  assert.equal(s.pending.length,2,'return before old settlement starts independent load');
  s.finish(0,'wolfhouse-somo',true);await old;
  assert.equal(s.attrs['aria-checked'],'false');assert.equal(s.btn.disabled,true);
  assert.equal(s.btn._lunaIntelligencePending,true,'stale finally cannot release fresh pending ownership');
  assert.equal(s.status.textContent,'Loading…');
  s.finish(1,'wolfhouse-somo',false);await fresh;
  assert.equal(s.btn.disabled,false);assert.equal(s.btn._lunaIntelligencePending,false);
  console.log('PASS Intelligence stale completion cannot release replacement request');
 }
})().catch(e=>{console.error(e);process.exitCode=1});
