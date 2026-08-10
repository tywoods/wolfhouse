'use strict';

const runtimeIsProxy = require('node:util').types.isProxy.bind(undefined);
const { createEmailLunaDraftAuthor } = require('./email-luna-draft-author');

const SUNSET_DEPLOYMENT = 'sunset-staging';
const SUNSET_LOCATION_KEY = 'sunset-somo';
const ENV_RUNTIME_ENABLED = 'EMAIL_LUNA_DRAFT_RUNTIME_ENABLED';
const objectFreeze = Object.freeze;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectGetPrototypeOf = Object.getPrototypeOf;
const objectHasOwn = Object.hasOwn;
const reflectOwnKeys = Reflect.ownKeys;

function data(value, keys, exact, allowedOnly = true) {
  if (!value || typeof value !== 'object' || runtimeIsProxy(value) || Array.isArray(value)
      || objectGetPrototypeOf(value) !== Object.prototype) return null;
  let own;
  try { own = reflectOwnKeys(value); } catch (_) { return null; }
  if ((allowedOnly && own.some((key) => typeof key !== 'string' || !keys.includes(key)))
      || (exact && own.length !== keys.length)) return null;
  const out = Object.create(null);
  for (const key of keys) {
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (!descriptor) { if (exact) return null; continue; }
    if (!objectHasOwn(descriptor, 'value') || !descriptor.enumerable) return null;
    out[key] = descriptor.value;
  }
  return out;
}
function isEmailLunaDraftRuntimeEnabled(input) {
  const request = data(input, ['env', 'authority', 'tenant_location_gate'], true);
  if (!request) return false;
  const env = data(request.env, ['LUNA_DEPLOYMENT', ENV_RUNTIME_ENABLED], false, false);
  const authority = data(request.authority, ['client_id', 'location_id', 'location_key'], true);
  const gate = data(request.tenant_location_gate, ['client_id', 'location_id', 'location_key', 'draft_enabled'], true);
  return Boolean(env && authority && gate
    && env.LUNA_DEPLOYMENT === SUNSET_DEPLOYMENT && env[ENV_RUNTIME_ENABLED] === 'true'
    && authority.location_key === SUNSET_LOCATION_KEY
    && gate.draft_enabled === true && gate.location_key === SUNSET_LOCATION_KEY
    && typeof authority.client_id === 'string' && typeof authority.location_id === 'string'
    && gate.client_id === authority.client_id && gate.location_id === authority.location_id);
}
function createEmailLunaSunsetStagingRuntimeComposition(configuration) {
  const config = data(configuration, ['env', 'authority', 'tenant_location_gate', 'callModel', 'timeoutMs'], false);
  const gateInput = config && { env: config.env, authority: config.authority, tenant_location_gate: config.tenant_location_gate };
  if (!gateInput || !isEmailLunaDraftRuntimeEnabled(gateInput)) {
    const error = new Error('Email Luna draft runtime disabled.');
    error.code = 'EMAIL_LUNA_DRAFT_RUNTIME_DISABLED';
    throw error;
  }
  const authorConfig = {};
  if (objectHasOwn(config, 'callModel')) authorConfig.callModel = config.callModel;
  if (objectHasOwn(config, 'timeoutMs')) authorConfig.timeoutMs = config.timeoutMs;
  const author = createEmailLunaDraftAuthor(authorConfig);
  return objectFreeze({ authorDraft: author.authorDraft });
}

module.exports = {
  SUNSET_DEPLOYMENT, SUNSET_LOCATION_KEY, ENV_RUNTIME_ENABLED,
  isEmailLunaDraftRuntimeEnabled, createEmailLunaSunsetStagingRuntimeComposition,
};
