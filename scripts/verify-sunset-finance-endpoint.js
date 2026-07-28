'use strict';

/** Real HTTP route/auth verifier for the Sunset Finance endpoint. Invalid scope
 * must be rejected before any PostgreSQL acquisition (DATABASE_URL is deliberately
 * unusable); auth-required mode must reject before reaching the handler. */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..');
const API_PATH = path.join(ROOT, 'scripts', 'staff-query-api.js');
const API = fs.readFileSync(API_PATH, 'utf8');
let pass = 0; let fail = 0;
function ok(label, cond, extra) { if (cond) { pass++; console.log(`  PASS  ${label}`); } else { fail++; console.error(`  FAIL  ${label}${extra ? ` (${extra})` : ''}`); } }
function request(port, pathname) { return new Promise((resolve, reject) => { http.get({ host:'127.0.0.1', port, path:pathname }, (res) => { let body=''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status:res.statusCode, body })); }).on('error', reject); }); }
async function start(port, authRequired) {
  const child = spawn(process.execPath, [API_PATH], { cwd:ROOT, stdio:['ignore','pipe','pipe'], env:{ ...process.env, NODE_PATH:[process.env.NODE_PATH,'/opt/wolfhouse/WH/node_modules'].filter(Boolean).join(path.delimiter), NODE_ENV:'test', STAFF_QUERY_API_PORT:String(port), STAFF_QUERY_API_HOST:'127.0.0.1', STAFF_AUTH_REQUIRED:String(authRequired), STAFF_AUTH_ALLOW_OPEN:authRequired ? 'false' : 'true', DEFAULT_CLIENT_SLUG:'sunset', DATABASE_URL:'postgres://invalid:***@127.0.0.1:1/invalid' } });
  let logs=''; child.stdout.on('data', (d) => { logs += d; }); child.stderr.on('data', (d) => { logs += d; });
  for (let i=0;i<80;i++) { try { const r=await request(port,'/healthz'); if (r.status) return {child, logs:()=>logs}; } catch (_) {} await new Promise((r)=>setTimeout(r,50)); }
  child.kill(); throw new Error(`server did not start: ${logs}`);
}
async function stop(child) { if (!child || child.exitCode != null) return; child.kill('SIGTERM'); await Promise.race([new Promise((r)=>child.once('exit',r)),new Promise((r)=>setTimeout(r,1000))]); if (child.exitCode == null) child.kill('SIGKILL'); }
async function main() {
  ok('real GET route is admin-auth gated', /pathname === '\/staff\/admin\/finance\/summary' && method === 'GET'[\s\S]{0,300}requireAuth\(req, res, 'admin'\)/.test(API));
  ok('handler validates scope before withPgClient', API.indexOf("if (!clientSlug || SQL_INJECT_RE.test(clientSlug))") < API.indexOf('withPgClient((pg) => fetchSunsetFinanceData'));
  let open; let locked;
  try {
    open = await start(43981, false);
    const cases = [
      ['/staff/admin/finance/summary?location=sunset-somo',400],
      ['/staff/admin/finance/summary?client=&location=sunset-somo',400],
      ['/staff/admin/finance/summary?client=%27%3Bdrop&location=sunset-somo',400],
      ['/staff/admin/finance/summary?client=wolfhouse-somo&location=sunset-somo',403],
      ['/staff/admin/finance/summary?client=sunset',403],
      ['/staff/admin/finance/summary?client=sunset&location=',403],
      ['/staff/admin/finance/summary?client=sunset&location=sunset-sardinero',403],
    ];
    for (const [url,status] of cases) { const r=await request(43981,url); ok(`real route rejects ${url} with ${status} before PG`, r.status===status, `${r.status} ${r.body}`); }
    ok('pre-PG rejection does not log a DB connection attempt', !/ECONNREFUSED|invalid.*database|connect ECONN/.test(open.logs()), open.logs());
  } finally { await stop(open && open.child); }
  try {
    locked = await start(43982, true);
    const r = await request(43982,'/staff/admin/finance/summary?client=sunset&location=sunset-somo');
    ok('real auth gate rejects unauthenticated request', r.status===401 || r.status===403, `${r.status} ${r.body}`);
    ok('auth rejection occurs before PG', !/ECONNREFUSED|connect ECONN/.test(locked.logs()), locked.logs());
  } finally { await stop(locked && locked.child); }
  ok('data quality failure is safe 503', /err instanceof FinanceDataQualityError[\s\S]*503[\s\S]*FINANCE_DATA_QUALITY/.test(API));
  console.log(`\n── verify:sunset-finance-endpoint: ${pass} passed, ${fail} failed ──`);
  if (fail) process.exitCode=1; else console.log('verify:sunset-finance-endpoint — ALL CHECKS PASSED');
}
main().catch((e)=>{ console.error(e); process.exit(1); });
