'use strict';
// Exact registered route/dispatch seam; persistence is covered by verify-per-guest-dates.js.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(ROOT, 'scripts/staff-query-api.js'), 'utf8');
function fn(name, optional = false) {
  const m = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  if (!m) { if (optional) return ''; throw Error('Missing ' + name); }
  return source.slice(m.index, source.indexOf('\n}', m.index) + 2);
}
async function main() {
  const calls = [], audits = [];
  const config = { source: 'synthetic-admin-overlay' };
  const sandbox = { console, Date, JSON, Set, Map, STAFF_ACTIONS_ENABLED: true, STAFF_AUTH_REQUIRED: true,
    DEFAULT_CLIENT: 'wolfhouse-somo', SQL_INJECT_RE: /[';]|--/, UUID_VALIDATE_RE: /^[0-9a-f-]{36}$/i,
    readBody: async req => req.raw, sendJSON: (res,status,body) => Object.assign(res,{status,body}),
    send400: (res,error) => Object.assign(res,{status:400,body:{success:false,error}}),
    appendAuditLog: event => audits.push(event), withPgClient: fn => fn({ fixturePg: true }),
    staffClientAccessAllowed: (user,slug) => user.clients.includes(slug),
    requireAuth: async(req,res) => req.denied ? (res.status=403,{ok:false}) : {ok:true,user:{role:'operator',clients:['wolfhouse-somo']}},
    loadWolfhouseQuoteConfigWithOverlay: async () => config,
    require: name => { assert.equal(name,'./lib/booking-guest-dates'); return {editGuestDates: async(pg,body,options) => {
      calls.push({pg,body,options});return {status:200,body:{success:true,updated:true,edit_type:'guest_dates'}};
    }}; }
  };
  vm.createContext(sandbox);
  const start=source.indexOf("  if (pathname === '/staff/bookings/edit') {");
  const route=source.slice(start,source.indexOf('\n  }',start)+4);
  vm.runInContext(source.match(/^const EDIT_WRITE_SUPPORTED_TYPES = .*;$/m)[0]+'\n'+
    fn('assertStaffClientAccess')+'\n'+fn('handleBookingEditWriteGuestDates',true)+'\n'+fn('handleBookingEditWrite')+
    '\nasync function route(req,res){const pathname="/staff/bookings/edit",method=req.method;'+route+'\n}',sandbox);
  const payload={client_slug:'wolfhouse-somo',booking_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',booking_code:'WH-DATES-TEST',
    booking_guest_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',edit_type:'guest_dates',check_in:'2026-10-05',check_out:'2026-10-12',
    expected_check_in:'2026-10-05',expected_check_out:'2026-10-11',idempotency_key:'offline-dates-1'};
  async function call(patch={},options={}){const res={writeHead(status){this.status=status;},end(raw){this.body=JSON.parse(raw);}};
    await sandbox.route({method:options.method||'POST',denied:options.denied,raw:JSON.stringify({...payload,...patch})},res);return res;}
  const result=await call();
  assert.equal(result.status,200,'ordinary Staff edit route accepts guest-scoped date edit: '+JSON.stringify(result.body));
  assert.equal(calls.length,1);assert.equal(calls[0].body.booking_guest_id,payload.booking_guest_id);
  assert.equal(calls[0].options.quoteConfig,config,'saved Admin pricing config reaches service');
  assert(audits.some(a=>a.success===true&&a.updated===true),'mutation result audited');
  for(const [patch,options,status] of [[{client_slug:'sunset'}, {},403],[{}, {denied:true},403],[{}, {method:'GET'},405]]) {
    const before=calls.length;assert.equal((await call(patch,options)).status,status);assert.equal(calls.length,before);
  }
  sandbox.STAFF_ACTIONS_ENABLED=false;assert.equal((await call()).status,403);assert.equal(calls.length,1);
  console.log('PASS guest-date route dispatch, Admin config, audit, tenant/auth/method/write guards (SQL tested separately)');
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
