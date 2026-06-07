/**
 * Phase 25b — Verifier for staff_phone_access foundation.
 *
 * Usage:
 *   npm run verify:luna-agent-phase25-staff-phone-access
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MIGRATION = path.join(ROOT, 'database', 'migrations', '016_staff_phone_access.sql');
const HELPER = path.join(__dirname, 'lib', 'staff-phone-access.js');
const UPSERT = path.join(__dirname, 'upsert-staff-phone-access.js');
const DOC = path.join(ROOT, 'docs', 'PHASE-25b-STAFF-PHONE-ACCESS.md');
const PKG_FILE = path.join(ROOT, 'package.json');
const SCRIPT = 'verify:luna-agent-phase25-staff-phone-access';

const GUEST_UNTOUCHED = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-inbound-process.js'),
  path.join(__dirname, 'lib', 'luna-guest-reply-draft.js'),
];

const GUEST_WEBHOOK = [
  path.join(__dirname, 'lib', 'luna-meta-whatsapp-webhook.js'),
  path.join(ROOT, 'scripts', 'luna-meta-whatsapp-webhook.js'),
].find((p) => fs.existsSync(p));

const DOWNSTREAM = ['verify:luna-agent-phase25-owner-design'];

let passes = 0;
let failures = 0;

function pass(id, msg) { console.log(`  PASS  [${id}] ${msg}`); passes++; }
function fail(id, msg) { console.error(`  FAIL  [${id}] ${msg}`); failures++; }
function section(t) { console.log(`\n── ${t} ──`); }

function readOrEmpty(p) {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; }
  catch { return ''; }
}

console.log('\nverify-luna-agent-phase25-staff-phone-access.js  (Phase 25b)\n');

try {
  execSync(`node --check "${HELPER}"`, { stdio: 'pipe' });
  execSync(`node --check "${UPSERT}"`, { stdio: 'pipe' });
  pass('0', 'helper + upsert CLI pass node --check');
} catch {
  fail('0', 'syntax check failed');
}

section('A. Migration');

const mig = readOrEmpty(MIGRATION);
if (mig.includes('staff_phone_access')) pass('A1', 'migration creates staff_phone_access');
else fail('A1', 'staff_phone_access table missing');
if (/role.*operator.*owner|CHECK \(role IN \('operator', 'owner'\)\)/i.test(mig)) {
  pass('A2', 'role check includes operator and owner');
} else fail('A2', 'role check missing');
if (/UNIQUE \(client_slug, phone_normalized, channel\)/i.test(mig)) {
  pass('A3', 'unique(client_slug, phone_normalized, channel)');
} else fail('A3', 'unique constraint missing');
if (/idx_staff_phone_access_client_phone/i.test(mig)) pass('A4', 'index client_slug + phone_normalized');
else fail('A4', 'client phone index missing');
if (/idx_staff_phone_access_client_role/i.test(mig)) pass('A5', 'index client_slug + role');
else fail('A5', 'client role index missing');
if (/idx_staff_phone_access_client_active/i.test(mig)) pass('A6', 'index client_slug + is_active');
else fail('A6', 'client active index missing');
if (/client_slug/i.test(mig) && !/wolfhouse-somo/i.test(mig)) {
  pass('A7', 'migration is generic (no Wolfhouse hard-code)');
} else if (/wolfhouse-somo/i.test(mig)) {
  fail('A7', 'migration hard-codes Wolfhouse');
} else {
  fail('A7', 'client_slug missing');
}

section('B. Helper — no runtime hard-coding');

const helperSrc = readOrEmpty(HELPER);
if (helperSrc && !/wolfhouse-somo|\bTy\b|\bAle\b|\bCami\b/.test(helperSrc)) {
  pass('B1', 'helper has no Wolfhouse/Ty/Ale/Cami hard-code');
} else fail('B1', 'helper hard-codes client or names');

const {
  normalizeStaffPhone,
  formatStaffPhoneE164,
  lookupStaffPhoneAccess,
  upsertStaffPhoneAccess,
} = require('./lib/staff-phone-access');

if (normalizeStaffPhone('+49 172 6422307') === '491726422307') {
  pass('B2', 'normalizeStaffPhone strips + spaces');
} else fail('B2', 'normalizeStaffPhone + spaces');
if (normalizeStaffPhone('(49)172-6422307') === '491726422307') {
  pass('B3', 'normalizeStaffPhone strips punctuation');
} else fail('B3', 'normalizeStaffPhone punctuation');
if (formatStaffPhoneE164('491726422307') === '+491726422307') {
  pass('B4', 'formatStaffPhoneE164 returns +digits');
} else fail('B4', 'formatStaffPhoneE164');

section('C. Lookup + upsert (mock pg)');

function mockPg(seed = []) {
  const rows = [...seed];
  return {
    rows,
    query: async (sql, params = []) => {
      const norm = sql.replace(/\s+/g, ' ').trim();
      if (/INSERT INTO staff_phone_access/i.test(norm)) {
        const [
          clientSlug, phoneE164, phoneNormalized, displayName, role, channel, isActive, notes,
        ] = params;
        const idx = rows.findIndex((r) => r.client_slug === clientSlug
          && r.phone_normalized === phoneNormalized
          && r.channel === channel);
        const row = {
          client_slug: clientSlug,
          phone_e164: phoneE164,
          phone_normalized: phoneNormalized,
          display_name: displayName,
          role,
          channel,
          is_active: isActive,
          notes,
        };
        if (idx >= 0) rows[idx] = row;
        else rows.push(row);
        return { rows: [row] };
      }
      if (/FROM staff_phone_access/i.test(norm)) {
        const [clientSlug, phoneNormalized, channel] = params;
        const hit = rows.find((r) => r.client_slug === clientSlug
          && r.phone_normalized === phoneNormalized
          && r.channel === channel);
        return { rows: hit ? [hit] : [] };
      }
      throw new Error(`unexpected sql: ${norm.slice(0, 80)}`);
    },
  };
}

(async function runAsync() {
  const pgEmpty = mockPg();
  const miss = await lookupStaffPhoneAccess(pgEmpty, {
    client_slug: 'sunset-surf-shop',
    phone: '+34600111222',
  });
  if (miss.found === false && miss.active === false) pass('C1', 'lookup miss returns found=false');
  else fail('C1', 'lookup miss shape');

  const pgOwner = mockPg();
  await upsertStaffPhoneAccess(pgOwner, {
    client_slug: 'wolfhouse-somo',
    phone: '+491726422307',
    display_name: 'Ty',
    role: 'owner',
  });
  const hit = await lookupStaffPhoneAccess(pgOwner, {
    client_slug: 'wolfhouse-somo',
    phone: '49 172 6422307',
  });
  if (hit.found && hit.active && hit.role === 'owner') pass('C2', 'active owner lookup works');
  else fail('C2', 'active owner lookup');
  if (hit.client_slug === 'wolfhouse-somo' && hit.phone_normalized === '491726422307') {
    pass('C3', 'lookup is client_slug scoped + phone_normalized');
  } else fail('C3', 'lookup scope');

  const pgInactive = mockPg([{
    client_slug: 'wolfhouse-somo',
    phone_e164: '+491726422307',
    phone_normalized: '491726422307',
    display_name: 'Ty',
    role: 'owner',
    channel: 'whatsapp',
    is_active: false,
  }]);
  const inactive = await lookupStaffPhoneAccess(pgInactive, {
    client_slug: 'wolfhouse-somo',
    phone: '+491726422307',
  });
  if (inactive.found && !inactive.active && inactive.is_active === false) {
    pass('C4', 'inactive row not treated as active staff');
  } else fail('C4', 'inactive row active flag');

  const pgDup = mockPg();
  await upsertStaffPhoneAccess(pgDup, {
    client_slug: 'sunset-surf-shop',
    phone: '+34600111222',
    display_name: 'Staff',
    role: 'operator',
  });
  await upsertStaffPhoneAccess(pgDup, {
    client_slug: 'sunset-surf-shop',
    phone: '+34600111222',
    display_name: 'Staff Updated',
    role: 'operator',
  });
  if (pgDup.rows.length === 1 && pgDup.rows[0].display_name === 'Staff Updated') {
    pass('C5', 'upsert does not duplicate');
  } else fail('C5', 'upsert duplicate rows');

  const wrongClient = await lookupStaffPhoneAccess(pgOwner, {
    client_slug: 'other-client',
    phone: '+491726422307',
  });
  if (!wrongClient.found) pass('C6', 'lookup does not cross clients');
  else fail('C6', 'cross-client lookup leak');

  section('D. Docs + upsert CLI');

  const doc = readOrEmpty(DOC);
  if (doc.includes('+491726422307')) pass('D1', 'Ty +491726422307 documented');
  else fail('D1', 'Ty phone doc');
  if (/Ale.*owner/i.test(doc) && /Cami.*owner/i.test(doc)) pass('D2', 'Ale/Cami documented as owner');
  else fail('D2', 'Ale/Cami owner doc');
  if (/not invented|add when known|when numbers are provided/i.test(doc)) {
    pass('D3', 'Ale/Cami fake numbers not invented');
  } else fail('D3', 'missing Ale/Cami placeholder note');
  if (/25c|no WhatsApp routing/i.test(doc)) pass('D4', 'no WhatsApp routing until 25c');
  else fail('D4', '25c routing note');

  const upsertSrc = readOrEmpty(UPSERT);
  if (upsertSrc.includes('--client') && !/wolfhouse-somo.*=/.test(upsertSrc)) {
    pass('D5', 'generic upsert CLI (--client arg, no hard-coded client)');
  } else fail('D5', 'upsert CLI not generic');

  section('E. Guest path + integrations untouched');

  for (const f of GUEST_UNTOUCHED) {
    const base = path.basename(f);
    const src = readOrEmpty(f);
    if (!src) {
      fail('E.' + base, `${base} missing`);
      continue;
    }
    if (base === 'luna-meta-whatsapp-inbound-process.js') {
      if (src.includes('lookupStaffPhoneAccess')
        && src.includes('processOwnerWhatsAppCommandCenterInbound')) {
        pass('E.' + base, `${base} wired for 25c Command Center routing`);
      } else {
        fail('E.' + base, `${base} missing 25c routing wiring`);
      }
      continue;
    }
    if (!src.includes('staff-phone-access') && !/staff_phone_access/i.test(src)) {
      pass('E.' + base, `${base} unchanged`);
    } else fail('E.' + base, `${base} touched unexpectedly`);
  }
  if (GUEST_WEBHOOK) {
    const wh = readOrEmpty(GUEST_WEBHOOK);
    if (!wh.includes('staff-phone-access') && !/staff_phone_access/i.test(wh)) {
      pass('E.webhook', 'Meta webhook file unchanged');
    } else fail('E.webhook', 'Meta webhook references staff_phone_access');
  } else {
    pass('E.webhook', 'Meta webhook file not in repo (skip)');
  }

  const apiSrc = readOrEmpty(path.join(__dirname, 'staff-query-api.js'));
  if (!apiSrc.includes('staff-phone-access') && !/staff_phone_access/i.test(apiSrc)) {
    pass('E.api', 'staff-query-api.js no routing yet');
  } else fail('E.api', 'staff-query-api.js already wired (25c scope)');

  if (!helperSrc.match(/\bstripe\b/i) && !helperSrc.match(/\bn8n\b/i)) {
    pass('E.safe', 'helper has no Stripe/n8n');
  } else fail('E.safe', 'helper touches Stripe/n8n');

  section('F. npm script');

  const pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'));
  const rel = 'scripts/verify-luna-agent-phase25-staff-phone-access.js';
  if (pkg.scripts && pkg.scripts[SCRIPT] === `node ${rel}`) pass('F1', `${SCRIPT} registered`);
  else fail('F1', `${SCRIPT} missing`);

  section('G. Downstream design verifier');

  for (const script of DOWNSTREAM) {
    try {
      execSync(`npm run ${script}`, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', timeout: 120000 });
      pass('G.' + script, `${script} still passes`);
    } catch (e) {
      fail('G.' + script, `${script} failed`);
    }
  }

  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(failures > 0 ? 1 : 0);
})().catch((err) => {
  fail('async', err.message);
  console.log(`\n--- ${passes} passed, ${failures} failed ---\n`);
  process.exit(1);
});
