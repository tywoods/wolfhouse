'use strict';
const path=require('node:path');
const {FAULTS}=require('./staff-owner-http-receipt');
const {isIP}=require('node:net');
const PG_FENCE='PostgreSQL TEST loopback fence requires numeric loopback, explicit identity, no URI options or PG environment';
function numericLoopback(host) {
 return (isIP(host)===4 && host.split('.')[0]==='127') || host==='::1';
}
function postgresConnections(env,db) {
 // Fail before pg parsing: URI SSL options can read local files in its parser.
 // Check BOTH the supplied config environment and the ambient environment pg
 // actually consults. Unknown future PG settings fail closed as well.
 for(const source of [env,process.env]) {
  if(Object.keys(source).some(k=>/^(?:PG|NODE_PG)/i.test(k) && source[k]!==undefined && source[k]!==''))throw new Error(PG_FENCE);
 }
 try {
  const raw=env.LUNA_OWNER_ADMIN_URL;
  if(typeof raw!=='string' || /[\s\u0000-\u001f\u007f]/.test(raw))throw new Error();
  const admin=new URL(raw);
  if(!['postgres:','postgresql:'].includes(admin.protocol) || admin.search || admin.hash || raw.includes('?') || raw.includes('#'))throw new Error();
  const host=admin.hostname==='[::1]'?'::1':admin.hostname;
  const user=decodeURIComponent(admin.username),password=decodeURIComponent(admin.password);
  const adminDb=decodeURIComponent(admin.pathname.slice(1));
  const port=admin.port?Number(admin.port):5432;
  if(!numericLoopback(host) || !user || !/^[a-zA-Z0-9_]+$/.test(adminDb) || !Number.isInteger(port) || port<1 || port>65535)throw new Error();
  // Emit only controlled options. Explicit host also repairs pg's bracketed
  // IPv6 URL parsing: its effective socket host must be ::1, never [::1]/DNS.
  admin.port=String(port);
  admin.searchParams.set('host',host);
  admin.searchParams.set('sslmode','disable');
  const database=new URL(admin);database.pathname='/'+db;
  const {Client}=require('pg');
  for(const [url,expectedDb] of [[admin,adminDb],[database,db]]) {
   // Same Client constructor/options as runner.client(); no connect or lookup.
   const cp=new Client({connectionString:url.href}).connectionParameters;
   if(!numericLoopback(cp.host) || cp.host!==host || cp.port!==port || cp.database!==expectedDb || cp.user!==user ||
      cp.password!==(password || null) || cp.isDomainSocket || cp.options || cp.replication || cp.ssl!==false)throw new Error();
  }
  return {admin:admin.href,database:database.href};
 } catch {
  // Never propagate parser errors: input URLs, passwords and file paths leak.
  throw new Error(PG_FENCE);
 }
}
function config(env=process.env) {
 if(env.NODE_ENV!=='test' || env.LUNA_OWNER_TEST_RUN!=='true')throw new Error('explicit NODE_ENV=test and LUNA_OWNER_TEST_RUN=true TEST fencing required');
 const db=env.LUNA_OWNER_DB;
 if(!/^luna_owner_test_[a-z0-9_]{1,42}$/.test(db||''))throw new Error('fresh LUNA_OWNER_DB must start luna_owner_test_');
 const port=Number(env.LUNA_OWNER_PORT);
 if(!Number.isInteger(port) || port<1024 || port>65535)throw new Error('explicit isolated LUNA_OWNER_PORT required');
 if(!env.LUNA_OWNER_OUTPUT || !path.isAbsolute(env.LUNA_OWNER_OUTPUT))throw new Error('absolute fresh LUNA_OWNER_OUTPUT required');
 const key=env.LUNA_OWNER_RECEIPT_ISSUER_KEY;
 if(typeof key!=='string' || Buffer.byteLength(key)<32)throw new Error('explicit test LUNA_OWNER_RECEIPT_ISSUER_KEY required (32 bytes)');
 const connections=postgresConnections(env,db);
 return Object.freeze({...connections,db,port,out:env.LUNA_OWNER_OUTPUT,key});
}
function recipes() {
 const addon=(code,date,person='Alex')=>({code,quantity:1,people:[person],dates:[date]});
 const base={check_in:'2027-06-01',check_out:'2027-06-08',guests:[{name:'Alex'}],room:{kind:'shared'},package:'package_none',add_ons:[]};
 const specs={accommodation:{},package:{package:'malibu'},rental:{add_ons:[addon('board','2027-06-02')]},'service:lesson_a':{add_ons:[addon('group_lesson','2027-06-03')]},'service:lesson_b':{add_ons:[addon('private_lesson','2027-06-04')]},mixed:{package:'malibu',add_ons:[addon('board','2027-06-02'),addon('group_lesson','2027-06-03')]},multi_guest:{guests:[{name:'Alex'},{name:'Sam'}],package:{per_guest:[{guest:1,code:'malibu'},{guest:2,code:'package_none'}]},add_ons:[addon('board','2027-06-02'),addon('private_lesson','2027-06-04','Sam')]}};
 const rows=Object.entries(specs).map(([category,spec])=>({id:'owner-'+category.replace(':','-'),category,control:structuredClone({...base,...spec})}));
 const corrected=structuredClone(rows.find(x=>x.category==='rental').control), refused=structuredClone(corrected);refused.add_ons[0].quantity=0;
 rows.push({id:'owner-quantity-correction',category:'continuation',control:refused,corrected_control:corrected,correction_prompt:'Correction: one board for Alex on 2027-06-02, not zero. Keep the same stay and accommodation-only choice. Please quote again.'});
 const incomplete=structuredClone(base);delete incomplete.room;
 rows.push({id:'owner-clarification',category:'clarification',control:incomplete});
 for(const fault of FAULTS)rows.push({id:'owner-fault-'+fault,category:'fault',fault,control:structuredClone(rows.find(x=>x.category==='mixed').control)});
 for(const row of rows)row.prompt=row.category==='clarification'?'Please quote accommodation only for Alex from 2027-06-01 to 2027-06-08; I have not chosen a room type.':`Please quote, without booking or holding, exactly this stay and these per-person selections: ${JSON.stringify(row.control)}. Do not replace invalid quantities; ask me to correct them.`;
 return rows;
}
function newSession(){return 'luna-v3:'+require('node:crypto').randomBytes(12).toString('hex');}
module.exports={config,recipes,newSession};
