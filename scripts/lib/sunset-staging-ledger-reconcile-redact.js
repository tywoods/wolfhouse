'use strict';

const path = require('path');
const { scanSecretValues } = require('./sunset-staging-iac-drift');
const { ENV_PG_ADMIN_PASSWORD, ENV_PG_ADMIN_USER } = require('./sunset-schema-observer-role-provision');

const ENV_TOKEN = 'SUNSET_STAGING_LEDGER_RECONCILE_APPROVAL_TOKEN';

const PATH_RE = /(?:[A-Za-z]:\\|\/)[^\s"'`]+/g;
const DSN_RE = /postgres(?:ql)?:\/\/[^\s"'`]+/gi;
const APPROVAL_RE = /APPROVE-SUNSET-056060-[0-9a-f]{32}/gi;

function redactString(text, extraSecrets) {
  let out = String(text || '');
  for (const secret of extraSecrets || []) {
    if (secret && out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  out = out.replace(DSN_RE, '[REDACTED_DSN]');
  out = out.replace(APPROVAL_RE, '[REDACTED_TOKEN]');
  out = out.replace(PATH_RE, '[REDACTED_PATH]');
  return out.slice(0, 240);
}

function collectSecrets(env) {
  const e = env || process.env;
  const secrets = [];
  for (const key of [ENV_PG_ADMIN_PASSWORD, ENV_PG_ADMIN_USER, ENV_TOKEN]) {
    const v = String(e[key] || '');
    if (v) secrets.push(v);
  }
  return secrets;
}

function sanitizeReconcileError(err, env) {
  const secrets = collectSecrets(env);
  const raw = {
    ok: false,
    code: err && err.code ? String(err.code) : 'unhandled',
    message: redactString(err && err.message ? err.message : String(err || 'error'), secrets),
  };
  if (Array.isArray(err && err.errors)) {
    raw.errors = err.errors.map((e) => ({
      code: e.code,
      message: redactString(e.message || '', secrets),
    }));
  }
  const hits = scanSecretValues(raw);
  if (hits.length) {
    return { ok: false, code: 'secret_material_refused', message: 'error redaction failed closed' };
  }
  return raw;
}

function sanitizePublicPayload(payload, env) {
  const secrets = collectSecrets(env);
  const json = JSON.parse(JSON.stringify(payload || {}));
  const scrub = (v) => {
    if (typeof v === 'string') return redactString(v, secrets);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, val] of Object.entries(v)) o[k] = scrub(val);
      return o;
    }
    return v;
  };
  const out = scrub(json);
  const hits = scanSecretValues(out);
  if (hits.length) return { ok: false, code: 'secret_material_refused' };
  return out;
}

module.exports = {
  redactString,
  sanitizeReconcileError,
  sanitizePublicPayload,
  collectSecrets,
};
