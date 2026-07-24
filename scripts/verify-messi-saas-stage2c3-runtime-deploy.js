#!/usr/bin/env node
'use strict';
/** verify:messi-saas-stage2c3-runtime-deploy — Stage 2C3 synthetic runtime secrets + private Staff API. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const BASE = 'a75d9edc2740a5a1a9923a40b96b233d2579c34a';
const MAIN_REL = 'infra/azure/modules/tenant-staging/main.bicep';
const SEC_REL = 'infra/azure/modules/tenant-staging/synthetic-runtime-secrets.bicep';
const FIX_REL = 'infra/azure/modules/tenant-staging/parameters.synthetic-runtime.json';
const WRAP_REL = 'infra/azure/sunset-staging/main.bicep';
const FILES = [MAIN_REL, SEC_REL, FIX_REL,
  'scripts/verify-messi-saas-stage2c3-runtime-deploy.js',
  'scripts/verify-messi-saas-stage2a-tenant-staging-iac.js',
  'scripts/verify-messi-saas-stage2c1-private-network.js',
  'scripts/verify-messi-saas-stage2c2-bootstrap-job.js', 'package.json'];
const TAGS = ['tenant', 'stage', 'owner', 'planDigest', 'deploySha'];
const SLUG = 'synthdemo';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const SECRET_ORDER = [
  'stripe-webhook-secret', 'synthdemo-database-url', 'meta-whatsapp-token', 'meta-app-secret',
  'meta-whatsapp-verify-token', 'staff-session-secret', 'stripe-secret-key', 'luna-bot-internal-token',
  'tenant-loc-1-wa-number', 'tenant-loc-1-wa-phone-id', 'tenant-loc-1-inbox-email',
  'tenant-loc-2-wa-number', 'tenant-loc-2-wa-phone-id', 'tenant-loc-2-inbox-email',
];
const SENTINELS = {
  stripeSecretKey: 'sk_test_disabled',
  stripeWebhookSecret: 'whsec_disabled',
  metaWhatsappToken: 'EAAG_disabled',
  metaAppSecret: 'meta_app_secret_disabled',
  metaWhatsappVerifyToken: 'meta_verify_disabled',
};
const WA = {
  a: '+10000000001', b: '+10000000002',
  idA: '1000000000000001', idB: '1000000000000002',
  mailA: 'synthdemo-a@inbox.synthdemo.invalid', mailB: 'synthdemo-b@inbox.synthdemo.invalid',
};
let pass = 0; let fail = 0;
const ok = (n, c, d) => { if (c) { pass += 1; console.log(`  PASS  ${n}`); }
else { fail += 1; console.log(`  FAIL  ${n}${d ? `\n        ${d}` : ''}`); } };
const bin = () => ['/opt/data/home/.azure/bin/bicep', '/opt/data/.azure/bin/bicep',
  '/opt/data/home/bin/bicep'].find((p) => fs.existsSync(p));
const tmpDirs = [];
const cleanup = () => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {} } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const hasFail = (s, c) => new RegExp(`fail\\('${c}'\\)`).test(s);
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
    try { baseLines = show(`${BASE}:${rel}`).split(/\r?\n/).length; } catch (_) { baseLines = 0; }
    const cur = fs.readFileSync(abs, 'utf8').split(/\r?\n/).length;
    if (!baseLines) { rawAdd += cur; perFile.push({ file: rel, add: cur, del: 0 }); }
  }
  const wrapDiff = execFileSync('git', ['diff', '--numstat', BASE, '--', WRAP_REL], { cwd: ROOT, encoding: 'utf8' }).trim().length;
  return { rawAdd, rawDel, net: rawAdd - rawDel, files: perFile.length, perFile, wrapUntouched: wrapDiff === 0 };
}
function build(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's2c3-')); tmpDirs.push(dir);
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
  if (!c) return false;
  // Staff/alerts stay for Sunset: or(not(enablePrivateNetwork), syntheticRuntimePhase)
  if (/or\(\s*not\(\s*variables\('enablePrivateNetwork'\)/.test(c)) return false;
  return /variables\('enablePrivateNetwork'\)/.test(c)
    || /variables\('syntheticRuntimePhase'\)/.test(c)
    || /not\(\s*variables\('isLockedLiveSunset'\)\s*\)/.test(c)
    || /syntheticRuntimeSecrets|runtimePrereqsPhase|useDigestImage|runtimeDeploymentPhase|deployBootstrapJob/.test(c);
}
function flatten(compiled) {
  const resources = [];
  const walk = (list, parentCond, vars) => {
    for (const r of list || []) {
      const cond = combineCond(parentCond, r.condition);
      if (r.type === 'Microsoft.Resources/deployments') {
        const childVars = (((r.properties || {}).template || {}).variables) || {};
        walk(((r.properties || {}).template || {}).resources || [], cond, childVars);
        resources.push({ ...r, _effCond: cond, _vars: childVars }); continue;
      }
      resources.push({ ...r, _effCond: cond, _vars: vars });
    }
  };
  walk(compiled.resources || [], '', compiled.variables || {}); return resources;
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
function resolveVarExpr(expr, vars) {
  if (expr == null || typeof expr === 'number' || typeof expr === 'boolean') return expr;
  if (Array.isArray(expr)) return expr.map((x) => resolveVarExpr(x, vars));
  if (typeof expr === 'object') {
    const o = {}; for (const [k, v] of Object.entries(expr)) o[k] = resolveVarExpr(v, vars); return o;
  }
  if (typeof expr !== 'string') return expr;
  let s = expr.trim();
  const wrapped = s.startsWith('[') && s.endsWith(']');
  if (wrapped) s = s.slice(1, -1);
  const m = s.match(/^variables\('([^']+)'\)$/);
  if (m && vars && Object.prototype.hasOwnProperty.call(vars, m[1])) return resolveVarExpr(vars[m[1]], vars);
  const cm = s.match(/^concat\(([\s\S]*)\)$/);
  if (cm) {
    const parts = splitArgs(cm[1]).map((p) => {
      const t = p.trim();
      return resolveVarExpr((t.startsWith('[') && t.endsWith(']')) ? t : `[${t}]`, vars);
    });
    if (parts.every((p) => Array.isArray(p))) return parts.flat();
  }
  return expr;
}
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
    m = inner.match(/^if\(\s*variables\('(useCustomDomain|isLockedLiveSunset|useDigestImage|syntheticRuntimePhase|runtimeAttestGate|enableGenericRuntimeEnv)'\)\s*,([\s\S]*)\)$/);
    if (m) {
      const a = splitArgs(m[2]); if (a.length === 2) {
        return (m[1] === 'useCustomDomain' || m[1] === 'isLockedLiveSunset') ? a[0].trim() : a[1].trim();
      }
    }
    m = inner.match(/^if\(\s*parameters\('enableSunsetRuntimeEnv'\)\s*,([\s\S]*)\)$/);
    if (m) { const a = splitArgs(m[1]); if (a.length === 2) return a[0].trim(); }
    m = inner.match(/^if\(\s*and\(\s*variables\('syntheticRuntimePhase'\)[\s\S]*\)\s*,([\s\S]*)\)$/);
    if (m) { const a = splitArgs(m[1]); if (a.length === 2) return a[1].trim(); }
    m = inner.match(/^union\(([\s\S]*)\)$/);
    if (m) {
      const a = splitArgs(m[1]).map((x) => x.trim());
      if (a.length === 2 && /^if\(\s*variables\('(enablePrivateNetwork|syntheticRuntimePhase)'\)/.test(a[1])) {
        const flag = RegExp.$1;
        const rest = a[1].replace(new RegExp(`^if\\(\\s*variables\\('${flag}'\\)\\s*,`), '');
        const ia = splitArgs(rest.replace(/\)$/, ''));
        if (ia.length === 2 && /createObject\(\)/.test(ia[1])) return a[0];
        if (flag === 'syntheticRuntimePhase' && ia.length === 2) return a[0];
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
function envFingerprint(env) {
  const resolved = sunsetEval(env);
  const arr = Array.isArray(resolved) ? resolved : null;
  if (!arr) {
    const s = typeof env === 'string' ? env : JSON.stringify(env || '');
    const names = [...s.matchAll(/'name'\s*,\s*'([^']+)'/g)].map((m) => m[1]);
    if (names.length) return names.sort().join('|');
    return stable(env);
  }
  return arr.map((e) => {
    if (!e || typeof e !== 'object') return String(e);
    const n = e.name || e.Name;
    const ref = e.secretRef || e.secretRef === '' ? String(e.secretRef || '') : '';
    if (ref || e.secretRef === '') return `${n}=secret:${ref.replace(/^\[|\]$/g, '')}`;
    return `${n}=val`;
  }).join('|');
}
function secretsFingerprint(secrets) {
  const resolved = sunsetEval(secrets);
  const arr = Array.isArray(resolved) ? resolved : null;
  if (!arr) {
    const s = typeof secrets === 'string' ? secrets : JSON.stringify(secrets || '');
    const names = [...s.matchAll(/'name'\s*,\s*'([^']+)'/g)].map((m) => m[1]);
    if (names.length) return names.join(',');
    return stable(secrets);
  }
  return arr.map((e) => {
    if (!e || typeof e !== 'object') return String(e);
    let n = e.name || e.Name;
    if (typeof n === 'string') n = n.replace(/^\[|\]$/g, '');
    if (e.value !== undefined) return `${n}=inline`;
    if (e.keyVaultUrl || e.keyVaultUrl === '') return `${n}=kv`;
    return `${n}=?`;
  }).join('|');
}
function fp(r) {
  const props = sunsetEval(r.properties || {}); const cfg = props.configuration || {};
  const tags = sunsetEval(r.tags);
  const empty = !tags || tags === '[createObject()]' || tags === 'createObject()'
    || (typeof tags === 'object' && !Array.isArray(tags) && !Object.keys(tags).length);
  const rawEnv = ((((props.template || {}).containers || [])[0] || {}).env) || null;
  const rawSecrets = cfg.secrets || null;
  const rawImage = ((((props.template || {}).containers || [])[0] || {}).image) || null;
  // AcrPull may be emitted via shared-RG nested module or tenant-RG absolute scope;
  // normalize the name so Sunset effective parity keys on role identity, not expression form.
  let name = r.name;
  if (r.type === 'Microsoft.Authorization/roleAssignments'
    && /7f951dda-4ed3-4680-a7ca-43fe172d538d/.test(JSON.stringify(r.properties || r))) {
    name = 'acrPullRoleAssignment';
  }
  return {
    type: r.type, name, tags: empty ? null : tags, identity: sunsetEval(r.identity) || null,
    network: props.network || props.vnetConfiguration || cfg.ingress || null,
    cert: cfg.customDomains || props.customDomainConfiguration || null,
    domain: (cfg.ingress && cfg.ingress.customDomains) || null,
    env: r.type === 'Microsoft.App/containerApps' ? envFingerprint(rawEnv) : rawEnv,
    secrets: r.type === 'Microsoft.App/containerApps' ? secretsFingerprint(rawSecrets) : rawSecrets,
    image: sunsetEval(rawImage),
    alert: r.type === 'Microsoft.Insights/metricAlerts' ? {
      severity: props.severity, enabled: props.enabled,
      evaluationFrequency: props.evaluationFrequency, windowSize: props.windowSize,
    } : null,
  };
}
function deepResolve(expr, vars) {
  let cur = expr;
  for (let i = 0; i < 8; i += 1) {
    const next = sunsetEval(resolveVarExpr(cur, vars));
    if (JSON.stringify(next) === JSON.stringify(cur)) return cur;
    cur = next;
  }
  return cur;
}
function sunsetEffective(compiled) {
  return flatten(compiled)
    .filter((r) => r.type !== 'Microsoft.Resources/deployments' && !isSyntheticOnlyCond(r._effCond))
    .map((r) => {
      const vars = r._vars || {};
      const props = r.properties || {};
      const cfg = props.configuration || {};
      const resolved = {
        ...r,
        tags: deepResolve(r.tags, vars),
        properties: {
          ...props,
          configuration: {
            ...cfg,
            secrets: deepResolve(cfg.secrets, vars),
            ingress: cfg.ingress,
          },
          template: props.template ? {
            ...props.template,
            containers: ((props.template.containers) || []).map((c) => {
              let env = deepResolve(c.env, vars);
              const sun = Array.isArray(vars.sunsetAdminLocationEnv) ? vars.sunsetAdminLocationEnv : [];
              if (typeof env === 'string' && /concat\(/.test(env)) {
                if (Array.isArray(vars.baseStaffEnv)) env = vars.baseStaffEnv.concat(sun);
                else {
                  let s = env.trim(); if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
                  const cm = s.match(/^concat\(([\s\S]*)\)$/);
                  if (cm) {
                    const first = sunsetEval(`[${splitArgs(cm[1])[0].trim()}]`);
                    if (Array.isArray(first)) env = first.concat(sun);
                  }
                }
              }
              if (Array.isArray(env) && sun.length && !env.some((e) => e && /^SUNSET_/.test(String(e.name || '')))) {
                env = env.concat(sun);
              }
              return { ...c, env, image: deepResolve(c.image, vars) };
            }),
          } : props.template,
        },
      };
      return fp(resolved);
    })
    .sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}
function secretNamesFromCompiled(compiled) {
  const names = [];
  for (const r of flatten(compiled)) {
    if (r.type === 'Microsoft.KeyVault/vaults/secrets') names.push(String(r.name || '').replace(/^.*\//, ''));
  }
  return names;
}
try {
  console.log('verify:messi-saas-stage2c3-runtime-deploy — Stage 2C3\n');
  const pkg = JSON.parse(read('package.json'));
  ok('package_script', pkg.scripts['verify:messi-saas-stage2c3-runtime-deploy']
    === 'node scripts/verify-messi-saas-stage2c3-runtime-deploy.js');
  ok('no_plan_apply_cli', !fs.existsSync(path.join(ROOT, 'scripts/messi-saas-stage2c3-plan.js'))
    && !fs.existsSync(path.join(ROOT, 'scripts/messi-saas-stage2c3-apply.js'))
    && !/stage2c3-plan|stage2c3-apply/i.test(read('package.json')));
  const mainSrc = fs.existsSync(path.join(ROOT, MAIN_REL)) ? read(MAIN_REL) : '';
  const sec = fs.existsSync(path.join(ROOT, SEC_REL)) ? read(SEC_REL) : '';
  const fixTxt = fs.existsSync(path.join(ROOT, FIX_REL)) ? read(FIX_REL) : '';
  const wrap = fs.existsSync(path.join(ROOT, WRAP_REL)) ? read(WRAP_REL) : '';
  let fix = null; try { fix = JSON.parse(fixTxt); } catch (_) {}
  const fv = (k) => fix && fix.parameters && fix.parameters[k] && fix.parameters[k].value;
  ok('secrets_module_exists', Boolean(sec));
  ok('runtime_fixture_exists', Boolean(fix));
  ok('main_wires_secrets_module', /module\s+syntheticRuntimeSecrets\s+'\.\/synthetic-runtime-secrets\.bicep'\s*=\s*if\s*\(/.test(mainSrc)
    && /runtimeDeploymentPhase\s*==\s*'runtime-prereqs'/.test(mainSrc));
  ok('phase_conflict_fail', hasFail(mainSrc, 'runtime_bootstrap_phase_conflict'));
  ok('two_deployment_boundary', /runtimeDeploymentPhase/.test(mainSrc)
    && /runtimePrereqsVerified/.test(mainSrc)
    && hasFail(mainSrc, 'runtime_prereqs_verification_required')
    && /runtimeDeploymentPhase\s*==\s*'runtime-app'/.test(mainSrc));
  ok('secrets_secure_params', /@secure\(\)/.test(sec) && /appDatabasePassword/.test(sec)
    && /staffSessionSecret/.test(sec) && /lunaBotInternalToken/.test(sec)
    && /stripeSecretKey/.test(sec) && /stripeWebhookSecret/.test(sec)
    && /metaWhatsappToken/.test(sec) && /metaAppSecret/.test(sec)
    && /metaWhatsappVerifyToken/.test(sec)
    && /locationWhatsappNumberA/.test(sec) && /locationInboxEmailB/.test(sec));
  ok('dsn_derived_exact_encoded', !/param\s+appDatabase(Url|Username|Host|Name)/.test(mainSrc + sec)
    && /uriComponent\(appDatabasePassword\)/.test(mainSrc + sec)
    && /uriComponent\(expectedAppUser\)/.test(mainSrc + sec)
    && /pgApp\.properties\.fullyQualifiedDomainName/.test(mainSrc)
    && /:5432\//.test(mainSrc + sec) && /\?sslmode=require/.test(mainSrc + sec));
  ok('fixed_unique_database_secret', /runtimeDatabaseUrlSecretName\s*=\s*'\$\{tenantSlugLower\}-database-url'/.test(mainSrc)
    && hasFail(mainSrc + sec, 'duplicate_runtime_secret_name'));
  ok('stripe_meta_sentinels', hasFail(mainSrc + sec, 'stripe_secret_sentinel')
    && hasFail(mainSrc + sec, 'stripe_webhook_sentinel')
    && hasFail(mainSrc + sec, 'meta_token_sentinel')
    && hasFail(mainSrc + sec, 'meta_app_secret_sentinel')
    && hasFail(mainSrc + sec, 'meta_verify_sentinel')
    && Object.values(SENTINELS).every((v) => (mainSrc + sec + fixTxt).includes(v)));
  ok('channel_sentinels', hasFail(mainSrc + sec, 'synthetic_whatsapp_number_sentinel')
    && hasFail(mainSrc + sec, 'synthetic_whatsapp_phone_id_sentinel')
    && hasFail(mainSrc + sec, 'synthetic_inbox_invalid_required')
    && fixTxt.includes(WA.a) && fixTxt.includes(WA.b)
    && fixTxt.includes(WA.mailA) && fixTxt.includes(WA.mailB));
  ok('process_flags_locked', /effectiveStaffActionsEnabled\s*=\s*isLockedLiveSunset\s*\?\s*staffActionsEnabled\s*:\s*'false'/.test(mainSrc)
    && /effectiveStripeLinksEnabled\s*=\s*isLockedLiveSunset\s*\?\s*stripeLinksEnabled\s*:\s*'false'/.test(mainSrc)
    && /effectiveWhatsappDryRun\s*=\s*isLockedLiveSunset\s*\?\s*whatsappDryRun\s*:\s*'true'/.test(mainSrc)
    && /staff_actions:\s*false/.test(mainSrc) && /stripe_links:\s*false/.test(mainSrc)
    && /whatsapp_dry_run:\s*true/.test(mainSrc));
  ok('digest_image_synthetic', (/@sha256:/.test(mainSrc) || /@\$\{staffApiImageDigest\}/.test(mainSrc))
    && /useDigestImage/.test(mainSrc)
    && hasFail(mainSrc, 'staff_image_digest_required')
    && /staffApiImageTagged\s*=\s*'\$\{acrLoginServer\}\/\$\{staffApiImageRepository\}:\$\{staffApiImageTag\}'/.test(mainSrc));
  ok('app_not_coupled_to_prereqs_write', /runtimePrereqsPhase[\s\S]*syntheticRuntimeSecrets/.test(mainSrc)
    && !/dependsOn:[\s\S]{0,160}syntheticRuntimeSecrets/.test(mainSrc));
  ok('generated_ingress_no_custom', /useCustomDomain\s*=\s*isLockedLiveSunset/.test(mainSrc)
    && /defaultDomain/.test(mainSrc)
    && /staffApiGeneratedFqdn|GeneratedFqdn/.test(mainSrc)
    && !/two.?step|revision.?swap/i.test(mainSrc));
  ok('runtime_outputs_narrow', /output staffApiFqdn string/.test(mainSrc)
    && /output staffApiUrl string/.test(mainSrc)
    && /output staffApiResourceId string/.test(mainSrc)
    && /output staffApiLatestRevisionName string/.test(mainSrc)
    && !/output[\s\S]{0,60}(Password|password|Secret|secret|DatabaseUrl|Token)/.test(mainSrc));
  ok('outputs_resource_backed', /staffApiApp!\.properties\.configuration\.ingress\.fqdn/.test(mainSrc)
    && /staffApiApp!\.properties\.template\.containers\[0\]\.image/.test(mainSrc)
    && /staffApiApp!\.properties\.template\.scale\.minReplicas/.test(mainSrc)
    && /staffApiApp!\.properties\.template\.scale\.maxReplicas/.test(mainSrc)
    && /staffApiApp!\.properties\.latestRevisionName/.test(mainSrc));
  ok('fixture_runtime_phase', Boolean(fix) && fv('deployStaffApi') === true && fv('deployBootstrapJob') === false
    && fv('runtimeDeploymentPhase') === 'runtime-app' && fv('runtimePrereqsVerified') === true
    && fv('staffApiMinReplicas') === 1 && fv('staffApiMaxReplicas') === 1
    && fv('staffApiImageDigest') === DIGEST && fv('stageTag') === 'saas-2c3'
    && typeof fv('appDatabasePassword') === 'string'
    && fv('stripeSecretKey') === SENTINELS.stripeSecretKey
    && fv('stripeWebhookSecret') === SENTINELS.stripeWebhookSecret
    && !/sk_live_/.test(fixTxt));
  ok('wrapper_untouched', /module\s+tenantStaging\s+'\.\.\/modules\/tenant-staging\/main\.bicep'/.test(wrap)
    && !/runtimeBootstrapComplete|synthetic-runtime-secrets|staffApiImageDigest/.test(wrap));
  ok('ownership_tags', TAGS.every((t) => new RegExp(`${t}:`).test(sec)) && TAGS.every((t) => new RegExp(`${t}:`).test(mainSrc)));

  if (mainSrc && sec && wrap && bin()) {
    try {
      const compiledSec = build(path.join(ROOT, SEC_REL));
      const compiledMain = build(path.join(ROOT, MAIN_REL));
      const compiledWrap = build(path.join(ROOT, WRAP_REL));
      const secNames = secretNamesFromCompiled(compiledSec);
      const secBlob = JSON.stringify(compiledSec);
      ok('compile_secrets_module', true);
      ok('compile_complete_secrets', SECRET_ORDER.every((n) => {
        if (n === 'synthdemo-database-url') return /databaseUrlSecretName/.test(secBlob) || secNames.includes(n);
        return secNames.includes(n) || secBlob.includes(n);
      }), `missing=${SECRET_ORDER.filter((n) => !(n === 'synthdemo-database-url' ? /databaseUrlSecretName/.test(secBlob) : (secNames.includes(n) || secBlob.includes(n)))).join(',')}`);
      ok('compile_secret_order_source', SECRET_ORDER.every((n) => sec.includes(n) || (n === 'synthdemo-database-url' && /databaseUrlSecretName/.test(sec))));
      const blob = JSON.stringify(compiledMain);
      ok('compile_main', true);
      ok('compile_digest_image', (/@sha256:/.test(blob) || /staffApiImageDigest/.test(blob)) && /staff_image_digest_required/.test(blob));
      ok('compile_generated_ingress', /defaultDomain/.test(blob) && /customDomains/.test(blob));
      ok('compile_no_secret_outputs', Object.keys(compiledMain.outputs || {})
        .every((k) => !/pass|secret|token|dsn|password/i.test(k)));
      ok('compile_private_pg_env', /delegatedSubnetResourceId/.test(blob) && /publicNetworkAccess/.test(blob));
      ok('compile_ownership_tags', TAGS.every((t) => blob.includes(t) || sec.includes(`${t}:`)));
      ok('compile_phase_gates', /runtime_bootstrap_phase_conflict/.test(blob)
        && /runtimeDeploymentPhase/.test(blob) && /runtimePrereqsVerified/.test(blob));
      const orderHit = SECRET_ORDER.filter((n) => mainSrc.includes(n) || n === 'synthdemo-database-url');
      ok('compile_secretRefs_named', orderHit.length >= 8 && /secretRef:\s*'luna-bot-internal-token'|secretRef:\s*databaseUrlSecretName/.test(mainSrc));
      const wrapDir = fs.mkdtempSync(path.join(os.tmpdir(), 's2c3-parity-')); tmpDirs.push(wrapDir);
      fs.mkdirSync(path.join(wrapDir, 'infra/azure/sunset-staging'), { recursive: true });
      fs.mkdirSync(path.join(wrapDir, 'infra/azure/modules/tenant-staging'), { recursive: true });
      fs.writeFileSync(path.join(wrapDir, 'infra/azure/sunset-staging/main.bicep'), show(`${BASE}:${WRAP_REL}`));
      fs.writeFileSync(path.join(wrapDir, 'infra/azure/modules/tenant-staging/main.bicep'), show(`${BASE}:${MAIN_REL}`));
      fs.writeFileSync(path.join(wrapDir, 'infra/azure/sunset-staging/acr-pull-role.bicep'), show(`${BASE}:infra/azure/sunset-staging/acr-pull-role.bicep`));
      fs.writeFileSync(path.join(wrapDir, 'infra/azure/sunset-staging/schema-observer-job.bicep'), show(`${BASE}:infra/azure/sunset-staging/schema-observer-job.bicep`));
      fs.writeFileSync(path.join(wrapDir, 'infra/azure/modules/tenant-staging/private-network.bicep'), show(`${BASE}:infra/azure/modules/tenant-staging/private-network.bicep`));
      fs.writeFileSync(path.join(wrapDir, 'infra/azure/modules/tenant-staging/synthetic-bootstrap-job.bicep'), show(`${BASE}:infra/azure/modules/tenant-staging/synthetic-bootstrap-job.bicep`));
      const baseCompiled = build(path.join(wrapDir, 'infra/azure/sunset-staging/main.bicep'));
      const baseEff = sunsetEffective(baseCompiled); const curEff = sunsetEffective(compiledWrap);
      const errs = []; const bMap = new Map(baseEff.map((r) => [`${r.type}|${r.name}`, r]));
      const cMap = new Map(curEff.map((r) => [`${r.type}|${r.name}`, r]));
      for (const [k, b] of bMap) {
        const c = cMap.get(k); if (!c) { errs.push(`missing:${k}`); continue; }
        for (const f of ['tags', 'identity', 'network', 'cert', 'domain', 'env', 'secrets', 'image', 'alert']) {
          if (stable(b[f]) !== stable(c[f])) errs.push(`${f}:${k}`);
        }
      }
      for (const [k] of cMap) if (!bMap.has(k)) errs.push(`extra:${k}`);
      ok('sunset_effective_parity', errs.length === 0, errs.slice(0, 10).join(';'));
      ok('sunset_keeps_tag_image', /staffApiImageTagged|:\$\{staffApiImageTag\}/.test(mainSrc));
    } catch (err) {
      const msg = String(err.stderr || err.message || err).slice(0, 400);
      ok('sunset_effective_parity', false, msg);
      ok('sunset_keeps_tag_image', false, 'skipped');
    }
  } else ok('compile_secrets_module', false, 'missing sources or bicep');

  const st = diffStat();
  console.log('\n── budget ──');
  console.log(JSON.stringify({ files: st.files, rawAdd: st.rawAdd, rawDel: st.rawDel, net: st.net,
    wrapUntouched: st.wrapUntouched, perFile: st.perFile }, null, 2));
  ok('budget_files', st.files <= 8, `files=${st.files}`);
  ok('budget_net', st.net <= 950, `net=${st.net}`);
  ok('wrapper_diff_zero', st.wrapUntouched);
  console.log(`\nRESULT: ${fail === 0 ? 'PASS' : 'FAIL'}  pass=${pass} fail=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
} finally { cleanup(); }
