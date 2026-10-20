'use strict';

const fs = require('fs');

const REQUIRED = Object.freeze({
  LUNA_ROUTING_CONTROLLER_PORT: (value) => value === '8096',
  LUNA_ROUTING_SITE: (value, site) => value === site,
  LUNA_ROUTING_MUTATIONS_ENABLED: (value) => value === 'false',
  LUNA_ROUTING_CONTROLLER_HMAC_KEY: (value) => value.length >= 32,
  LUNA_ROUTING_INGRESS_PROOF_KEY: (value) => value.length >= 32,
  LUNA_ROUTING_INGRESS_PROOF_URL: (value) => {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
  },
});
const FRANCE_SITE = 'whatsapp-staging.lunafrontdesk.com';
const FRANCE_PUBLIC = Object.freeze({
  WA_PHONE_NUMBER_ID: (value) => /^[0-9]{8,20}$/.test(value),
  WA_BUSINESS_ACCOUNT_ID: (value) => /^[0-9]{8,20}$/.test(value),
  WA_APP_ID: (value) => /^[0-9]{8,20}$/.test(value),
  LUNA_STAGING_WHATSAPP_NUMBER_E164: (value) => /^\+[1-9][0-9]{7,14}$/.test(value),
  LUNA_STAGING_WHATSAPP_NUMBER_DISPLAY: (value) => /^\+[0-9-]{8,32}$/.test(value) && !value.includes('--'),
});
const SECRET_KEYS = new Set([
  'WA_ACCESS_TOKEN',
  'WA_APP_SECRET',
  'WHATSAPP_CLOUD_ACCESS_TOKEN',
  'WHATSAPP_CLOUD_APP_SECRET',
  'META_APP_SECRET',
]);
const SIMPLE_VALUE = /^[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/;

function allowedKeys(expectedSite) {
  return expectedSite === FRANCE_SITE ? { ...REQUIRED, ...FRANCE_PUBLIC } : REQUIRED;
}

function validateControllerEnv(text, expectedSite) {
  const accepts = allowedKeys(expectedSite);
  const values = new Map();
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (!line.trim() || /^#[^\r\n]*$/.test(line)) continue;
    const strict = /^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/.exec(line);
    if (!strict || !SIMPLE_VALUE.test(strict[2])) {
      throw new Error(`unsupported EnvironmentFile assignment at line ${index + 1}`);
    }
    if (SECRET_KEYS.has(strict[1])) throw new Error(`secret key rejected: ${strict[1]}`);
    if (!Object.hasOwn(accepts, strict[1])) {
      throw new Error(`unsupported EnvironmentFile assignment at line ${index + 1}`);
    }
    if (values.has(strict[1])) throw new Error(`duplicate EnvironmentFile assignment: ${strict[1]}`);
    values.set(strict[1], strict[2]);
  }
  for (const [key, accept] of Object.entries(accepts)) {
    if (!values.has(key) || !accept(values.get(key), expectedSite)) throw new Error(`invalid or missing ${key}`);
  }
  if (expectedSite === FRANCE_SITE) {
    const e164 = String(values.get('LUNA_STAGING_WHATSAPP_NUMBER_E164') || '').replace(/\D/g, '');
    const display = String(values.get('LUNA_STAGING_WHATSAPP_NUMBER_DISPLAY') || '').replace(/\D/g, '');
    if (!e164 || e164 !== display) throw new Error('invalid or missing LUNA_STAGING_WHATSAPP_NUMBER_DISPLAY');
  }
  return true;
}

if (require.main === module) {
  const [filename, expectedSite] = process.argv.slice(2);
  if (!filename || !expectedSite) throw new Error('usage: validate-controller-env.js FILE EXPECTED_SITE');
  validateControllerEnv(fs.readFileSync(filename, 'utf8'), expectedSite);
}

module.exports = { validateControllerEnv };
