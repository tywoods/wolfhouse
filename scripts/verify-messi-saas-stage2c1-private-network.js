#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2c1-private-network — synthetic private ACA+PG (2C1 correction). */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = '19899f5d77b91803372ab17eaf23b6eb9c4d8c78';
const MODULE_REL = 'infra/azure/modules/tenant-staging/main.bicep';
const NET_REL = 'infra/azure/modules/tenant-staging/private-network.bicep';
const FIX_REL = 'infra/azure/modules/tenant-staging/parameters.synthetic.json';
const WRAPPER_REL = 'infra/azure/sunset-staging/main.bicep';
const FILES = [MODULE_REL, NET_REL, FIX_REL, WRAPPER_REL,
  'scripts/verify-messi-saas-stage2c1-private-network.js',
  'scripts/verify-messi-saas-stage2a-tenant-staging-iac.js', 'package.json'];
const OWNERSHIP_TAGS = ['tenant', 'stage', 'owner', 'planDigest', 'deploySha'];
const TAG_TYPES = new Set([
  'Microsoft.OperationalInsights/workspaces', 'Microsoft.Insights/components',
  'Microsoft.ManagedIdentity/userAssignedIdentities', 'Microsoft.KeyVault/vaults',
  'Microsoft.DBforPostgreSQL/flexibleServers', 'Microsoft.App/managedEnvironments',
  'Microsoft.App/containerApps', 'Microsoft.Insights/metricAlerts',
  'Microsoft.Network/publicIPAddresses', 'Microsoft.Network/natGateways',
  'Microsoft.Network/virtualNetworks', 'Microsoft.Network/privateDnsZones',
  'Microsoft.Network/privateDnsZones/virtualNetworkLinks']);
const PRIVATE_OUTPUTS = [
  'privateNetworkEnabled', 'vnetId', 'acaInfrastructureSubnetId', 'postgresDelegatedSubnetId',
  'privateDnsZoneId', 'privateDnsVnetLinkId', 'natGatewayId', 'natPublicIpId', 'natPublicIpAddress',
  'postgresServerId', 'postgresPrivateFqdn', 'containerAppsEnvironmentId'];

let pass = 0; let fail = 0;
const ok = (n, c, d) => { if (c) { pass += 1; console.log(`  PASS  ${n}`); }
else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
const bin = () => ['/opt/data/home/.azure/bin/bicep', '/opt/data/.azure/bin/bicep',
  '/opt/data/home/bin/bicep'].find((p) => fs.existsSync(p));
const tmpDirs = [];
const cleanup = () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const hasFail = (s, code) => new RegExp(`fail\\('${code}'\\)`).test(s);
const show = (p) => execFileSync('git', ['show', p], { cwd: ROOT, encoding: 'utf8' });

function diffStat() {
  const out = execFileSync('git', ['diff', '--numstat', BASE, '--', ...FILES], { cwd: ROOT, encoding: 'utf8' }).trim();
  let rawAdd = 0; let rawDel = 0; const perFile = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, d, file] = line.split('\t');
    const add = a === '-' ? 0 : Number(a); const del = d === '-' ? 0 : Number(d);
    rawAdd += add; rawDel += del; perFile.push({ file, add, del });
  }
  for (const rel of FILES) {
    if (perFile.some((p) => p.file === rel)) continue;
    const abs = path.join(ROOT, rel); if (!fs.existsSync(abs)) continue;
    let baseLines = 0;
    try { baseLines = show(`${BASE}:${rel}`).split(/\r?\n/).length; } catch (_) { /* new */ }
    const cur = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
    if (!baseLines) { rawAdd += cur; perFile.push({ file: rel, add: cur, del: 0 }); }
  }
  const wrapDiff = execFileSync('git', ['diff', '--numstat', BASE, '--', WRAPPER_REL], { cwd: ROOT, encoding: 'utf8' }).trim().length;
  return { rawAdd, rawDel, net: rawAdd - rawDel, files: perFile.length, perFile, wrapUntouched: wrapDiff === 0 };
}

function build(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2c1pn-')); tmpDirs.push(dir);
  const out = path.join(dir, 'out.json');
  execFileSync(bin(), ['build', file, '--outfile', out], {
    cwd: ROOT, env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function combineCond(parent, child) {
  const p = String(parent || '').replace(/^\[|\]$/g, '').trim();
  const c = String(child || '').replace(/^\[|\]$/g, '').trim();
  if (p && c) return `[and(${p}, ${c})]`;
  return p ? `[${p}]` : (c ? `[${c}]` : '');
}
function isSyntheticOnlyCond(cond) {
  const c = String(cond || '');
  return /variables\('enablePrivateNetwork'\)/.test(c) || /not\(\s*variables\('isLockedLiveSunset'\)\s*\)/.test(c);
}
function flatten(compiled) {
  const resources = [];
  const walk = (list, parentCond) => {
    for (const r of list || []) {
      const cond = combineCond(parentCond, r.condition);
      if (r.type === 'Microsoft.Resources/deployments') {
        walk(((r.properties || {}).template || {}).resources || [], cond);
        resources.push({ ...r, _effCond: cond }); continue;
      }
      resources.push({ ...r, _effCond: cond });
    }
  };
  walk(compiled.resources || [], ''); return resources;
}
function splitArgs(inner) {
  const args = []; let depth = 0; let cur = '';
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '(') depth += 1; if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) args.push(cur); return args;
}
/** Sunset-locked eval: enablePrivateNetwork=false, useCustomDomain/isLockedLiveSunset=true. */
function sunsetEval(expr) {
  if (expr == null || typeof expr === 'number' || typeof expr === 'boolean') return expr;
  if (Array.isArray(expr)) return expr.map(sunsetEval);
  if (typeof expr === 'object') {
    const o = {}; for (const [k, v] of Object.entries(expr)) o[k] = sunsetEval(v); return o;
  }
  if (typeof expr !== 'string') return expr;
  let s = expr.trim();
  if (/^'.*'$/.test(s) && !(s.startsWith('[') && s.endsWith(']'))) return s.slice(1, -1);
  const wrapped = s.startsWith('[') && s.endsWith(']');
  if (wrapped) s = s.slice(1, -1);
  const reduceOnce = (inner) => {
    let m = inner.match(/^if\(\s*variables\('enablePrivateNetwork'\)\s*,([\s\S]*)\)$/);
    if (m) { const a = splitArgs(m[1]); if (a.length === 2) return a[1].trim(); }
    m = inner.match(/^if\(\s*variables\('(useCustomDomain|isLockedLiveSunset)'\)\s*,([\s\S]*)\)$/);
    if (m) { const a = splitArgs(m[2]); if (a.length === 2) return a[0].trim(); }
    m = inner.match(/^union\(([\s\S]*)\)$/);
    if (m) {
      const a = splitArgs(m[1]).map((x) => x.trim());
      if (a.length === 2 && /^if\(\s*variables\('enablePrivateNetwork'\)/.test(a[1])) {
        const rest = a[1].replace(/^if\(\s*variables\('enablePrivateNetwork'\)\s*,/, '');
        const ia = splitArgs(rest.replace(/\)$/, ''));
        if (ia.length === 2 && /createObject\(\)/.test(ia[1])) return a[0];
      }
    }
    m = inner.match(/^createObject\(([\s\S]*)\)$/);
    if (m) {
      if (!m[1].trim()) return {};
      const parts = splitArgs(m[1]); const o = {};
      for (let i = 0; i + 1 < parts.length; i += 2) o[parts[i].trim().replace(/^'|'$/g, '')] = sunsetEval(parts[i + 1].trim());
      return o;
    }
    m = inner.match(/^createArray\(([\s\S]*)\)$/);
    if (m) return m[1].trim() ? splitArgs(m[1]).map((a) => sunsetEval(a.trim())) : [];
    return null;
  };
  let cur = s;
  for (let i = 0; i < 8; i += 1) {
    if (typeof cur !== 'string') return cur;
    const next = reduceOnce(cur); if (next == null) break; cur = next;
  }
  if (typeof cur !== 'string') return cur;
  if (cur === s) return wrapped ? `[${cur}]` : expr;
  if (/^'.*'$/.test(cur)) return cur.slice(1, -1);
  return wrapped ? `[${cur}]` : cur;
}
function stable(v) {
  const norm = (x) => {
    if (x == null || typeof x === 'number' || typeof x === 'boolean') return x;
    if (Array.isArray(x)) return x.map(norm);
    if (typeof x === 'object') { const o = {}; for (const k of Object.keys(x).sort()) o[k] = norm(x[k]); return o; }
    if (typeof x !== 'string') return x;
    let s = x.trim();
    if (/^'.*'$/.test(s)) s = s.slice(1, -1);
    if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
    if (/^'.*'$/.test(s)) s = s.slice(1, -1);
    return s;
  };
  return JSON.stringify(norm(sunsetEval(v)));
}
function fp(r) {
  const props = sunsetEval(r.properties || {}); const cfg = props.configuration || {};
  const tags = sunsetEval(r.tags);
  const empty = !tags || tags === '[createObject()]' || tags === 'createObject()'
    || (typeof tags === 'object' && !Array.isArray(tags) && !Object.keys(tags).length);
  return {
    type: r.type, name: r.name, tags: empty ? null : tags, identity: sunsetEval(r.identity) || null,
    network: props.network || props.vnetConfiguration || cfg.ingress || null,
    cert: cfg.customDomains || props.customDomainConfiguration || null,
    domain: (cfg.ingress && cfg.ingress.customDomains) || null,
    env: ((((props.template || {}).containers || [])[0] || {}).env) || null,
    alert: r.type === 'Microsoft.Insights/metricAlerts' ? {
      severity: props.severity, enabled: props.enabled,
      evaluationFrequency: props.evaluationFrequency, windowSize: props.windowSize,
    } : null,
  };
}
function sunsetEffective(compiled) {
  return flatten(compiled)
    .filter((r) => r.type !== 'Microsoft.Resources/deployments' && !isSyntheticOnlyCond(r._effCond))
    .map(fp).sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}
function hasOwnershipTags(tags) {
  const s = JSON.stringify(tags || '');
  if (/syntheticOwnershipTags|variables\('resourceTags'\)|variables\('staffApiTags'\)/.test(s)) return true;
  return OWNERSHIP_TAGS.every((t) => new RegExp(`'${t}'|"${t}"|${t}:`).test(s));
}

try {
  console.log('verify:messi-saas-stage2c1-private-network — Stage 2C1 correction\n');
  const pkg = JSON.parse(read('package.json'));
  ok('package_script', pkg.scripts && pkg.scripts['verify:messi-saas-stage2c1-private-network']
    === 'node scripts/verify-messi-saas-stage2c1-private-network.js');
  ok('no_plan_apply_cli', !fs.existsSync(path.join(ROOT, 'scripts/messi-saas-stage2c-plan.js'))
    && !fs.existsSync(path.join(ROOT, 'scripts/messi-saas-stage2c-apply.js'))
    && !/stage2c-plan|stage2c-apply/i.test(read('package.json')));
  ok('no_runtime_secrets_module', !fs.existsSync(path.join(ROOT, 'infra/azure/modules/tenant-staging/runtime-kv-secrets.bicep')));

  const mod = fs.existsSync(path.join(ROOT, MODULE_REL)) ? read(MODULE_REL) : '';
  const net = fs.existsSync(path.join(ROOT, NET_REL)) ? read(NET_REL) : '';
  const wrap = fs.existsSync(path.join(ROOT, WRAPPER_REL)) ? read(WRAPPER_REL) : '';
  const fixTxt = fs.existsSync(path.join(ROOT, FIX_REL)) ? read(FIX_REL) : '';
  let fix = null; try { fix = JSON.parse(fixTxt); } catch (_) {}
  const fv = (k) => fix && fix.parameters && fix.parameters[k] && fix.parameters[k].value;

  ok('module_exists', Boolean(mod));
  ok('private_network_module_exists', Boolean(net));
  ok('wrapper_untouched', /module\s+tenantStaging\s+'\.\.\/modules\/tenant-staging\/main\.bicep'/.test(wrap)
    && !/private-network|enablePrivateNetwork|natGateway|infrastructureSubnetId/.test(wrap));
  ok('enable_private_derived', /enablePrivateNetwork\s*=\s*!isLockedLiveSunset/.test(mod));
  ok('private_module_gated', mod.includes("module privateNetwork './private-network.bicep' = if (enablePrivateNetwork)"));
  ok('aca_infrastructure_subnet_binding', /infrastructureSubnetId/.test(mod) && /vnetConfiguration/.test(mod));
  ok('aca_workload_profiles_private', /workloadProfiles/.test(mod)
    && /workloadProfileType:\s*'Consumption'/.test(mod) && /name:\s*'Consumption'/.test(mod)
    && /enablePrivateNetwork\s*\?[\s\S]{0,500}workloadProfiles/.test(mod));
  ok('pg_private_network', /delegatedSubnetResourceId/.test(mod)
    && /privateDnsZoneArmResourceId/.test(mod) && /publicNetworkAccess:\s*'Disabled'/.test(mod));
  ok('pg_public_for_sunset', /enablePrivateNetwork\s*\?[\s\S]{0,200}publicNetworkAccess:\s*'Disabled'[\s\S]{0,80}:\s*\{[\s\S]{0,80}publicNetworkAccess:\s*'Enabled'/.test(mod));
  ok('no_firewall_on_private', hasFail(mod, 'private_network_no_firewall')
    && /enablePrivateNetwork\s*\?\s*\[\]\s*:\s*postgresAllowedIpAddresses/.test(mod));
  ok('no_operator_ip_param', !/operatorMigrationIp|acaOutboundIpAddresses/.test(mod + net + fixTxt));
  ok('no_staticip_as_egress', !/staticIp.*egress|egress.*staticIp|acaOutbound|containerAppsEnvironmentStaticIp/.test(mod + net)
    && /natPublicIpAddress/.test(mod));
  ok('ownership_tags_conditional', /var syntheticOwnershipTags\s*=/.test(mod)
    && OWNERSHIP_TAGS.every((t) => new RegExp(`${t}:`).test(mod))
    && /param planDigest string/.test(mod) && hasFail(mod, 'synthetic_ownership_tuple_required')
    && /resourceTags\s*=\s*union\(\s*sunsetResourceTags\s*,\s*enablePrivateNetwork\s*\?/.test(mod));
  ok('sunset_base_tags_exact_shape', /var sunsetResourceTags\s*=/.test(mod)
    && /safetyLocksSatisfied:\s*string\(safetyLocksSatisfied\)/.test(mod)
    && !/var sunsetResourceTags\s*=\s*\{[^}]*stage:\s*stageTag/.test(mod)
    && !/var sunsetResourceTags\s*=\s*\{[^}]*planDigest:/.test(mod)
    && !/var sunsetResourceTags\s*=\s*\{[^}]*deploySha:/.test(mod));
  ok('metric_alerts_ownership_tags',
    /staffApiCpuPressureAlert[\s\S]{0,220}tags:\s*enablePrivateNetwork\s*\?\s*syntheticOwnershipTags/.test(mod)
    && /staffApiMemoryPressureAlert[\s\S]{0,220}tags:\s*enablePrivateNetwork\s*\?\s*syntheticOwnershipTags/.test(mod));
  ok('infra_staff_api_absent', /deployStaffApi/.test(mod) && fv('deployStaffApi') === false);
  ok('custom_domain_locked_only', /useCustomDomain\s*=\s*isLockedLiveSunset/.test(mod)
    && /existingManagedCert[\s\S]{0,120}existing\s*=\s*if\s*\(/.test(mod));
  ok('private_outputs', PRIVATE_OUTPUTS.every((o) => new RegExp(`output ${o} `).test(mod)));
  ok('reserved_prod_guards', hasFail(mod, 'reserved_slug_in_synthetic_mode')
    && hasFail(mod, 'non_staging_prefix') && hasFail(mod, 'non_staging_rg') && hasFail(mod, 'non_staging_environment'));
  ok('net_module_delegations', net.includes('Microsoft.App/environments')
    && net.includes('Microsoft.DBforPostgreSQL/flexibleServers')
    && /natGateways/.test(net) && /publicIPAddresses/.test(net) && /privateDnsZones/.test(net)
    && /virtualNetworkLinks/.test(net) && /sku:\s*\{[\s\S]*name:\s*'Standard'/.test(net)
    && /publicIPAllocationMethod:\s*'Static'/.test(net));
  ok('net_module_tags', OWNERSHIP_TAGS.every((t) => new RegExp(`${t}:`).test(net)));
  ok('fixture_synthetic_private', Boolean(fix) && fv('tenantSlug') !== 'sunset' && fv('tenantSlug') !== 'wolfhouse'
    && fv('deployStaffApi') === false && Array.isArray(fv('postgresAllowedIpAddresses'))
    && fv('postgresAllowedIpAddresses').length === 0 && Boolean(fv('planDigest')) && Boolean(fv('deploySha'))
    && String(fv('stageTag') || '').includes('2c') && /SYNTHETIC|NOT_A_SECRET|example\.invalid/i.test(fixTxt)
    && !/sk_live_|whsec_|operatorMigrationIp/.test(fixTxt));

  if (mod && net && wrap && bin()) {
    try {
      const netCompiled = build(path.join(ROOT, NET_REL));
      const modCompiled = build(path.join(ROOT, MODULE_REL));
      const wrapCompiled = build(path.join(ROOT, WRAPPER_REL));
      const netRes = flatten(netCompiled); const blob = JSON.stringify(modCompiled);
      const byType = (res, t) => res.filter((r) => r.type === t);
      ok('compile_private_network', true); ok('compile_module', true); ok('compile_wrapper', true);
      const vnet = byType(netRes, 'Microsoft.Network/virtualNetworks')[0];
      const subnets = ((((vnet || {}).properties || {}).subnets) || []);
      const acaSub = subnets.find((s) => /aca|infra/i.test(String(s.name)));
      const pgSub = subnets.find((s) => /pg|postgres/i.test(String(s.name)));
      ok('compile_aca_subnet_delegation', JSON.stringify((((acaSub || {}).properties || {}).delegations) || []).includes('Microsoft.App/environments'));
      ok('compile_pg_subnet_delegation', JSON.stringify((((pgSub || {}).properties || {}).delegations) || []).includes('Microsoft.DBforPostgreSQL/flexibleServers'));
      ok('compile_nat_on_aca_subnet', /natGateways|natGateway/.test(JSON.stringify((acaSub || {}).properties || {})));
      ok('compile_nat_and_pip', byType(netRes, 'Microsoft.Network/natGateways').length === 1
        && byType(netRes, 'Microsoft.Network/publicIPAddresses').length === 1);
      ok('compile_private_dns_link', byType(netRes, 'Microsoft.Network/privateDnsZones').length >= 1
        && byType(netRes, 'Microsoft.Network/privateDnsZones/virtualNetworkLinks').length >= 1
        && JSON.stringify(netCompiled).includes('privatelink.postgres.database.azure.com'));
      ok('compile_pg_private_disabled', /delegatedSubnetResourceId/.test(blob) && /privateDnsZoneArmResourceId/.test(blob) && /Disabled/.test(blob));
      ok('compile_no_firewall_expr', /private_network_no_firewall/.test(blob));
      ok('compile_aca_subnet_binding', /infrastructureSubnetId/.test(blob) && /vnetConfiguration/.test(blob));
      const caeProps = String((byType(flatten(modCompiled), 'Microsoft.App/managedEnvironments')[0] || {}).properties || '');
      ok('compile_aca_workload_profiles_private', /workloadProfiles/.test(caeProps) && /Consumption/.test(caeProps)
        && /infrastructureSubnetId/.test(caeProps) && /enablePrivateNetwork/.test(caeProps));
      ok('compile_ownership_outputs', PRIVATE_OUTPUTS.every((o) => (modCompiled.outputs || {})[o]));
      ok('compile_ownership_fail', /synthetic_ownership_tuple_required/.test(blob));
      const tagMiss = [...flatten(modCompiled), ...flatten(netCompiled)]
        .filter((r) => TAG_TYPES.has(r.type) && !hasOwnershipTags(r.tags)).map((r) => r.type);
      ok('compile_synthetic_taggable_ownership', tagMiss.length === 0, tagMiss.slice(0, 5).join(','));
      const rt = (modCompiled.variables || {}).sunsetResourceTags;
      ok('compile_sunset_tag_keys', rt && typeof rt === 'object'
        && !['stage', 'planDigest', 'deploySha'].some((k) => Object.prototype.hasOwnProperty.call(rt, k))
        && ['product', 'tenant', 'environment', 'owner', 'slice', 'safetyLocksSatisfied'].every((k) => Object.prototype.hasOwnProperty.call(rt, k)),
      `keys=${rt && typeof rt === 'object' ? Object.keys(rt).join(',') : typeof rt}`);

      const wrapDir = fs.mkdtempSync(path.join(os.tmpdir(), 's2c1-base-layout-')); tmpDirs.push(wrapDir);
      fs.mkdirSync(path.join(wrapDir, 'infra/azure/sunset-staging'), { recursive: true });
      fs.mkdirSync(path.join(wrapDir, 'infra/azure/modules/tenant-staging'), { recursive: true });
      fs.writeFileSync(path.join(wrapDir, 'infra/azure/sunset-staging/main.bicep'), show(`${BASE}:${WRAPPER_REL}`));
      fs.writeFileSync(path.join(wrapDir, 'infra/azure/modules/tenant-staging/main.bicep'), show(`${BASE}:${MODULE_REL}`));
      fs.writeFileSync(path.join(wrapDir, 'infra/azure/sunset-staging/acr-pull-role.bicep'), show(`${BASE}:infra/azure/sunset-staging/acr-pull-role.bicep`));
      fs.writeFileSync(path.join(wrapDir, 'infra/azure/sunset-staging/schema-observer-job.bicep'), show(`${BASE}:infra/azure/sunset-staging/schema-observer-job.bicep`));
      const baseCompiled = build(path.join(wrapDir, 'infra/azure/sunset-staging/main.bicep'));
      const leaks = flatten(wrapCompiled).filter((r) => (
        String(r.type || '').startsWith('Microsoft.Network/') || /privateNetwork/i.test(String(r.name || ''))
      ) && !isSyntheticOnlyCond(r._effCond));
      ok('sunset_no_private_network_resources', leaks.length === 0, leaks.slice(0, 3).map((r) => `${r.type}:${r._effCond}`).join(';'));
      const baseEff = sunsetEffective(baseCompiled); const curEff = sunsetEffective(wrapCompiled);
      const errs = []; const bMap = new Map(baseEff.map((r) => [`${r.type}|${r.name}`, r]));
      const cMap = new Map(curEff.map((r) => [`${r.type}|${r.name}`, r]));
      for (const [k, b] of bMap) {
        const c = cMap.get(k); if (!c) { errs.push(`missing:${k}`); continue; }
        for (const f of ['tags', 'identity', 'network', 'cert', 'domain', 'env', 'alert']) {
          if (stable(b[f]) !== stable(c[f])) errs.push(`${f}:${k}`);
        }
      }
      for (const [k] of cMap) if (!bMap.has(k)) errs.push(`extra:${k}`);
      ok('sunset_effective_parity', errs.length === 0, errs.slice(0, 8).join(';'));
      ok('sunset_effective_type_parity', JSON.stringify(baseEff.map((r) => r.type).sort())
        === JSON.stringify(curEff.map((r) => r.type).sort()));
      ok('sunset_keeps_public_pg', /publicNetworkAccess/.test(JSON.stringify(wrapCompiled)));
      ok('sunset_keeps_custom_domain', /customDomains|managedCertificates/.test(JSON.stringify(wrapCompiled)));
      ok('additive_private_outputs_ok', PRIVATE_OUTPUTS.every((o) => (modCompiled.outputs || {})[o]));
    } catch (err) {
      const msg = String(err.stderr || err.message || err).slice(0, 400);
      ['compile_private_network', 'compile_module', 'compile_wrapper', 'compile_aca_subnet_delegation',
        'compile_pg_subnet_delegation', 'compile_nat_on_aca_subnet', 'compile_nat_and_pip',
        'compile_private_dns_link', 'compile_pg_private_disabled', 'compile_no_firewall_expr',
        'compile_aca_subnet_binding', 'compile_aca_workload_profiles_private', 'compile_ownership_outputs',
        'compile_ownership_fail', 'compile_synthetic_taggable_ownership', 'compile_sunset_tag_keys',
        'sunset_no_private_network_resources', 'sunset_effective_parity', 'sunset_effective_type_parity',
        'sunset_keeps_public_pg', 'sunset_keeps_custom_domain', 'additive_private_outputs_ok']
        .forEach((n, i) => ok(n, false, i === 0 ? msg : 'skipped'));
    }
  } else { ok('compile_private_network', false, 'missing sources or bicep'); }

  const st = diffStat();
  console.log('\n── budget ──');
  console.log(JSON.stringify({ files: st.files, rawAdd: st.rawAdd, rawDel: st.rawDel, net: st.net,
    wrapUntouched: st.wrapUntouched, perFile: st.perFile }, null, 2));
  ok('budget_files', st.files <= 8, `files=${st.files}`);
  ok('budget_net', st.net <= 650, `net=${st.net}`);
  ok('wrapper_diff_zero', st.wrapUntouched);
  console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
} finally { cleanup(); }
