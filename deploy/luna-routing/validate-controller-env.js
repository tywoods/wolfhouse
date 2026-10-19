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
const SIMPLE_VALUE = /^[A-Za-z0-9._~:/?#@!$&()*+,;=%-]+$/;

function validateControllerEnv(text, expectedSite) {
  const values = new Map();
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (!line.trim() || /^#[^\r\n]*$/.test(line)) continue;
    const strict = /^([A-Z][A-Z0-9_]*)=([^\r\n]*)$/.exec(line);
    if (!strict || !Object.hasOwn(REQUIRED, strict[1]) || !SIMPLE_VALUE.test(strict[2])) {
      throw new Error(`unsupported EnvironmentFile assignment at line ${index + 1}`);
    }
    if (values.has(strict[1])) throw new Error(`duplicate EnvironmentFile assignment: ${strict[1]}`);
    values.set(strict[1], strict[2]);
  }
  for (const [key, accepts] of Object.entries(REQUIRED)) {
    if (!values.has(key) || !accepts(values.get(key), expectedSite)) throw new Error(`invalid or missing ${key}`);
  }
  return true;
}

if (require.main === module) {
  const [filename, expectedSite] = process.argv.slice(2);
  if (!filename || !expectedSite) throw new Error('usage: validate-controller-env.js FILE EXPECTED_SITE');
  validateControllerEnv(fs.readFileSync(filename, 'utf8'), expectedSite);
}

module.exports = { validateControllerEnv };
