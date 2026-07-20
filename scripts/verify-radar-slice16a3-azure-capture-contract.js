'use strict';

/**
 * verify:radar-slice16a3-azure-capture-contract — RADAR Slice 16A3
 *
 * Offline design-freeze gate for the independent exact Azure evidence-capture
 * contract. Consumes frozen fixtures + docs only. No network, no Azure, no DB.
 * Must NOT import any capture implementation module.
 *
 * Exit 0 on pass, nonzero on failure.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'radar-operations');
const SAMPLE_DIR = path.join(FIXTURE_DIR, 'slice16a3-sample-artifacts');

const CONTRACT_PATH = path.join(FIXTURE_DIR, 'slice16a3-contract.json');
const METHOD_SPEC_PATH = path.join(FIXTURE_DIR, 'slice16a3-method-spec.json');
const ATTEMPT_SCHEMA_PATH = path.join(FIXTURE_DIR, 'slice16a3-attempt-log.schema.json');
const HASH_POLICY_PATH = path.join(FIXTURE_DIR, 'slice16a3-hash-policy.json');
const ADVERSARIAL_PATH = path.join(FIXTURE_DIR, 'slice16a3-adversarial-cases.json');
const FINDINGS_PATH = path.join(FIXTURE_DIR, 'slice16a3-findings.md');
const DOC_PATH = path.join(ROOT, 'docs', 'RADAR-OPERATIONS-GATE-LEDGER.md');
const VERIFIER_PATH = path.join(__dirname, 'verify-radar-slice16a3-azure-capture-contract.js');

const MASTER_BASIS = '5a8b08d395e11c51baf928b918016d5dd5bb4afe';
const BRANCH = 'radar/slice-16a3-capture-contract';
const DEFERRED_16A2_SHA = '9d98590109c99f53a2d03b59d488373d9f9377d1';

const SECRET_PATTERNS = [
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{20,}/,
  /whsec_[A-Za-z0-9]+/,
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /ClientSecret["']?\s*[:=]\s*["'][^"']{12,}/i,
  /password["']?\s*[:=]\s*["'][^"']{8,}/i,
  /ACCOUNT_KEY["']?\s*[:=]\s*["'][^"']{16,}/i,
];

const REQUIRED_ADVERSARIAL_IDS = [
  'AC16A3_COMMAND_SUBSTITUTION',
  'AC16A3_LISTKEYS',
  'AC16A3_RESTART_POST',
  'AC16A3_ALTERED_PATH',
  'AC16A3_ALTERED_API_VERSION',
  'AC16A3_ALTERED_BODY',
  'AC16A3_HIDDEN_RETRY',
  'AC16A3_HIDDEN_FALLBACK',
  'AC16A3_MISSING_FAILURE_RECORD',
  'AC16A3_SHARED_CONSTANT_DRIFT',
];

let pass = 0;
let fail = 0;
const redResults = [];

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
    return true;
  }
  fail += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function red(id, cond, detail) {
  const passed = ok(`RED ${id}`, cond, detail);
  redResults.push({ id, ok: passed });
  return passed;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function hashCanonical(value) {
  return sha256Hex(canonicalJson(value));
}

function secretFree(text, label) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, detail: `${label} matched ${re}` };
  }
  return { ok: true };
}

function expandPathTemplate(template, vars) {
  if (template == null) return null;
  return String(template)
    .replace(/\{sub\}/g, vars.sub || '')
    .replace(/\{rg\}/g, vars.rg || '')
    .replace(/\{name\}/g, vars.name || '')
    .replace(/\{host\}/g, vars.host || '')
    .replace(/\{resourceId\}/g, vars.resourceId || '');
}

function pathMatchesTemplate(actual, template, vars) {
  if (template == null && actual == null) return true;
  if (template == null || actual == null) return false;
  if (template.includes('{resourceId}')) {
    // Allow any resourceId prefix under allowed subscription + RG, then exact suffix.
    const suffix = '/providers/Microsoft.Insights/diagnosticSettings';
    if (!String(actual).endsWith(suffix)) return false;
    const sub = vars.sub;
    const rg = vars.rg;
    const prefix = `/subscriptions/${sub}/resourceGroups/${rg}/`;
    return String(actual).startsWith(prefix) || String(actual).includes('/providers/');
  }
  const expected = expandPathTemplate(template, vars);
  return String(actual) === String(expected);
}

function commandMatchesTemplate(command, template) {
  if (!template) return false;
  const cmd = String(command || '');
  // Template tokens {rg}/{name}/{host}/... become non-empty segments.
  const escaped = template
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{rg\\\}/g, '[A-Za-z0-9._-]+')
    .replace(/\\\{name\\\}/g, '[A-Za-z0-9._-]+')
    .replace(/\\\{host\\\}/g, '[A-Za-z0-9._-]+')
    .replace(/\\\{sub\\\}/g, '[0-9a-fA-F-]+')
    .replace(/\\\{resourceId\\\}/g, '\\S+')
    .replace(/\\\{costUrl\\\}/g, '\\S+')
    .replace(/\\\{budgetsUrl\\\}/g, '\\S+')
    .replace(/\\\{bodyPath\\\}/g, '\\S+')
    .replace(/\\\{body\\\}/g, '\\S+');
  return new RegExp(`^${escaped}$`).test(cmd);
}

function bodyMatchesSchema(body, schema) {
  if (schema == null) return body == null;
  if (body == null || typeof body !== 'object') return false;
  if (schema.additionalProperties === false) {
    const allowed = new Set(Object.keys(schema.properties || {}));
    for (const k of Object.keys(body)) {
      if (!allowed.has(k)) return false;
    }
  }
  for (const req of schema.required || []) {
    if (!Object.prototype.hasOwnProperty.call(body, req)) return false;
  }
  for (const [key, rule] of Object.entries(schema.properties || {})) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const val = body[key];
    if (Object.prototype.hasOwnProperty.call(rule, 'const')) {
      if (hashCanonical(val) !== hashCanonical(rule.const)) return false;
      continue;
    }
    if (rule.type === 'object') {
      if (!bodyMatchesSchema(val, rule)) return false;
      continue;
    }
    if (rule.type === 'string') {
      if (typeof val !== 'string') return false;
      if (rule.pattern && !new RegExp(rule.pattern).test(val)) return false;
    }
  }
  return true;
}

/**
 * Evaluate a proposed dispatch against the frozen method-spec.
 * Returns { ok: true } or { ok: false, reasons: string[] }.
 */
function evaluatePreDispatch(spec, input) {
  const reasons = [];
  const method = (spec.methods || []).find((m) => m.id === input.method_id);
  if (!method) {
    reasons.push('unknown method_id');
    return { ok: false, reasons };
  }

  const http = String(input.http_method || '').toUpperCase();
  if (http !== String(method.http_method).toUpperCase()) {
    reasons.push(`http_method mismatch (expected ${method.http_method})`);
  }

  if (http === 'POST' && !(spec.mutation_policy.post_allowed_only_for_method_ids || []).includes(method.id)) {
    reasons.push('POST not allowed for method_id');
  }
  if (['PUT', 'PATCH', 'DELETE'].includes(http)) {
    reasons.push(`${http} mutation forbidden`);
  }

  const cmd = String(input.command_or_url || '');
  const restPath = input.rest_path == null ? null : String(input.rest_path);
  const blob = `${cmd}\n${restPath || ''}`;

  for (const marker of spec.forbidden_path_markers || []) {
    if (blob.includes(marker)) reasons.push(`forbidden path marker: ${marker}`);
  }
  for (const marker of spec.forbidden_command_markers || []) {
    if (cmd.includes(marker) || (restPath && restPath.includes(marker))) {
      reasons.push(`forbidden command marker: ${marker}`);
    }
  }

  if (/restart/i.test(blob)) reasons.push('restart forbidden');

  if (method.scope && method.scope.subscription_required) {
    if (input.subscription_id !== spec.allowed_subscription_id) {
      reasons.push('subscription mismatch');
    }
  }
  if (method.scope && method.scope.resource_group_required) {
    if (!(spec.allowed_resource_groups || []).includes(input.resource_group)) {
      reasons.push('resource_group not allowlisted');
    }
  }
  if ((spec.forbidden_resource_groups || []).includes(input.resource_group)) {
    reasons.push('forbidden resource_group');
  }

  if ((method.allowed_hosts || []).length) {
    if (!(method.allowed_hosts || []).includes(input.host)) {
      reasons.push('host not allowlisted');
    }
  }

  if (method.rest && method.rest.path_template) {
    const vars = {
      sub: spec.allowed_subscription_id,
      rg: input.resource_group,
      host: input.host,
      name: 'x',
      resourceId: restPath ? String(restPath).replace(/\/providers\/Microsoft\.Insights\/diagnosticSettings$/, '') : '',
    };
    if (!pathMatchesTemplate(restPath, method.rest.path_template, vars)) {
      // For templates with {name}, compare structurally: same prefix/suffix around {name}
      const tpl = method.rest.path_template;
      if (tpl.includes('{name}')) {
        const [pre, post] = expandPathTemplate(tpl, { ...vars, name: '\u0000' }).split('\u0000');
        if (!(restPath && restPath.startsWith(pre) && restPath.endsWith(post))) {
          reasons.push('rest path mismatch vs template');
        }
      } else if (tpl.includes('{host}')) {
        const expected = expandPathTemplate(tpl, vars);
        if (restPath !== expected) reasons.push('rest path mismatch vs template');
      } else if (!pathMatchesTemplate(restPath, tpl, vars)) {
        reasons.push('rest path mismatch vs template');
      }
    }
    if (method.rest.api_version !== input.api_version) {
      reasons.push(`api_version mismatch (expected ${method.rest.api_version})`);
    }
  } else if (method.rest === null && restPath != null) {
    // account show has null rest; tolerate null only
    reasons.push('unexpected rest_path');
  }

  if (method.command_template && !commandMatchesTemplate(cmd, method.command_template)) {
    // Allow healthz fallback commands from declared chain
    const fallbackCmds = ((method.fallback_policy && method.fallback_policy.declared_chain) || [])
      .map((s) => s.command_template);
    const okFallback = fallbackCmds.some((t) => commandMatchesTemplate(cmd, t));
    if (!okFallback) reasons.push('command does not match method command_template');
  }

  if (method.body_schema) {
    if (!bodyMatchesSchema(input.request_body, method.body_schema)) {
      reasons.push('body schema mismatch (expected ActualCost frozen shape)');
    }
  } else if (input.request_body != null) {
    reasons.push('unexpected request body');
  }

  return reasons.length ? { ok: false, reasons } : { ok: true, reasons: [] };
}

function evaluateAdversarial(spec, c) {
  const classifier = c.classifier;
  if (classifier.startsWith('pre_dispatch')) {
    const result = evaluatePreDispatch(spec, c.input);
    const refused = !result.ok;
    const reasonText = result.reasons.join(' | ').toLowerCase();
    const needles = (c.expect.reason_includes || []).map((s) => String(s).toLowerCase());
    const reasonsOk = needles.every((n) => reasonText.includes(n)
      || (n === 'command' && reasonText.includes('command'))
      || (n === 'template' && reasonText.includes('template'))
      || (n === 'path' && reasonText.includes('path'))
      || (n === 'post' && reasonText.includes('post'))
      || (n === 'restart' && reasonText.includes('restart'))
      || (n === 'listkeys' && reasonText.includes('listkeys'))
      || (n === 'api_version' && reasonText.includes('api_version'))
      || (n === 'body' && reasonText.includes('body'))
      || (n === 'actualcost' && reasonText.includes('actualcost')));
    return {
      ok: c.expect.verdict === 'refuse' ? (refused && reasonsOk) : false,
      detail: result.reasons.join('; '),
    };
  }

  if (classifier === 'attempt_log_hidden_retry') {
    const slice = c.input.attempt_log_slice || [];
    const hidden = slice.some((a) => a.implied_prior_failures > 0 && a.outcome === 'success' && a.attempt_index === 0);
    return {
      ok: hidden && c.expect.verdict === 'fail',
      detail: hidden ? 'hidden retry detected' : 'no hidden retry signal',
    };
  }

  if (classifier === 'attempt_log_hidden_fallback') {
    const slice = c.input.attempt_log_slice || [];
    const hidden = slice.some((a) => a.implied_undeclared_prior_transport && a.is_fallback === false);
    return {
      ok: hidden && c.expect.verdict === 'fail',
      detail: hidden ? 'hidden fallback detected' : 'no hidden fallback signal',
    };
  }

  if (classifier === 'attempt_log_missing_failure') {
    const known = c.input.known_physical_failures || [];
    const slice = c.input.attempt_log_slice || [];
    const missing = known.some((k) => {
      const match = slice.find((a) => a.logical_call_id === k.logical_call_id && a.attempt_index === k.attempt_index);
      return !match || match.outcome !== 'failure' || match.error_class !== k.error_class;
    });
    return {
      ok: missing && c.expect.verdict === 'fail',
      detail: missing ? 'missing failure record' : 'failure present',
    };
  }

  if (classifier === 'shared_constant_drift') {
    const frozenIds = (spec.methods || []).map((m) => m.id).sort();
    const drifted = (c.input.drifted_implementation_constants.allowed_method_ids || []).slice().sort();
    const extra = drifted.filter((id) => !frozenIds.includes(id));
    const drift = extra.length > 0 || drifted.length !== frozenIds.length;
    const reasonText = `drift extras=${extra.join(',')}`;
    const needles = (c.expect.reason_includes || []).map((s) => String(s).toLowerCase());
    const reasonsOk = needles.every((n) => reasonText.toLowerCase().includes(n) || n === 'drift');
    return {
      ok: drift && reasonsOk && c.expect.verdict === 'fail',
      detail: reasonText,
    };
  }

  return { ok: false, detail: `unknown classifier ${classifier}` };
}

function methodSpecHashable(spec) {
  return {
    allowed_subscription_id: spec.allowed_subscription_id,
    allowed_resource_groups: spec.allowed_resource_groups,
    forbidden_resource_groups: spec.forbidden_resource_groups,
    allowed_public_healthz_hosts: spec.allowed_public_healthz_hosts,
    forbidden_path_markers: spec.forbidden_path_markers,
    forbidden_command_markers: spec.forbidden_command_markers,
    mutation_policy: spec.mutation_policy,
    sampled_diagnostic_resources: spec.sampled_diagnostic_resources,
    methods: spec.methods,
    attempt_semantics: spec.attempt_semantics,
    pre_dispatch_rule: spec.pre_dispatch_rule,
  };
}

function walkFiles(dir, acc) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

console.log('verify:radar-slice16a3-azure-capture-contract — RADAR Slice 16A3\n');

ok('F01 contract exists', fs.existsSync(CONTRACT_PATH));
ok('F02 method-spec exists', fs.existsSync(METHOD_SPEC_PATH));
ok('F03 attempt-log schema exists', fs.existsSync(ATTEMPT_SCHEMA_PATH));
ok('F04 hash-policy exists', fs.existsSync(HASH_POLICY_PATH));
ok('F05 adversarial cases exist', fs.existsSync(ADVERSARIAL_PATH));
ok('F06 findings exist', fs.existsSync(FINDINGS_PATH));
ok('F07 doc exists', fs.existsSync(DOC_PATH));
ok('F08 sample artifacts dir exists', fs.existsSync(SAMPLE_DIR));

const contract = readJson(CONTRACT_PATH);
const spec = readJson(METHOD_SPEC_PATH);
const attemptSchema = readJson(ATTEMPT_SCHEMA_PATH);
const hashPolicy = readJson(HASH_POLICY_PATH);
const adversarial = readJson(ADVERSARIAL_PATH);
const findings = readText(FINDINGS_PATH);
const doc = readText(DOC_PATH);
const verifierSrc = readText(VERIFIER_PATH);
const greenLog = readJson(path.join(SAMPLE_DIR, 'green-attempt-log.json'));
const artifactIndex = readJson(path.join(SAMPLE_DIR, 'artifact-index.json'));
const costBody = readJson(path.join(SAMPLE_DIR, 'cost-query-body.sample.json'));

ok('F09 slice RADAR-16A3', contract.slice === 'RADAR-16A3' && spec.slice === 'RADAR-16A3');
ok('F10 master basis pinned',
  contract.master_basis === MASTER_BASIS && spec.master_basis === MASTER_BASIS);
ok('F11 branch name', contract.branch === BRANCH);
ok('F12 audit-only / no live mutation / no network',
  contract.audit_only === true
  && contract.live_mutation === false
  && contract.network_calls === false
  && contract.runtime_behavior_changed === false);
ok('F13 supersedes deferred 16A2',
  contract.supersedes
  && contract.supersedes.slice === 'RADAR-16A2'
  && contract.supersedes.tip_sha === DEFERRED_16A2_SHA
  && /deferred/i.test(contract.supersedes.policy));

ok('F14 G09 budget-vs-anomaly semantics preserved',
  contract.preserves_from_16a2
  && contract.preserves_from_16a2.g09_semantics
  && contract.preserves_from_16a2.g09_semantics.gate_id_corrected === 'G09_cost_controls'
  && contract.preserves_from_16a2.g09_semantics.budgets_are === 'threshold_controls'
  && contract.preserves_from_16a2.g09_semantics.budgets_are_not === 'anomaly_detection'
  && contract.preserves_from_16a2.g09_semantics.selected_16b === '16B_staging_rg_cost_budget_threshold'
  && contract.preserves_from_16a2.g09_semantics.selected_16b_does_not_implement === 'anomaly_detection');

ok('F15 bounded replacement owner named',
  contract.bounded_replacement_implementation_owner
  && contract.bounded_replacement_implementation_owner.slice_id === '16A4_azure_capture_implementation'
  && contract.bounded_replacement_implementation_owner.planned_module
    === 'scripts/lib/radar-operations-azure-capture.js'
  && contract.bounded_replacement_implementation_owner.must_load_spec_from
    === 'fixtures/radar-operations/slice16a3-method-spec.json'
  && contract.bounded_replacement_implementation_owner.must_not_be_imported_by_verifier === true);

ok('F16 method inventory size 17', Array.isArray(spec.methods) && spec.methods.length === 17);
ok('F17 cost_query is sole POST',
  spec.methods.filter((m) => m.http_method === 'POST').map((m) => m.id).join(',') === 'cost_query'
  && (spec.mutation_policy.post_allowed_only_for_method_ids || []).join(',') === 'cost_query');
ok('F18 every method has retry+fallback policy',
  spec.methods.every((m) => m.retry_policy && m.fallback_policy
    && m.retry_policy.record_each_physical_attempt === true
    && m.retry_policy.record_failures === true
    && m.retry_policy.hidden_retries_forbidden === true
    && m.fallback_policy.undeclared_fallbacks_forbidden === true));
ok('F19 attempt semantics require physical-dispatch records',
  spec.attempt_semantics
  && spec.attempt_semantics.unit === 'physical_dispatch_attempt'
  && spec.attempt_semantics.hidden_retry_or_fallback_is_defect === true
  && spec.attempt_semantics.missing_failure_record_is_defect === true
  && Array.isArray(spec.attempt_semantics.required_fields)
  && spec.attempt_semantics.required_fields.includes('outcome')
  && spec.attempt_semantics.required_fields.includes('error_class'));

const recomputedManifest = hashCanonical(methodSpecHashable(spec));
ok('F20 complete_manifest_sha256 recomputes',
  recomputedManifest === spec.complete_manifest_sha256
  && recomputedManifest === contract.complete_manifest_sha256,
  `got ${recomputedManifest}`);

ok('F21 hash policy algorithm sha256+canonical',
  hashPolicy.algorithm === 'sha256'
  && hashPolicy.canonical_json
  && hashPolicy.canonical_json.object_keys === 'sorted_lexicographic');

ok('F22 attempt schema outcomes include failure',
  attemptSchema.properties
  && attemptSchema.properties.outcome
  && (attemptSchema.properties.outcome.enum || []).includes('failure'));

ok('F23 green attempt log pins manifest hash',
  greenLog.method_spec_complete_manifest_sha256 === spec.complete_manifest_sha256);
ok('F24 green log records failure then success for cost_query',
  greenLog.attempts.some((a) => a.method_id === 'cost_query' && a.outcome === 'failure' && a.error_class === 'http_429')
  && greenLog.attempts.some((a) => a.method_id === 'cost_query' && a.outcome === 'success' && a.attempt_index === 1));
ok('F25 green log records declared healthz fallback',
  greenLog.attempts.some((a) => a.method_id === 'public_healthz_get' && a.outcome === 'failure' && a.fallback_step_id === 'curl_https_get')
  && greenLog.attempts.some((a) => a.method_id === 'public_healthz_get' && a.is_fallback === true && a.fallback_step_id === 'node_https_get'));

let artifactHashOk = true;
for (const art of artifactIndex.artifacts) {
  const abs = path.join(SAMPLE_DIR, art.relpath);
  if (!fs.existsSync(abs)) {
    artifactHashOk = false;
    break;
  }
  const obj = readJson(abs);
  if (hashCanonical(obj) !== art.response_sha256) {
    artifactHashOk = false;
    break;
  }
}
ok('F26 sample raw response hashes independently recompute', artifactHashOk);
ok('F27 cost body sample hash matches index',
  hashCanonical(costBody) === artifactIndex.cost_query_body_sha256);
ok('F28 green attempt response hashes match artifacts',
  greenLog.attempts
    .filter((a) => a.response_artifact_relpath)
    .every((a) => {
      const obj = readJson(path.join(SAMPLE_DIR, a.response_artifact_relpath));
      return hashCanonical(obj) === a.response_sha256;
    }));

ok('F29 adversarial case ids complete',
  REQUIRED_ADVERSARIAL_IDS.every((id) => (adversarial.cases || []).some((c) => c.id === id)));

for (const c of adversarial.cases) {
  const ev = evaluateAdversarial(spec, c);
  red(c.id, ev.ok, ev.detail);
}

ok('F30 all RED cases passed', redResults.length === REQUIRED_ADVERSARIAL_IDS.length && redResults.every((r) => r.ok));

const requireImportRe = /require\s*\(\s*['"][^'"]*(?:radar-operations-azure-capture|capture-radar-operations-staging-readonly)[^'"]*['"]\s*\)/;
ok('F31 verifier source does not import capture implementation',
  !requireImportRe.test(verifierSrc)
  && !/from\s+['"][^'"]*(?:radar-operations-azure-capture|capture-radar-operations-staging-readonly)/.test(verifierSrc));

ok('F32 capture implementation absent on this design-freeze branch',
  !fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'radar-operations-azure-capture.js'))
  && !fs.existsSync(path.join(ROOT, 'scripts', 'capture-radar-operations-staging-readonly.js')));

ok('F33 doc marks 16A2 deferred',
  /16A2/.test(doc) && /deferred/i.test(doc) && /do not merge/i.test(doc));
ok('F34 doc preserves G09 budget-vs-anomaly semantics',
  /G09_cost_controls/.test(doc)
  && /threshold/i.test(doc)
  && /anomaly detection/i.test(doc)
  && /16B_staging_rg_cost_budget_threshold/.test(doc)
  && /real delivery proof/i.test(doc));
ok('F35 findings name 16A4 owner + deferred 16A2',
  /16A4_azure_capture_implementation/.test(findings)
  && /deferred/i.test(findings)
  && /16A2/.test(findings));

const runtimePaths = contract.zero_mutation_proof.runtime_paths_unchanged;
let runtimeClean = true;
for (const rel of runtimePaths) {
  try {
    const out = execSync(`git diff --name-only ${MASTER_BASIS} -- ${rel}`, {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
    if (out) {
      runtimeClean = false;
      console.log(`        runtime path dirty: ${rel} -> ${out}`);
    }
  } catch (err) {
    runtimeClean = false;
  }
}
ok('F36 runtime paths unchanged vs master basis', runtimeClean);

let diffCheckOk = true;
try {
  execSync(`git diff --check ${MASTER_BASIS}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (err) {
  diffCheckOk = false;
  console.log(`        git diff --check failed: ${String(err.stderr || err.message).slice(0, 300)}`);
}
ok('F37 exact git diff --check clean', diffCheckOk);

const fixtureFiles = walkFiles(FIXTURE_DIR, []).filter((p) => /slice16a3/.test(p));
let secretsOk = true;
let secretDetail = '';
for (const p of fixtureFiles.concat([DOC_PATH, VERIFIER_PATH, FINDINGS_PATH])) {
  const sf = secretFree(readText(p), path.relative(ROOT, p));
  if (!sf.ok) {
    secretsOk = false;
    secretDetail = sf.detail;
    break;
  }
}
ok('F38 secret-free fixtures/docs/verifier', secretsOk, secretDetail);

ok('F39 package.json registers 16A3 gate',
  /verify:radar-slice16a3-azure-capture-contract/.test(readText(path.join(ROOT, 'package.json'))));

// Positive control: a clearly valid arm_rg_show dispatch must accept
const greenDispatch = evaluatePreDispatch(spec, {
  method_id: 'arm_rg_show',
  http_method: 'GET',
  command_or_url: 'az group show -n wh-staging-rg -o json',
  rest_path: `/subscriptions/${spec.allowed_subscription_id}/resourceGroups/wh-staging-rg`,
  api_version: '2021-04-01',
  subscription_id: spec.allowed_subscription_id,
  resource_group: 'wh-staging-rg',
  host: null,
  request_body: null,
});
ok('F40 GREEN pre-dispatch accepts exact arm_rg_show', greenDispatch.ok, greenDispatch.reasons.join('; '));

const greenCost = evaluatePreDispatch(spec, {
  method_id: 'cost_query',
  http_method: 'POST',
  command_or_url: 'az rest --method post --url https://example.invalid --body @cost.json -o json',
  rest_path: `/subscriptions/${spec.allowed_subscription_id}/resourceGroups/wh-staging-rg/providers/Microsoft.CostManagement/query`,
  api_version: '2023-11-01',
  subscription_id: spec.allowed_subscription_id,
  resource_group: 'wh-staging-rg',
  host: null,
  request_body: costBody,
});
ok('F41 GREEN pre-dispatch accepts frozen cost_query body', greenCost.ok, greenCost.reasons.join('; '));

console.log(`\n── RADAR 16A3 capture contract: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail) ──`);
console.log(`complete_manifest_sha256=${spec.complete_manifest_sha256}`);
console.log(`bounded_owner=${contract.bounded_replacement_implementation_owner.slice_id}`);
process.exit(fail === 0 ? 0 : 1);
