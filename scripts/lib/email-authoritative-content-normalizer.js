'use strict';
/** Plain-text-only deterministic normalizer. Provider semantic content remains untrusted. */
const RAW_MAX=128*1024, TEXT_MAX=16*1024;
function fail(){const e=new Error('authoritative_content_failed');e.code='authoritative_content_failed';throw e;}
function clean(s){
 const n=s.replace(/\r\n?/g,'\n').replace(/[\t\f\v ]+/g,' ').split('\n').map(x=>x.trim()).filter(Boolean).join('\n').trim();
 if(/(^|\n)\s*(On .{0,200}wrote:|From:|Sent:|-----Original Message-----)/i.test(n))fail();
 if(Buffer.byteLength(n,'utf8')>TEXT_MAX)fail();return n;
}
function normalizeAuthoritativeMessageContent(input){
 if(!input||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).length!==2)fail();
 const td=Object.getOwnPropertyDescriptor(input,'contentType'), cd=Object.getOwnPropertyDescriptor(input,'content');
 if(!td||!cd||!('value'in td)||!('value'in cd)||td.value!=='text'||typeof cd.value!=='string')fail();
 if(Buffer.byteLength(cd.value,'utf8')>RAW_MAX||cd.value.includes('\ufffd'))fail();
 const latest_text=clean(cd.value);if(!latest_text)fail();return Object.freeze({latest_text});
}
module.exports=Object.freeze({RAW_BODY_MAX_BYTES:RAW_MAX,SANITIZED_TEXT_MAX_BYTES:TEXT_MAX,normalizeAuthoritativeMessageContent});
