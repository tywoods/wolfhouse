'use strict';

/**
 * Sunset staging live-to-IaC drift helpers (FOUNDATION Slice 1).
 * Secret-safe. No Azure mutations. Pure classification + scan utilities.
 */

const CLASSIFICATIONS = Object.freeze([
  'matches',
  'live_but_unmanaged',
  'declared_but_absent',
  'materially_drifted',
  'secret_manual_dependency',
  'intentionally_shared_external_dependency',
]);

const FORBIDDEN_WOLFHOUSE_RUNTIME = Object.freeze([
  'wh-staging-staff-api',
  'staff-staging.lunafrontdesk.com',
  'wh-staff-api:',
  'wh-staff-api@',
  'wolfhouse_staging',
  'wh-staging-kv',
  'wh-staging-pg-app',
  'wh-staging-env',
]);

/**
 * Unmistakably synthetic sentinel for RED self-tests only.
 * Assembled from parts so the contiguous token is never a committed literal.
 * Never a real credential.
 */
const SYNTHETIC_SECRET_SENTINEL = ['WH', 'FOUNDATION', 'SLICE1', 'SYNTHETIC', 'SECRET', 'SENTINEL', 'NEVER', 'REAL'].join('_');

/** Patterns that indicate a secret *value* leaked into inventory JSON. */
const SECRET_VALUE_PATTERNS = Object.freeze([
  new RegExp(SYNTHETIC_SECRET_SENTINEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  /sk_live_[A-Za-z0-9]+/,
  /sk_test_[A-Za-z0-9]{8,}/,
  /whsec_[A-Za-z0-9]+/,
  // Real connection strings only — ignore docs placeholders like <DB_PASSWORD>.
  /postgres(?:ql)?:\/\/[^:\s"'<>]+:(?!<)[^@\s"'<>]+@[^\s"']+/i,
  /-----BEGIN [A-Z ]+PRIVATE KEY-----/,
]);

const ALLOWED_SHARED_MARKERS = Object.freeze([
  'whstagingacr',
  'wh-staging-rg',
]);

function isClassification(value) {
  return CLASSIFICATIONS.includes(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectStrings(node, out = []) {
  if (node == null) return out;
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
    return out;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
  return out;
}

function scanSecretValues(inventory) {
  const text = typeof inventory === 'string' ? inventory : JSON.stringify(inventory);
  const hits = [];
  for (const re of SECRET_VALUE_PATTERNS) {
    const m = text.match(re);
    if (m) hits.push({ pattern: String(re), sample: m[0].slice(0, 64) });
  }
  return hits;
}

function scanForbiddenWolfhouseRuntime(inventory) {
  const text = typeof inventory === 'string' ? inventory : JSON.stringify(inventory);
  const hits = [];
  for (const needle of FORBIDDEN_WOLFHOUSE_RUNTIME) {
    if (text.includes(needle)) hits.push(needle);
  }
  return hits;
}

function validateSchema(inventory) {
  const errors = [];
  if (!inventory || typeof inventory !== 'object') {
    return ['inventory must be a JSON object'];
  }
  if (inventory.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (!inventory.scope || inventory.scope.resourceGroup !== 'luna-sunset-staging-rg') {
    errors.push('scope.resourceGroup must be luna-sunset-staging-rg');
  }
  if (!inventory.scope || inventory.scope.app !== 'luna-sunset-staging-staff-api') {
    errors.push('scope.app must be luna-sunset-staging-staff-api');
  }
  if (!inventory.cost || inventory.cost.type !== 'ActualCost') {
    errors.push('cost.type must be ActualCost');
  }
  if (!Array.isArray(inventory.resources)) errors.push('resources must be an array');
  if (!Array.isArray(inventory.items)) errors.push('items must be an array');
  return errors;
}

function findUnresolvedMaterialDrift(inventory) {
  const items = Array.isArray(inventory.items) ? inventory.items : [];
  return items.filter((item) => {
    if (!item || typeof item !== 'object') return true;
    if (!isClassification(item.classification)) return true;
    if (item.classification === 'materially_drifted' && item.resolved === false) return true;
    return false;
  });
}

function findUnknownResources(inventory) {
  const resources = Array.isArray(inventory.resources) ? inventory.resources : [];
  const items = Array.isArray(inventory.items) ? inventory.items : [];
  const covered = new Set(
    items
      .filter((i) => i && i.resourceKey)
      .map((i) => i.resourceKey),
  );
  return resources.filter((r) => {
    const key = `${r.type}::${r.name}`;
    return !covered.has(key);
  });
}

function findUnclassifiedEnvVars(inventory) {
  const plainEnv =
    inventory &&
    inventory.normalized &&
    inventory.normalized.staffApi &&
    inventory.normalized.staffApi.plainEnv;
  const classifications =
    inventory &&
    inventory.normalized &&
    inventory.normalized.staffApi &&
    inventory.normalized.staffApi.envClassifications;

  if (!plainEnv || typeof plainEnv !== 'object') {
    return ['missing normalized.staffApi.plainEnv'];
  }
  if (!classifications || typeof classifications !== 'object') {
    return ['missing normalized.staffApi.envClassifications'];
  }

  const errors = [];
  const plainKeys = Object.keys(plainEnv).sort();
  const classKeys = Object.keys(classifications).sort();

  for (const key of plainKeys) {
    if (!Object.prototype.hasOwnProperty.call(classifications, key)) {
      errors.push(`unclassified-env: ${key}`);
      continue;
    }
    if (!isClassification(classifications[key])) {
      errors.push(`bad-env-classification: ${key}=${classifications[key]}`);
    }
  }
  for (const key of classKeys) {
    if (!Object.prototype.hasOwnProperty.call(plainEnv, key)) {
      errors.push(`env-classification-without-plainEnv: ${key}`);
    }
  }
  return errors;
}

function summarizeByClassification(inventory) {
  const counts = Object.fromEntries(CLASSIFICATIONS.map((c) => [c, 0]));
  for (const item of inventory.items || []) {
    if (item && counts[item.classification] != null) counts[item.classification] += 1;
  }
  return counts;
}

module.exports = {
  CLASSIFICATIONS,
  FORBIDDEN_WOLFHOUSE_RUNTIME,
  SECRET_VALUE_PATTERNS,
  SYNTHETIC_SECRET_SENTINEL,
  ALLOWED_SHARED_MARKERS,
  isClassification,
  deepClone,
  collectStrings,
  scanSecretValues,
  scanForbiddenWolfhouseRuntime,
  validateSchema,
  findUnresolvedMaterialDrift,
  findUnknownResources,
  findUnclassifiedEnvVars,
  summarizeByClassification,
};
