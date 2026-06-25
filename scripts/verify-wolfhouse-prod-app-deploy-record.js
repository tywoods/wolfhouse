'use strict';

/**
 * Wolfhouse prod Staff API deploy RECORD — static gate.
 *
 * Read-only. Verifies the deploy record exists, documents the key deployment
 * facts (app, revision, image, FQDN, target port, health marker), does NOT claim
 * the custom domain is bound, does NOT claim migrations/Hermes/Meta/WhatsApp/Stripe
 * were done, and leaks no secret-looking values.
 *
 * No DB, no network, no az, no runtime imports. Exit 0 on pass, nonzero on fail.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REC = path.join(ROOT, 'docs', 'clients', 'wolfhouse', 'PROD-APP-DEPLOY-RECORD.md');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }

console.log('verify:wolfhouse-prod-app-deploy-record (static) — read-only\n');

const rec = readSafe(REC);
const r = rec || '';
const rLow = r.toLowerCase();

ok('docs/clients/wolfhouse/PROD-APP-DEPLOY-RECORD.md exists', rec != null);

// Required documented facts.
const FACTS = [
  ['app name', 'wh-prod-staff-api'],
  ['revision', 'wh-prod-staff-api--0000002'],
  ['image (acr + sha)', 'whprodacr.azurecr.io/wh-staff-api:ef45a9e195ac74a079cc0319a99180f8da7804b5'],
  ['generated FQDN', 'wh-prod-staff-api.victoriousmushroom-8be40d6f.northeurope.azurecontainerapps.io'],
  ['ingress target port 3036', '3036'],
];
for (const [label, needle] of FACTS) {
  ok(`record documents ${label}`, r.includes(needle));
}

// Health marker documented.
ok('record documents health (HTTP 200 + x-powered-by marker)',
  (r.includes('200')) && rLow.includes('x-powered-by') && rLow.includes('wolfhouse-staff-api'));

// Custom domain NOT claimed as bound/live.
ok('record does NOT claim the custom domain is bound',
  rLow.includes('staff.lunafrontdesk.com')
  && (rLow.includes('not bound') || rLow.includes('not yet') || rLow.includes('is not'))
  && !/\b(is bound|is live|now serving|domain bound|successfully bound)\b/i.test(r));

// No migrations / Hermes / Meta / WhatsApp / Stripe claimed as done.
ok('record states no migrations were run', rLow.includes('no database migrations') || rLow.includes('no migrations'));
ok('record states no Hermes app deployed', rLow.includes('no hermes'));
ok('record states no Meta/WhatsApp changes', rLow.includes('no meta') && rLow.includes('whatsapp'));
ok('record states no Stripe live changes', rLow.includes('no stripe'));

// No secret-looking values.
const FORBIDDEN = ['sk_live_', 'xoxb-', 'DISCORD_BOT_TOKEN=', 'WHATSAPP_ACCESS_TOKEN=', 'STRIPE_SECRET_KEY=', 'password='];
const hits = FORBIDDEN.filter((p) => r.includes(p));
ok('record contains no obvious secret-looking values', hits.length === 0, hits.length ? hits.join(', ') : null);

console.log(`\n── wolfhouse-prod-app-deploy-record(static): ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:wolfhouse-prod-app-deploy-record — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
