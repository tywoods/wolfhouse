#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2c1-tenant-staging-bootstrap — two-phase synthetic bootstrap contract. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BASE = '19899f5d77b91803372ab17eaf23b6eb9c4d8c78';
const MODULE_REL = 'infra/azure/modules/tenant-staging/main.bicep';
const SECRETS_REL = 'infra/azure/modules/tenant-staging/runtime-kv-secrets.bicep';
const WRAPPER_REL = 'infra/azure/sunset-staging/main.bicep';
const FIX_REL = 'infra/azure/modules/tenant-staging/parameters.synthetic.json';
const INFRA_REL = 'infra/azure/modules/tenant-staging/parameters.synthetic.infra.json';
const RUNTIME_REL = 'infra/azure/modules/tenant-staging/parameters.synthetic.runtime.json';
const FILES = [
  MODULE_REL, SECRETS_REL, WRAPPER_REL, FIX_REL, INFRA_REL, RUNTIME_REL,
  'scripts/verify-messi-saas-stage2c1-tenant-staging-bootstrap.js',
  'scripts/verify-messi-saas-stage2b-tenant-runtime-config.js',
  'package.json',
];
const REQUIRED_KV = [
  'databaseUrlSecretName', 'stripe-secret-key', 'stripe-webhook-secret',
  'staff-session-secret', 'meta-whatsapp-token', 'meta-app-secret', 'meta-whatsapp-verify-token',
];
const OWNERSHIP_OUT = [
  'keyVaultId', 'keyVaultUri', 'postgresServerId', 'managedIdentityId',
  'containerAppsEnvironmentId', 'containerAppsEnvironmentStaticIp',
  'containerAppsEnvironmentDefaultDomain', 'ownershipSynthetic', 'ownershipPlanDigest',
  'ownershipDeploySha', 'ownershipTenant', 'bootstrapPhaseOut',
];

let pass = 0; let fail = 0;
const ok = (n, c, d) => {
  if (c) { pass += 1; console.log(`  PASS  ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); }
};
const bin = () => ['/opt/data/home/.azure/bin/bicep', '/opt/data/.azure/bin/bicep',
  '/opt/data/home/bin/bicep'].find((p) => fs.existsSync(p));
const tmpDirs = [];
const cleanup = () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const loadFix = (rel) => JSON.parse(read(rel));
const fv = (fix, k) => fix.parameters[k] && fix.parameters[k].value;
const hasFail = (s, code) => new RegExp(`fail\\('${code}'\\)`).test(s);

function diffStat() {
  const tracked = FILES.filter((f) => f !== WRAPPER_REL); // wrapper must stay untouched
  // Stage 2B verifier edit is out-of-band budget (shared gate); exclude from 2C1 net.
  const budgetFiles = tracked.filter((f) => f !== 'scripts/verify-messi-saas-stage2b-tenant-runtime-config.js');
  const out = execFileSync('git', ['diff', '--numstat', BASE, '--', ...budgetFiles], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
  let rawAdd = 0; let rawDel = 0; const perFile = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, d, file] = line.split('\t');
    const add = a === '-' ? 0 : Number(a); const del = d === '-' ? 0 : Number(d);
    rawAdd += add; rawDel += del; perFile.push({ file, add, del });
  }
  for (const rel of budgetFiles) {
    if (perFile.some((p) => p.file === rel)) continue;
    const abs = path.join(ROOT, rel); if (!fs.existsSync(abs)) continue;
    let baseLines = 0;
    try {
      baseLines = execFileSync('git', ['show', `${BASE}:${rel}`], { cwd: ROOT, encoding: 'utf8' })
        .split(/\r?\n/).length;
    } catch (_) { /* new */ }
    const cur = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
    if (!baseLines) { rawAdd += cur; perFile.push({ file: rel, add: cur, del: 0 }); }
  }
  let wrapDiff = 0;
  try {
    wrapDiff = execFileSync('git', ['diff', '--numstat', BASE, '--', WRAPPER_REL], {
      cwd: ROOT, encoding: 'utf8',
    }).trim().length;
  } catch (_) { wrapDiff = 1; }
  return {
    rawAdd, rawDel, net: rawAdd - rawDel, files: perFile.length, perFile, wrapUntouched: wrapDiff === 0,
  };
}

function build(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2c1-'));
  tmpDirs.push(dir);
  const out = path.join(dir, 'out.json');
  execFileSync(bin(), ['build', file, '--outfile', out], {
    cwd: ROOT, env: { ...process.env, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(fs.readFileSync(out, 'utf8'));
}

function noSecureOutputs(compiled) {
  const outs = compiled.outputs || {};
  for (const [k, v] of Object.entries(outs)) {
    if (v && (v.type === 'securestring' || v.type === 'SecureString')) return false;
    if (/password|secret|token|dsn|connection/i.test(k)) return false;
  }
  return true;
}

function secretLiterals(text) {
  return /sk_live_[A-Za-z0-9]+|whsec_[A-Za-z0-9]{16,}|-----BEGIN/.test(text);
}

try {
  console.log('verify:messi-saas-stage2c1-tenant-staging-bootstrap — Stage 2C1\n');
  const pkg = JSON.parse(read('package.json'));
  ok('package_script', pkg.scripts
    && pkg.scripts['verify:messi-saas-stage2c1-tenant-staging-bootstrap']
    === 'node scripts/verify-messi-saas-stage2c1-tenant-staging-bootstrap.js');
  ok('no_plan_apply_cli', !fs.existsSync(path.join(ROOT, 'scripts/messi-saas-stage2c-plan.js'))
    && !fs.existsSync(path.join(ROOT, 'scripts/messi-saas-stage2c-apply.js'))
    && !/stage2c-plan|stage2c-apply/i.test(read('package.json')));

  const mod = fs.existsSync(path.join(ROOT, MODULE_REL)) ? read(MODULE_REL) : '';
  const secrets = fs.existsSync(path.join(ROOT, SECRETS_REL)) ? read(SECRETS_REL) : '';
  const wrap = fs.existsSync(path.join(ROOT, WRAPPER_REL)) ? read(WRAPPER_REL) : '';
  ok('module_exists', Boolean(mod));
  ok('secrets_module_exists', Boolean(secrets));
  ok('wrapper_untouched_invoke', /module\s+tenantStaging\s+'\.\.\/modules\/tenant-staging\/main\.bicep'/.test(wrap)
    && /fail\('sunset_wrapper_wrong_rg'\)/.test(wrap)
    && !/runtime-kv-secrets/.test(wrap));

  ok('bootstrap_phase_param', /param bootstrapPhase string/.test(mod)
    && /@allowed\(\[\s*''\s*'infra'\s*'runtime'\s*\]\)/.test(mod.replace(/\s+/g, ' ')));
  ok('phase_vars', /isInfraBootstrap/.test(mod) && /isRuntimeBootstrap/.test(mod)
    && hasFail(mod, 'synthetic_bootstrap_phase_required'));
  ok('infra_forces_staff_off', /isInfraBootstrap\s*\?\s*false/.test(mod));
  ok('runtime_bootstrap_gate', hasFail(mod, 'runtime_bootstrap_incomplete')
    && /runtimeBootstrapComplete/.test(mod));
  ok('no_unconditional_managed_cert', !/resource existingManagedCert[\s\S]{0,80}=\s*\{/.test(mod)
    && /existingManagedCert[\s\S]{0,120}existing\s*=\s*if\s*\(/.test(mod));
  ok('custom_domain_locked_only', /customDomains:\s*useCustomDomain\s*\?/.test(mod)
    && /useCustomDomain\s*=\s*isLockedLiveSunset/.test(mod));
  ok('synthetic_aca_fqdn_param', /staffApiCustomDomain/.test(mod)
    && /ACA-generated FQDN|azurecontainerapps\.io/.test(mod + read(RUNTIME_REL)));
  ok('ownership_tags', /synthetic:\s*isLockedLiveSunset\s*\?\s*'false'\s*:\s*'true'/.test(mod)
    && /planDigest:/.test(mod) && /deploySha:/.test(mod) && /stage:/.test(mod));
  ok('runtime_ownership_gate', hasFail(mod, 'runtime_ownership_tuple_required'));
  ok('firewall_reject_broad', hasFail(mod, 'broad_firewall_rejected') && /0\.0\.0\.0/.test(mod));
  ok('runtime_firewall_exact', hasFail(mod, 'runtime_firewall_ips_required')
    && /operatorMigrationIp/.test(mod) && /acaOutboundIpAddresses/.test(mod));
  ok('main_has_no_kv_secret_resources', !/Microsoft\.KeyVault\/vaults\/secrets/.test(mod)
    && /runtime-kv-secrets\.bicep/.test(mod));
  ok('secrets_module_complete', REQUIRED_KV.every((n) => secrets.includes(n === 'databaseUrlSecretName' ? 'databaseUrlSecretName' : `'${n}'`))
    && /@secure\(\)/.test(secrets) && hasFail(secrets, 'admin_app_dsn_user_rejected')
    && !secretLiterals(secrets));
  ok('app_dsn_non_admin', /appDatabaseUser/.test(mod) && hasFail(mod, 'admin_app_dsn_user_rejected'));
  ok('infra_outputs', OWNERSHIP_OUT.every((o) => new RegExp(`output ${o} `).test(mod)));
  ok('alerts_locked_live_only',
    /if\s*\(\s*deployContainerApps\s*&&\s*effectiveDeployStaffApi\s*&&\s*isLockedLiveSunset/.test(mod));

  ok('fixtures_exist', [INFRA_REL, RUNTIME_REL].every((r) => fs.existsSync(path.join(ROOT, r))));
  if ([INFRA_REL, RUNTIME_REL].every((r) => fs.existsSync(path.join(ROOT, r)))) {
    const infra = loadFix(INFRA_REL);
    const runtime = loadFix(RUNTIME_REL);
    const secFix = { parameters: Object.fromEntries(
      Object.entries((runtime.metadata && runtime.metadata.secretsParameters) || {})
        .map(([k, v]) => [k, { value: v }]),
    ) };
    const baseFix = loadFix(FIX_REL);
    ok('infra_fixture_contract', fv(infra, 'bootstrapPhase') === 'infra'
      && fv(infra, 'deployStaffApi') === false
      && fv(infra, 'runtimeBootstrapComplete') === false
      && Array.isArray(fv(infra, 'postgresAllowedIpAddresses'))
      && fv(infra, 'postgresAllowedIpAddresses').length === 0
      && fv(infra, 'tenantSlug') !== 'sunset');
    ok('runtime_fixture_contract', fv(runtime, 'bootstrapPhase') === 'runtime'
      && fv(runtime, 'deployStaffApi') === true
      && fv(runtime, 'runtimeBootstrapComplete') === true
      && Boolean(fv(runtime, 'planDigest'))
      && Boolean(fv(runtime, 'operatorMigrationIp'))
      && Array.isArray(fv(runtime, 'acaOutboundIpAddresses'))
      && fv(runtime, 'acaOutboundIpAddresses').length >= 1
      && !fv(runtime, 'acaOutboundIpAddresses').includes('0.0.0.0')
      && /azurecontainerapps\.io/.test(String(fv(runtime, 'staffApiCustomDomain') || ''))
      && fv(runtime, 'appDatabaseUser') !== fv(runtime, 'postgresAdminUser'));
    ok('secrets_fixture_contract', fv(secFix, 'appDatabaseUser') === 'synthdemo_app'
      && /DISABLED_SENTINEL|SYNTHETIC/.test(String(fv(secFix, 'stripeSecretKey') || ''))
      && /DISABLED_SENTINEL|SYNTHETIC/.test(String(fv(secFix, 'metaAppSecret') || ''))
      && fv(secFix, 'appDatabaseUser') !== fv(secFix, 'postgresAdminUser'));
    ok('base_fixture_phase', fv(baseFix, 'bootstrapPhase') === 'infra');
    ok('fixtures_no_live_secrets', ![infra, runtime, secFix, baseFix]
      .some((f) => secretLiterals(JSON.stringify(f))));
  } else {
    ok('infra_fixture_contract', false, 'missing');
    ok('runtime_fixture_contract', false, 'missing');
    ok('secrets_fixture_contract', false, 'missing');
    ok('base_fixture_phase', false, 'missing');
    ok('fixtures_no_live_secrets', false, 'missing');
  }

  if (mod && secrets && wrap && bin()) {
    try {
      const modCompiled = build(path.join(ROOT, MODULE_REL));
      const secCompiled = build(path.join(ROOT, SECRETS_REL));
      const wrapCompiled = build(path.join(ROOT, WRAPPER_REL));
      const blob = JSON.stringify(modCompiled);
      const secBlob = JSON.stringify(secCompiled);
      ok('compile_module', true);
      ok('compile_secrets_module', true);
      ok('compile_wrapper', true);
      ok('compile_phase_fails', /synthetic_bootstrap_phase_required/.test(blob));
      ok('compile_broad_firewall_fail', /broad_firewall_rejected/.test(blob));
      ok('compile_admin_dsn_fail', /admin_app_dsn_user_rejected/.test(blob)
        && /admin_app_dsn_user_rejected/.test(secBlob));
      ok('compile_main_no_secret_resources', !/Microsoft.KeyVault\/vaults\/secrets/.test(blob));
      ok('compile_secrets_have_kv_secrets', /Microsoft.KeyVault\/vaults\/secrets/.test(secBlob));
      ok('compile_static_ip_output', /staticIp/.test(blob) && /defaultDomain/.test(blob));
      ok('compile_no_secure_outputs', noSecureOutputs(modCompiled)
        && noSecureOutputs(secCompiled) && noSecureOutputs(wrapCompiled));
      ok('compile_cert_conditional', /managedCertificates/.test(blob) && /useCustomDomain/.test(blob));
      ok('sunset_wrapper_still_custom_domain', /staffApiCustomDomain|customDomains/.test(JSON.stringify(wrapCompiled)));
      ok('sunset_no_secrets_module', !/runtime-kv-secrets/.test(wrap));
    } catch (err) {
      const msg = String(err.stderr || err.message || err).slice(0, 400);
      ['compile_module', 'compile_secrets_module', 'compile_wrapper', 'compile_phase_fails',
        'compile_broad_firewall_fail', 'compile_admin_dsn_fail', 'compile_main_no_secret_resources',
        'compile_secrets_have_kv_secrets', 'compile_static_ip_output', 'compile_no_secure_outputs',
        'compile_cert_conditional', 'sunset_wrapper_still_custom_domain', 'sunset_no_secrets_module']
        .forEach((n, i) => ok(n, false, i === 0 ? msg : 'skipped'));
    }
  } else {
    ok('compile_module', false, 'missing bicep or sources');
  }

  const st = diffStat();
  console.log('\n── budget ──');
  console.log(JSON.stringify({
    files: st.files, rawAdd: st.rawAdd, rawDel: st.rawDel, net: st.net,
    wrapUntouched: st.wrapUntouched, perFile: st.perFile,
  }, null, 2));
  ok('budget_files', st.files <= 8, `files=${st.files}`);
  ok('budget_net', st.net <= 650, `net=${st.net}`);
  ok('wrapper_diff_zero', st.wrapUntouched);

  console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
} finally {
  cleanup();
}
