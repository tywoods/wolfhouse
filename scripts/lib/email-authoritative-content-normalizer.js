'use strict';
/** Provider-neutral, deterministic current-slice normalizer. Semantic content is untrusted data. */
const RAW_MAX=128*1024, TEXT_MAX=16*1024;
const DROP=new Set(['script','style','form','svg','math','head','meta','link','object','embed','iframe','template','noscript']);
const BLOCK=new Set(['p','div','br','li','tr','h1','h2','h3','h4','h5','h6','section','article']);
function fail(){const e=new Error('authoritative_content_failed');e.code='authoritative_content_failed';throw e;}
function decode(s){return s.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/g,x=>({'&nbsp;':' ','&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[x]));}
function htmlText(html){
 let out='', i=0, drop=0, quoted=false;
 while(i<html.length){
  if(html.startsWith('<!--',i)){const e=html.indexOf('-->',i+4);if(e<0)fail();i=e+3;continue;}
  if(html[i]!=='<'){const e=html.indexOf('<',i), chunk=html.slice(i,e<0?html.length:e);if(!drop&&!quoted)out+=decode(chunk);i=e<0?html.length:e;continue;}
  const e=html.indexOf('>',i+1);if(e<0)fail();const raw=html.slice(i+1,e).trim();if(!raw)fail();
  const close=raw[0]==='/', m=/^\/?\s*([A-Za-z][A-Za-z0-9:-]*)/.exec(raw);if(!m)fail();const tag=m[1].toLowerCase();
  if(tag==='blockquote'){if(close){if(!quoted)fail();quoted=false;}else{if(quoted)fail();quoted=true;}i=e+1;continue;}
  if(DROP.has(tag)){if(close){if(drop<1)fail();drop--;}else if(!/\/$/.test(raw))drop++;i=e+1;continue;}
  if(!drop&&!quoted&&BLOCK.has(tag))out+='\n'; i=e+1;
 }
 if(drop||quoted)fail();
 return out;
}
function clean(s){
 const n=s.replace(/\r\n?/g,'\n').replace(/[\t\f\v ]+/g,' ').split('\n').map(x=>x.trim()).filter(Boolean).join('\n').trim();
 if(/(^|\n)\s*(On .{0,200}wrote:|From:|Sent:|-----Original Message-----)/i.test(n))fail();
 if(Buffer.byteLength(n,'utf8')>TEXT_MAX)fail(); return n;
}
function normalizeAuthoritativeMessageContent(input){
 if(!input||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).length!==2||typeof input.contentType!=='string'||typeof input.content!=='string')fail();
 if(input.contentType!=='text'&&input.contentType!=='html')fail();if(Buffer.byteLength(input.content,'utf8')>RAW_MAX||input.content.includes('\ufffd'))fail();
 const latest_text=clean(input.contentType==='text'?input.content:htmlText(input.content));if(!latest_text)fail();return Object.freeze({latest_text});
}
module.exports=Object.freeze({RAW_BODY_MAX_BYTES:RAW_MAX,SANITIZED_TEXT_MAX_BYTES:TEXT_MAX,normalizeAuthoritativeMessageContent});
