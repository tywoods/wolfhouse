'use strict';
const FAILURE='microsoft_graph_message_content_failed', UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, ID=/^[A-Za-z0-9_+=.-]{1,2048}$/;
const CAP=256*1024, DEADLINE=10000;
function fail(){const e=new Error('Microsoft Graph message content request failed.');Object.defineProperty(e,'code',{value:FAILURE,enumerable:true});return Object.freeze(e);}
function createMicrosoftGraphMessageContentTransport(deps){
 if(!deps||typeof deps.httpsImpl?.request!=='function'||!deps.timers)throw fail();
 async function fetchMessageContent(input){
  let token=null, options=null, chunks=[];
  try{
   if(!input||Object.getPrototypeOf(input)!==Object.prototype||Reflect.ownKeys(input).length!==3)throw fail();
   token=input.accessToken;if(typeof token!=='string'||token.length<1||token.length>16384||!UUID.test(input.providerMailboxId)||!ID.test(input.providerMessageId))throw fail();
   options={protocol:'https:',hostname:'graph.microsoft.com',port:443,method:'GET',path:`/v1.0/users/${input.providerMailboxId}/messages/${encodeURIComponent(input.providerMessageId)}?$select=id,body`,agent:false,timeout:DEADLINE,headers:{Accept:'application/json',Prefer:'IdType="ImmutableId"',Authorization:`Bearer ${token}`}};
   return await new Promise((resolve,reject)=>{let done=false,size=0;const finish=(err,val)=>{if(done)return;done=true;err?reject(fail()):resolve(val);};let req;
    try{req=deps.httpsImpl.request(options,res=>{if(res.statusCode!==200||!res.headers||res.headers['content-type']!=='application/json'){finish(true);return;}res.on('data',b=>{size+=b.length;if(size>CAP)finish(true);else chunks.push(b);});res.on('error',()=>finish(true));res.on('aborted',()=>finish(true));res.on('end',()=>{try{const raw=Buffer.concat(chunks);const round=Buffer.from(raw.toString('utf8'),'utf8');if(!raw.equals(round))throw fail();const x=JSON.parse(raw.toString('utf8'));if(!x||Object.getPrototypeOf(x)!==Object.prototype||Reflect.ownKeys(x).length!==2||x.id!==input.providerMessageId||!x.body||Object.getPrototypeOf(x.body)!==Object.prototype||Reflect.ownKeys(x.body).length!==2||!['text','html'].includes(x.body.contentType)||typeof x.body.content!=='string')throw fail();finish(null,Object.freeze({contentType:x.body.contentType,content:x.body.content}));}catch{finish(true);}});});req.on('error',()=>finish(true));req.setTimeout?.(DEADLINE,()=>{req.destroy?.();finish(true);});req.end();}catch{finish(true);}});
  }catch{throw fail();}finally{token=null;chunks=null;if(options?.headers)options.headers.Authorization=null;options=null;}
 }
 return Object.freeze({fetchMessageContent});
}
module.exports=Object.freeze({FAILURE_CODE:FAILURE,RESPONSE_CAP_BYTES:CAP,DEADLINE_MS:DEADLINE,createMicrosoftGraphMessageContentTransport});
