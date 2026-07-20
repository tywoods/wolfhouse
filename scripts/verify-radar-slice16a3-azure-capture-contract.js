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

const FREE_PLACEHOLDER_RE = /(?<!%)\{[a-zA-Z_][a-zA-Z0-9_]*\}/;

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
  redResults.push({ id, ok: passed, detail: detail || '' });
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

function stripManifestHash(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(stripManifestHash);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'complete_manifest_sha256' || k === 'method_spec_complete_manifest_sha256') continue;
    out[k] = stripManifestHash(v);
  }
  return out;
}

function computeCompleteManifest(parts) {
  const map = {};
  for (const [rel, value] of Object.entries(parts)) {
    map[rel] = stripManifestHash(value);
  }
  return hashCanonical(map);
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function getByPath(obj, dotted) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setByPath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function applyMutation(target, mutation) {
  const out = deepClone(target);
  const field = mutation.field;
  if (mutation.op === 'remove_attempt_id') {
    out.attempts = (out.attempts || []).filter((a) => a.attempt_id !== mutation.value);
    return out;
  }
  if (mutation.op === 'append' && field === 'allowed_method_ids') {
    out.allowed_method_ids = [...(out.allowed_method_ids || []), mutation.value];
    return out;
  }
  const m = /^attempts\[attempt_id=([^\]]+)\]\.(.+)$/.exec(field);
  if (m) {
    const attempt = (out.attempts || []).find((a) => a.attempt_id === m[1]);
    if (!attempt) throw new Error(`attempt ${m[1]} not found for mutation`);
    setByPath(attempt, m[2], mutation.value);
    return out;
  }
  setByPath(out, field, mutation.value);
  return out;
}

function proveIntendedDelta(before, after, intended) {
  if (intended.op === 'remove_attempt_id' && intended.field === 'attempts') {
    const beforeHas = (before.attempts || []).some((a) => a.attempt_id === 'att-003');
    const afterHas = (after.attempts || []).some((a) => a.attempt_id === 'att-003');
    return beforeHas && !afterHas
      && (after.attempts || []).some((a) => a.attempt_id === 'att-004' && a.attempt_index === 1);
  }
  if (intended.op === 'append' && intended.field === 'allowed_method_ids') {
    return (before.allowed_method_ids || []).length === intended.before_length
      && (after.allowed_method_ids || []).includes(intended.after_extra)
      && (after.allowed_method_ids || []).length === intended.before_length + 1;
  }
  const field = intended.field;
  const m = /^attempts\[attempt_id=([^\]]+)\]\.(.+)$/.exec(field);
  if (m) {
    const b = (before.attempts || []).find((a) => a.attempt_id === m[1]);
    const a = (after.attempts || []).find((a) => a.attempt_id === m[1]);
    if (!b || !a) return false;
    return getByPath(b, m[2]) === intended.before && getByPath(a, m[2]) === intended.after;
  }
  return getByPath(before, field) === intended.before && getByPath(after, field) === intended.after;
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

function bindingMatches(binding, input) {
  if (binding.command !== input.command_or_url) return false;
  const restPath = input.rest_path == null ? null : String(input.rest_path);
  if (binding.rest == null) {
    if (restPath != null) return false;
  } else {
    if (binding.rest.method !== String(input.http_method || '').toUpperCase()) return false;
    if (binding.rest.path !== restPath) return false;
    if (binding.rest.api_version !== input.api_version) return false;
  }
  if ((binding.resource_group || null) !== (input.resource_group || null)) return false;
  if ((binding.resource_name || null) !== (input.resource_name || null)) return false;
  if ((binding.host || null) !== (input.host || null)) return false;
  if (binding.body == null) {
    if (input.request_body != null) return false;
  } else if (hashCanonical(binding.body) !== hashCanonical(input.request_body)) {
    // Binding freezes one sample body; schema may still accept shape variants —
    // exact binding match requires exact body when binding.body is set.
    return false;
  }
  return true;
}

/**
 * Evaluate a proposed dispatch against exact frozen bindings.
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

  if (FREE_PLACEHOLDER_RE.test(cmd) || (restPath && FREE_PLACEHOLDER_RE.test(restPath))) {
    reasons.push('free placeholder forbidden in command/path');
  }

  if (method.scope && method.scope.subscription_required) {
    if (input.subscription_id !== spec.allowed_subscription_id) {
      reasons.push('subscription mismatch');
    }
  }
  if (method.scope && method.scope.resource_group_required) {
    if (!(spec.allowed_resource_groups || []).includes(input.resource_group)) {
      reasons.push('resource_group not allowlisted');
    }
    if ((method.allowed_resource_groups || []).length
      && !(method.allowed_resource_groups || []).includes(input.resource_group)) {
      reasons.push('resource_group not in method allowlist');
    }
  }
  if ((spec.forbidden_resource_groups || []).includes(input.resource_group)) {
    reasons.push('forbidden resource_group');
  }

  if ((method.allowed_resource_names || []).length) {
    if (!(method.allowed_resource_names || []).includes(input.resource_name)) {
      reasons.push('resource_name not allowlisted');
    }
  } else if (input.resource_name != null) {
    reasons.push('unexpected resource_name');
  }

  if ((method.allowed_hosts || []).length) {
    if (!(method.allowed_hosts || []).includes(input.host)) {
      reasons.push('host not allowlisted');
    }
  }

  if ((method.allowed_sampled_diagnostic_resource_ids || []).length) {
    const okDiag = (method.allowed_sampled_diagnostic_resource_ids || []).some((id) => {
      const suffix = `${id}/providers/Microsoft.Insights/diagnosticSettings`;
      return restPath === suffix || cmd.includes(id);
    });
    if (!okDiag) reasons.push('diagnostic resource_id not in exact allowlist');
  }

  // Exact binding match (command may also be a declared fallback command)
  const bindings = method.bindings || [];
  let matched = bindings.some((b) => bindingMatches(b, input));
  if (!matched) {
    const fallbackCmds = ((method.fallback_policy && method.fallback_policy.declared_chain) || [])
      .flatMap((s) => s.commands || []);
    const cmdOk = fallbackCmds.includes(cmd);
    const restOk = bindings.some((b) => b.rest && b.rest.path === restPath
      && b.rest.api_version === input.api_version
      && (b.host || null) === (input.host || null));
    if (!(cmdOk && (restPath == null || restOk || bindings.some((b) => b.rest && b.rest.path === restPath)))) {
      reasons.push('command/path does not match exact binding');
    } else {
      matched = true;
    }
    if (!matched && method.rest === undefined) {
      // keep reasons
    }
  }

  if (!matched) {
    // More specific mismatch reasons for RED needles
    const anyPath = bindings.some((b) => b.rest && b.rest.path === restPath);
    const anyApi = bindings.some((b) => b.rest && b.rest.api_version === input.api_version);
    const anyCmd = bindings.some((b) => b.command === cmd) || ((method.fallback_policy && method.fallback_policy.declared_chain) || [])
      .flatMap((s) => s.commands || []).includes(cmd);
    if (!anyCmd) reasons.push('command does not match exact binding template');
    if (restPath != null && !anyPath) reasons.push('rest path mismatch vs exact binding');
    if (input.api_version !== undefined && bindings.some((b) => b.rest) && !anyApi) {
      reasons.push(`api_version mismatch (expected exact binding)`);
    }
  }

  if (method.body_schema) {
    if (!bodyMatchesSchema(input.request_body, method.body_schema)) {
      reasons.push('body schema mismatch (expected ActualCost frozen shape)');
    }
  } else if (input.request_body != null) {
    reasons.push('unexpected request body');
  }

  // Deduplicate reasons
  const uniq = [...new Set(reasons)];
  return uniq.length ? { ok: false, reasons: uniq } : { ok: true, reasons: [] };
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function matchesSchemaNode(value, schema, pathLabel, errs) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.const !== undefined) {
    if (hashCanonical(value) !== hashCanonical(schema.const)) {
      errs.push(`${pathLabel}: const mismatch`);
    }
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errs.push(`${pathLabel}: enum mismatch`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const t = typeOf(value);
    const okType = types.some((x) => (x === 'integer' ? Number.isInteger(value) : x === t)
      || (x === 'number' && typeof value === 'number'));
    if (!okType) errs.push(`${pathLabel}: type ${t} not in ${types.join('|')}`);
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    errs.push(`${pathLabel}: pattern mismatch`);
  }
  if (typeof schema.minLength === 'number' && typeof value === 'string' && value.length < schema.minLength) {
    errs.push(`${pathLabel}: minLength`);
  }
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    errs.push(`${pathLabel}: minimum`);
  }
  if (typeof schema.maximum === 'number' && typeof value === 'number' && value > schema.maximum) {
    errs.push(`${pathLabel}: maximum`);
  }
  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object')) || schema.properties) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (schema.additionalProperties === false) {
        const allowed = new Set(Object.keys(schema.properties || {}));
        for (const k of Object.keys(value)) {
          if (!allowed.has(k)) errs.push(`${pathLabel}: additional property ${k}`);
        }
      }
      for (const req of schema.required || []) {
        if (!Object.prototype.hasOwnProperty.call(value, req)) errs.push(`${pathLabel}: missing ${req}`);
      }
      for (const [k, sub] of Object.entries(schema.properties || {})) {
        if (Object.prototype.hasOwnProperty.call(value, k)) {
          matchesSchemaNode(value[k], sub, `${pathLabel}.${k}`, errs);
        }
      }
    }
  }
  if ((schema.type === 'array' || (Array.isArray(schema.type) && schema.type.includes('array'))) && Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) errs.push(`${pathLabel}: minItems`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) errs.push(`${pathLabel}: maxItems`);
    if (schema.items) {
      value.forEach((item, i) => matchesSchemaNode(item, schema.items, `${pathLabel}[${i}]`, errs));
    }
  }
  for (const branch of schema.allOf || []) {
    if (branch.if && branch.then) {
      const ifErrs = [];
      matchesSchemaNode(value, branch.if, pathLabel, ifErrs);
      // Lightweight if: check outcome const when present
      let applies = true;
      if (branch.if.properties && branch.if.properties.outcome && branch.if.properties.outcome.const !== undefined) {
        applies = value && value.outcome === branch.if.properties.outcome.const;
      }
      if (applies) matchesSchemaNode(value, branch.then, pathLabel, errs);
    } else {
      matchesSchemaNode(value, branch, pathLabel, errs);
    }
  }
}

function validateAgainstSchema(doc, schema) {
  const errs = [];
  matchesSchemaNode(doc, schema, '$', errs);
  return errs;
}

function validateWholeAttemptLog(spec, log) {
  const reasons = [];
  const attempts = log.attempts || [];
  if (!Array.isArray(attempts) || attempts.length === 0) {
    return { ok: false, reasons: ['empty attempts'] };
  }
  if (attempts.length > 64) reasons.push('attempts exceed bound 64');

  // Unique + contiguous ordered IDs att-001..att-NNN
  const ids = attempts.map((a) => a.attempt_id);
  if (new Set(ids).size !== ids.length) reasons.push('attempt_id not unique');
  for (let i = 0; i < attempts.length; i += 1) {
    const expected = `att-${String(i + 1).padStart(3, '0')}`;
    if (attempts[i].attempt_id !== expected) {
      reasons.push(`attempt_id not contiguous ordered (expected ${expected} at index ${i})`);
      break;
    }
  }

  // Per logical call: contiguous attempt_index from 0, bounded by method max
  const byCall = new Map();
  for (const a of attempts) {
    if (!byCall.has(a.logical_call_id)) byCall.set(a.logical_call_id, []);
    byCall.get(a.logical_call_id).push(a);
  }
  for (const [callId, rows] of byCall.entries()) {
    rows.sort((x, y) => x.attempt_index - y.attempt_index);
    for (let i = 0; i < rows.length; i += 1) {
      if (rows[i].attempt_index !== i) {
        reasons.push(`attempt_index not contiguous for ${callId}`);
        break;
      }
    }
    const method = (spec.methods || []).find((m) => m.id === rows[0].method_id);
    if (method) {
      const chainLen = ((method.fallback_policy && method.fallback_policy.declared_chain) || []).length;
      const maxA = Math.max(method.retry_policy.max_physical_attempts, chainLen || 1);
      if (rows.length > maxA) reasons.push(`attempts exceed method max_physical_attempts for ${callId}`);
      for (const r of rows) {
        if (r.outcome === 'failure' && r.error_class) {
          const retryable = method.retry_policy.retry_on_error_classes || [];
          // failure classes used for retries must be in policy when followed by another attempt
        }
      }
      // If success at index>0, prior rows must be failures with retryable classes (else hidden retry)
      const success = rows.filter((r) => r.outcome === 'success');
      for (const s of success) {
        if (s.attempt_index > 0) {
          const priors = rows.filter((r) => r.attempt_index < s.attempt_index);
          const okPriors = priors.length === s.attempt_index
            && priors.every((r) => r.outcome === 'failure'
              && (method.retry_policy.retry_on_error_classes || []).includes(r.error_class));
          // healthz uses fallback not retry classes
          if (method.id === 'public_healthz_get') {
            // handled below
          } else if (!okPriors) {
            reasons.push(`hidden retry for ${callId}`);
          }
        }
      }

      // Fallback chain exact
      const chain = (method.fallback_policy && method.fallback_policy.declared_chain) || [];
      for (const r of rows) {
        if (r.fallback_step_id) {
          const step = chain.find((s) => s.id === r.fallback_step_id);
          if (!step) reasons.push(`fallback_step_id not in declared chain for ${callId}`);
          else if (!(step.commands || []).includes(r.command_or_url)) {
            reasons.push(`fallback command not in exact chain for ${callId}`);
          }
        }
        if (r.is_fallback) {
          const stepIdx = chain.findIndex((s) => s.id === r.fallback_step_id);
          if (stepIdx <= 0) reasons.push(`hidden fallback for ${callId}`);
          if (!r.fallback_of_attempt_id) reasons.push(`fallback missing parent for ${callId}`);
        } else if (r.fallback_step_id && chain.findIndex((s) => s.id === r.fallback_step_id) > 0) {
          reasons.push(`hidden fallback for ${callId}`);
        }
      }
    }
  }

  // Outcome-conditional fields (also in schema; re-check)
  for (const a of attempts) {
    if (a.outcome === 'success') {
      if (a.error_class !== null) reasons.push(`success has error_class ${a.attempt_id}`);
      if (!a.response_sha256 || !a.response_artifact_relpath) reasons.push(`success missing response hash ${a.attempt_id}`);
    } else if (a.outcome === 'failure' || a.outcome === 'refused_pre_dispatch') {
      if (!a.error_class) reasons.push(`failure missing error_class ${a.attempt_id}`);
      if (a.response_sha256 !== null || a.response_artifact_relpath !== null) {
        reasons.push(`failure has response fields ${a.attempt_id}`);
      }
    }
  }

  // Missing failure: if a logical call has attempt_index>=1 success after non-failure prior
  for (const [callId, rows] of byCall.entries()) {
    const method = (spec.methods || []).find((m) => m.id === rows[0].method_id);
    if (!method || method.id === 'public_healthz_get') continue;
    const sorted = [...rows].sort((x, y) => x.attempt_index - y.attempt_index);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i].outcome === 'success' || sorted[i].attempt_index > 0) {
        const prior = sorted[i - 1];
        if (prior.outcome !== 'failure') {
          reasons.push(`missing failure before retry for ${callId}`);
        }
      }
    }
    // Two successes without intervening failure when indices suggest retry
    const failures = sorted.filter((r) => r.outcome === 'failure');
    const successes = sorted.filter((r) => r.outcome === 'success');
    if (successes.length >= 1 && sorted.some((r) => r.attempt_index > 0) && failures.length === 0) {
      reasons.push(`missing failure for ${callId}`);
    }
    // Outcome flipped: failure expected class path — if first row is success with attempt_index 0
    // but second also success, missing failure
    if (sorted.length >= 2 && sorted[0].outcome === 'success' && sorted[1].outcome === 'success') {
      reasons.push(`missing failure for ${callId}`);
    }
  }

  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

function evaluateAdversarial(spec, adversarial, greenLog, c) {
  const classifier = c.classifier;
  const intended = c.intended_delta;

  if (classifier === 'pre_dispatch_one_field_mutation') {
    const green = adversarial.green_controls[c.green_control];
    if (!green) return { ok: false, detail: 'missing green control' };
    const greenEval = evaluatePreDispatch(spec, green);
    if (!greenEval.ok) return { ok: false, detail: `GREEN control not accepted: ${greenEval.reasons.join('; ')}` };
    const mutated = applyMutation(green, c.mutation);
    const deltaOk = proveIntendedDelta(green, mutated, intended);
    if (!deltaOk) return { ok: false, detail: 'intended delta not proven' };
    const result = evaluatePreDispatch(spec, mutated);
    const refused = !result.ok;
    const reasonText = result.reasons.join(' | ').toLowerCase();
    const needles = (c.expect.reason_includes || []).map((s) => String(s).toLowerCase());
    const reasonsOk = needles.every((n) => reasonText.includes(n)
      || (n === 'command' && reasonText.includes('command'))
      || (n === 'path' && reasonText.includes('path'))
      || (n === 'post' && reasonText.includes('post'))
      || (n === 'restart' && reasonText.includes('restart'))
      || (n === 'listkeys' && reasonText.includes('listkeys'))
      || (n === 'api_version' && reasonText.includes('api_version'))
      || (n === 'body' && reasonText.includes('body'))
      || (n === 'actualcost' && reasonText.includes('actualcost')));
    return {
      ok: c.expect.verdict === 'refuse' && refused && reasonsOk && deltaOk,
      detail: `delta=${deltaOk}; ${result.reasons.join('; ')}`,
    };
  }

  if (classifier === 'attempt_log_one_field_mutation') {
    const green = deepClone(greenLog);
    const greenVal = validateWholeAttemptLog(spec, green);
    if (!greenVal.ok) return { ok: false, detail: `GREEN log invalid: ${greenVal.reasons.join('; ')}` };
    const mutated = applyMutation(green, c.mutation);
    const deltaOk = proveIntendedDelta(greenLog, mutated, intended);
    if (!deltaOk) return { ok: false, detail: 'intended delta not proven' };
    const result = validateWholeAttemptLog(spec, mutated);
    const failed = !result.ok;
    const reasonText = result.reasons.join(' | ').toLowerCase();
    const needles = (c.expect.reason_includes || []).map((s) => String(s).toLowerCase());
    const reasonsOk = needles.every((n) => reasonText.includes(n));
    return {
      ok: c.expect.verdict === 'fail' && failed && reasonsOk && deltaOk,
      detail: `delta=${deltaOk}; ${result.reasons.join('; ')}`,
    };
  }

  if (classifier === 'shared_constant_one_field_mutation') {
    const green = adversarial.green_controls[c.green_control];
    const mutated = applyMutation(green, c.mutation);
    const deltaOk = proveIntendedDelta(green, mutated, intended);
    const frozenIds = (spec.methods || []).map((m) => m.id).sort();
    const drifted = (mutated.allowed_method_ids || []).slice().sort();
    const extra = drifted.filter((id) => !frozenIds.includes(id));
    const drift = extra.length > 0 || drifted.length !== frozenIds.length;
    const reasonText = `drift extras=${extra.join(',')}`;
    const needles = (c.expect.reason_includes || []).map((s) => String(s).toLowerCase());
    const reasonsOk = needles.every((n) => reasonText.toLowerCase().includes(n) || n === 'drift');
    return {
      ok: drift && reasonsOk && deltaOk && c.expect.verdict === 'fail',
      detail: `delta=${deltaOk}; ${reasonText}`,
    };
  }

  return { ok: false, detail: `unknown classifier ${classifier}` };
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
ok('F18 every method has retry+fallback policy + exact bindings',
  spec.methods.every((m) => m.retry_policy && m.fallback_policy
    && Array.isArray(m.bindings) && m.bindings.length >= 1
    && Array.isArray(m.allowed_resource_names)
    && Array.isArray(m.allowed_sampled_diagnostic_resource_ids)
    && m.retry_policy.record_each_physical_attempt === true
    && m.retry_policy.record_failures === true
    && m.retry_policy.hidden_retries_forbidden === true
    && m.fallback_policy.undeclared_fallbacks_forbidden === true));

ok('F18b no free placeholders in bindings/fallback commands',
  spec.methods.every((m) => (m.bindings || []).every((b) => !FREE_PLACEHOLDER_RE.test(b.command)
    && !(b.rest && b.rest.path && FREE_PLACEHOLDER_RE.test(b.rest.path)))
    && ((m.fallback_policy && m.fallback_policy.declared_chain) || []).every((s) => (s.commands || [])
      .every((c) => !FREE_PLACEHOLDER_RE.test(c)))));

ok('F18c diagnostic paths are exact subscription/RG/resource IDs',
  (() => {
    const diag = spec.methods.find((m) => m.id === 'diagnostic_settings_list');
    if (!diag) return false;
    const ids = diag.allowed_sampled_diagnostic_resource_ids || [];
    if (ids.length !== 10) return false;
    return ids.every((id) => id.startsWith(`/subscriptions/${spec.allowed_subscription_id}/resourceGroups/`))
      && diag.bindings.every((b) => ids.includes(
        String(b.rest.path).replace(/\/providers\/Microsoft\.Insights\/diagnosticSettings$/, ''),
      ));
  })());

ok('F19 attempt semantics require physical-dispatch records',
  spec.attempt_semantics
  && spec.attempt_semantics.unit === 'physical_dispatch_attempt'
  && spec.attempt_semantics.hidden_retry_or_fallback_is_defect === true
  && spec.attempt_semantics.missing_failure_record_is_defect === true
  && Array.isArray(spec.attempt_semantics.required_fields)
  && spec.attempt_semantics.required_fields.includes('outcome')
  && spec.attempt_semantics.required_fields.includes('error_class')
  && spec.attempt_semantics.required_fields.includes('resource_name'));

ok('F19b attempt schema is closed whole-log (additionalProperties=false)',
  attemptSchema.additionalProperties === false
  && attemptSchema.properties
  && attemptSchema.properties.attempts
  && attemptSchema.properties.attempts.items
  && attemptSchema.properties.attempts.items.additionalProperties === false
  && attemptSchema.properties.attempts.maxItems === 64
  && (attemptSchema.verifier_enforced_whole_log_rules || {}).attempt_ids_contiguous_ordered_from_att_001 === true);

const recomputedManifest = computeCompleteManifest({
  'fixtures/radar-operations/slice16a3-method-spec.json': spec,
  'fixtures/radar-operations/slice16a3-attempt-log.schema.json': attemptSchema,
  'fixtures/radar-operations/slice16a3-hash-policy.json': hashPolicy,
  'fixtures/radar-operations/slice16a3-contract.json#bounded_replacement_implementation_owner':
    contract.bounded_replacement_implementation_owner,
  'fixtures/radar-operations/slice16a3-adversarial-cases.json': adversarial,
  'fixtures/radar-operations/slice16a3-sample-artifacts/artifact-index.json': artifactIndex,
});
ok('F20 complete_manifest_sha256 recomputes over full frozen scope',
  recomputedManifest === spec.complete_manifest_sha256
  && recomputedManifest === contract.complete_manifest_sha256
  && recomputedManifest === artifactIndex.complete_manifest_sha256
  && recomputedManifest === hashPolicy.complete_manifest_sha256,
  `got ${recomputedManifest}`);

ok('F21 hash policy algorithm sha256+canonical + full scope',
  hashPolicy.algorithm === 'sha256'
  && hashPolicy.canonical_json
  && hashPolicy.canonical_json.object_keys === 'sorted_lexicographic'
  && Array.isArray(hashPolicy.complete_manifest_scope)
  && hashPolicy.complete_manifest_scope.length === 6);

ok('F22 attempt schema outcomes include failure',
  attemptSchema.properties
  && attemptSchema.properties.attempts
  && attemptSchema.properties.attempts.items
  && attemptSchema.properties.attempts.items.properties
  && attemptSchema.properties.attempts.items.properties.outcome
  && (attemptSchema.properties.attempts.items.properties.outcome.enum || []).includes('failure'));

const schemaErrs = validateAgainstSchema(greenLog, attemptSchema);
ok('F23 GREEN attempt log validates against closed whole-log schema',
  schemaErrs.length === 0, schemaErrs.slice(0, 5).join('; '));

const wholeGreen = validateWholeAttemptLog(spec, greenLog);
ok('F23b GREEN whole-log rules pass', wholeGreen.ok, wholeGreen.reasons.join('; '));

ok('F24 green attempt log pins manifest hash',
  greenLog.method_spec_complete_manifest_sha256 === spec.complete_manifest_sha256);
ok('F25 green log records failure then success for cost_query',
  greenLog.attempts.some((a) => a.method_id === 'cost_query' && a.outcome === 'failure' && a.error_class === 'http_429')
  && greenLog.attempts.some((a) => a.method_id === 'cost_query' && a.outcome === 'success' && a.attempt_index === 1));
ok('F26 green log records declared healthz fallback',
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
ok('F27 sample raw response hashes independently recompute', artifactHashOk);
ok('F28 cost body sample hash matches index',
  hashCanonical(costBody) === artifactIndex.cost_query_body_sha256);
ok('F29 green attempt response hashes match artifacts',
  greenLog.attempts
    .filter((a) => a.response_artifact_relpath)
    .every((a) => {
      const obj = readJson(path.join(SAMPLE_DIR, a.response_artifact_relpath));
      return hashCanonical(obj) === a.response_sha256;
    }));

ok('F30 adversarial case ids complete',
  REQUIRED_ADVERSARIAL_IDS.every((id) => (adversarial.cases || []).some((c) => c.id === id)));
ok('F30b adversarial cases are one-field mutations (no implied_* metadata)',
  (adversarial.cases || []).every((c) => c.mutation && c.intended_delta && c.green_control)
  && !/implied_prior_failures|implied_undeclared_prior_transport/.test(JSON.stringify(adversarial)));

for (const c of adversarial.cases) {
  const ev = evaluateAdversarial(spec, adversarial, greenLog, c);
  red(c.id, ev.ok, ev.detail);
}

ok('F31 all RED cases passed', redResults.length === REQUIRED_ADVERSARIAL_IDS.length && redResults.every((r) => r.ok));

const requireImportRe = /require\s*\(\s*['"][^'"]*(?:radar-operations-azure-capture|capture-radar-operations-staging-readonly)[^'"]*['"]\s*\)/;
ok('F32 verifier source does not import capture implementation',
  !requireImportRe.test(verifierSrc)
  && !/from\s+['"][^'"]*(?:radar-operations-azure-capture|capture-radar-operations-staging-readonly)/.test(verifierSrc));

ok('F33 capture implementation absent on this design-freeze branch',
  !fs.existsSync(path.join(ROOT, 'scripts', 'lib', 'radar-operations-azure-capture.js'))
  && !fs.existsSync(path.join(ROOT, 'scripts', 'capture-radar-operations-staging-readonly.js')));

ok('F34 doc marks 16A2 deferred',
  /16A2/.test(doc) && /deferred/i.test(doc) && /do not merge/i.test(doc));
ok('F35 doc preserves G09 budget-vs-anomaly semantics',
  /G09_cost_controls/.test(doc)
  && /threshold/i.test(doc)
  && /anomaly detection/i.test(doc)
  && /16B_staging_rg_cost_budget_threshold/.test(doc)
  && /real delivery proof/i.test(doc));
ok('F36 findings name 16A4 owner + deferred 16A2',
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
ok('F37 runtime paths unchanged vs master basis', runtimeClean);

function rangeDiffCheckClean() {
  try {
    const out = execSync(
      `git diff --check ${MASTER_BASIS}..HEAD`,
      { cwd: ROOT, encoding: 'utf8' },
    );
    return { ok: true, detail: out.trim() || '(clean)' };
  } catch (err) {
    const detail = String((err && err.stdout) || (err && err.message) || err).trim();
    return { ok: false, detail: detail.slice(0, 800) };
  }
}

function noTrailingWhitespace(text) {
  return !text.split(/\n/).some((line) => /[ \t]+$/.test(line));
}

const rangeCheck = rangeDiffCheckClean();
ok('F38 exact git diff --check clean vs master basis', rangeCheck.ok, rangeCheck.detail);
ok('F38b findings have no trailing whitespace', noTrailingWhitespace(findings));
ok('F38c contract gates pin range diff --check',
  Array.isArray(contract.gates)
  && contract.gates.some((g) => g === `git diff --check ${MASTER_BASIS}..HEAD`));

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
ok('F39 secret-free fixtures/docs/verifier', secretsOk, secretDetail);

ok('F40 package.json registers 16A3 gate',
  /verify:radar-slice16a3-azure-capture-contract/.test(readText(path.join(ROOT, 'package.json'))));

const greenDispatch = evaluatePreDispatch(spec, adversarial.green_controls.GC_arm_rg_show_wh);
ok('F41 GREEN pre-dispatch accepts exact arm_rg_show', greenDispatch.ok, greenDispatch.reasons.join('; '));

const greenCost = evaluatePreDispatch(spec, adversarial.green_controls.GC_cost_query_wh);
ok('F42 GREEN pre-dispatch accepts frozen cost_query body', greenCost.ok, greenCost.reasons.join('; '));

console.log(`\n── RADAR 16A3 capture contract: ${fail === 0 ? 'PASS' : 'FAIL'} (${pass} pass, ${fail} fail) ──`);
console.log(`complete_manifest_sha256=${spec.complete_manifest_sha256}`);
console.log(`bounded_owner=${contract.bounded_replacement_implementation_owner.slice_id}`);
process.exit(fail === 0 ? 0 : 1);
