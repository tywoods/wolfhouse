'use strict';

/**
 * Prod vs TEST Staff env parity — NAMES only, never values.
 * Reads checked-in examples/compose. Does not read live /etc env files.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_STAFF_NAMES = Object.freeze([
  'NODE_ENV',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_WEBHOOK_CLIENT_SLUG',
  'STRIPE_WEBHOOK_SKIP_VERIFY',
  'WHATSAPP_DRY_RUN',
  'LUNA_AUTO_SEND_ENABLED',
  'META_APP_SECRET',
  'META_WHATSAPP_VERIFY_TOKEN',
  'DEFAULT_CLIENT',
  'LUNA_DEPLOYMENT',
]);

function uniqueSorted(list) {
  return [...new Set(list.filter(Boolean))].sort();
}

function namesFromExample(text) {
  const names = [];
  const src = String(text || '');
  const re = /^\s*(?:#\s*)?([A-Z][A-Z0-9_]+)=/gm;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  const mention = /^\s*#\s+([A-Z][A-Z0-9_]+)=/gm;
  while ((m = mention.exec(src))) names.push(m[1]);
  return uniqueSorted(names);
}

function namesFromComposeEnvironment(text, service) {
  const src = String(text || '');
  const names = [];
  const blockRe = new RegExp(`(?:^|\\n)  ${service}:[\\s\\S]*?(?=\\n  [a-z]|\\nnetworks:|\\nvolumes:|$)`);
  const block = (src.match(blockRe) || [''])[0];
  const envRe = /^\s+([A-Z][A-Z0-9_]+):/gm;
  let m;
  while ((m = envRe.exec(block))) names.push(m[1]);
  return uniqueSorted(names);
}

function compareProdTestEnvNames(opts) {
  const root = (opts && opts.root) || process.cwd();
  const testExample = fs.readFileSync(path.join(root, 'infra/.env.example'), 'utf8');
  const prodExample = fs.readFileSync(path.join(root, 'deploy/wolfhouse-prod/env.example'), 'utf8');
  const prodCompose = fs.readFileSync(path.join(root, 'deploy/wolfhouse-prod/compose.yaml'), 'utf8');

  const test_names = uniqueSorted(namesFromExample(testExample).concat(REQUIRED_STAFF_NAMES));
  const prod_declared_names = uniqueSorted(
    namesFromExample(prodExample).concat(namesFromComposeEnvironment(prodCompose, 'staff-api')),
  );
  const missing_on_prod = test_names.filter((name) => prod_declared_names.indexOf(name) < 0);
  const extra_required_missing = REQUIRED_STAFF_NAMES.filter((name) => prod_declared_names.indexOf(name) < 0);

  return {
    test_names,
    prod_declared_names,
    missing_on_prod: uniqueSorted(missing_on_prod.concat(extra_required_missing)),
    required_staff_names: REQUIRED_STAFF_NAMES.slice(),
  };
}

module.exports = {
  REQUIRED_STAFF_NAMES,
  compareProdTestEnvNames,
};
