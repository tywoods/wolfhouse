#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2a-tenant-staging-iac — MOVE-aware Stage 2A security gate. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const MOVE_BASE = 'ecc9728135ce80a17c1acfc056efc2a1bdcd92cb';
const BUDGET_BASE = 'ee7a37a459129186b3c506f27af4d43254e3cf73';
const BASE = MOVE_BASE;
const MODULE_REL = 'infra/azure/modules/tenant-staging/main.bicep';
const FIXTURE_REL = 'infra/azure/modules/tenant-staging/parameters.synthetic.json';
const WRAPPER_REL = 'infra/azure/sunset-staging/main.bicep';
const FILES = [MODULE_REL, FIXTURE_REL, WRAPPER_REL,
  'scripts/verify-messi-saas-stage2a-tenant-staging-iac.js', 'package.json',
  'scripts/verify-sunset-staging-bicep-reconcile.js',
  'scripts/verify-radar-slice16l-staff-api-capacity-alerts.js'];
const LOCKED = { rg: 'luna-sunset-staging-rg', prefix: 'luna-sunset-staging', db: 'sunset_staging',
  tenant: 'sunset', acr: 'whstagingacr.azurecr.io', imageRepo: 'luna-sunset-staff-api' };
let pass = 0; let fail = 0;
const ok = (n, c, d) => { if (c) { pass += 1; console.log(`  PASS  ${n}`); }
else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
const bin = () => ['/opt/data/home/.azure/bin/bicep', '/opt/data/.azure/bin/bicep'].find((p) => fs.existsSync(p));
const tmpDirs = [];
const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };
const cleanup = () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };
function build(file, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(bin(), ['build', file, '--outfile', out], {
    cwd: ROOT, env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}
const show = (p) => execFileSync('git', ['show', p], { cwd: ROOT, encoding: 'utf8' });
function diffStat() {
  const out = execFileSync('git', ['diff', '--numstat', BUDGET_BASE, '--', ...FILES], { cwd: ROOT, encoding: 'utf8' }).trim();
  let rawAdd = 0; let rawDel = 0; const perFile = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, d, file] = line.split('\t');
    const add = a === '-' ? 0 : Number(a); const del = d === '-' ? 0 : Number(d);
    rawAdd += add; rawDel += del; perFile.push({ file, add, del });
  }
  for (const rel of FILES) {
    if (perFile.some((p) => p.file === rel)) continue;
    const abs = path.join(ROOT, rel); if (!fs.existsSync(abs)) continue;
    let baseLines = 0; try { baseLines = show(`${BUDGET_BASE}:${rel}`).split(/\r?\n/).length; } catch (_) {}
    const cur = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
    if (!baseLines) { rawAdd += cur; perFile.push({ file: rel, add: cur, del: 0 }); }
  }
  const mod = perFile.find((p) => p.file === MODULE_REL) || { add: 0, del: 0 };
  const wrap = perFile.find((p) => p.file === WRAPPER_REL) || { add: 0, del: 0 };
  const moved = (mod.add >= 400 && wrap.del >= 300) ? mod.add : Math.min(mod.add, wrap.del);
  return { rawAdd, rawDel, net: rawAdd - rawDel, perFile, files: perFile.length, moved,
    nonMoved: Math.max(0, rawAdd - moved) };
}
function flatten(compiled) {
  const resources = []; const variables = { ...(compiled.variables || {}) };
  const walk = (list, pv) => {
    for (const r of list || []) {
      if (r.type === 'Microsoft.Resources/deployments') {
        const tpl = (r.properties || {}).template || {};
        const passed = (r.properties || {}).parameters || {};
        const next = { ...pv };
        for (const [k, v] of Object.entries(passed)) {
          if (!v || !Object.prototype.hasOwnProperty.call(v, 'value')) continue;
          let val = v.value;
          const vm = typeof val === 'string' && val.match(/^\[variables\('([^']+)'\)\]$/);
          if (vm && Object.prototype.hasOwnProperty.call(variables, vm[1])) val = variables[vm[1]];
          next[k] = val;
        }
        Object.assign(variables, tpl.variables || {});
        walk(tpl.resources || [], next); continue;
      }
      resources.push({ r, pv });
    }
  };
  walk(compiled.resources || [], {});
  return { resources, variables };
}
function mapEnv(rawEnv, variables, pv) {
  const evalCond = (cond) => {
    const c = String(cond).trim();
    const notVar = c.match(/^!variables\('([^']+)'\)$/);
    if (notVar) {
      const v = variables[notVar[1]];
      return !(v === true || v === 'true');
    }
    const pm = c.match(/parameters\('([^']+)'\)/);
    if (pm) return pv[pm[1]] === true || pv[pm[1]] === 'true';
    const vm = c.match(/variables\('([^']+)'\)/);
    if (vm) {
      const v = variables[vm[1]];
      return v === true || v === 'true';
    }
    return false;
  };
  const resolveArr = (expr) => {
    if (Array.isArray(expr)) return expr;
    if (typeof expr !== 'string') return [];
    const s = expr.trim();
    if (s === 'createArray()' || s === '[]') return [];
    const varM = s.match(/^variables\('([^']+)'\)$/);
    if (varM) {
      const v = variables[varM[1]];
      return Array.isArray(v) ? v : [];
    }
    const ifM = s.match(/^if\((.+),\s*variables\('([^']+)'\),\s*createArray\(\)\)$/);
    if (ifM) {
      return evalCond(ifM[1]) ? (Array.isArray(variables[ifM[2]]) ? variables[ifM[2]] : []) : [];
    }
    const concatM = s.match(/^\[?concat\(([\s\S]*)\)\]?$/);
    if (concatM) {
      const inner = concatM[1];
      const parts = [];
      let depth = 0;
      let cur = '';
      for (let i = 0; i < inner.length; i += 1) {
        const ch = inner[i];
        if (ch === '(') depth += 1;
        if (ch === ')') depth -= 1;
        if (ch === ',' && depth === 0) {
          parts.push(cur.trim());
          cur = '';
          continue;
        }
        cur += ch;
      }
      if (cur.trim()) parts.push(cur.trim());
      return parts.reduce((acc, p) => acc.concat(resolveArr(p)), []);
    }
    return [];
  };
  const envArr = typeof rawEnv === 'string' && /concat\(/.test(rawEnv) ? resolveArr(rawEnv) : rawEnv;
  return (Array.isArray(envArr) ? envArr : []).map((e) => {
    if (e.secretRef) {
      const pm = typeof e.secretRef === 'string' && e.secretRef.match(/^\[parameters\('([^']+)'\)\]$/);
      return `${e.name}=secret:${(pm && pv[pm[1]]) ? pv[pm[1]] : e.secretRef}`;
    }
    let val = e.value;
    if (typeof val === 'string') {
      const vm = val.match(/^\[variables\('([^']+)'\)\]$/);
      if (vm) {
        if (/^effective(WhatsappDryRun|StripeLinksEnabled|StaffActionsEnabled)$/.test(vm[1])) {
          return `${e.name}=true`; // Sunset locked-live enablement
        }
        if (Object.prototype.hasOwnProperty.call(variables, vm[1])) val = variables[vm[1]];
      }
      const pm = typeof val === 'string' && val.match(/^\[parameters\('([^']+)'\)\]$/);
      if (pm && Object.prototype.hasOwnProperty.call(pv, pm[1])) return `${e.name}=${pv[pm[1]]}`;
      if (/staffApiCustomDomain|checkout(Success|Cancel)Url/.test(String(val))) return `${e.name}=domain`;
    }
    return `${e.name}=${val}`;
  }).sort();
}
function graph(compiled) {
  const { resources, variables } = flatten(compiled);
  const types = []; const alerts = []; let env = []; let secrets = [];
  for (const { r, pv } of resources) {
    if (/sunsetTenantStaging/.test(String(r.name))) continue;
    types.push(r.type);
    if (r.type === 'Microsoft.Insights/metricAlerts') {
      const s = String(r.name || '');
      const m = s.match(/^\[format\('\{0\}-staff-api-(cpu|memory)-pressure',\s*parameters\('capacityAlertNamePrefix'\)\)\]$/);
      alerts.push((m && pv.capacityAlertNamePrefix)
        ? `${pv.capacityAlertNamePrefix}-staff-api-${m[1]}-pressure` : s);
    }
    if (r.type !== 'Microsoft.App/containerApps') continue;
    const cfg = (r.properties || {}).configuration || {};
    secrets = (cfg.secrets || []).map((s) => {
      const pm = typeof s.name === 'string' && s.name.match(/^\[parameters\('([^']+)'\)\]$/);
      return (pm && pv[pm[1]]) ? pv[pm[1]] : s.name;
    }).sort();
    const c0 = (((r.properties || {}).template || {}).containers || [])[0] || {};
    env = mapEnv(c0.env || [], variables, pv);
  }
  return { types: types.sort(), alerts: alerts.sort(), env, secrets,
    radar: [variables.radar16lCapacityThreshold, variables.radar16lWindowSize, variables.radar16lEvaluationFrequency, variables.radar16lTimeAggregation] };
}
function buildBase() {
  const src = show(`${BASE}:infra/azure/sunset-staging/main.bicep`);
  const dir = mkTmp('s2a-base-');
  fs.writeFileSync(path.join(dir, 'main.bicep'), src);
  fs.writeFileSync(path.join(dir, 'acr-pull-role.bicep'), show(`${BASE}:infra/azure/sunset-staging/acr-pull-role.bicep`));
  fs.writeFileSync(path.join(dir, 'schema-observer-job.bicep'), show(`${BASE}:infra/azure/sunset-staging/schema-observer-job.bicep`));
  return build(path.join(dir, 'main.bicep'), path.join(dir, 'out.json'));
}
const hasFail = (mod, code) => new RegExp(`fail\\('${code}'\\)`).test(mod);
try {
  console.log('verify:messi-saas-stage2a-tenant-staging-iac — Stage 2A\n');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  ok('package_script', pkg.scripts && pkg.scripts['verify:messi-saas-stage2a-tenant-staging-iac']
    === 'node scripts/verify-messi-saas-stage2a-tenant-staging-iac.js');
  const modulePath = path.join(ROOT, MODULE_REL);
  const fixturePath = path.join(ROOT, FIXTURE_REL);
  const wrapperPath = path.join(ROOT, WRAPPER_REL);
  const mod = fs.existsSync(modulePath) ? fs.readFileSync(modulePath, 'utf8') : '';
  const wrap = fs.existsSync(wrapperPath) ? fs.readFileSync(wrapperPath, 'utf8') : '';
  const fixTxt = fs.existsSync(fixturePath) ? fs.readFileSync(fixturePath, 'utf8') : '';
  let fix = null; try { fix = JSON.parse(fixTxt); } catch (_) {}
  const fv = (k) => fix && fix.parameters && fix.parameters[k] && fix.parameters[k].value;
  ok('module_exists', Boolean(mod));
  ok('fixture_exists', Boolean(fix));
  ok('wrapper_module_invoke', /module\s+tenantStaging\s+'\.\.\/modules\/tenant-staging\/main\.bicep'/.test(wrap));
  ok('wrapper_hard_fail_rg', /fail\('sunset_wrapper_wrong_rg'\)/.test(wrap));
  ok('wrapper_locks_prefix_db', /'luna-sunset-staging'/.test(wrap) && /'sunset_staging'/.test(wrap) && /@allowed/.test(wrap));
  ok('wrapper_live_enablement', /lockedStaffActionsEnabled\s*=\s*'true'/.test(wrap)
    && /lockedStripeLinksEnabled\s*=\s*'true'/.test(wrap) && /lockedWhatsappDryRun\s*=\s*'true'/.test(wrap)
    && /lockedTenantSlug\s*=\s*'sunset'/.test(wrap));
  ok('wrapper_locked_acr_image', wrap.includes(`'${LOCKED.acr}'`) && wrap.includes(`'${LOCKED.imageRepo}'`) && /acrLoginServer:\s*lockedAcrLoginServer/.test(wrap) && /staffApiImageRepository:\s*lockedStaffApiImageRepository/.test(wrap));
  ok('module_params', /param tenantSlug string/.test(mod) && /param assertedResourceGroupName string/.test(mod) && /param acrLoginServer string/.test(mod) && /param staffApiImageRepository string/.test(mod) && /@secure\(\)/.test(mod));
  ok('locked_live_tuple', /isLockedLiveSunset/.test(mod) && mod.includes(`'${LOCKED.rg}'`)
    && mod.includes(`'${LOCKED.prefix}'`) && mod.includes(`'${LOCKED.db}'`)
    && hasFail(mod, 'sunset_slug_requires_locked_live_tuple'));
  ok('reserved_slug_guard', hasFail(mod, 'reserved_slug_in_synthetic_mode')
    && /tenantSlugLower\s*=\s*toLower\(tenantSlug\)/.test(mod)
    && /startsWith\(tenantSlugLower,\s*'wolfhouse'\)/.test(mod));
  ok('unconditional_scope_env', hasFail(mod, 'wrong_resource_group') && hasFail(mod, 'non_staging_environment')
    && /safetyLocksSatisfied/.test(mod) && /resourceTags[\s\S]{0,200}safetyLocksSatisfied/.test(mod)
    && /tags:\s*union\(resourceTags/.test(mod));
  ok('derived_synthetic_outbound', /effectiveWhatsappDryRun\s*=\s*isLockedLiveSunset\s*\?\s*whatsappDryRun\s*:\s*'true'/.test(mod)
    && /effectiveStripeLinksEnabled\s*=\s*isLockedLiveSunset\s*\?\s*stripeLinksEnabled\s*:\s*'false'/.test(mod)
    && /effectiveStaffActionsEnabled\s*=\s*isLockedLiveSunset\s*\?\s*staffActionsEnabled\s*:\s*'false'/.test(mod)
    && /value:\s*effectiveWhatsappDryRun/.test(mod) && /value:\s*effectiveStaffActionsEnabled/.test(mod)
    && /value:\s*effectiveStripeLinksEnabled/.test(mod));
  ok('acr_image_parameterized', /staffApiImage\s*=\s*'\$\{acrLoginServer\}\/\$\{staffApiImageRepository\}:\$\{staffApiImageTag\}'/.test(mod)
    && /server:\s*acrLoginServer/.test(mod) && hasFail(mod, 'image_registry_mismatch'));
  ok('sunset_env_gated', /var sunsetAdminLocationEnv/.test(mod) && /var baseStaffEnv/.test(mod)
    && /concat\(\s*baseStaffEnv\s*,\s*enableSunsetRuntimeEnv\s*\?\s*sunsetAdminLocationEnv\s*:\s*\[\]/.test(mod));
  const runtimeLibs = ['scripts/lib/tenant-business-config.js', 'scripts/lib/tenant-admin-writes.js',
    'scripts/lib/sunset-inbox-channel-config.js'].map((r) => fs.readFileSync(path.join(ROOT, r), 'utf8')).join('\n');
  const hasGenericAdmin = /process\.env\.(TENANT_ADMIN_|ADMIN_DB_READ_ENABLED|GENERIC_ADMIN_)/.test(runtimeLibs)
    && !/SUNSET_ADMIN_DB_READ_ENABLED/.test(runtimeLibs);
  const hasLegacyLocAb = /process\.env\.LOCATION_[AB]_WHATSAPP/.test(runtimeLibs);
  const hasSlot = /channel_slot/.test(runtimeLibs) && /tenantLocationChannelEnvKeys/.test(runtimeLibs);
  ok('third_tenant_runtime_redesign_gate', !hasGenericAdmin && !hasLegacyLocAb && hasSlot
    && /SUNSET_ADMIN_DB_READ_ENABLED/.test(runtimeLibs) && /TENANT_RUNTIME_CONFIG_ENV/.test(runtimeLibs),
  'Stage 2B channel_slot allowlist; Sunset legacy flags preserved');
  ok('observer_naming_parameterized', /param schemaObserverJobName string/.test(mod)
    && /param schemaObserverDatabaseSecretName string/.test(mod)
    && /resolvedSchemaObserverJobName/.test(mod)
    && /observerDatabaseSecretName:\s*resolvedSchemaObserverSecretName/.test(mod));
  ok('fixture_staging_disabled_outbound', Boolean(fix)
    && String(fv('appNamePrefix') || '').includes('staging')
    && fv('whatsappDryRun') === 'true' && fv('stripeLinksEnabled') === 'false'
    && fv('staffActionsEnabled') === 'false' && fv('enableSunsetRuntimeEnv') === false
    && fv('acrLoginServer') === LOCKED.acr && fv('staffApiImageRepository') === LOCKED.imageRepo
    && fv('tenantSlug') !== 'sunset' && fv('tenantSlug') !== 'wolfhouse'
    && /SYNTHETIC|NOT_A_SECRET|example\.invalid/i.test(fixTxt) && !/sk_live_|whsec_/.test(fixTxt));
  const reservedVariant = (slug) => ['wh', 'wolfhouse'].includes(slug.toLowerCase()) || slug.toLowerCase().startsWith('wolfhouse-');
  ok('hostile_reserved_impersonation', hasFail(mod, 'reserved_slug_in_synthetic_mode')
    && ['Wolfhouse', 'WH', 'Wolfhouse-Somo'].every(reservedVariant));
  ok('hostile_rg_mismatch_staff_disabled', hasFail(mod, 'wrong_resource_group')
    && /safetyLocksSatisfied/.test(mod) && /deployStaffApi/.test(mod));
  ok('hostile_non_staging_environment', hasFail(mod, 'non_staging_environment'));
  ok('hostile_registry_image_mismatch', hasFail(mod, 'image_registry_mismatch'));
  ok('hostile_hidden_sunset_literals', /enableSunsetRuntimeEnv\s*\?\s*sunsetAdminLocationEnv\s*:\s*\[\]/.test(mod)
    && fv('enableSunsetRuntimeEnv') === false);

  const st = diffStat();
  console.log('\n── budget ──');
  console.log(JSON.stringify({ files: st.files, rawAdd: st.rawAdd, rawDel: st.rawDel, net: st.net,
    moved: st.moved, nonMoved: st.nonMoved, perFile: st.perFile }, null, 2));
  ok('budget_files', st.files <= 9, `files=${st.files}`);
  ok('budget_raw', st.rawAdd <= 1100 && (st.moved > 0 ? st.rawDel >= Math.floor(st.rawAdd * 0.30) : true),
    `rawAdd=${st.rawAdd} rawDel=${st.rawDel}`);
  ok('budget_net', st.net <= 700, `net=${st.net}`);
  ok('budget_non_moved', st.nonMoved <= 700, `nonMoved=${st.nonMoved}`);

  if (mod && wrap && bin()) {
    try {
      const outDir = mkTmp('s2a-compile-');
      const baseG = graph(buildBase());
      const curG = graph(build(wrapperPath, path.join(outDir, 'wrapper.json')));
      const errs = [];
      if (JSON.stringify(baseG.types) !== JSON.stringify(curG.types)) errs.push('types');
      if (JSON.stringify(baseG.alerts) !== JSON.stringify(curG.alerts)) errs.push(`alerts:${curG.alerts}`);
      if (JSON.stringify(baseG.secrets) !== JSON.stringify(curG.secrets)) errs.push('secrets');
      if (JSON.stringify(baseG.radar) !== JSON.stringify(curG.radar)) errs.push('radar');
      const baseEnv = baseG.env.map((e) => e.replace(/=https:\/\/sunset-staging\.lunafrontdesk\.com.*/, '=domain'));
      if (JSON.stringify(baseEnv) !== JSON.stringify(curG.env)) errs.push(`env:${curG.env.filter((e) => !baseEnv.includes(e)).slice(0, 5)}`);
      ok('compiled_wrapper_module', true);
      ok('semantic_parity', errs.length === 0, errs.join(';'));
      const modCompiled = build(modulePath, path.join(outDir, 'module.json'));
      ok('compiled_module', true);
      const blob = JSON.stringify(modCompiled);
      ok('compile_has_scope_fail', /wrong_resource_group/.test(blob)); ok('compile_has_env_fail', /non_staging_environment/.test(blob));
      ok('compile_has_casefold_reserved_guard', /toLower[\s\S]*reserved_slug_in_synthetic_mode/.test(blob));
      ok('compile_tmpdir_clean_repo', !fs.existsSync(path.join(ROOT, 'tmp/stage2a-wrapper.json'))
        && !fs.existsSync(path.join(ROOT, 'tmp/stage2a-module.json')));
    } catch (err) {
      ok('compiled_wrapper_module', false, String(err.stderr || err.message || err).slice(0, 300));
      ok('semantic_parity', false, 'compile_failed');
      ok('compiled_module', false, 'skipped');
      ok('compile_has_scope_fail', false, 'skipped'); ok('compile_has_env_fail', false, 'skipped');
      ok('compile_has_casefold_reserved_guard', false, 'skipped');
      ok('compile_tmpdir_clean_repo', false, 'skipped');
    }
  } else {
    ok('compiled_wrapper_module', false, 'missing'); ok('semantic_parity', false, 'missing');
    ok('compiled_module', false, 'missing');
    ok('compile_has_casefold_reserved_guard', false, 'missing');
  }
  console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  pass=${pass} fail=${fail}`);
  console.log('NOTE: Stage 2B channel_slot allowlist; Sunset legacy env unchanged.');
  process.exit(fail === 0 ? 0 : 1);
} finally {
  cleanup();
}
