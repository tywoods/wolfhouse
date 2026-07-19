'use strict';

/**
 * Run PostgreSQL provision operations from inside luna-sunset-staging-staff-api
 * (allowed firewall egress). Password never appears in az/container argv —
 * CREATE uses a temporary Key Vault secret read via managed identity.
 *
 * Worker source is staged to a temporary Key Vault secret (0600 --file), then a
 * short bootstrap command fetches it via MI. This avoids containerapp exec
 * command-length limits on Windows.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  TARGETS,
  redactSecrets,
} = require('./sunset-schema-observer-role-provision');

const TEMP_BOOTSTRAP_SECRET = 'sunset-schema-observer-bootstrap-temp';
const TEMP_WORKER_SECRET = 'sunset-schema-observer-worker-temp';
const STAFF_API_APP = 'luna-sunset-staging-staff-api';
/** User-assigned MI client id for luna-sunset-staging-identity (not a secret). */
const SUNSET_STAGING_MI_CLIENT_ID = '0e05fbe3-e8c5-48aa-a914-30aed284e6f7';

function azureCliPython() {
  if (process.platform === 'win32') {
    const candidate = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\python.exe';
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function azureCliInvoker() {
  const py = azureCliPython();
  if (py) {
    return { exe: py, prefixArgs: ['-IBm', 'azure.cli'] };
  }
  return { exe: 'az', prefixArgs: [] };
}

function azSpawn(args, opts) {
  const options = opts || {};
  const inv = azureCliInvoker();
  const result = spawnSync(inv.exe, inv.prefixArgs.concat(args), {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
    shell: false,
    timeout: options.timeout || 180000,
  });
  const mixed = String(result.stdout || '') + String(result.stderr || '');
  if (result.error || (result.status !== 0 && !options.allowFailure)) {
    throw Object.assign(
      new Error(redactSecrets(
        mixed.slice(0, 400) || (result.error && result.error.message) || `az_status_${result.status}`,
        options.secrets || [],
      )),
      { code: 'az_failed', status: result.status },
    );
  }
  return mixed;
}

function azJson(args, opts) {
  const out = azSpawn(args, opts);
  const s = String(out || '').replace(/^\uFEFF/, '').trim();
  const iObj = s.indexOf('{');
  const iArr = s.indexOf('[');
  let i = -1;
  if (iObj >= 0 && iArr >= 0) i = Math.min(iObj, iArr);
  else i = Math.max(iObj, iArr);
  if (i < 0) {
    if (opts && opts.allowEmpty) return null;
    throw Object.assign(new Error('az returned no JSON'), { code: 'az_no_json' });
  }
  const slice = s.slice(i);
  const open = slice[0];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let p = 0; p < slice.length; p += 1) {
    const ch = slice[p];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        end = p + 1;
        break;
      }
    }
  }
  if (end < 0) {
    if (opts && opts.allowEmpty) return null;
    throw Object.assign(new Error('az returned incomplete JSON'), { code: 'az_bad_json' });
  }
  return JSON.parse(slice.slice(0, end));
}

const CONTAINER_WORKER = `
const { Client } = require('/app/node_modules/pg');
const https = require('https');
const http = require('http');
const ROLE='sunset_schema_observer';
const DB='sunset_staging';
const HOST='luna-sunset-staging-pg-app.postgres.database.azure.com';
const KV='luna-sunset-staging-kv';
const TEMP='sunset-schema-observer-bootstrap-temp';
const op=process.env.WH_OBS_OP||'inspect';

function getMiToken(resource){
  const endpoint=process.env.IDENTITY_ENDPOINT;
  const header=process.env.IDENTITY_HEADER;
  if(!endpoint||!header) throw new Error('managed_identity_unavailable');
  const clientId=process.env.AZURE_CLIENT_ID||'0e05fbe3-e8c5-48aa-a914-30aed284e6f7';
  const url=endpoint+'?api-version=2019-08-01&resource='+encodeURIComponent(resource)+'&client_id='+encodeURIComponent(clientId);
  return new Promise((resolve,reject)=>{
    const req=http.get(url,{headers:{'X-IDENTITY-HEADER':header}},(res)=>{
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
        try{ resolve(JSON.parse(d).access_token); } catch(e){ reject(e); }
      });
    });
    req.on('error',reject);
  });
}

function kvGet(name,token){
  const p='/secrets/'+encodeURIComponent(name)+'?api-version=7.4';
  const opts={hostname:KV+'.vault.azure.net',path:p,method:'GET',headers:{Authorization:'Bearer '+token}};
  return new Promise((resolve,reject)=>{
    const req=https.request(opts,(res)=>{
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
        if(res.statusCode===404) return resolve(null);
        if(res.statusCode>=300) return reject(new Error('kv_get_'+res.statusCode));
        try{ resolve(JSON.parse(d).value); } catch(e){ reject(e); }
      });
    });
    req.on('error',reject); req.end();
  });
}

function sqlLit(v){ return "'"+String(v).replace(/'/g,"''")+"'"; }

async function withClient(fn){
  const raw=process.env.WOLFHOUSE_DATABASE_URL||'';
  const u=new URL(raw);
  if(u.hostname!==HOST) throw new Error('wrong_db_host');
  if((u.pathname||'').replace(/^\\//,'')!==DB) throw new Error('wrong_db_name');
  const client=new Client({
    host:HOST, port:5432, user:decodeURIComponent(u.username||''),
    password:decodeURIComponent(u.password||''), database:DB,
    ssl:{rejectUnauthorized:true, servername:HOST},
    connectionTimeoutMillis:20000,
    application_name:'wh-sunset-schema-observer-provision'
  });
  await client.connect();
  try{
    const cur=await client.query('SELECT current_database() AS db');
    if(cur.rows[0].db!==DB) throw new Error('wrong_current_database');
    return await fn(client);
  } finally { try{ await client.end(); } catch(_){} }
}

async function inspect(client){
  const existsR=await client.query('SELECT 1 AS ok FROM pg_roles WHERE rolname=$1',[ROLE]);
  const roleExists=existsR.rowCount>0;
  if(!roleExists){
    return {roleExists:false,attributes:null,memberships:[],ownedObjects:[],grants:[],roleSettings:{},databaseSettings:{}};
  }
  const a=(await client.query('SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[ROLE])).rows[0];
  const memberships=(await client.query('SELECT r.rolname AS member_of FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid JOIN pg_roles u ON u.oid=m.member WHERE u.rolname=$1 ORDER BY 1',[ROLE])).rows.map(r=>r.member_of);
  const ownedObjects=(await client.query("SELECT n.nspname||'.'||c.relname AS obj FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname=$1 ORDER BY 1 LIMIT 50",[ROLE])).rows.map(r=>r.obj);
  const hasConnect=(await client.query('SELECT has_database_privilege($1,$2,\\'CONNECT\\') AS c',[ROLE,DB])).rows[0].c===true;
  const grants=hasConnect?[{privilege:'CONNECT',objectType:'DATABASE',objectName:DB}]:[];
  const roleSettings={};
  for(const row of (await client.query('SELECT unnest(COALESCE(rolconfig,ARRAY[]::text[])) AS cfg FROM pg_roles WHERE rolname=$1',[ROLE])).rows){
    const cfg=String(row.cfg||''); const eq=cfg.indexOf('='); if(eq>0) roleSettings[cfg.slice(0,eq)]=cfg.slice(eq+1);
  }
  const databaseSettings={};
  for(const row of (await client.query('SELECT setconfig FROM pg_db_role_setting s JOIN pg_roles r ON r.oid=s.setrole JOIN pg_database d ON d.oid=s.setdatabase WHERE r.rolname=$1 AND d.datname=$2',[ROLE,DB])).rows){
    for(const cfg of (row.setconfig||[])){ const s=String(cfg); const eq=s.indexOf('='); if(eq>0) databaseSettings[s.slice(0,eq)]=s.slice(eq+1); }
  }
  const attributes={
    rolcanlogin:a.rolcanlogin===true, rolsuper:a.rolsuper===true, rolcreatedb:a.rolcreatedb===true,
    rolcreaterole:a.rolcreaterole===true, rolinherit:a.rolinherit===true, rolreplication:a.rolreplication===true,
    rolbypassrls:a.rolbypassrls===true,
    default_transaction_read_only:String(roleSettings.default_transaction_read_only||'').toLowerCase()||'off'
  };
  return {roleExists:true,attributes,memberships,ownedObjects,grants,roleSettings,databaseSettings};
}

async function main(){
  const out=await withClient(async (client)=>{
    if(op==='ping'){
      const r=await client.query('SELECT current_database() AS db');
      return {ok:true,db:r.rows[0].db,host:HOST};
    }
    if(op==='inspect') return await inspect(client);
    if(op==='exec'){
      const sql=process.env.WH_OBS_SQL_B64
        ? Buffer.from(process.env.WH_OBS_SQL_B64,'base64').toString('utf8')
        : (process.env.WH_OBS_SQL||'');
      if(!sql) throw new Error('missing_sql');
      if(/PASSWORD/i.test(sql)) throw new Error('password_sql_forbidden_via_exec');
      await client.query(sql);
      return {ok:true};
    }
    if(op==='create_role'){
      const token=await getMiToken('https://vault.azure.net');
      const password=await kvGet(TEMP, token);
      if(!password) throw new Error('bootstrap_password_missing');
      if(!/^[A-Za-z0-9_-]{40,128}$/.test(password)) throw new Error('password_format_invalid');
      const sql='CREATE ROLE '+ROLE+' LOGIN PASSWORD '+sqlLit(password)+' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
      await client.query(sql);
      return {ok:true,created:true};
    }
    if(op==='bootstrap_create'){
      const token=await getMiToken('https://vault.azure.net');
      const password=await kvGet(TEMP, token);
      if(!password) throw new Error('bootstrap_password_missing');
      if(!/^[A-Za-z0-9_-]{40,128}$/.test(password)) throw new Error('password_format_invalid');
      const progress={ok:false,transactional:true,createSucceeded:false,grantSucceeded:false,alterSucceeded:false,committed:false,rolledBack:false,roleRemains:null,hasConnect:null,hasReadonlySetting:null,failedStep:null,error:null};
      try{
        await client.query('BEGIN');
        await client.query('CREATE ROLE '+ROLE+' LOGIN PASSWORD '+sqlLit(password)+' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS');
        progress.createSucceeded=true;
        await client.query('GRANT CONNECT ON DATABASE '+DB+' TO '+ROLE);
        progress.grantSucceeded=true;
        await client.query('ALTER ROLE '+ROLE+' SET default_transaction_read_only = on');
        progress.alterSucceeded=true;
        await client.query('COMMIT');
        progress.committed=true;
        progress.ok=true;
        progress.roleRemains=true;
        progress.hasConnect=true;
        progress.hasReadonlySetting=true;
        return progress;
      }catch(err){
        progress.failedStep=progress.alterSucceeded?'commit':(progress.grantSucceeded?'alter':(progress.createSucceeded?'grant':'create'));
        progress.error=String(err&&err.message||err).replace(password,'***REDACTED***');
        try{ await client.query('ROLLBACK'); progress.rolledBack=true; }catch(rb){ progress.rolledBack=false; progress.error+=";rollback_failed"; }
        const existsR=await client.query('SELECT 1 AS ok FROM pg_roles WHERE rolname=$1',[ROLE]);
        progress.roleRemains=existsR.rowCount>0;
        if(progress.roleRemains){
          try{ progress.hasConnect=(await client.query('SELECT has_database_privilege($1,$2,\\'CONNECT\\') AS c',[ROLE,DB])).rows[0].c===true; }catch(_){ progress.hasConnect=null; }
          try{
            const cfgs=(await client.query('SELECT unnest(COALESCE(rolconfig,ARRAY[]::text[])) AS cfg FROM pg_roles WHERE rolname=$1',[ROLE])).rows||[];
            progress.hasReadonlySetting=cfgs.some(r=>String(r.cfg||'').toLowerCase().startsWith('default_transaction_read_only='));
          }catch(_){ progress.hasReadonlySetting=null; }
        }else{
          progress.hasConnect=false;
          progress.hasReadonlySetting=false;
        }
        progress.ok=false;
        return progress;
      }
    }
    throw new Error('unknown_op');
  });
  process.stdout.write('WH_OBS_BEGIN'+JSON.stringify(out)+'WH_OBS_END');
}
main().catch((e)=>{ process.stdout.write('WH_OBS_BEGIN'+JSON.stringify({ok:false,error:String(e&&e.message||e)})+'WH_OBS_END'); process.exit(1); });
`;

function buildBootstrapFetch(secretName) {
  const nameLit = JSON.stringify(String(secretName));
  return `(async()=>{
const http=require('http'),https=require('https'),fs=require('fs');
const ep=process.env.IDENTITY_ENDPOINT,h=process.env.IDENTITY_HEADER;
if(!ep||!h)throw new Error('managed_identity_unavailable');
const clientId=process.env.AZURE_CLIENT_ID||'${SUNSET_STAGING_MI_CLIENT_ID}';
const tok=await new Promise((res,rej)=>{http.get(ep+'?api-version=2019-08-01&resource='+encodeURIComponent('https://vault.azure.net')+'&client_id='+encodeURIComponent(clientId),{headers:{'X-IDENTITY-HEADER':h}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d).access_token)}catch(e){rej(e)}})}).on('error',rej)});
const body=await new Promise((res,rej)=>{const req=https.request({hostname:'luna-sunset-staging-kv.vault.azure.net',path:'/secrets/'+encodeURIComponent(${nameLit})+'?api-version=7.4',method:'GET',headers:{Authorization:'Bearer '+tok}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{if(r.statusCode===404)return rej(new Error('worker_missing'));if(r.statusCode>=300)return rej(new Error('kv_get_'+r.statusCode));try{res(JSON.parse(d).value)}catch(e){rej(e)}})});req.on('error',rej);req.end()});
fs.writeFileSync('/tmp/wh_obs_w.js',body);require('/tmp/wh_obs_w.js');
})().catch(e=>{process.stdout.write('WH_OBS_BEGIN'+JSON.stringify({ok:false,error:String(e&&e.message||e)})+'WH_OBS_END');process.exit(1)});`;
}

function buildLauncherSource(op, envExtra) {
  const extra = { ...(envExtra || {}) };
  if (extra.WH_OBS_SQL) {
    extra.WH_OBS_SQL_B64 = Buffer.from(String(extra.WH_OBS_SQL), 'utf8').toString('base64');
    delete extra.WH_OBS_SQL;
  }
  const envAssigns = Object.entries({ WH_OBS_OP: op, ...extra })
    .map(([k, v]) => `process.env[${JSON.stringify(k)}]=${JSON.stringify(String(v))};`)
    .join('');
  return `${envAssigns}${CONTAINER_WORKER}`;
}

function secretIsActive(secretName) {
  try {
    azJson([
      'keyvault', 'secret', 'show',
      '--vault-name', TARGETS.keyVault,
      '--name', secretName,
      '--subscription', TARGETS.subscriptionId,
      '-o', 'json',
    ]);
    return true;
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/SecretNotFound|was not found|Secret Disabled|404/i.test(msg)) {
      return false;
    }
    // Ambiguous — treat as still present so callers fail closed.
    return true;
  }
}

/**
 * Delete + purge temp worker secret, then verify it is not an active secret.
 * Surfaces secret-free failure if still active. Never returns secret values.
 */
function deleteWorkerSecret(secretName) {
  const name = secretName || TEMP_WORKER_SECRET;
  const errors = [];
  try {
    azJson([
      'keyvault', 'secret', 'delete',
      '--vault-name', TARGETS.keyVault,
      '--name', name,
      '--subscription', TARGETS.subscriptionId,
      '-o', 'json',
    ], { allowFailure: true, allowEmpty: true });
  } catch (err) {
    errors.push(`delete:${String(err && err.message ? err.message : err).slice(0, 120)}`);
  }
  try {
    azSpawn([
      'keyvault', 'secret', 'purge',
      '--vault-name', TARGETS.keyVault,
      '--name', name,
      '--subscription', TARGETS.subscriptionId,
    ], { allowFailure: true });
  } catch (err) {
    errors.push(`purge:${String(err && err.message ? err.message : err).slice(0, 120)}`);
  }

  if (secretIsActive(name)) {
    throw Object.assign(
      new Error(redactSecrets(
        `temp_worker_secret_still_active name=${name}${errors.length ? ` detail=${errors.join(';')}` : ''}`,
        [],
      )),
      { code: 'temp_worker_secret_still_active', secretName: name },
    );
  }
  return { ok: true, secretName: name, active: false };
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* fallback spin */ }
  }
}

function runBootstrapCommand(secretName) {
  const b64 = Buffer.from(buildBootstrapFetch(secretName), 'utf8').toString('base64');
  const command =
    `node -e "require('fs').writeFileSync('/tmp/wh_obs_b.js',Buffer.from('${b64}','base64'));require('/tmp/wh_obs_b.js')"`;
  if (command.length > 4000) {
    throw Object.assign(new Error('bootstrap command exceeds safe length'), { code: 'bootstrap_too_long' });
  }
  const inv = azureCliInvoker();
  const args = inv.prefixArgs.concat([
    'containerapp', 'exec',
    '-g', TARGETS.resourceGroup,
    '-n', STAFF_API_APP,
    '--subscription', TARGETS.subscriptionId,
    '--command', command,
  ]);

  const maxAttempts = 4;
  let lastMixed = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnSync(inv.exe, args, {
      encoding: 'utf8',
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
      shell: false,
      timeout: 180000,
    });
    lastMixed = String(result.stdout || '') + String(result.stderr || '');
    if (lastMixed.includes('WH_OBS_BEGIN') && lastMixed.includes('WH_OBS_END')) {
      return lastMixed;
    }
    const rateLimited = /429|Too Many Requests|retry-after/i.test(lastMixed);
    if (rateLimited && attempt < maxAttempts) {
      const m = lastMixed.match(/retry-after['\":\s]+(\d+)/i);
      const waitSec = m ? Math.min(Number(m[1]), 600) : 60;
      sleepSync(waitSec * 1000);
      continue;
    }
    return lastMixed;
  }
  return lastMixed;
}

/**
 * Stage worker to a unique KV secret, exec short bootstrap in staff-api, parse markers, delete.
 * Cleanup failure is never silently ignored — surfaces secret-free error if secret still active.
 */
function runContainerWorker(op, envExtra) {
  const launcher = buildLauncherSource(op, envExtra);
  const secretName = `${TEMP_WORKER_SECRET}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-obs-worker-'));
  const filePath = path.join(dir, 'worker.js');
  try {
    fs.writeFileSync(filePath, launcher, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch (_) { /* windows */ }
    azJson([
      'keyvault', 'secret', 'set',
      '--vault-name', TARGETS.keyVault,
      '--name', secretName,
      '--file', filePath,
      '--subscription', TARGETS.subscriptionId,
      '-o', 'json',
    ]);
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    try { fs.rmdirSync(dir); } catch (_) { /* ignore */ }
  }

  let mixed;
  let cleanupError = null;
  try {
    mixed = runBootstrapCommand(secretName);
  } finally {
    try {
      deleteWorkerSecret(secretName);
    } catch (err) {
      cleanupError = err;
    }
  }

  const begin = mixed.indexOf('WH_OBS_BEGIN');
  const end = mixed.indexOf('WH_OBS_END');
  if (begin < 0 || end <= begin) {
    throw Object.assign(
      new Error(redactSecrets(
        cleanupError
          ? `${String(cleanupError.message || cleanupError)}; container worker produced no result marker`
          : (mixed.slice(0, 400) || 'container worker produced no result marker'),
        [],
      )),
      { code: cleanupError ? cleanupError.code || 'temp_worker_secret_still_active' : 'container_exec_failed' },
    );
  }
  const parsed = JSON.parse(mixed.slice(begin + 'WH_OBS_BEGIN'.length, end));
  // Preserve complete secret-free worker progress even when temp worker-secret cleanup fails.
  // Callers must treat tempWorkerSecretCleanup.ok===false as failure (and roll back if committed).
  const tempWorkerSecretCleanup = cleanupError
    ? {
      ok: false,
      stillActive: true,
      code: cleanupError.code || 'temp_worker_secret_still_active',
      secretName,
    }
    : {
      ok: true,
      stillActive: false,
      secretName,
    };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed.tempWorkerSecretCleanup = tempWorkerSecretCleanup;
  }
  return parsed;
}

/**
 * Stage arbitrary worker JS to a temp KV secret, exec via MI bootstrap, parse WH_OBS markers, delete.
 * Same secret-safe path as runContainerWorker; for Slice 11 read-only/drift proofs.
 */
function runStagedWorkerSource(source) {
  const launcher = String(source || '');
  if (!launcher.includes('WH_OBS_BEGIN') || !launcher.includes('WH_OBS_END')) {
    throw Object.assign(new Error('worker source must emit WH_OBS markers'), { code: 'worker_markers_required' });
  }
  const secretName = `${TEMP_WORKER_SECRET}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-obs-worker-'));
  const filePath = path.join(dir, 'worker.js');
  try {
    fs.writeFileSync(filePath, launcher, { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(filePath, 0o600); } catch (_) { /* windows */ }
    azJson([
      'keyvault', 'secret', 'set',
      '--vault-name', TARGETS.keyVault,
      '--name', secretName,
      '--file', filePath,
      '--subscription', TARGETS.subscriptionId,
      '-o', 'json',
    ]);
  } finally {
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    try { fs.rmdirSync(dir); } catch (_) { /* ignore */ }
  }

  let mixed;
  let cleanupError = null;
  try {
    mixed = runBootstrapCommand(secretName);
  } finally {
    try {
      deleteWorkerSecret(secretName);
    } catch (err) {
      cleanupError = err;
    }
  }

  const begin = mixed.indexOf('WH_OBS_BEGIN');
  const end = mixed.indexOf('WH_OBS_END');
  if (begin < 0 || end <= begin) {
    throw Object.assign(
      new Error(redactSecrets(
        cleanupError
          ? `${String(cleanupError.message || cleanupError)}; container worker produced no result marker`
          : (mixed.slice(0, 400) || 'container worker produced no result marker'),
        [],
      )),
      { code: cleanupError ? cleanupError.code || 'temp_worker_secret_still_active' : 'container_exec_failed' },
    );
  }
  const parsed = JSON.parse(mixed.slice(begin + 'WH_OBS_BEGIN'.length, end));
  const tempWorkerSecretCleanup = cleanupError
    ? {
      ok: false,
      stillActive: true,
      code: cleanupError.code || 'temp_worker_secret_still_active',
      secretName,
    }
    : {
      ok: true,
      stillActive: false,
      secretName,
    };
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    parsed.tempWorkerSecretCleanup = tempWorkerSecretCleanup;
  }
  if (cleanupError) {
    throw Object.assign(
      new Error(redactSecrets(String(cleanupError.message || cleanupError), [])),
      {
        code: cleanupError.code || 'temp_worker_secret_still_active',
        result: parsed,
      },
    );
  }
  return parsed;
}

module.exports = {
  TEMP_BOOTSTRAP_SECRET,
  TEMP_WORKER_SECRET,
  STAFF_API_APP,
  SUNSET_STAGING_MI_CLIENT_ID,
  runContainerWorker,
  runStagedWorkerSource,
  azureCliInvoker,
  azJson,
  deleteWorkerSecret,
  secretIsActive,
};
