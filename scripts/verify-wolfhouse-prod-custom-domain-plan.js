'use strict';

/**
 * Wolfhouse prod custom domain plan — static gate.
 *
 * Read-only. Verifies the custom-domain plan (doc + dry-run planner) exists, names
 * the app/target hostname/generated FQDN, includes the DNS CNAME + asuid TXT plan,
 * the Azure custom-domain verification ID step, health checks, approval gates, an
 * explicit "no staff.lunafrontdesk.com binding" statement, and leaks no secrets.
 *
 * No DB, no network, no az, no runtime imports. Exit 0 on pass, nonzero on fail.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', 'clients', 'wolfhouse', 'PROD-CUSTOM-DOMAIN-PLAN.md');
const SCRIPT = path.join(ROOT, 'scripts', 'plan-wolfhouse-prod-custom-domain.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS ', name); }
  else { fail += 1; console.log('  FAIL ', name); if (detail) console.log(`        ${detail}`); }
}
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; } }

console.log('verify:wolfhouse-prod-custom-domain-plan (static) — read-only\n');

const docText = readSafe(DOC);
const scriptText = readSafe(SCRIPT);

ok('docs/clients/wolfhouse/PROD-CUSTOM-DOMAIN-PLAN.md exists', docText != null);
ok('scripts/plan-wolfhouse-prod-custom-domain.js (dry-run script) exists', scriptText != null);

const combined = `${docText || ''}\n${scriptText || ''}`;
const low = combined.toLowerCase();

ok('plan names target hostname wolfhouse.lunafrontdesk.com', combined.includes('wolfhouse.lunafrontdesk.com'));
ok('plan names the generated FQDN',
  combined.includes('wh-prod-staff-api.victoriousmushroom-8be40d6f.northeurope.azurecontainerapps.io'));
ok('plan names the app wh-prod-staff-api', combined.includes('wh-prod-staff-api'));

ok('plan includes a DNS CNAME record step', low.includes('cname'));
ok('plan includes a DNS TXT (asuid) record step', low.includes('txt') && low.includes('asuid'));
ok('plan references the Azure custom-domain verification ID',
  low.includes('customdomainverificationid'));

ok('plan includes health checks (curl + dig)', low.includes('curl') && low.includes('dig'));
ok('plan checks app health on the generated FQDN first',
  /generated fqdn|pre-flight|before any dns|before dns/i.test(combined) && low.includes('/staff/ui'));

ok('plan includes hostname bind / managed cert step',
  low.includes('hostname add') || low.includes('hostname bind'));

ok('plan explicitly does NOT bind staff.lunafrontdesk.com',
  low.includes('staff.lunafrontdesk.com')
  && (low.includes('no staff.lunafrontdesk.com') || low.includes('not staff.lunafrontdesk.com')));

ok('plan states approval gates for DNS/cert/bind',
  low.includes('approval') && (low.includes('dns') && (low.includes('cert') || low.includes('bind'))));

ok('plan includes rollback (remove hostname binding)',
  low.includes('rollback') && (low.includes('hostname delete') || low.includes('remove hostname') || low.includes('remove the hostname')));

ok('plan is dry-run / executes nothing',
  (low.includes('dry-run') || low.includes('dry run'))
  && (low.includes('executes nothing') || low.includes('nothing executed') || low.includes('not executed') || low.includes('no az')));

// out-of-scope assertions
ok('plan excludes Meta/WhatsApp/Stripe, migrations, Hermes',
  low.includes('no meta') && low.includes('whatsapp') && low.includes('stripe')
  && low.includes('migration') && low.includes('hermes'));

// no secret-looking values
const FORBIDDEN = ['sk_live_', 'xoxb-', 'DISCORD_BOT_TOKEN=', 'WHATSAPP_ACCESS_TOKEN=', 'STRIPE_SECRET_KEY=', 'password='];
const hits = [];
for (const [label, text] of [['PROD-CUSTOM-DOMAIN-PLAN.md', docText], ['plan-wolfhouse-prod-custom-domain.js', scriptText]]) {
  if (!text) continue;
  for (const p of FORBIDDEN) if (text.includes(p)) hits.push(`${label}: "${p}"`);
}
ok('plan contains no obvious secret-looking values', hits.length === 0, hits.length ? hits.join('; ') : null);

console.log(`\n── wolfhouse-prod-custom-domain-plan(static): ${pass} passed, ${fail} failed ──`);
if (fail === 0) console.log('verify:wolfhouse-prod-custom-domain-plan — ALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
