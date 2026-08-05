'use strict';
const F=['sunset','microsoft','oauth','provider','unavailable'].join('_'),D='sunset-staging',K=['LUNA','EMAIL','OAUTH','CLIENT','SECRET'].join('_'),M=['get','Client','Secret'].join(''),N=['create','Sunset','Microsoft','OAuth','Client','Secret','Provider'].join(''),L=4096;
function fail(){const e=new Error(F);e.code=F;return e;}
function own(o,k){const d=Object.getOwnPropertyDescriptor(o,k);return d&&!d.get&&!d.set?d.value:undefined;}
function exact(o,ks){if(!o||Object.getPrototypeOf(o)!==Object.prototype)return false;const a=Reflect.ownKeys(o);return a.length===ks.length&&!a.some(k=>typeof k!=='string'||!ks.includes(k))&&ks.every(k=>{const d=Object.getOwnPropertyDescriptor(o,k);return d&&!d.get&&!d.set;});}
function create(x){let v;try{if(!exact(x,['deployment','env'])||own(x,'deployment')!==D)throw fail();const e=own(x,'env');if((typeof e!=='object'&&typeof e!=='function')||e===null)throw fail();v=own(e,K);if(typeof v!=='string'||!v.length||v.length>L||!(/^[\x20-\x7e]+$/).test(v))throw fail();}catch(_){throw fail();}let used=false;async function get(){if(used)throw fail();used=true;return v;}return Object.freeze({[M]:get});}
module.exports=Object.freeze({FAILURE_CODE:F,SUNSET_DEPLOYMENT:D,ENV_KEY:K,VALUE_LIMIT_CHARS:L,[N]:create});
